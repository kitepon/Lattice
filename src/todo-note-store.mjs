import { createHash, randomBytes } from 'node:crypto';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import {
  lstat, mkdir, open, readFile, readdir, rename, rm, stat,
} from 'node:fs/promises';
import path from 'node:path';
import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import { syncPublishedFile } from './fs-publish.mjs';
import { normalizeCheckoutEol } from './todo-store-view.mjs';
import { memoByFileIdentity } from './todo-version-memo.mjs';

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
    await rename(temporary, ref);
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

function migrationIndex(migrations) {
  if (!Array.isArray(migrations)) throw new TypeError('todo note migrations must be an array');
  const index = new Map();
  for (const migration of migrations) {
    if (!exactRecord(migration, ['from_plan_version', 'to_plan_version', 'task_migration'])
      || !isTodoIdentifier(migration.from_plan_version)
      || !isTodoIdentifier(migration.to_plan_version)
      || migration.from_plan_version === migration.to_plan_version
      || !Array.isArray(migration.task_migration)
      || index.has(migration.from_plan_version)) {
      fail('NOTE_PROJECTION_INVALID', 'note_migration_history_invalid');
    }
    const taskMap = new Map();
    for (const entry of migration.task_migration) {
      if (!exactRecord(entry, ['from_task_id', 'to_task_id'])
        || !isTodoIdentifier(entry.from_task_id)
        || !(entry.to_task_id === null || isTodoIdentifier(entry.to_task_id))
        || taskMap.has(entry.from_task_id)) {
        fail('NOTE_PROJECTION_INVALID', 'note_task_migration_invalid');
      }
      taskMap.set(entry.from_task_id, entry.to_task_id === 'removed' ? null : entry.to_task_id);
    }
    index.set(migration.from_plan_version, {
      toPlanVersion: migration.to_plan_version, taskMap,
    });
  }
  return index;
}

function resolveNoteTarget(event, { currentPlanVersion, currentTaskIds, migrations }) {
  let version = event.plan_version;
  let taskId = event.task_id;
  const seen = new Set();
  while (version !== currentPlanVersion) {
    if (seen.has(version)) fail('NOTE_PROJECTION_INVALID', 'note_migration_cycle');
    seen.add(version);
    const step = migrations.get(version);
    if (step === undefined) return { kind: 'archived' };
    const nextTaskId = step.taskMap.get(taskId);
    if (nextTaskId === undefined || nextTaskId === null) return { kind: 'archived' };
    version = step.toPlanVersion;
    taskId = nextTaskId;
  }
  return currentTaskIds.has(taskId) ? { kind: 'active', taskId } : { kind: 'archived' };
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
  const migrations = migrationIndex(options.migrations);
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
    const target = resolveNoteTarget(event, {
      currentPlanVersion: options.currentPlanVersion, currentTaskIds, migrations,
    });
    if (target.kind === 'archived') archived.push(entry);
    else if (target.taskId === options.currentTaskId) taskCurrent.push(entry);
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

  const notes = [];
  let usedBytes = 0;
  for (const entry of current) {
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
    overflow_count: current.length - notes.length,
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

async function readNoteMigrations(repoRoot, planKey, eventVersions) {
  const base = path.resolve(repoRoot, '.lattice/todo/plans', planKey);
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT' && eventVersions.size === 0) return [];
    fail('NOTE_PROJECTION_INVALID', 'note_plan_history_unreadable', { plan_key: planKey });
  }
  const versions = new Set();
  const migrations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isTodoIdentifier(entry.name)) {
      fail('NOTE_PROJECTION_INVALID', 'note_plan_history_inventory_invalid', { plan_key: planKey });
    }
    const versionRoot = path.join(base, entry.name);
    const planPath = path.join(versionRoot, 'plan.json');
    const revisionPath = path.join(versionRoot, 'revision.json');
    // perf-store: validated once per process while both files are unchanged (todo-version-memo).
    const version = await memoByFileIdentity([planPath, revisionPath], async () => {
      // A revision directory is published before manifest activation.  A crash during
      // that window can leave an unreferenced directory containing only a journal
      // stub.  It is not a historical plan until its canonical plan artifact exists.
      // Do not make that unreachable residue poison note projection; if a note event
      // names this version, the origin-version check below still fails closed.
      const plan = await readCanonicalJson(planPath, { missing: true });
      if (plan === null) return null;
      if (!validateTodoPlan(plan) || plan.plan_key !== planKey || plan.plan_version !== entry.name) {
        fail('NOTE_PROJECTION_INVALID', 'note_historical_plan_invalid', { plan_version: entry.name });
      }
      const revision = await readCanonicalJson(revisionPath, { missing: true });
      if (revision === null) return { migration: null };
      if (!(validateTodoRevision(revision) || validatePhaseTodoRevision(revision))
        || revision.plan_key !== planKey || revision.predecessor?.plan_version === undefined
        || !Array.isArray(revision.task_migration)) {
        fail('NOTE_PROJECTION_INVALID', 'note_historical_revision_invalid', { plan_version: entry.name });
      }
      return { migration: {
        from_plan_version: revision.predecessor.plan_version,
        to_plan_version: entry.name,
        task_migration: revision.task_migration.map(({ from_task_id: fromTaskId, to_task_id: toTaskId }) => ({
          from_task_id: fromTaskId, to_task_id: toTaskId,
        })),
      } };
    });
    if (version === null) continue;
    versions.add(entry.name);
    if (version.migration !== null) migrations.push(structuredClone(version.migration));
  }
  if ([...eventVersions].some((version) => !versions.has(version))) {
    fail('NOTE_PROJECTION_INVALID', 'note_origin_plan_version_unknown');
  }
  return migrations;
}

/** active store memberと歴史revisionから、通常供給用contextを一回で読む。 */
export async function readTodoNoteContext(options = {}) {
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
  const migrations = await readNoteMigrations(repoRoot, options.planKey,
    new Set(chain.events.map(({ plan_version: version }) => version)));
  return projectTodoNoteContext({
    projectId: member.plan.project_id,
    planKey: options.planKey,
    currentPlanVersion: member.plan.plan_version,
    currentTaskId: task.task_id,
    currentTaskIds: member.plan.tasks.map(({ task_id: taskId }) => taskId),
    events: chain.events,
    planEvents: planChain.events,
    migrations,
  });
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
  const migrations = await readNoteMigrations(repoRoot, options.planKey,
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
