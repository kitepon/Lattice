import { createHash, randomBytes } from 'node:crypto';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import {
  lstat, mkdir, open, readFile, readdir, rm, stat,
} from 'node:fs/promises';
import path from 'node:path';
import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import { renamePublishedFile, syncPublishedFile } from './fs-publish.mjs';
import { normalizeCheckoutEol } from './todo-store-view.mjs';
import { memoByFileIdentity } from './todo-version-memo.mjs';
import { TODO_VERSION_COMPACT_FILE, readVersionCompact } from './todo-version-compact.mjs';
import { publishDerivedPlanCache, readDerivedPlanCache } from './todo-store.mjs';

import {
  TODO_LIMITS,
  TODO_NOTE_CONTEXT_SCHEMA,
  TODO_NOTE_EVENT_SCHEMA,
  TODO_NOTE_EVENT_V2_SCHEMA,
  canonicalizeTodoArtifact,
  exactRecord,
  isTodoDigest,
  isTodoIdentifier,
  todoSelfDigest,
  validateTodoPlan,
  validateTodoNoteContext,
  validateTodoNoteEvent,
} from './todo-contracts.mjs';
import { validatePhaseTodoRevision, validateTodoRevision } from './todo-revision.mjs';
import { revisionRecordTaskIds } from './todo-revision-note.mjs';

const NOTE_ROOT_REF = '.lattice/todo/notes';
const SEALED_NAME = /^(\d{12})-(\d{12})-([0-9a-f]{64})-([0-9a-f]{64})\.jsonl$/u;
const ZERO_DIGEST = '0'.repeat(64);
const MAX_SEGMENTS = 4_096;

export class TodoNoteStoreError extends Error {
  constructor(code, reason, detail = {}) {
    super(reason);
    this.name = 'TodoNoteStoreError';
    this.code = code;
    this.detail = { reason, ...detail };
  }
}

function fail(code, reason, detail) {
  throw new TodoNoteStoreError(code, reason, detail);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalLine(value) {
  return Buffer.from(`${canonicalizeTodoArtifact(value)}\n`, 'utf8');
}

/**
 * task noteとplan noteは**別のchain file**へ積む。
 *
 * 混ぜると、plan note(`todo_note_event.v2`)を1件書いた時点で、旧CLIにとってその planの
 * chain全体が壊れたものになる——`parseCanonicalSegment`は1 eventずつbyte完全一致で検証し、
 * 1件でも通らなければchainごと`NOTE_LOG_CORRUPT`で落とすためである。noteの読みは
 * `todo start`の前提条件(fail closed)なので、**旧CLIでstartが通らなくなる**。しかも
 * store��書いたものは戻せないので、rollbackで復旧できない。
 *
 * 旧readerが読むのは`active.jsonl`と`sealed/*`だけで、plan直下を列挙しない。別名のfileへ
 * 積めば存在に気づかず、task noteの読み書きは1バイトも変わらない。旧CLIからplan noteは
 * 見えないままだが、**旧CLIではplan noteを書けない以上、読めなくても行動が変わらない**。
 */
function notePaths(repoRoot, planKey) {
  if (!isTodoIdentifier(planKey)) throw new TypeError('planKey must be a todo identifier');
  const root = path.resolve(repoRoot, NOTE_ROOT_REF, planKey);
  return {
    root,
    active: path.join(root, 'active.jsonl'),
    sealed: path.join(root, 'sealed'),
    planActive: path.join(root, 'plan-active.jsonl'),
    planSealed: path.join(root, 'plan-sealed'),
  };
}

/** chainごとのpathと、そのchainが受けるevent schema。 */
function chainRefs(repoRoot, planKey, scope) {
  const refs = notePaths(repoRoot, planKey);
  return scope === 'plan'
    ? { active: refs.planActive, sealed: refs.planSealed, schema: TODO_NOTE_EVENT_V2_SCHEMA }
    : { active: refs.active, sealed: refs.sealed, schema: TODO_NOTE_EVENT_SCHEMA };
}

async function readOptionalBounded(ref, { missing = false } = {}) {
  try {
    const metadata = await stat(ref);
    if (!metadata.isFile() || metadata.size > TODO_LIMITS.journalSegmentBytes) {
      fail('NOTE_LOG_CORRUPT', 'note_segment_invalid', { ref });
    }
    return normalizeCheckoutEol(await readFile(ref));
  } catch (error) {
    if (error instanceof TodoNoteStoreError) throw error;
    if (missing && error?.code === 'ENOENT') return null;
    fail('NOTE_LOG_CORRUPT', 'note_segment_unreadable', { ref });
  }
}

function parseCanonicalSegment(bytes, ref) {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    fail('NOTE_LOG_CORRUPT', 'note_segment_not_canonical', { ref });
  }
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  const events = [];
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { fail('NOTE_LOG_CORRUPT', 'note_json_invalid', { ref }); }
    if (!validateTodoNoteEvent(event) || canonicalLine(event).toString('utf8') !== `${line}\n`) {
      fail('NOTE_LOG_CORRUPT', 'note_event_invalid', { ref });
    }
    events.push(event);
  }
  return events;
}

async function sealedFiles(ref) {
  try {
    const names = await readdir(ref);
    if (names.length > MAX_SEGMENTS || names.some((name) => !SEALED_NAME.test(name))) {
      fail('NOTE_LOG_CORRUPT', 'note_sealed_inventory_invalid', { ref });
    }
    return names.sort();
  } catch (error) {
    if (error instanceof TodoNoteStoreError) throw error;
    if (error?.code === 'ENOENT') return [];
    fail('NOTE_LOG_CORRUPT', 'note_sealed_inventory_unreadable', { ref });
  }
}

function validateEventChain(events, { projectId, planKey }) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1] ?? null;
    if (event.project_id !== projectId || event.plan_key !== planKey
      || event.sequence !== index + 1
      || event.previous_digest !== (previous?.event_digest ?? null)) {
      fail('NOTE_LOG_CORRUPT', 'note_digest_chain_invalid', {
        plan_key: planKey, sequence: event.sequence,
      });
    }
  }
}

/**
 * planに属する独立note chainをbyte-levelで検証して読む。missingだけは空chainである。
 * `scope`で読むchainを選ぶ（既定はtask chain＝旧CLIと同じ経路・同じbyte）。
 */
export async function readTodoNoteEvents(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const scope = options.scope ?? 'task';
  if (!['plan', 'task'].includes(scope)) throw new TypeError('note chain scope must be plan or task');
  const { active, sealed, schema } = chainRefs(repoRoot, options.planKey, scope);
  const names = await sealedFiles(sealed);
  const events = [];
  let previousSegmentDigest = ZERO_DIGEST;
  let lastSealedBytes = null;
  for (const name of names) {
    const match = name.match(SEALED_NAME);
    const bytes = await readOptionalBounded(path.join(sealed, name));
    const segmentDigest = sha256(bytes);
    const segmentEvents = parseCanonicalSegment(bytes, path.join(sealed, name));
    if (Number(match[1]) !== segmentEvents[0]?.sequence
      || Number(match[2]) !== segmentEvents.at(-1)?.sequence
      || match[3] !== previousSegmentDigest || match[4] !== segmentDigest) {
      fail('NOTE_LOG_CORRUPT', 'note_seal_invalid', { ref: path.join(sealed, name) });
    }
    events.push(...segmentEvents);
    previousSegmentDigest = segmentDigest;
    lastSealedBytes = bytes;
  }
  const activeBytes = await readOptionalBounded(active, { missing: true });
  const duplicateActive = activeBytes !== null && lastSealedBytes?.equals(activeBytes) === true;
  if (activeBytes !== null && !duplicateActive) events.push(...parseCanonicalSegment(activeBytes, active));
  // chainの分離は「そのfileへ何が積まれるか」で守る。混ざったchainは分離の意味を失うので
  // 黙って受けず、読んだ時点でtypedに落とす。
  if (events.some((event) => event.schema !== schema)) {
    fail('NOTE_LOG_CORRUPT', 'note_chain_scope_mixed', { plan_key: options.planKey, scope });
  }
  if (events.length > 0) {
    validateEventChain(events, { projectId: events[0].project_id, planKey: options.planKey });
  }
  return {
    events,
    head_digest: events.at(-1)?.event_digest ?? null,
    active_bytes: duplicateActive ? Buffer.alloc(0) : activeBytes ?? Buffer.alloc(0),
    previous_segment_digest: previousSegmentDigest,
  };
}

async function atomicWrite(ref, bytes) {
  const temporary = path.join(path.dirname(ref),
    `.${path.basename(ref)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await syncPublishedFile(handle, ref);
    await handle.close();
    handle = null;
    await renamePublishedFile(temporary, ref);
    await fsyncDirectory(path.dirname(ref));
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

async function ensureNoteDirectory(root) {
  try { await mkdir(root); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('NOTE_WRITE_CONFLICT', 'note_store_locked', {
      next_action: 'Retry after initialization or recovery finishes publishing the Todo Store.',
    });
    if (error?.code !== 'EEXIST') throw error;
  }
  const state = await lstat(root);
  if (state.isSymbolicLink() || !state.isDirectory()) fail('NOTE_WRITE_CONFLICT', 'note_store_locked', {
    next_action: `Restore a real note directory at ${root}, then retry.`,
  });
}

async function withNoteLock(repoRoot, callback) {
  const root = path.resolve(repoRoot, NOTE_ROOT_REF);
  try {
    for (const ref of ['.lattice', '.lattice/todo', '.lattice/todo/manifest.json']) {
      const state = await lstat(path.resolve(repoRoot, ref)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
        return null;
      });
      if (state === null || state.isSymbolicLink()
        || (ref.endsWith('.json') ? !state.isFile() : !state.isDirectory())) {
        fail('NOTE_WRITE_CONFLICT', 'note_store_locked', {
          next_action: 'Initialize a published Todo Store before writing notes, then retry.',
        });
      }
    }
    await ensureNoteDirectory(root);
    return await withStoreLock({ lockPath: path.join(root, '.write.lock'), createParent: false, waitMs: LOCK_WAIT_MS }, callback);
  }
  catch (error) {
    if (error instanceof StoreLockError) {
      fail('NOTE_WRITE_CONFLICT', error.reason === 'store_locked' ? 'note_store_locked' : error.reason,
        error.detail);
    }
    throw error;
  }
}

/** lifecycle artifactsへ触れず、独立note chainだけへ1 eventを追記する。 */
export async function appendTodoNote(options = {}) {
  const keys = [
    'repoRoot', 'projectId', 'planKey', 'planVersion', 'taskId', 'actor',
    'recordedAt', 'body', 'supersedes', 'eligibleSupersedes',
  ];
  if (!exactRecord(options, keys)
    || !Array.isArray(options.eligibleSupersedes)
    || !options.eligibleSupersedes.every(isTodoDigest)
    || ![options.projectId, options.planKey, options.planVersion].every(isTodoIdentifier)
    // taskId nullがplan単位noteの指定。scopeはeventのschemaが持つ。
    || !(options.taskId === null || isTodoIdentifier(options.taskId))) {
    throw new TypeError('todo note append options invalid');
  }
  const planScoped = options.taskId === null;
  const scope = planScoped ? 'plan' : 'task';
  const repoRoot = path.resolve(options.repoRoot);
  return withNoteLock(repoRoot, async (assertHeld) => {
    // sequenceとprevious_digestはchainごとに独立。note系の起点は1（journal系の0ではない）。
    const chain = await readTodoNoteEvents({ repoRoot, planKey: options.planKey, scope });
    if (options.supersedes !== null) {
      const target = chain.events.find(({ event_digest: digest }) => digest === options.supersedes);
      if (target === undefined || !options.eligibleSupersedes.includes(options.supersedes)) {
        // plan noteはplan noteだけを、task noteは同じtaskのnoteだけを訂正できる。
        // scopeを跨ぐ訂正を許すと、届く先が違うものを同じ履歴として畳むことになる。
        fail('NOTE_SUPERSEDES_INVALID', planScoped
          ? 'superseded_note_not_plan_scoped' : 'superseded_note_not_in_same_task', {
          plan_key: options.planKey, task_id: options.taskId,
        });
      }
    }
    const previous = chain.events.at(-1) ?? null;
    const event = {
      schema: planScoped ? TODO_NOTE_EVENT_V2_SCHEMA : TODO_NOTE_EVENT_SCHEMA,
      ...(planScoped ? { scope: 'plan' } : {}),
      project_id: options.projectId,
      plan_key: options.planKey,
      task_id: options.taskId,
      plan_version: options.planVersion,
      sequence: (previous?.sequence ?? 0) + 1,
      previous_digest: previous?.event_digest ?? null,
      actor: options.actor,
      recorded_at: options.recordedAt,
      body: options.body,
      supersedes: options.supersedes,
      event_digest: '',
    };
    event.event_digest = todoSelfDigest(event, 'event_digest');
    if (!validateTodoNoteEvent(event)) throw new TypeError('todo note event input invalid');

    const paths = chainRefs(repoRoot, options.planKey, scope);
    await ensureNoteDirectory(path.dirname(paths.active));
    const eventBytes = canonicalLine(event);
    // A holder that lost its lock while suspended must not overwrite the new owner's chain.
    await assertHeld();
    if (chain.active_bytes.length > 0
      && chain.active_bytes.length + eventBytes.length > TODO_LIMITS.journalSegmentBytes) {
      const activeEvents = parseCanonicalSegment(chain.active_bytes, paths.active);
      const segmentDigest = sha256(chain.active_bytes);
      const name = `${String(activeEvents[0].sequence).padStart(12, '0')}`
        + `-${String(activeEvents.at(-1).sequence).padStart(12, '0')}`
        + `-${chain.previous_segment_digest}-${segmentDigest}.jsonl`;
      await ensureNoteDirectory(paths.sealed);
      await atomicWrite(path.join(paths.sealed, name), chain.active_bytes);
      await atomicWrite(paths.active, eventBytes);
    } else {
      await atomicWrite(paths.active, Buffer.concat([chain.active_bytes, eventBytes]));
    }
    return event;
  });
}

/** v1(task note)とv2(plan note)を、明示`scope`を持つ1つの形へ正規化する。 */
function noteProjectionEntry(event, supersededBy) {
  return {
    event_digest: event.event_digest,
    origin_plan_version: event.plan_version,
    scope: event.schema === TODO_NOTE_EVENT_V2_SCHEMA ? 'plan' : 'task',
    origin_task_id: event.task_id,
    actor: event.actor,
    recorded_at: event.recorded_at,
    body: event.body,
    supersedes: event.supersedes,
    superseded_by: supersededBy ?? null,
    correction_state: supersededBy === undefined ? 'current' : 'superseded',
  };
}

/**
 * One migration's entries that change a task, `[from, to | null]` (null: removed). A migration lists every task of its
 * predecessor (the writer refuses an incomplete one: predecessor_task_migration_incomplete), so an entry that keeps the id
 * says nothing and is left out; this is what keeps the lineage small on a plan with thousands of tasks and versions.
 */
function changedTaskMoves(taskMigration, planVersion) {
  const seen = new Set();
  const moves = [];
  for (const entry of taskMigration) {
    const to = entry?.to_task_id === 'removed' ? null : entry?.to_task_id;
    if (!isTodoIdentifier(entry?.from_task_id) || !(to === null || isTodoIdentifier(to)) || seen.has(entry.from_task_id)) {
      fail('NOTE_PROJECTION_INVALID', 'note_task_migration_invalid', { plan_version: planVersion });
    }
    seen.add(entry.from_task_id);
    if (to !== entry.from_task_id) moves.push([entry.from_task_id, to]);
  }
  return moves;
}

/**
 * w2-impl: where a note's origin (plan version, task) ends up at the head, without walking every later version per note.
 * `versions` runs from the oldest version to the head along the predecessor chain; `moves` are `[index, from, to | null]`:
 * the migration from versions[index] to versions[index + 1] renamed or removed `from`, in ascending index order.
 */
class NoteLineage {
  constructor(versions, moves) {
    this.versions = versions;
    this.positions = new Map(versions.map((version, index) => [version, index]));
    this.moves = new Map();
    for (const [index, from, to] of moves) {
      if (!this.moves.has(from)) this.moves.set(from, []);
      this.moves.get(from).push([index, to]);
    }
  }

  /** The head task id that `taskId` of `version` became (callers check it is still in the plan), or null: removed, or a version off the chain. */
  resolve(version, taskId) {
    let index = this.positions.get(version);
    if (index === undefined) return null;
    for (let task = taskId; ;) {
      // shortcut: linear in the task's own moves (a few), upgrade if one task is renamed thousands of times
      const move = this.moves.get(task)?.find(([at]) => at >= index);
      if (move === undefined) return task;
      if (move[1] === null) return null;
      [index, task] = [move[0] + 1, move[1]];
    }
  }
}

/** The lineage of a hand-made migration list (the pure projector's input): its chain ending at `head`; versions off that chain resolve to null. */
function lineageFromMigrations(migrations, head) {
  if (!Array.isArray(migrations)) throw new TypeError('todo note migrations must be an array');
  const byTo = new Map();
  const froms = new Set();
  for (const migration of migrations) {
    if (!exactRecord(migration, ['from_plan_version', 'to_plan_version', 'task_migration'])
      || !isTodoIdentifier(migration.from_plan_version)
      || !isTodoIdentifier(migration.to_plan_version)
      || migration.from_plan_version === migration.to_plan_version
      || !Array.isArray(migration.task_migration)
      || froms.has(migration.from_plan_version) || byTo.has(migration.to_plan_version)) {
      fail('NOTE_PROJECTION_INVALID', 'note_migration_history_invalid');
    }
    froms.add(migration.from_plan_version);
    byTo.set(migration.to_plan_version, { from: migration.from_plan_version,
      moves: changedTaskMoves(migration.task_migration, migration.to_plan_version) });
  }
  const versions = [head];
  const steps = [];
  for (let version = head; byTo.has(version);) {
    const step = byTo.get(version);
    if (versions.includes(step.from)) fail('NOTE_PROJECTION_INVALID', 'note_migration_cycle');
    versions.unshift(step.from);
    steps.unshift(step.moves);
    version = step.from;
  }
  return new NoteLineage(versions, steps.flatMap((moves, index) => moves.map(([from, to]) => [index, from, to])));
}

/**
 * 既存task_migrationを合成し、現行taskへ渡すbounded contextとremoved taskのarchived束を作る。
 * note listはこの全履歴を使えるが、通常詳細/startはcontextを自動同梱する。
 */
export function projectTodoNoteContext(options = {}) {
  if (!exactRecord(options, [
    'projectId', 'planKey', 'currentPlanVersion', 'currentTaskId',
    'currentTaskIds', 'events', 'planEvents', 'migrations',
  ]) || ![options.projectId, options.planKey, options.currentPlanVersion, options.currentTaskId]
    .every(isTodoIdentifier) || !Array.isArray(options.currentTaskIds)
    || !options.currentTaskIds.every(isTodoIdentifier)
    || !options.currentTaskIds.includes(options.currentTaskId)
    || !Array.isArray(options.events) || !options.events.every(validateTodoNoteEvent)
    || !Array.isArray(options.planEvents) || !options.planEvents.every(validateTodoNoteEvent)) {
    throw new TypeError('todo note projection options invalid');
  }
  const currentTaskIds = new Set(options.currentTaskIds);
  const lineage = options.migrations instanceof NoteLineage
    ? options.migrations : lineageFromMigrations(options.migrations, options.currentPlanVersion);
  // 訂正はscopeを跨げないので、supersedeの追跡もchainごとに閉じる。
  const supersededBy = new Map();
  for (const event of [...options.events, ...options.planEvents]) {
    if (event.project_id !== options.projectId || event.plan_key !== options.planKey) {
      fail('NOTE_LOG_CORRUPT', 'note_identity_mismatch');
    }
    if (event.supersedes !== null) supersededBy.set(event.supersedes, event.event_digest);
  }

  const taskCurrent = [];
  const archived = [];
  const sequenceOf = (events) => new Map(events.map((event) => [event.event_digest, event.sequence]));
  const taskSequence = sequenceOf(options.events);
  const planSequence = sequenceOf(options.planEvents);
  for (const event of options.events) {
    const entry = noteProjectionEntry(event, supersededBy.get(event.event_digest));
    const target = lineage.resolve(event.plan_version, event.task_id);
    if (target === null || !currentTaskIds.has(target)) archived.push(entry);
    else if (target === options.currentTaskId) taskCurrent.push(entry);
  }
  // plan noteは特定のtaskに属さないので、task migrationで宛先を失うことがない。全taskの
  // contextへ載せる——工程レベルの義務は「次に着手する誰か」へ届くべきもので、誰が着手するかは
  // 書いた時点で分からない。
  const planCurrent = options.planEvents
    .map((event) => noteProjectionEntry(event, supersededBy.get(event.event_digest)));
  taskCurrent.sort((left, right) => taskSequence.get(right.event_digest)
    - taskSequence.get(left.event_digest));
  planCurrent.sort((left, right) => planSequence.get(right.event_digest)
    - planSequence.get(left.event_digest));
  // 2本のsequenceは独立なので、混ぜた全順序は時刻にもsequenceにも作れない（時刻は
  // future_clock_skewがある以上信用できない）。決定的な規則で並べる: plan単位の申し送りは
  // task固有のものより文脈が広いので先に読ませる。
  const current = [...planCurrent, ...taskCurrent];
  archived.reverse();
  // n3: Lattice's own revision records about other tasks would fill the cap and push out every
  // human handoff (546 on bellteam-dev-added); they stay in history and note list.
  const offered = current.filter((entry) => entry.scope !== 'plan'
    || (revisionRecordTaskIds(entry.body)?.includes(options.currentTaskId) ?? true));

  const notes = [];
  let usedBytes = 0;
  for (const entry of offered) {
    // 件数もvalidatorと同じ上限で切る。byteに収まる短いnoteが溜まると、自分の出力が自分の検証で落ちる。
    if (notes.length >= TODO_LIMITS.noteContextEntries) break;
    const bytes = Buffer.byteLength(entry.body, 'utf8');
    if (usedBytes + bytes > TODO_LIMITS.noteContextBytes) continue;
    notes.push(entry);
    usedBytes += bytes;
  }
  const context = {
    schema: TODO_NOTE_CONTEXT_SCHEMA,
    project_id: options.projectId,
    plan_key: options.planKey,
    task_id: options.currentTaskId,
    notes,
    // headはchainごとに言う。合成すると「どちらのheadか」と連結順を定義する必要が生まれ、
    // 順序が決まっていなければ同じ状態から違うdigestが出る。
    note_head_digest: taskCurrent[0]?.event_digest ?? null,
    plan_note_head_digest: planCurrent[0]?.event_digest ?? null,
    // overflowはcontext全体の予算の話でchainの性質ではないので、ここは合成でよい。
    overflow_count: offered.length - notes.length,
    // plan noteを載せる以上、案内はplan全体を返す形でなければ「full」ではない。
    full_history_command: `lattice todo note list --plan ${options.planKey} --json`,
    context_digest: '',
  };
  context.context_digest = todoSelfDigest(context, 'context_digest');
  if (!validateTodoNoteContext(context)) {
    fail('NOTE_PROJECTION_INVALID', 'note_context_invalid');
  }
  return { context, archived, history: current };
}

async function readCanonicalJson(ref, { missing = false } = {}) {
  let bytes;
  try {
    const metadata = await stat(ref);
    if (!metadata.isFile() || metadata.size > TODO_LIMITS.snapshotBytes) {
      fail('NOTE_PROJECTION_INVALID', 'note_projection_artifact_invalid', { ref });
    }
    bytes = normalizeCheckoutEol(await readFile(ref));
  } catch (error) {
    if (error instanceof TodoNoteStoreError) throw error;
    if (missing && error?.code === 'ENOENT') return null;
    fail('NOTE_PROJECTION_INVALID', 'note_projection_artifact_unreadable', { ref });
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('NOTE_PROJECTION_INVALID', 'note_projection_json_invalid', { ref }); }
  if (!bytes.equals(canonicalLine(value))) {
    fail('NOTE_PROJECTION_INVALID', 'note_projection_artifact_not_canonical', { ref });
  }
  return value;
}

/**
 * One retained version as the lineage needs it: `{predecessor, moves}` (its predecessor's version name, null for the first
 * version, and `changedTaskMoves` of the migration into it), or null when the version does not exist.
 */
function readVersionMigration(base, name, planKey) {
  const versionRoot = path.join(base, name);
  const planPath = path.join(versionRoot, 'plan.json');
  const revisionPath = path.join(versionRoot, 'revision.json');
  const compactPath = path.join(versionRoot, TODO_VERSION_COMPACT_FILE);
  // perf-store: validated once per process while the files are unchanged (todo-version-memo). w2: the memo holds only the
  // moves, not the whole 3,321-entry task_migration (that array times 4,204 versions was the 1.6 GB).
  return memoByFileIdentity([planPath, revisionPath, compactPath], async () => {
    const record = (predecessor, taskMigration) => {
      if (predecessor === name) fail('NOTE_PROJECTION_INVALID', 'note_migration_history_invalid');
      return { predecessor, moves: changedTaskMoves(taskMigration, name) };
    };
    // b10: a superseded version keeps compact.json.gz (its revision, minus the plan it repeats) instead of plan.json/revision.json.
    const compact = await readVersionCompact(versionRoot, undefined, { verify: false }).catch(() => fail('NOTE_PROJECTION_INVALID',
      'note_historical_plan_invalid', { plan_version: name }));
    if (compact !== null) {
      if (compact.plan_key !== planKey || compact.plan_version !== name) {
        fail('NOTE_PROJECTION_INVALID', 'note_historical_plan_invalid', { plan_version: name });
      }
      if (compact.revision === null) return { predecessor: null, moves: [] };
      if (compact.predecessor_plan_version === null || !Array.isArray(compact.revision?.task_migration)) {
        fail('NOTE_PROJECTION_INVALID', 'note_historical_revision_invalid', { plan_version: name });
      }
      return record(compact.predecessor_plan_version, compact.revision.task_migration);
    }
    // A revision directory is published before manifest activation.  A crash during
    // that window can leave an unreferenced directory containing only a journal
    // stub.  It is not a historical plan until its canonical plan artifact exists.
    // Do not make that unreachable residue poison note projection; if a note event
    // names this version, the origin-version check below still fails closed.
    const plan = await readCanonicalJson(planPath, { missing: true });
    if (plan === null) return null;
    if (!validateTodoPlan(plan) || plan.plan_key !== planKey || plan.plan_version !== name) {
      fail('NOTE_PROJECTION_INVALID', 'note_historical_plan_invalid', { plan_version: name });
    }
    const revision = await readCanonicalJson(revisionPath, { missing: true });
    if (revision === null) return { predecessor: null, moves: [] };
    if (!(validateTodoRevision(revision) || validatePhaseTodoRevision(revision))
      || revision.plan_key !== planKey || revision.predecessor?.plan_version === undefined
      || !Array.isArray(revision.task_migration)) {
      fail('NOTE_PROJECTION_INVALID', 'note_historical_revision_invalid', { plan_version: name });
    }
    return record(revision.predecessor.plan_version, revision.task_migration);
  });
}

const LINEAGE_CACHE_DIRECTORY = '.lattice/generated/store-note-lineage';
const LINEAGE_CACHE_SCHEMA = 'lattice.todo_note_lineage_cache.v1';
// shortcut: a shorter chain reads in well under 0.1 s, so an ordinary `todo start` on a small plan leaves no file in a user's git tree; upgrade if a short chain gets slow
const LINEAGE_CACHE_MIN_VERSIONS = 32;

/** The cached `{versions, moves}` of a plan's lineage up to some head, or null for any miss (absent, unreadable, wrong plan, bad digest, bad shape). */
async function readLineageCache(root, planKey) {
  const body = await readDerivedPlanCache(root, LINEAGE_CACHE_DIRECTORY, LINEAGE_CACHE_SCHEMA, planKey);
  if (body === null || !Array.isArray(body.versions) || body.versions.length === 0
    || !body.versions.every(isTodoIdentifier) || new Set(body.versions).size !== body.versions.length
    || !Array.isArray(body.moves) || !body.moves.every((move, at) => Array.isArray(move) && move.length === 3
      && Number.isInteger(move[0]) && move[0] >= 0 && move[0] < body.versions.length - 1
      && (at === 0 || move[0] >= body.moves[at - 1][0])
      && isTodoIdentifier(move[1]) && (move[2] === null || isTodoIdentifier(move[2])))) return null;
  return body;
}

/**
 * w2-impl: the lineage of `headVersion`, from the head back along its predecessors. Derived cache
 * `.lattice/generated/store-note-lineage/<plan_key>.json` (best effort, never truth: any miss reads the chain; a failed write
 * never fails the read; written only for a chain of at least LINEAGE_CACHE_MIN_VERSIONS versions): a cached head equal
 * to this one costs no version read, a head some revisions later reads only the versions after the cached head. Only a chain
 * that reaches the first version (or the cached head, itself rooted) is cached, so a version directory that is missing for a
 * while can never leave a short lineage behind. Versions off the head's chain
 * (unpublished residue) are not read; a note naming a version that does not exist at all is still refused.
 */
async function readNoteLineage(repoRoot, planKey, headVersion, eventVersions) {
  const base = path.resolve(repoRoot, '.lattice/todo/plans', planKey);
  const lineage = await memoByFileIdentity([path.join(base, headVersion, 'plan.json')], async () => {
    const cached = await readLineageCache(repoRoot, planKey);
    const stop = cached?.versions.at(-1) ?? null;
    if (stop === headVersion) return new NoteLineage(cached.versions, cached.moves);
    const fresh = []; // newest first
    for (let name = headVersion, seen = new Set(); name !== null && name !== stop;) {
      if (seen.has(name)) fail('NOTE_PROJECTION_INVALID', 'note_migration_cycle');
      seen.add(name);
      const record = await readVersionMigration(base, name, planKey);
      if (record === null) break;
      fresh.push({ name, ...record });
      name = record.predecessor;
    }
    fresh.reverse();
    const extends_ = stop !== null && fresh[0]?.predecessor === stop;
    const rooted = extends_ || fresh[0]?.predecessor === null;
    const versions = [...(extends_ ? cached.versions : []), ...fresh.map(({ name }) => name)];
    const moves = extends_ ? [...cached.moves] : [];
    fresh.forEach(({ moves: changed }, at) => {
      const index = (extends_ ? cached.versions.length : 0) + at - 1; // the migration into this version
      if (index >= 0) for (const [from, to] of changed) moves.push([index, from, to]);
    });
    if (rooted && fresh.length > 0 && versions.length >= LINEAGE_CACHE_MIN_VERSIONS) {
      await publishDerivedPlanCache(repoRoot, LINEAGE_CACHE_DIRECTORY, { schema: LINEAGE_CACHE_SCHEMA, plan_key: planKey,
        versions, moves }).catch(() => {});
    }
    return new NoteLineage(versions, moves);
  }, 'note-lineage');
  for (const version of eventVersions) {
    if (!lineage.positions.has(version) && await readVersionMigration(base, version, planKey) === null) {
      fail('NOTE_PROJECTION_INVALID', 'note_origin_plan_version_unknown');
    }
  }
  return lineage;
}

/**
 * active store memberと歴史revisionから、1 taskのnote contextの素材を一回で読む。`project(extra)`がcontextを作る。
 * `extra`は読んだ後に積んだtask note（appendNoteが今書いたもの）で、素材を読み直さずに入れる。
 */
export async function readTodoNoteSource(options = {}) {
  if (!exactRecord(options, ['repoRoot', 'store', 'planKey', 'taskId'])
    || !isTodoIdentifier(options.planKey) || !isTodoIdentifier(options.taskId)
    || options.store === null || typeof options.store !== 'object') {
    throw new TypeError('todo note context read options invalid');
  }
  const repoRoot = path.resolve(options.repoRoot);
  const member = options.store.members?.find(({ descriptor }) => (
    descriptor.plan_key === options.planKey
  ));
  if (member === undefined) fail('NOTE_TASK_NOT_FOUND', 'note_plan_not_active', {
    plan_key: options.planKey,
  });
  const task = member.plan.tasks.find(({ task_id: taskId }) => taskId === options.taskId);
  if (task === undefined) fail('NOTE_TASK_NOT_FOUND', 'note_task_not_active', {
    plan_key: options.planKey, task_id: options.taskId,
  });
  const chain = await readTodoNoteEvents({ repoRoot, planKey: options.planKey });
  const planChain = await readTodoNoteEvents({ repoRoot, planKey: options.planKey, scope: 'plan' });
  const lineage = await readNoteLineage(repoRoot, options.planKey, member.plan.plan_version,
    new Set(chain.events.map(({ plan_version: version }) => version)));
  return { project: (extra = []) => projectTodoNoteContext({
    projectId: member.plan.project_id,
    planKey: options.planKey,
    currentPlanVersion: member.plan.plan_version,
    currentTaskId: task.task_id,
    currentTaskIds: member.plan.tasks.map(({ task_id: taskId }) => taskId),
    events: [...chain.events, ...extra],
    planEvents: planChain.events,
    migrations: lineage,
  }) };
}

export async function readTodoNoteContext(options = {}) {
  return (await readTodoNoteSource(options)).project();
}

/**
 * status面の`plan_notes`欄の素材を、store内の全planぶん一度に読む。
 *
 * plan単位noteは「工程に属する義務」で、着手する誰かのcontextへは届くが、**まだ誰も
 * 着手していない工程の義務はどこにも出ない**。statusはそれを出す唯一の面なので、
 * ここでは本文を一切運ばない——載せるのは件数・帰属・次の一手だけで、中身は
 * `note list`が持つ（`audit_pending`が330字のproseを落としたのと同じ判断・ADR 0159）。
 *
 * noteを持たないplanはentryごと出さない。「全plan常に1行」は、前campaignの
 * witness `coverage: missing`と同じ「満杯で始まるので読み飛ばされる欄」になる。
 *
 * chainが壊れているplanが1つでもあれば`readTodoNoteEvents`のtyped errorがそのまま出る
 * （fail closed）。壊れた義務記録を「義務なし」と同じ空へ丸めない。
 */
export async function readTodoPlanNotesForStatus(options = {}) {
  if (!exactRecord(options, ['repoRoot', 'store'])
    || options.store === null || typeof options.store !== 'object'
    || !Array.isArray(options.store.members)) {
    throw new TypeError('todo plan notes read options invalid');
  }
  const repoRoot = path.resolve(options.repoRoot);
  const summaries = [];
  for (const member of options.store.members) {
    const planKey = member.plan.plan_key;
    // plan noteは専用chainに在る。schemaでの選別は要らない——読む先そのものが分かれている。
    const chain = await readTodoNoteEvents({ repoRoot, planKey, scope: 'plan' });
    const superseded = new Set(chain.events
      .filter(({ supersedes }) => supersedes !== null)
      .map(({ supersedes }) => supersedes));
    // 訂正されたnoteは数えない。数えると訂正するほど件数が増える。
    const current = chain.events
      .filter((event) => !superseded.has(event.event_digest))
      .sort((left, right) => right.sequence - left.sequence);
    if (current.length === 0) continue;
    summaries.push({
      plan_key: planKey,
      // `note_context.note_head_digest`はtask chainのheadを指す。同名で別のchainを指すと
      // 型が同じdigestなので取り違えてもvalidatorを通る——名前で区別する（room [211]）。
      plan_note_head_digest: current[0].event_digest,
      count: current.length,
      latest: current.slice(0, TODO_LIMITS.statusPlanNoteLatest).map((event) => ({
        event_digest: event.event_digest,
        actor_agent: event.actor.agent,
        recorded_at: event.recorded_at,
      })),
      // 欄だけでは読まれない。届いた先で次に何を打てばいいかを名指しする。
      next_commands: [`lattice todo note list --plan ${planKey} --json`],
    });
  }
  summaries.sort((left, right) => (
    left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1 : 0));
  return summaries;
}

/** 1 planを一度だけ読み全taskへ投影する。includeHistoryはbudget前の履歴も返す。 */
export async function readTodoNoteContextsForPlan(options = {}) {
  const keys = ['repoRoot', 'store', 'planKey'];
  if (!(exactRecord(options, keys) || exactRecord(options, [...keys, 'includeHistory']))
    || ('includeHistory' in options && typeof options.includeHistory !== 'boolean')
    || !isTodoIdentifier(options.planKey)
    || options.store === null || typeof options.store !== 'object') {
    throw new TypeError('todo note contexts read options invalid');
  }
  const repoRoot = path.resolve(options.repoRoot);
  const member = options.store.members?.find(({ descriptor }) => (
    descriptor.plan_key === options.planKey
  ));
  if (member === undefined) fail('NOTE_TASK_NOT_FOUND', 'note_plan_not_active', {
    plan_key: options.planKey,
  });
  const chain = await readTodoNoteEvents({ repoRoot, planKey: options.planKey });
  const planChain = await readTodoNoteEvents({ repoRoot, planKey: options.planKey, scope: 'plan' });
  const migrations = await readNoteLineage(repoRoot, options.planKey, member.plan.plan_version,
    new Set(chain.events.map(({ plan_version: version }) => version)));
  const currentTaskIds = member.plan.tasks.map(({ task_id: taskId }) => taskId);
  const projected = member.plan.tasks.map((task) => projectTodoNoteContext({
    projectId: member.plan.project_id,
    planKey: options.planKey,
    currentPlanVersion: member.plan.plan_version,
    currentTaskId: task.task_id,
    currentTaskIds,
    events: chain.events,
    planEvents: planChain.events,
    migrations,
  }));
  return {
    contexts: projected.map(({ context }) => context),
    archived: projected[0]?.archived ?? [],
    note_head_digest: chain.head_digest,
    ...(options.includeHistory ? { histories: projected.map(({ context, history }) => ({
      task_id: context.task_id, history,
    })) } : {}),
  };
}
