import {
  isDecoupledPhaseTodoPlanSchema,
  isPhaseTodoPlanSchema,
  isPhaselessTodoPlanSchema,
  projectTodoCrossPlanDependencies,
  normalizeCheckoutEol,
  isFinishedTodoTaskState,
  stepTodoReopenedPending,
} from './todo-store-view.mjs';
export {
  isDecoupledPhaseTodoPlanSchema,
  isFinishedTodoTaskState,
  isPhaseTodoPlanSchema,
  isPhaselessTodoPlanSchema,
  projectTodoCrossPlanDependencies,
  todoTaskCarrySemantics,
} from './todo-store-view.mjs';
import { randomBytes } from 'node:crypto';
import { fsyncDirectory } from './fs-dir-sync.mjs';
import { renamePublishedFile, syncPublishedFile } from './fs-publish.mjs';
import { LOCK_WAIT_MS, StoreLockError, withStoreLock } from './store-lock.mjs';
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import {
  TODO_COORDINATION_MODES,
  TODO_EVENT_KINDS,
  TODO_LIMITS,
  TODO_PLAN_SCOPED_EVENT_KINDS,
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  explainTodoPlan,
  exactRecord,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoIdentifier,
  isTodoRef,
  todoSelfDigest,
  validateEvidenceDescriptor,
  validateTodoImportSource,
  validateTodoEvent,
  validateTodoManifest,
  validateTodoPlan,
  validateTodoSnapshot,
} from './todo-contracts.mjs';
import {
  TODO_INDEPENDENCE_LEGACY_MARKER_SCHEMA,
  isTodoIndependenceLegacyArtifactIdentity,
  validateTodoIndependence,
  validateTodoWitnessSet,
} from './todo-independence-contracts.mjs';
import { validateSeamProposal } from './seam-proposal-contracts.mjs';
import {
  digestTodoStructureRealizationHeads,
  explainTodoStructureSet,
  explainTodoStructureRealization,
  validateTodoStructureBinding,
  validateTodoStructureCompileArtifact,
  validateTodoStructureSet,
} from './todo-structure-contracts.mjs';
import {
  bindTodoStructureRealizationCommits,
  collectTodoStructureGitProvenance,
} from './todo-structure-git-adapter.mjs';
import { sha256Bytes, verifyLinearHashChain } from './hash-chain.mjs';
import packageJson from '../package.json' with { type: 'json' };
import { gitCatFileBatch, gitSync } from './git-process.mjs';
import { matchesTodoSourceLineDigest } from './todo-source-line-eol.mjs';
import {
  parseTodoSourceRef,
  todoCutoverArchiveSourceRef,
  todoLegacyReconciliationDigest,
  validatePhaseTodoRevision,
  validateTodoRevision,
  validateTodoRevisionSet,
} from './todo-revision.mjs';

const STORE_ROOT_REF = '.lattice/todo';
const MANIFEST_REF = `${STORE_ROOT_REF}/manifest.json`;
const CROSS_PLAN_IMPORT_TRANSACTIONS_REF = `${STORE_ROOT_REF}/transactions/imports`;
const CROSS_PLAN_RECOVERY_CLAIMS_REF = `${STORE_ROOT_REF}/.cross-plan-recovery`;
const CROSS_PLAN_IMPORT_TRANSACTION_SCHEMA = 'lattice.todo_cross_plan_import_transaction.v1';
const SOURCE_CUTOVER_BARRIER_REF = `${STORE_ROOT_REF}/source-cutover-recovery.json`;
const SOURCE_CUTOVER_RECOVERY_CAPABILITY = Symbol('lattice.todo.source-cutover-recovery');
const STORE_LOCK_HELD = Symbol('lattice.todo.lock-held');
const WRITER_CALLERS = new Set(['g4-migration', 'g5-authoring']);
const TODO_REVISION_SCHEMAS = Object.freeze([
  'lattice.todo_revision.v1', 'lattice.todo_revision.v2',
]);
const PHASE_TODO_REVISION_SCHEMAS = Object.freeze([
  'lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2',
  'lattice.phase_todo_revision.v3', 'lattice.phase_todo_revision.v4',
  'lattice.phase_todo_revision.v5',
]);

export class TodoStoreError extends Error {
  constructor(code, reason, message = reason, detail = {}) {
    super(message);
    this.name = 'TodoStoreError';
    this.code = code;
    this.detail = { reason, ...detail };
  }
}

export function createTodoStoreWriter(options = {}) {
  if (!exactRecord(options, ['caller']) || !WRITER_CALLERS.has(options.caller)) {
    throw new TypeError('todo store writer caller must be g4-migration or g5-authoring');
  }
  return Object.freeze({ schema: 'lattice.todo_store_writer.v1', caller: options.caller });
}

function fail(code, reason, detail) {
  throw new TodoStoreError(code, reason, reason, detail);
}

// No Store yet is an empty project, not a broken one (same classification as `status`): never invite repair or deletion.
function failUninitialized() {
  fail('STORE_UNINITIALIZED', 'store_uninitialized', {
    ref: STORE_ROOT_REF, next_action: 'lattice plan create --template --json',
  });
}

/** Absent manifest: uninitialized when no Store exists yet; a Store without its manifest stays STORE_INCONSISTENT. */
async function failManifestMissing(repoRoot) {
  if (await isUninitializedTodoStore({ repoRoot })) failUninitialized();
  fail('STORE_INCONSISTENT', 'artifact_missing', { ref: MANIFEST_REF });
}

async function readManifest(repoRoot) {
  const manifest = await readArtifact(repoRoot, MANIFEST_REF, {
    code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest, missing: true,
  });
  return manifest ?? failManifestMissing(repoRoot);
}

const upgradeAction = (what) => `${what} was written by a newer Lattice than ${packageJson.version}. The record is`
  + ` not corrupt: do not repair or delete it. Upgrade Lattice on this host to a version newer than`
  + ` ${packageJson.version}, then run the command again.`;

function rejectUnsupportedRevisionSchema(value, { family, supportedSchemas }) {
  const schema = value?.schema;
  if (typeof schema === 'string'
    && new RegExp(`^lattice\\.${family}\\.v[1-9]\\d*$`, 'u').test(schema)
    && !supportedSchemas.includes(schema)) {
    fail('UNSUPPORTED_SCHEMA', 'unsupported_revision_schema', {
      schema, supported_schemas: [...supportedSchemas], next_action: upgradeAction(`Schema ${schema}`),
    });
  }
}

// Reader registration (newer-value-says-upgrade): the newest schema of each Store record family this
// reader knows. Bump it in the same diff that teaches the validator a new version.
export const NEWEST_KNOWN_TODO_SCHEMA = Object.freeze({ todo_event: 4, todo_plan: 8, todo_manifest: 2, todo_notice_acks: 2, todo_notice_waits: 1 });
const NEWER_SCHEMA_FAMILY = new Map([[validateTodoPlan, 'todo_plan'], [validateTodoManifest, 'todo_manifest']]);
const vocabularyWord = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value);

function newerSchema(value, family) {
  const match = typeof value?.schema === 'string' ? value.schema.match(/^lattice\.([a-z_]+)\.v([1-9]\d{0,5})$/u) : null;
  return match !== null && match[1] === family && Number(match[2]) > NEWEST_KNOWN_TODO_SCHEMA[family]
    ? { pointer: '/schema', value: value.schema } : null;
}

// An event this reader cannot validate is "newer", not corrupt, when it names a higher event schema, or
// when it is intact (its own digest matches: the bytes are what a writer wrote) and names an event kind
// or coordination mode this reader does not know. Everything else stays STORE_CORRUPT.
function newerEventValue(event) {
  const schema = newerSchema(event, 'todo_event');
  if (schema !== null) return schema;
  let intact = false;
  try { intact = isTodoDigest(event?.event_digest) && event.event_digest === todoSelfDigest(event, 'event_digest'); } catch { /* not intact */ }
  if (!intact) return null;
  if (vocabularyWord(event.kind) && !TODO_EVENT_KINDS.includes(event.kind)) return { pointer: '/kind', value: event.kind };
  const mode = event.kind === 'coordination_mode' ? event.payload?.mode : undefined;
  return vocabularyWord(mode) && !TODO_COORDINATION_MODES.includes(mode) ? { pointer: '/payload/mode', value: mode } : null;
}

function failNewer({ pointer, value }, ref) {
  fail('UNSUPPORTED_SCHEMA', 'newer_lattice_value', {
    ...(ref === null ? {} : { ref }), pointer, value, reader_version: packageJson.version,
    required_version: `>${packageJson.version}`,
    next_action: upgradeAction(`The value '${value}' at ${pointer}${ref === null ? '' : ` in ${ref}`}`),
  });
}

/** Side records outside the lifecycle (the notice ack set) use the same upgrade refusal. */
export function rejectNewerTodoSchema(value, family, ref) {
  const newer = newerSchema(value, family);
  if (newer !== null) failNewer(newer, ref);
}

function requireWriter(writer, caller) {
  if (!exactRecord(writer, ['schema', 'caller']) || writer.schema !== 'lattice.todo_store_writer.v1'
    || writer.caller !== caller) throw new TypeError(`writer capability for ${caller} required`);
}

function canonicalLine(value) {
  return Buffer.from(`${canonicalizeTodoArtifact(value)}\n`, 'utf8');
}

async function pathState(repoRoot, ref, classification, { missing = false } = {}) {
  let canonicalRepoRoot;
  try { canonicalRepoRoot = await realpath(repoRoot); } catch { canonicalRepoRoot = path.resolve(repoRoot); }
  const absolute = path.resolve(canonicalRepoRoot, ref);
  const root = path.resolve(canonicalRepoRoot, STORE_ROOT_REF);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    fail(classification, 'path_outside_store', { ref });
  }
  let stats;
  try { stats = await lstat(absolute); } catch (error) {
    if (missing && error?.code === 'ENOENT') return null;
    fail(classification, 'artifact_missing', { ref });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) fail(classification, 'unsafe_artifact_path', { ref });
  const resolved = await realpath(absolute);
  if (resolved !== absolute) fail(classification, 'path_alias_or_escape', { ref });
  return { absolute, stats };
}

function decodeUtf8(bytes, code, reason) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(code, reason); }
}

function parseCanonicalJsonLine(bytes, { code, reason, maxBytes, validate, ref = null }) {
  const detail = ref === null ? undefined : { ref };
  if (bytes.length === 0 || bytes.length > maxBytes) {
    fail(code, bytes.length > maxBytes ? 'size_limit_exceeded' : reason, detail);
  }
  const text = decodeUtf8(bytes, code, 'invalid_utf8');
  if (text.startsWith('\uFEFF')) fail(code, reason, detail);
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let value;
  try { value = JSON.parse(body); } catch { fail(code, reason, detail); }
  if (!text.endsWith('\n')) fail(code, reason, detail);
  let expected;
  try { expected = `${canonicalizeTodoArtifact(value)}\n`; } catch { fail(code, reason, detail); }
  if (text !== expected) fail(code, 'non_canonical_or_duplicate_key', detail);
  if (!validate(value)) {
    const newer = NEWER_SCHEMA_FAMILY.has(validate) ? newerSchema(value, NEWER_SCHEMA_FAMILY.get(validate)) : null;
    if (newer !== null) failNewer(newer, ref);
    fail(code, 'schema_invalid', detail);
  }
  return value;
}

async function readArtifact(repoRoot, ref, { code, maxBytes, validate, missing = false }) {
  const state = await pathState(repoRoot, ref, code, { missing });
  if (state === null) return null;
  const bytes = normalizeCheckoutEol(await readFile(state.absolute));
  return parseCanonicalJsonLine(bytes, {
    code, reason: 'artifact_truncated_or_trailing_bytes', maxBytes, validate, ref,
  });
}

async function readSnapshotArtifact(repoRoot, ref) {
  const state = await pathState(repoRoot, ref, 'STORE_INCONSISTENT', { missing: true });
  if (state === null) return null;
  const bytes = normalizeCheckoutEol(await readFile(state.absolute));
  return parseCanonicalJsonLine(bytes, {
    code: 'SNAPSHOT_INVALID', reason: 'snapshot_truncated_or_trailing_bytes',
    maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoSnapshot, ref,
  });
}

function parseJournalSegment(bytes, ref = null) {
  const detail = ref === null ? undefined : { ref };
  if (bytes.length === 0 || bytes.length > TODO_LIMITS.journalSegmentBytes) {
    fail('STORE_CORRUPT', bytes.length > TODO_LIMITS.journalSegmentBytes
      ? 'journal_segment_limit_exceeded' : 'journal_empty', detail);
  }
  const text = decodeUtf8(bytes, 'STORE_CORRUPT', 'journal_invalid_utf8');
  if (!text.endsWith('\n') || text.startsWith('\uFEFF')) fail('STORE_CORRUPT', 'journal_byte_contract', detail);
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) fail('STORE_CORRUPT', 'journal_truncated_or_empty_line');
  return lines.map((line) => {
    let event;
    try { event = JSON.parse(line); } catch { fail('STORE_CORRUPT', 'journal_json_invalid'); }
    let canonical;
    try { canonical = canonicalizeTodoArtifact(event); } catch { fail('STORE_CORRUPT', 'journal_schema_invalid'); }
    if (line !== canonical) fail('STORE_CORRUPT', 'journal_non_canonical_or_duplicate_key');
    if (!validateTodoEvent(event)) {
      const newer = newerEventValue(event);
      if (newer !== null) failNewer(newer, ref);
      fail('STORE_CORRUPT', 'journal_schema_invalid');
    }
    return event;
  });
}

async function readJournal(repoRoot, journalRef) {
  const state = await pathState(repoRoot, journalRef, 'STORE_CORRUPT');
  const directory = path.dirname(state.absolute);
  const sealedDirectory = path.join(directory, 'sealed');
  const segments = [];
  try {
    const sealedStats = await lstat(sealedDirectory);
    if (sealedStats.isSymbolicLink() || !sealedStats.isDirectory()) fail('STORE_CORRUPT', 'unsafe_sealed_directory');
    const names = (await readdir(sealedDirectory)).sort();
    for (const name of names) {
      if (!/^\d{12}-\d{12}-[0-9a-f]{64}-[0-9a-f]{64}\.jsonl$/u.test(name)) {
        fail('STORE_CORRUPT', 'sealed_segment_name_invalid', { name });
      }
      const ref = path.posix.join(path.posix.dirname(journalRef), 'sealed', name);
      const sealed = await pathState(repoRoot, ref, 'STORE_CORRUPT');
      const bytes = normalizeCheckoutEol(await readFile(sealed.absolute));
      const [, startText, endText, previousDigest, segmentDigest] = name.match(
        /^(\d{12})-(\d{12})-([0-9a-f]{64})-([0-9a-f]{64})\.jsonl$/u,
      );
      const events = parseJournalSegment(bytes, ref);
      if (sha256Bytes(bytes) !== segmentDigest) fail('STORE_CORRUPT', 'sealed_segment_digest_mismatch');
      if (events[0].sequence !== Number(startText) || events.at(-1).sequence !== Number(endText)) {
        fail('STORE_CORRUPT', 'sealed_segment_range_mismatch');
      }
      if (previousDigest !== (segments.at(-1)?.events.at(-1).event_digest ?? '0'.repeat(64))) {
        fail('STORE_CORRUPT', 'sealed_segment_link_mismatch');
      }
      segments.push({ ref, bytes, events });
    }
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code !== 'ENOENT') fail('STORE_CORRUPT', 'sealed_segment_read_failed');
  }
  const activeBytes = normalizeCheckoutEol(await readFile(state.absolute));
  const duplicateActive = segments.at(-1)?.bytes.equals(activeBytes) === true;
  if (!duplicateActive) {
    segments.push({ ref: journalRef, bytes: activeBytes, events: parseJournalSegment(activeBytes, journalRef) });
  }
  const events = segments.flatMap(({ events: entries }) => entries);
  const failures = verifyLinearHashChain({
    entries: events,
    canonicalize: canonicalizeTodoArtifact,
    digestField: 'event_digest',
    genesisPrevious: events[0]?.previous_digest ?? null,
  });
  if (failures.size > 0) fail('STORE_CORRUPT', [...failures].sort()[0], { failed_conditions: [...failures].sort() });
  if (events[0]?.kind !== 'plan_genesis' || events.slice(1).some(({ kind }) => kind === 'plan_genesis')) {
    fail('STORE_CORRUPT', 'genesis_missing_or_repeated');
  }
  const successorSchema = events[0].schema === 'lattice.todo_event.v2';
  const phaseSchema = ['lattice.todo_event.v3', 'lattice.todo_event.v4'].includes(events[0].schema);
  const phaseRevisionSchema = events[0].schema === 'lattice.todo_event.v4';
  const phaseTail = (event) => event.schema === 'lattice.todo_event.v3';
  const legacyTail = (event) => event.schema === 'lattice.todo_event.v1';
  // ADR 0147: genesisがv1/v2(phase無しplan)でも、暗黙のterminal-audit Phaseへの
  // phase_review/phase_accept/phase_reject/phase_reopen/phase_close_unaudited(ADR 0148)だけは
  // v3 tail eventとして混在を許す。task側のevent(start/done/block/unblock/reopen)は従来どおりv1のまま
  // ——既存planの既存event bytesは1つも変わらない。新しく増えるのは、これまで
  // phase無しplanには存在し得なかったphase_*event kindの受け皿だけである。
  const implicitTerminalAuditTail = (event) => phaseTail(event)
    && ['phase_review', 'phase_accept', 'phase_reject', 'phase_reopen', 'phase_close_unaudited']
      .includes(event.kind);
  const legacyOrImplicitPhaseTail = (event) => legacyTail(event) || implicitTerminalAuditTail(event);
  if ((phaseSchema && events.some(({ schema }, index) => index === 0
    ? !['lattice.todo_event.v3', 'lattice.todo_event.v4'].includes(schema) : !phaseTail(events[index])))
    || (!phaseSchema && events.slice(1).some((event) => !legacyOrImplicitPhaseTail(event)))
    || (!phaseSchema && !successorSchema && events.some((event, index) => index === 0
      ? event.schema !== 'lattice.todo_event.v1' : !legacyOrImplicitPhaseTail(event)))) {
    fail('STORE_CORRUPT', 'journal_schema_sequence_invalid');
  }
  return { segments, events, activeBytes: duplicateActive ? Buffer.alloc(0) : activeBytes };
}

/**
 * planへ帰属するeventを積む、lifecycle journalとは別のchain（ob03）。
 *
 * 同じ`journal/active.jsonl`へ混ぜない。旧CLIの`validateTodoEvent`は`TODO_EVENT_KINDS`を
 * exactで見るので、未知kindが1件混ざるとその**plan全体**が`STORE_CORRUPT`になる。journalは
 * `todo status`の正本なので、混ぜると旧CLIから工程が読めなくなり、版を戻してもstoreは戻らない。
 *
 * 旧CLIの`readJournal`は`journal/active.jsonl`と`journal/sealed/*`を名指しで開くだけで、
 * `journal/`自体をreaddirしない。version dir配下のfile一覧を厳密検査する経路も無い
 * （`independence.json`が同じ性質で既に出荷されている・ADR 0127 Decision 1）。したがって
 * 兄弟fileを置いても旧CLIは存在に気づかず、互換もrollbackも保たれる。
 */
function planScopedJournalRef(journalRef) {
  return path.posix.join(path.posix.dirname(journalRef), 'plan-scoped.jsonl');
}

/**
 * plan-scoped chainを読む。記録が無ければ空（「まだ何も宣言していない」）。
 *
 * lifecycle journalと違いgenesisを持たない——planの存在はjournalが証明しており、この
 * chainはそこへ後から積まれる宣言だけを持つ。壊れている記録はnullや空へ丸めずtyped failにする。
 */
async function readPlanScopedJournal(repoRoot, journalRef) {
  const ref = planScopedJournalRef(journalRef);
  const absolute = path.resolve(repoRoot, ref);
  let bytes;
  try {
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isFile()) fail('STORE_CORRUPT', 'plan_scoped_journal_unsafe');
    bytes = normalizeCheckoutEol(await readFile(absolute));
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return { ref, events: [], activeBytes: Buffer.alloc(0) };
    fail('STORE_CORRUPT', 'plan_scoped_journal_read_failed');
  }
  const events = parseJournalSegment(bytes, ref);
  if (!events.every(({ kind }) => TODO_PLAN_SCOPED_EVENT_KINDS.includes(kind))) {
    fail('STORE_CORRUPT', 'plan_scoped_journal_kind_invalid');
  }
  const failures = verifyLinearHashChain({
    entries: events,
    canonicalize: canonicalizeTodoArtifact,
    digestField: 'event_digest',
    genesisPrevious: null,
  });
  if (failures.size > 0) {
    fail('STORE_CORRUPT', [...failures].sort()[0], { failed_conditions: [...failures].sort() });
  }
  return { ref, events, activeBytes: bytes };
}

function taskState(taskId) {
  return { task_id: taskId, status: 'pending', started_at: null, done_at: null, blocked_reason: null,
    evidence: null, evidence_unverified: false, imported: false, test_result: null };
}

function emptyPhaseState(phaseId) {
  return { phase_id: phaseId, status: 'locked', review_event_digest: null,
    decision_event_digest: null, decision_evidence: null };
}

// phase無しplan(todo_plan.v1/v2/v3)の終端に暗黙で挿入する予約Phase(ADR 0147)。全taskが
// doneになっても、この暗黙Phaseのaccept(review→evidence束縛accept)が記録されるまでplanを
// 「閉じた」ことにさせない——既存のPhase gate機構(review/accept/evidence slot/journal event)を
// そのまま再利用し、新しい状態機械を増やさない(ADR 0147裁定2)。phase_idはtask/plan由来の識別子
// と衝突しない予約名として固定する。
export const TERMINAL_AUDIT_PHASE_ID = 'terminal-audit';

function terminalAuditPhase() {
  return { phase_id: TERMINAL_AUDIT_PHASE_ID, title: '終端重監査', gate_policy: 'terminal-audit',
    predecessor_phase_ids: [], required_evidence_slots: ['terminal-audit'] };
}

// v4/v5はplan.phasesをそのまま使う。phase無しplan(v1/v2/v3)は暗黙のterminal-audit Phase
// 1つだけを持つものとして扱う(所属taskは常にそのplanの全task)。derivedPhaseStatus・
// projectPhaseStates・replayのphase event検証が同じ一覧を見るよう、この関数だけに集約する。
function phasesOf(plan) {
  return isPhaselessTodoPlanSchema(plan.schema) ? [terminalAuditPhase()] : plan.phases;
}

// 終端監査Phaseの定義(required_evidence_slotsを含む)はterminalAuditPhase()の中だけに在り、
// store外からは読めなかった。todo-status側で再導出すると「終端監査が何を要求するか」の定義が
// 二重化するので、phasesOfをそのまま公開して定義の正本を1つに保つ。
// 返るのは呼び手が渡したplan自身のphases(またはその場で作る暗黙Phase)であり、新たな内部状態は
// 露出しない。
export function todoPhaseDefinitions(plan) {
  return phasesOf(plan);
}

/**
 * planの調整方式の宣言を投影する（ob03・オーナー裁定C①）。
 *
 * 最後の`coordination_mode` eventが現在の宣言で、1件も無ければ未宣言（null）である。
 * 未宣言は「witnessで行くと決めた」でも「会話で行くと決めた」でもなく、**まだ選んでいない**。
 * 「誰が選んだか」はeventのactorが持つ——witnessが全planの暗黙義務だった時に帰属が無く、
 * 正確な案内が素通りされたことへの是正なので、帰属を落とすとこの機構の意味が消える。
 *
 * 宣言はdispatchを変えない。未宣言でもready frontierは通常どおり出る（ADR 0160・ob04）。
 */
export function projectTodoCoordination(events) {
  const declaration = [...events].reverse()
    .find((event) => event.kind === 'coordination_mode');
  if (declaration === undefined) return null;
  return {
    mode: declaration.payload.mode,
    reason: declaration.payload.reason,
    declared_by: declaration.actor,
    declared_at: declaration.recorded_at,
    event_digest: declaration.event_digest,
  };
}

function derivedPhaseStatus(plan, taskStates, phaseStates, phaseId) {
  const state = phaseStates.get(phaseId);
  // ADR 0148: closed_unauditedも他の終端状態と同じく確定済みとして扱う。ここへ足さないと、
  // 全taskがdone(＝構造的にgate_ready)のままなので、以後の呼び出しで毎回gate_readyへ
  // 再導出されてしまい、記録した「監査なしで閉じた」がgantt折り畳み・phase_accept_dependencies
  // 判定の上で一瞬で消える。
  if (['reviewing', 'accepted', 'rejected', 'closed_unaudited'].includes(state.status)) return state.status;
  const phase = phasesOf(plan).find((entry) => entry.phase_id === phaseId);
  if (!phase.predecessor_phase_ids.every((id) => phaseStates.get(id)?.status === 'accepted')) return 'locked';
  // 暗黙のterminal-audit Phaseはtask側にphase_idフィールドが無い(v1/v2/v3にはそもそも
  // 存在しない)ため、所属taskをフィルタで絞らずplan全taskとして扱う。
  const tasks = phaseId === TERMINAL_AUDIT_PHASE_ID && isPhaselessTodoPlanSchema(plan.schema)
    ? plan.tasks : plan.tasks.filter((entry) => entry.phase_id === phaseId);
  // retiredは「実行されないまま閉じた」工程であり、Phase完了の妨げにしない（全taskがretiredのPhaseも閉じられる）
  return tasks.every((entry) => ['done', 'retired'].includes(taskStates.get(entry.task_id)?.status)) ? 'gate_ready' : 'active';
}

function projectPhaseStates(plan, events, taskStates) {
  const phases = phasesOf(plan);
  const states = new Map(phases.map(({ phase_id }) => [phase_id, emptyPhaseState(phase_id)]));
  for (const event of events) {
    if (event.schema === 'lattice.todo_event.v4') {
      for (const migration of event.phase_state_migration) {
        if (migration.state_policy === 'carry') {
          Object.assign(states.get(migration.phase_id), structuredClone(migration.state));
        }
      }
    } else if (event.kind === 'phase_review') {
      const state = states.get(event.phase_id);
      state.status = 'reviewing'; state.review_event_digest = event.event_digest;
      state.decision_event_digest = null; state.decision_evidence = null;
    } else if (event.kind === 'phase_accept') {
      const state = states.get(event.phase_id);
      state.status = 'accepted'; state.decision_event_digest = event.event_digest;
      state.decision_evidence = event.payload.decision_evidence;
    } else if (event.kind === 'phase_reject') {
      const state = states.get(event.phase_id);
      state.status = 'rejected'; state.decision_event_digest = event.event_digest;
      state.decision_evidence = event.payload.decision_evidence;
    } else if (event.kind === 'phase_close_unaudited') {
      // ADR 0148: 監査していないので証拠(decision_evidence)は残さない。理由はevent payload
      // 自身(decision_event_digestで指せるこの event)に記録済みで、accept/rejectと違い
      // ここに複製しない。
      const state = states.get(event.phase_id);
      state.status = 'closed_unaudited'; state.decision_event_digest = event.event_digest;
      state.decision_evidence = null;
    } else if (event.kind === 'phase_reopen') {
      Object.assign(states.get(event.phase_id), emptyPhaseState(event.phase_id));
    }
  }
  for (const phase of phases) {
    const state = states.get(phase.phase_id);
    state.status = derivedPhaseStatus(plan, taskStates, states, phase.phase_id);
  }
  return [...states.values()].sort((left, right) => left.phase_id.localeCompare(right.phase_id));
}

function localPredecessors(plan, taskId) {
  const result = [];
  for (const edge of plan.hard_dependencies) {
    if (edge.to.project_id === plan.project_id && edge.to.plan_key === plan.plan_key && edge.to.task_id === taskId
      && edge.from.project_id === plan.project_id && edge.from.plan_key === plan.plan_key) result.push(edge.from.task_id);
  }
  for (const join of plan.joins) {
    if (join.before.project_id === plan.project_id && join.before.plan_key === plan.plan_key && join.before.task_id === taskId) {
      for (const after of join.after) if (after.project_id === plan.project_id && after.plan_key === plan.plan_key) result.push(after.task_id);
    }
  }
  return [...new Set(result)];
}

function localSuccessors(plan, taskId) {
  return plan.tasks.map(({ task_id }) => task_id).filter((candidate) => localPredecessors(plan, candidate).includes(taskId));
}

const CARRY_STATE_POLICIES = ['carry', 'carry_reconciled_metadata', 'acquire_phase'];

/**
 * retract-anyone (A3, Ludmila 2026-11-12): the digest of the event that last made the task in-progress, or null.
 * One rule for replay and resolveTodoStartRetractionBinding. A revision genesis carrying the task open binds it.
 */
function stepStartBinding(binding, event, taskId) {
  if (event.kind === 'plan_genesis') {
    return (event.state_migration ?? []).some((migration) => CARRY_STATE_POLICIES.includes(migration.state_policy)
      && migration.to_task_id === taskId && ['in-progress', 'blocked'].includes(migration.state?.status))
      ? event.event_digest : binding;
  }
  if (event.task_id !== taskId) return binding;
  if (event.kind === 'start' || (event.kind === 'reopen' && event.payload.to_status === undefined)) return event.event_digest;
  if (['done', 'retire', 'start_retracted', 'reopen'].includes(event.kind)) return null;
  return binding;
}

function replay(plan, events, { verifyEvidence, verifyImportSource } = {}) {
  const states = new Map(plan.tasks.map(({ task_id }) => [task_id, taskState(task_id)]));
  const phaseStates = new Map(phasesOf(plan).map(({ phase_id }) => [phase_id, emptyPhaseState(phase_id)]));
  const doneDigest = new Map();
  const completion = new Map();
  const authoredStartBindings = new Map();
  // retract-anyone (B2): tasks reopened to unstarted; their start skips only the v4 own-phase check.
  const reopenedPending = new Set();
  const bind = (event, taskId = event.task_id) => {
    const next = stepStartBinding(authoredStartBindings.get(taskId) ?? null, event, taskId);
    if (next === null) authoredStartBindings.delete(taskId); else authoredStartBindings.set(taskId, next);
  };
  // hard証拠検証は即時でなくreplay完了後、まだ現在状態を支えている記述子だけへ行う。
  // reopen・再doneで差し替えられた古いdoneが指すblobは一度もcommitされないままGCで消え得るし、
  // 履歴の完全性はevent_digest鎖が既に持つ。即時検証だと消えたblobを指す過去eventが
  // storeを恒久的に書き込み不能へ落とす（2026-08-22実被弾: reopen済み旧doneのdangling blob）。
  const pendingVerifications = new Map();
  const importedGenesis = events[0]?.payload.historical_import === true;
  for (const event of events) {
    if (event.project_id !== plan.project_id || event.plan_key !== plan.plan_key || event.plan_version !== plan.plan_version) {
      fail('STORE_CORRUPT', 'journal_identity_mismatch');
    }
    if (!isStrictTodoTimestamp(event.recorded_at)) fail('STORE_CORRUPT', 'timestamp_invalid');
    // u03 A4/A5: order is the sequence + hash chain; recorded_at is a shown fact, never an integrity key.
    if (event.kind === 'plan_genesis') {
      if (event.payload.plan_digest !== plan.plan_digest || event.payload.topology_digest !== plan.topology_digest
        || event.payload.predecessor_plan_digest !== plan.predecessor_plan_digest) {
        fail('STORE_INCONSISTENT', 'genesis_plan_binding_mismatch');
      }
      if (['lattice.todo_event.v2', 'lattice.todo_event.v4'].includes(event.schema)) {
        const projected = event.state_migration.map(({ from_task_id, to_task_id }) => ({
          from_task_id, to_task_id,
        }));
        if (canonicalizeTodoArtifact(projected) !== canonicalizeTodoArtifact(event.payload.task_migration)) {
          fail('STORE_INCONSISTENT', 'genesis_migration_projection_mismatch');
        }
        const activeTargets = event.state_migration
          .filter(({ to_task_id }) => to_task_id !== 'removed').map(({ to_task_id }) => to_task_id);
        if (new Set(activeTargets).size !== activeTargets.length
          || activeTargets.some((taskId) => !states.has(taskId))) {
          fail('STORE_INCONSISTENT', 'genesis_migration_target_invalid');
        }
        for (const migration of event.state_migration) {
          // acquire_phaseもcarry系(状態を完全に持ち越す)。ADR 0147裁定4のPhase獲得はdoneを
          // 保つことが目的であり、ここで除外するとreplayが状態を復元しない。
          if (!CARRY_STATE_POLICIES.includes(migration.state_policy)) continue;
          const state = states.get(migration.to_task_id);
          Object.assign(state, structuredClone(migration.state), { evidence_unverified: false });
          if (state.evidence !== null) {
            const evidence = state.evidence;
            const context = { plan_key: plan.plan_key, task_id: migration.to_task_id,
              event_digest: event.event_digest };
            // importedは完了の来歴であって現在のdescriptor型ではない。promotion後の
            // imported doneは通常evidenceを持つため、descriptor自身から検証器を選ぶ。
            if (validateTodoImportSource(evidence)) {
              if (verifyImportSource) {
                pendingVerifications.set(`task:${migration.to_task_id}`, () => verifyImportSource(evidence, context));
              }
            } else if (verifyEvidence) {
              pendingVerifications.set(`task:${migration.to_task_id}`, () => verifyEvidence(evidence, context));
            }
          }
          if (state.status === 'done') {
            doneDigest.set(migration.to_task_id, event.event_digest);
            completion.set(migration.to_task_id, state.imported
              ? { mode: 'historical_import', completed_at: state.done_at ?? 'unknown_requires_evidence' }
              : { mode: 'authored', completed_at: state.done_at });
          }
        }
        if (event.schema === 'lattice.todo_event.v4') {
          for (const migration of event.phase_state_migration) {
            if (migration.state_policy === 'carry') {
              Object.assign(phaseStates.get(migration.phase_id), structuredClone(migration.state));
            }
          }
        }
        for (const taskId of states.keys()) bind(event, taskId);
      }
      continue;
    }
    // planへ帰属するkindは別chain(plan-scoped.jsonl)へ積むので、通常はここへ来ない。
    // 来た場合(旧形式のstoreや将来の移行)でもtask状態へ触れさせない——下の
    // states.get(event.task_id)がnullを引いてevent_task_missingで落ちるのを防ぐ。
    if (TODO_PLAN_SCOPED_EVENT_KINDS.includes(event.kind)) continue;
    if (event.kind.startsWith('phase_')) {
      // phaseStatesはphasesOf(plan)から作られる(v4/v5なら実Phase、それ以外なら暗黙の
      // terminal-audit Phaseだけ)。`has`判定だけで両方の場合を賄えるので、schemaでの
      // 事前分岐は不要——phase無しplanは予約phase_id以外を宣言していないため、任意の
      // phase_idを名乗るevent_phase_missingでの拒否は従来どおり効く。
      if (!phaseStates.has(event.phase_id)) {
        fail('STORE_INCONSISTENT', 'event_phase_missing');
      }
      const state = phaseStates.get(event.phase_id);
      const currentStatus = derivedPhaseStatus(plan, states, phaseStates, event.phase_id);
      if (event.kind === 'phase_review') {
        if (currentStatus !== 'gate_ready') fail('STORE_INCONSISTENT', 'phase_gate_not_ready');
        state.status = 'reviewing'; state.review_event_digest = event.event_digest;
        state.decision_event_digest = null; state.decision_evidence = null;
        pendingVerifications.delete(`phase:${event.phase_id}`);
      } else if (event.kind === 'phase_accept') {
        const phase = phasesOf(plan).find(({ phase_id }) => phase_id === event.phase_id);
        const slots = event.payload.evidence_slots.map(({ slot_id }) => slot_id);
        if (currentStatus !== 'reviewing' || state.review_event_digest !== event.payload.review_event_digest
          || canonicalizeTodoArtifact(slots) !== canonicalizeTodoArtifact(phase.required_evidence_slots)) {
          fail('STORE_INCONSISTENT', 'phase_accept_binding_invalid');
        }
        if (verifyEvidence) {
          const decisionEvidence = event.payload.decision_evidence;
          const slotEvidence = event.payload.evidence_slots.map((slot) => slot.evidence);
          pendingVerifications.set(`phase:${event.phase_id}`, () => {
            const context = { plan_key: plan.plan_key, phase_id: event.phase_id,
              event_digest: event.event_digest };
            verifyEvidence(decisionEvidence, context);
            for (const evidence of slotEvidence) verifyEvidence(evidence, context);
          });
        }
        state.status = 'accepted'; state.decision_event_digest = event.event_digest;
        state.decision_evidence = event.payload.decision_evidence;
      } else if (event.kind === 'phase_reject') {
        if (currentStatus !== 'reviewing' || state.review_event_digest !== event.payload.review_event_digest) {
          fail('STORE_INCONSISTENT', 'phase_reject_binding_invalid');
        }
        if (verifyEvidence) {
          const decisionEvidence = event.payload.decision_evidence;
          pendingVerifications.set(`phase:${event.phase_id}`, () => verifyEvidence(decisionEvidence, {
            plan_key: plan.plan_key, phase_id: event.phase_id, event_digest: event.event_digest,
          }));
        }
        state.status = 'rejected'; state.decision_event_digest = event.event_digest;
        state.decision_evidence = event.payload.decision_evidence;
      } else if (event.kind === 'phase_close_unaudited') {
        // ADR 0148裁定3: reviewと同じ前提(gate_ready)を課す——所属ToDoが全てdoneでない段階では
        // まだ監査の地点に到達していないので、監査なしで閉じることもできない。
        if (currentStatus !== 'gate_ready') fail('STORE_INCONSISTENT', 'phase_gate_not_ready');
        state.status = 'closed_unaudited'; state.decision_event_digest = event.event_digest;
        state.decision_evidence = null;
        pendingVerifications.delete(`phase:${event.phase_id}`);
      } else {
        // phase_reopen。ADR 0148裁定5: closed_unauditedもaccepted/rejectedと同じく
        // reopenで初期状態へ戻せる——監査せずに閉じた工程を、後から本当に監査したくなった時に
        // 永久に締め出さない。
        if (!['accepted', 'rejected', 'closed_unaudited'].includes(currentStatus)
          || state.decision_event_digest !== event.payload.target_decision_digest) {
          fail('STORE_INCONSISTENT', 'phase_reopen_binding_invalid');
        }
        // phase無しplanの暗黙Phaseは唯一のPhaseであり、他Phaseの前提にも
        // phase_accept_dependenciesにもなり得ない(v1/v2/v3にはそのフィールド自体が無い)ため、
        // successorStartedは常にfalseでよい。v4/v5の既存判定には一切手を入れない。
        const successorStarted = currentStatus === 'accepted' && !isPhaselessTodoPlanSchema(plan.schema)
          && (plan.schema === 'lattice.todo_plan.v4'
            ? plan.phases.some((phase) => phase.predecessor_phase_ids.includes(event.phase_id)
              && (phaseStates.get(phase.phase_id).status !== 'locked'
                || plan.tasks.some((task) => task.phase_id === phase.phase_id
                  && states.get(task.task_id).status !== 'pending')))
            : plan.phases.some((phase) => phase.predecessor_phase_ids.includes(event.phase_id)
                && phaseStates.get(phase.phase_id).status !== 'locked')
              || plan.phase_accept_dependencies.some((edge) => edge.from.project_id === plan.project_id
                && edge.from.plan_key === plan.plan_key && edge.from.phase_id === event.phase_id
                && edge.to.project_id === plan.project_id && edge.to.plan_key === plan.plan_key
                && states.get(edge.to.task_id)?.status !== 'pending'));
        if (successorStarted && event.payload.override_reason === null) {
          fail('STORE_INCONSISTENT', 'phase_reopen_has_started_successor');
        }
        Object.assign(state, emptyPhaseState(event.phase_id));
        pendingVerifications.delete(`phase:${event.phase_id}`);
      }
      continue;
    }
    const state = states.get(event.task_id);
    if (state === undefined) fail('STORE_INCONSISTENT', 'event_task_missing');
    const dependenciesDone = localPredecessors(plan, event.task_id)
      .every((id) => isFinishedTodoTaskState(states.get(id)));
    if (event.kind === 'start') {
      if (event.payload.start_mode === 'rebind') {
        // 改訂でcarryされたin-progressの再束縛。状態・開始時刻は動かさず、start束縛だけを
        // 現actor・現plan_versionのeventへ更新する（ADR 0191）
        if (state.status !== 'in-progress') {
          fail('STORE_INCONSISTENT', 'invalid_rebind_start_transition');
        }
        bind(event);
        continue;
      }
      if (event.payload.start_mode === 'historical_import') {
        if (!importedGenesis || state.status !== 'pending') {
          fail('STORE_INCONSISTENT', 'invalid_historical_import_start_transition');
        }
        if (verifyImportSource) {
          const evidence = event.payload.evidence;
          pendingVerifications.set(`task:${event.task_id}`, () => verifyImportSource(evidence, {
            plan_key: plan.plan_key, task_id: event.task_id, event_digest: event.event_digest,
          }));
        }
        state.status = 'in-progress';
        state.started_at = event.payload.started_at === 'unknown_requires_evidence'
          ? null : event.payload.started_at;
        state.evidence = event.payload.evidence;
        state.imported = true;
      } else {
        // B2: a task reopened to unstarted is redone inside its (possibly decided) phase, as the old reopen allowed.
        const phaseStatus = plan.schema === 'lattice.todo_plan.v4' && !reopenedPending.has(event.task_id)
          ? derivedPhaseStatus(plan, states, phaseStates,
            plan.tasks.find(({ task_id }) => task_id === event.task_id).phase_id) : 'active';
        if (state.status !== 'pending' || phaseStatus !== 'active'
          || (!dependenciesDone && event.payload.override_reason === null)) {
          fail('STORE_INCONSISTENT', 'invalid_start_transition');
        }
        state.status = 'in-progress'; state.started_at = event.recorded_at;
      }
      bind(event);
      stepTodoReopenedPending(reopenedPending, event);
    } else if (event.kind === 'start_retracted') {
      // A1-A3: any seat retracts; the target must be the event that last made the task in-progress.
      const binding = authoredStartBindings.get(event.task_id);
      if (state.status !== 'in-progress') {
        fail('START_RETRACTION_INVALID', 'start_retraction_requires_in_progress', {
          task_id: event.task_id, status: state.status,
        });
      }
      if (binding === undefined || binding !== event.payload.target_start_digest) {
        fail('START_RETRACTION_INVALID', 'authored_start_binding_missing', {
          task_id: event.task_id,
        });
      }
      Object.assign(state, taskState(event.task_id));
      // A2: a retracted historical_import start no longer holds its import source.
      pendingVerifications.delete(`task:${event.task_id}`);
      bind(event);
    } else if (event.kind === 'block') {
      if (state.status !== 'in-progress') fail('STORE_INCONSISTENT', 'invalid_block_transition');
      state.status = 'blocked'; state.blocked_reason = event.payload.reason;
    } else if (event.kind === 'unblock') {
      if (state.status !== 'blocked') fail('STORE_INCONSISTENT', 'invalid_unblock_transition');
      state.status = 'in-progress'; state.blocked_reason = null;
    } else if (event.kind === 'retire') {
      const priorStatus = event.payload.prior_status;
      if (priorStatus === undefined) {
        // legacy payload: pending/blocked only.
        if (!['pending', 'blocked'].includes(state.status)) fail('STORE_INCONSISTENT', 'invalid_retire_transition');
      } else {
        if (state.status === 'retired') fail('STORE_INCONSISTENT', 'invalid_retire_transition');
        if (priorStatus !== state.status) fail('STORE_INCONSISTENT', 'retire_prior_status_mismatch');
      }
      const wasDone = state.status === 'done';
      state.status = 'retired'; state.blocked_reason = event.payload.reason;
      state.done_at = wasDone ? state.done_at : null;
      // done_at and imported survive a retire from done so the finished mark stays (isFinishedTodoTaskState).
      state.evidence = null; state.test_result = null; state.imported = wasDone ? state.imported : false;
      state.evidence_unverified = false;
      bind(event);
      stepTodoReopenedPending(reopenedPending, event);
      if (wasDone) {
        completion.delete(event.task_id);
        pendingVerifications.delete(`task:${event.task_id}`);
      }
      // a retired task is unreachable by promotion/reopen (both require status done), so doneDigest is left as is.
    } else if (event.kind === 'done') {
      if (event.payload.done_mode === 'authored') {
        if (state.status !== 'in-progress' || !dependenciesDone) fail('STORE_INCONSISTENT', 'invalid_done_transition');
        if (verifyEvidence) {
          const evidence = event.payload.evidence;
          pendingVerifications.set(`task:${event.task_id}`, () => verifyEvidence(evidence, {
            plan_key: plan.plan_key, task_id: event.task_id, event_digest: event.event_digest,
          }));
        }
        state.status = 'done'; state.done_at = event.recorded_at; state.evidence = event.payload.evidence;
        state.test_result = event.payload.test_result ?? null;
        state.imported = false;
        completion.set(event.task_id, { mode: 'authored', completed_at: event.recorded_at });
      } else if (event.payload.done_mode === 'historical_import') {
        if (!importedGenesis || state.status !== 'pending') fail('STORE_INCONSISTENT', 'invalid_historical_import_transition');
        if (verifyImportSource) {
          const evidence = event.payload.evidence;
          pendingVerifications.set(`task:${event.task_id}`, () => verifyImportSource(evidence, {
            plan_key: plan.plan_key, task_id: event.task_id, event_digest: event.event_digest,
          }));
        }
        state.status = 'done'; state.done_at = event.payload.completed_at === 'unknown_requires_evidence'
          ? null : event.payload.completed_at;
        state.evidence = event.payload.evidence; state.imported = true;
        completion.set(event.task_id, { mode: 'historical_import', completed_at: event.payload.completed_at });
      } else {
        const current = completion.get(event.task_id);
        const expectedTarget = doneDigest.get(event.task_id) ?? null;
        if (state.status !== 'done' || current === undefined
          || state.imported !== event.payload.imported
          || expectedTarget !== event.payload.target_done_digest) {
          fail('STORE_INCONSISTENT', 'invalid_evidence_promotion', {
            task_id: event.task_id,
            status: state.status,
            current_completion_mode: current?.mode ?? null,
            current_imported: state.imported,
            requested_imported: event.payload.imported,
            expected_target_done_digest: expectedTarget,
            actual_target_done_digest: event.payload.target_done_digest,
            eligible_status: 'done',
            next_action: state.status === 'done'
              ? 'retry_against_latest_done_state' : 'complete_the_task_before_promoting_evidence',
          });
        }
        if (verifyEvidence) {
          const evidence = event.payload.evidence;
          pendingVerifications.set(`task:${event.task_id}`, () => verifyEvidence(evidence, {
            plan_key: plan.plan_key, task_id: event.task_id, event_digest: event.event_digest,
          }));
        }
        state.evidence = event.payload.evidence;
        completion.set(event.task_id, { mode: 'evidence_promotion', completed_at: current.completed_at });
      }
      doneDigest.set(event.task_id, event.event_digest);
      bind(event);
    } else if (event.kind === 'reopen') {
      if (state.status !== 'done' || doneDigest.get(event.task_id) !== event.payload.target_done_digest) {
        fail('STORE_INCONSISTENT', 'invalid_reopen_binding');
      }
      // u03 A15: reopening a task in an accepted/closed_unaudited phase is the user's change. The
      // phase decision stays as recorded; Plan shows it as acceptance_stale (derived from the journal).
      const startedSuccessor = localSuccessors(plan, event.task_id).some((id) => states.get(id).status !== 'pending');
      if (startedSuccessor && event.payload.override_reason === null) fail('STORE_INCONSISTENT', 'reopen_has_started_successor');
      if (event.payload.to_status === 'pending') {
        // B3: back to unstarted; doneDigest stays stale until the next done (unreachable while not done).
        Object.assign(state, taskState(event.task_id));
      } else {
        state.status = 'in-progress'; state.done_at = null; state.evidence = null; state.test_result = null;
      }
      completion.delete(event.task_id);
      pendingVerifications.delete(`task:${event.task_id}`);
      bind(event);
      stepTodoReopenedPending(reopenedPending, event);
    }
  }
  for (const verify of pendingVerifications.values()) verify();
  return [...states.values()].sort((left, right) => left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0);
}

/** retract-anyone (A3): the binding a retract targets, by the same rule replay uses; any seat may retract. */
export function resolveTodoStartRetractionBinding(store, { planKey, taskId }) {
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) fail('STORE_INCONSISTENT', 'plan_not_active');
  const canonicalTaskId = resolveCanonicalTaskId(member.plan, taskId);
  const task = member.tasks.find(({ task_id: candidate }) => candidate === canonicalTaskId);
  if (task === undefined) fail('STORE_INCONSISTENT', 'event_task_missing');
  if (task.status !== 'in-progress') {
    fail('START_RETRACTION_INVALID', 'start_retraction_requires_in_progress', {
      task_id: canonicalTaskId, status: task.status,
    });
  }
  const binding = member.journal.events.reduce((current, event) => stepStartBinding(current, event, canonicalTaskId), null);
  if (binding === null) fail('START_RETRACTION_INVALID', 'authored_start_binding_missing', { plan_key: planKey, task_id: canonicalTaskId });
  return { task_id: canonicalTaskId, activation_event_digest: binding };
}

function snapshotFor(plan, events, tasks) {
  const head = events.at(-1);
  // snapshot artifactの形式は変えない(store canonical形式の非目標)。既存on-disk snapshot
  // (phase無しplanはv1・`phases`キー無し)との canonical比較がここで外れると、全既存storeが
  // snapshot_staleになりforWrite(start/done/revise等)が丸ごとSTORE_WRITE_REFUSEDへ落ちる
  // ——ADR 0147以降の暗黙terminal-audit Phaseの状態は、この関数の外(readTodoStore/
  // appendTodoEventが返す`phases`という導出ビュー)で供給する。
  const phasePlan = isPhaseTodoPlanSchema(plan.schema);
  const resultAware = events.some((event) => event.kind === 'done'
    && typeof event.payload?.test_result === 'string')
    || events.some((event) => event.kind === 'plan_genesis'
      && event.state_migration?.some(({ state }) => typeof state?.test_result === 'string'));
  const snapshotTasks = resultAware ? tasks.map((task) => ({ ...task, test_result: task.test_result ?? null }))
    : tasks.map(({ test_result: _testResult, ...task }) => task);
  const snapshot = {
    schema: resultAware
      ? (phasePlan ? 'lattice.todo_snapshot.v4' : 'lattice.todo_snapshot.v3')
      : (phasePlan ? 'lattice.todo_snapshot.v2' : 'lattice.todo_snapshot.v1'),
    project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version,
    projection_version: resultAware ? (phasePlan ? 4 : 3) : (phasePlan ? 2 : 1),
    through_sequence: head.sequence,
    journal_head_digest: head.event_digest, tasks: snapshotTasks, snapshot_digest: '',
    ...(phasePlan ? { phases: projectPhaseStates(plan, events,
      new Map(tasks.map((task) => [task.task_id, task]))) } : {}),
  };
  snapshot.snapshot_digest = todoSelfDigest(snapshot, 'snapshot_digest');
  return snapshot;
}

/**
 * Validates the merged graph and returns cross-plan findings (u03 A24/A25b/N6): a reference into
 * another plan never refuses for a stale digest or a removed endpoint; a removed endpoint's edge
 * is left out of the graph. Same-plan shape and merged cycles still refuse.
 */
function validateMergedGraph(members, crossPlanDependencies = projectTodoCrossPlanDependencies(members),
  { newPlanKey = null } = {}) {
  const findings = [];
  const tasks = new Map();
  for (const member of members) for (const task of member.plan.tasks) {
    tasks.set(`${member.plan.project_id}\0${member.plan.plan_key}\0${task.task_id}`, member.plan.topology_digest);
  }
  const adjacency = new Map([...tasks.keys()].map((key) => [key, []]));
  const phases = new Map();
  for (const member of members) {
    if (!isDecoupledPhaseTodoPlanSchema(member.plan.schema)) continue;
    for (const phase of member.plan.phases) {
      const key = `phase\0${member.plan.project_id}\0${member.plan.plan_key}\0${phase.phase_id}`;
      phases.set(key, member.plan.topology_digest);
      adjacency.set(key, []);
    }
  }
  // Returns the node key, or null when a foreign endpoint is gone (the edge is then skipped).
  const bindIn = (nodes, key, ref, ownerPlan, eventDigest, side, danglingReason) => {
    const foreign = ref.project_id !== ownerPlan.project_id || ref.plan_key !== ownerPlan.plan_key;
    const topology = nodes.get(key);
    const finding = (reason) => findings.push({ owner_plan_key: ownerPlan.plan_key,
      event_digest: eventDigest, side, ref: structuredClone(ref), reason });
    // A plan being created is new input: it must name existing endpoints at their current topology.
    const strict = !foreign || ownerPlan.plan_key === newPlanKey;
    if (topology === undefined) {
      if (strict) fail('STORE_INCONSISTENT', danglingReason);
      finding('endpoint_missing');
      return null;
    }
    if (foreign && ref.expected_topology_digest === undefined) fail('STORE_INCONSISTENT', 'cross_plan_binding_missing');
    if (ref.expected_topology_digest !== undefined && topology !== ref.expected_topology_digest) {
      if (foreign && ownerPlan.plan_key === newPlanKey) fail('STORE_INCONSISTENT', 'binding_stale');
      finding('binding_stale');
    }
    return key;
  };
  const bind = (ref, ownerPlan, eventDigest = null, side = null) => bindIn(tasks,
    `${ref.project_id}\0${ref.plan_key}\0${ref.task_id}`, ref, ownerPlan, eventDigest, side, 'dangling_dependency');
  const bindPhase = (ref, ownerPlan) => bindIn(phases,
    `phase\0${ref.project_id}\0${ref.plan_key}\0${ref.phase_id}`, ref, ownerPlan, null, 'from',
    'dangling_phase_dependency');
  for (const { plan } of members) {
    for (const edge of plan.hard_dependencies) {
      const from = bind(edge.from, plan, null, 'from'); const to = bind(edge.to, plan, null, 'to');
      if (from === null || to === null) continue;
      if (from === to) fail('STORE_INCONSISTENT', 'self_edge');
      adjacency.get(from).push(to);
    }
    for (const join of plan.joins) {
      const before = bind(join.before, plan, null, 'to');
      for (const afterRef of join.after) {
        const after = bind(afterRef, plan, null, 'from');
        if (before === null || after === null) continue;
        if (after === before) fail('STORE_INCONSISTENT', 'join_self_edge');
        adjacency.get(after).push(before);
      }
    }
    if (isDecoupledPhaseTodoPlanSchema(plan.schema)) {
      for (const task of plan.tasks) {
        const taskKey = `${plan.project_id}\0${plan.plan_key}\0${task.task_id}`;
        const phaseKey = `phase\0${plan.project_id}\0${plan.plan_key}\0${task.phase_id}`;
        adjacency.get(taskKey).push(phaseKey);
      }
      for (const phase of plan.phases) {
        const to = `phase\0${plan.project_id}\0${plan.plan_key}\0${phase.phase_id}`;
        for (const predecessor of phase.predecessor_phase_ids) {
          adjacency.get(`phase\0${plan.project_id}\0${plan.plan_key}\0${predecessor}`).push(to);
        }
      }
      for (const edge of plan.phase_accept_dependencies) {
        const from = bindPhase(edge.from, plan); const to = bind(edge.to, plan, null, 'to');
        if (from !== null && to !== null) adjacency.get(from).push(to);
      }
    }
  }
  for (const dependency of crossPlanDependencies) {
    const owner = members.find(({ plan }) => plan.project_id === dependency.to.project_id
      && plan.plan_key === dependency.to.plan_key);
    if (owner === undefined) fail('STORE_INCONSISTENT', 'cross_plan_dependency_owner_missing');
    // xchart S2: a predecessor on another chart is Plan's node (read there); no finding, no adjacency here.
    if (dependency.from.project_id !== owner.plan.project_id) continue;
    const digest = dependency.event_digest ?? null;
    const from = bind(dependency.from, owner.plan, digest, 'from');
    const to = bind(dependency.to, owner.plan, digest, 'to');
    if (from === null || to === null) continue;
    if (from === to) fail('STORE_INCONSISTENT', 'self_edge');
    adjacency.get(from).push(to);
  }
  const colors = new Map();
  const stack = [];
  // a18: name the closed path (first node repeated last), not just that one exists.
  const nodeRef = (key) => {
    const parts = key.split('\0');
    return parts[0] === 'phase' ? { plan_key: parts[2], phase_id: parts[3] } : { plan_key: parts[1], task_id: parts[2] };
  };
  const visit = (node) => {
    if (colors.get(node) === 1) {
      fail('STORE_INCONSISTENT', 'merged_cycle', { cycle: [...stack.slice(stack.indexOf(node)), node].map(nodeRef) });
    }
    if (colors.get(node) === 2) return;
    colors.set(node, 1); stack.push(node);
    for (const next of adjacency.get(node)) visit(next);
    stack.pop(); colors.set(node, 2);
  };
  for (const node of adjacency.keys()) visit(node);
  // A join binds `before` once per member: keep one finding per identity, in code-unit order.
  const order = (finding) => JSON.stringify([finding.owner_plan_key, finding.event_digest ?? '',
    finding.side, finding.ref.plan_key, finding.ref.task_id ?? finding.ref.phase_id, finding.reason]);
  return [...new Map(findings.map((finding) => [canonicalizeTodoArtifact(finding), finding])).values()]
    .sort((left, right) => (order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0));
}

function crossPlanDependencyTask(store, ref) {
  const member = store.members.find(({ plan }) => plan.project_id === ref.project_id
    && plan.plan_key === ref.plan_key);
  if (member === undefined) fail('DEPENDENCY_INVALID', 'dependency_plan_not_found', { ref });
  if (member.plan.topology_digest !== ref.expected_topology_digest) {
    fail('DEPENDENCY_STALE', 'dependency_topology_stale', {
      ref, actual_topology_digest: member.plan.topology_digest,
    });
  }
  const task = member.tasks.find(({ task_id: taskId }) => taskId === ref.task_id);
  if (task === undefined) fail('DEPENDENCY_INVALID', 'dependency_task_not_found', { ref });
  return { member, task };
}

/**
 * xchart S3: only `todo dependency connect` (appendTodoEvent, `foreignFrom`) may record a predecessor on another
 * chart; Plan checked it there just before. Genesis, import and connectionOnly keep refusing a foreign from.
 */
function validateCrossPlanDependencyTransition(store, owner, input, { foreignFrom = false } = {}) {
  const { from, to } = input.payload;
  const foreign = from.project_id !== store.project_id;
  if ((foreign && !foreignFrom) || to.project_id !== store.project_id) {
    fail('DEPENDENCY_INVALID', 'dependency_project_mismatch');
  }
  // 同一plan内の後追い接続も受ける（2026-08-25 オーナー裁定）。「工程の線を誤ったので足す」という
  // 当たり前の修理を、source cutover込みのplan改訂トランザクションへ格上げする門は、能力を守らない
  // 防御でしかなかった。ready計算・gantt描画・start/doneゲートはmergedTaskKeyでplan非依存に動くため、
  // 跨ぎと同じ台帳・同じ検査（束縛digest・重複・自己辺・循環）でそのまま成立する。
  if (mergedTaskKey(from) === mergedTaskKey(to)) {
    fail('DEPENDENCY_INVALID', 'dependency_self_reference');
  }
  if (to.plan_key !== owner.plan.plan_key || to.project_id !== owner.plan.project_id) {
    fail('DEPENDENCY_INVALID', 'dependency_owner_mismatch');
  }
  // 同一planでは、plan本体が既に持つhard依存と同じ辺を二重に記録しない
  if (from.plan_key === to.plan_key && owner.plan.hard_dependencies.some((edge) => (
    edge.from.task_id === from.task_id && edge.to.task_id === to.task_id))) {
    fail('DEPENDENCY_EXISTS', 'dependency_already_in_plan', { from, to });
  }
  if (!foreign) crossPlanDependencyTask(store, from);
  const target = crossPlanDependencyTask(store, to);
  // A completed source already satisfies the prerequisite. Keep the existing
  // completion record as the proof instead of creating a second ledger entry.
  // The dependency event still records the topology edge for the target and
  // must pass all of the usual binding, duplicate, and cycle checks below.
  if (target.task.status === 'done') fail('DEPENDENCY_INVALID', 'dependency_target_terminal');
  const existing = projectTodoCrossPlanDependencies(store.members);
  if (existing.some((dependency) => mergedTaskKey(dependency.from) === mergedTaskKey(from)
    && mergedTaskKey(dependency.to) === mergedTaskKey(to))) {
    fail('DEPENDENCY_EXISTS', 'cross_plan_dependency_duplicate', { from, to });
  }
  try {
    validateMergedGraph(store.members, [...existing, { from, to }]);
  } catch (error) {
    if (error instanceof TodoStoreError && error.detail?.reason === 'merged_cycle') {
      fail('DEPENDENCY_CYCLE', 'cross_plan_dependency_cycle', { from, to, cycle: error.detail.cycle });
    }
    throw error;
  }
}

function mergedTaskKey(refValue) {
  return `${refValue.project_id}\0${refValue.plan_key}\0${refValue.task_id}`;
}

// Temporary adapter until Store receives the Plan callback from its caller.

/**
 * refsから辿れるobject idの集合。repositoryごとに1度だけ数え、以後は使い回す。
 *
 * 到達可能性を見ないと、手元にだけ在るdangling blobを「検証済み」と読んでしまう。
 */
const reachableObjectCache = new Map();
function reachableObjects(absoluteRepo) {
  const cached = reachableObjectCache.get(absoluteRepo);
  if (cached !== undefined) return cached;
  let set;
  try {
    // evidence-ref: Lattice's evidence anchors (refs/lattice/evidence/*, not seam refs) keep evidence from gc; anchored is not committed.
    const stdout = gitSync(['rev-list', '--objects', '--exclude=refs/lattice/evidence/*', '--all'],
      { cwd: absoluteRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024 });
    set = new Set();
    for (const line of stdout.split('\n')) {
      const oid = line.slice(0, 40);
      if (oid.length === 40) set.add(oid);
    }
  } catch {
    // 数えられない環境では到達可能性で落とさない。判定できないことを「到達不能」へ丸めると、
    // 既存recordが一斉に読めなくなる。ここは厳しさより「誤って否定しない」を採る。
    set = { has: () => true };
  }
  reachableObjectCache.set(absoluteRepo, set);
  return set;
}

// blob は内容アドレスなので oid が同じなら bytes は不変。gantt serve 等が store を再読する
// たびに同じ evidence blob を git 子起動で読み直すのを避ける（Windows のウィンドウ雪崩と
// 走査コストの主犯）。成功した読みだけを覚え、失敗は覚えない（repo 状態は変わりうる）。
const EVIDENCE_BLOB_CACHE_LIMIT = 512;
const evidenceBlobCache = new Map();

function readEvidenceBlob(absoluteRepo, oid) {
  const key = `${absoluteRepo}\0${oid}`;
  const cached = evidenceBlobCache.get(key);
  if (cached !== undefined) return cached;
  const [entry] = gitCatFileBatch([oid], {
    cwd: absoluteRepo, maxBodyBytes: TODO_LIMITS.narrativeSectionBytes + 1,
  });
  // child_processのmaxBufferはprocess出力の総量を制限するだけで、証拠1件の意味上限ではない。
  // 契約上限はbytesで明示判定し、process bufferの打切りを意味判定に使わない。
  if (entry.missing || entry.type !== 'blob'
    || entry.bytes.length > TODO_LIMITS.narrativeSectionBytes) throw new Error('not bounded blob');
  if (evidenceBlobCache.size >= EVIDENCE_BLOB_CACHE_LIMIT) {
    evidenceBlobCache.delete(evidenceBlobCache.keys().next().value);
  }
  evidenceBlobCache.set(key, entry.bytes);
  return entry.bytes;
}

function evidenceVerifier(manifest, repoRoot, hard, newEventDigest = null) {
  const repositories = new Map(manifest.repositories.map((repo) => [repo.repo_id, repo.path]));
  return (descriptor, context = {}) => {
    if (!validateEvidenceDescriptor(descriptor)) fail('STORE_INCONSISTENT', 'evidence_descriptor_invalid');
    const repoRef = repositories.get(descriptor.repo_id);
    if (repoRef === undefined) fail('STORE_INCONSISTENT', 'evidence_repo_missing');
    const absoluteRepo = path.resolve(repoRoot, repoRef);
    try {
      const bytes = readEvidenceBlob(absoluteRepo, descriptor.git_blob_oid);
      // **objectが在ることと、cloneした人が読めることは別である。** commitやtagから辿れない
      // dangling blobでも`cat-file`は通るので、手元では検証済みに見えるのに、fresh cloneでは
      // 誰も確かめられない証拠が残る。実際に16件そうなっており、公開CIで初めて露見した。
      // 手元とCIで判定が食い違う状態を残さない。
      //
      // ただし**書き込み時には要求しない**。証拠文書は同じ変更でcommitするのが普通の流れで、
      // `todo done`の時点ではindexに在るだけである。そこで拒むと正常な運用が止まる。
      // 「記録はできるが、commitするまでverifyは通らない」が正しい強さである。
      if (!hard && !reachableObjects(absoluteRepo).has(descriptor.git_blob_oid)) {
        throw new Error('blob unreachable from refs');
      }
      if (sha256Bytes(bytes) !== descriptor.content_digest) throw new Error('digest mismatch');
      return true;
    } catch {
      // 既存の不達は未検証として残す。新eventの証拠だけは書込み前にhard検証する。
      if (newEventDigest !== null && context.event_digest !== newEventDigest) return false;
      if (hard) fail('STORE_INCONSISTENT', 'evidence_unverified', {
        ...context,
        next_action: context.plan_key === undefined
          ? 'verify_the_evidence_descriptor_and_retry'
          : `lattice todo verify --plan ${context.plan_key} --json`,
      });
      return false;
    }
  };
}

/**
 * Read-only (a12): the evidence blob is present with its recorded digest but no ref reaches it yet,
 * i.e. it is waiting for a commit (message evidence or an uncommitted file). Missing or changed
 * bytes are not "uncommitted" and stay evidence_unverified refusals.
 */
export function isTodoEvidenceUncommitted({ repoRoot, store, evidence }) {
  if (!validateEvidenceDescriptor(evidence)) return false;
  const repoRef = store.manifest.repositories.find(({ repo_id: id }) => id === evidence.repo_id)?.path;
  if (repoRef === undefined) return false;
  const absoluteRepo = path.resolve(repoRoot, repoRef);
  try {
    return sha256Bytes(readEvidenceBlob(absoluteRepo, evidence.git_blob_oid)) === evidence.content_digest
      && !reachableObjects(absoluteRepo).has(evidence.git_blob_oid);
  } catch {
    return false;
  }
}

function pinnedSourceLine(repoRoot, source, cache = null) {
  // commit の型検査と blob 読みを 1 回の cat-file --batch へまとめる（object ごとの git
  // 子起動はWindowsで可視コンソールを開き、起動コストだけで走査を桁で遅くする）。
  const objectSpec = `${source.source_commit}:${source.origin_plan_ref}`;
  const needCommit = cache === null || !cache.commits.has(source.source_commit);
  let blob = cache?.blobs.get(objectSpec);
  if (needCommit || blob === undefined) {
    const names = [...(needCommit ? [source.source_commit] : []), ...(blob === undefined ? [objectSpec] : [])];
    const entries = gitCatFileBatch(names, {
      cwd: repoRoot, maxBodyBytes: TODO_LIMITS.narrativeSectionBytes + 1,
    });
    if (needCommit) {
      const commitEntry = entries.shift();
      if (commitEntry.missing || commitEntry.type !== 'commit') throw new Error('not commit');
      cache?.commits.add(source.source_commit);
    }
    if (blob === undefined) {
      const blobEntry = entries.shift();
      // commitとblobを同じbatchで読むと総buffer予算は2件分になる。source 1件の意味上限は
      // cacheへ入れる前に実bytesで判定する。
      if (blobEntry.missing || blobEntry.type !== 'blob'
        || blobEntry.bytes.length > TODO_LIMITS.narrativeSectionBytes) throw new Error('not bounded source blob');
      blob = blobEntry.bytes;
      cache?.blobs.set(objectSpec, blob);
    }
  }
  let start = 0;
  let line = 1;
  for (let index = 0; index < blob.length; index += 1) {
    if (blob[index] !== 0x0a) continue;
    if (line === source.origin_line) return blob.subarray(start, index);
    start = index + 1;
    line += 1;
  }
  if (start < blob.length && line === source.origin_line) return blob.subarray(start);
  throw new Error('line outside blob');
}

// 検証対象objectの一括prefetch。event payloadに現れるevidence記述子とimport sourceを
// 収集し、repoごとに1回の`cat-file --batch`でcacheへseedする。object 1個=spawn 1回の
// 雪崩はWindowsで起動単価66〜100msになり、evidenceが育ったstoreのstatusを桁で遅くする。
// 成功した読みだけをcacheへ入れ、missing・型不一致・batchごと失敗（repo不在等の境界）は
// 何もcacheしない——正誤の裁定は従来どおりper-objectの検証経路が同じ結果を出す。
function prefetchVerificationObjects(manifest, repoRoot, events, pinnedSourceCache) {
  const candidates = [];
  for (const event of events) {
    // 改版genesisはevent直下のstate_migrationでtask状態（evidence込み）を搬送する。
    // replayがcarry系だけを復元・検証するので、収集も同じpolicyへ揃える。
    if (Array.isArray(event.state_migration)) {
      for (const migration of event.state_migration) {
        if (['carry', 'carry_reconciled_metadata', 'acquire_phase'].includes(migration.state_policy)
          && migration.state !== null && typeof migration.state === 'object'
          && migration.state.evidence !== null && typeof migration.state.evidence === 'object') {
          candidates.push(migration.state.evidence);
        }
      }
    }
    const payload = event.payload;
    if (payload === null || typeof payload !== 'object') continue;
    if (payload.evidence !== null && typeof payload.evidence === 'object') candidates.push(payload.evidence);
    if (payload.decision_evidence !== null && typeof payload.decision_evidence === 'object') {
      candidates.push(payload.decision_evidence);
    }
    if (Array.isArray(payload.evidence_slots)) {
      for (const slot of payload.evidence_slots) {
        if (slot !== null && typeof slot === 'object'
          && slot.evidence !== null && typeof slot.evidence === 'object') candidates.push(slot.evidence);
      }
    }
  }
  const repositories = new Map(manifest.repositories.map((repo) => [repo.repo_id, repo.path]));
  const oidsByRepo = new Map();
  const pinnedCommits = new Set();
  const pinnedSpecs = new Set();
  for (const candidate of candidates) {
    if (validateEvidenceDescriptor(candidate)) {
      const repoRef = repositories.get(candidate.repo_id);
      if (repoRef === undefined) continue;
      const absoluteRepo = path.resolve(repoRoot, repoRef);
      if (evidenceBlobCache.has(`${absoluteRepo}\0${candidate.git_blob_oid}`)) continue;
      let oids = oidsByRepo.get(absoluteRepo);
      if (oids === undefined) oidsByRepo.set(absoluteRepo, oids = new Set());
      oids.add(candidate.git_blob_oid);
    } else if (validateTodoImportSource(candidate) && pinnedSourceCache !== null) {
      if (!pinnedSourceCache.commits.has(candidate.source_commit)) pinnedCommits.add(candidate.source_commit);
      const spec = `${candidate.source_commit}:${candidate.origin_plan_ref}`;
      if (!pinnedSourceCache.blobs.has(spec)) pinnedSpecs.add(spec);
    }
  }
  for (const [absoluteRepo, oids] of oidsByRepo) {
    let entries;
    try {
      entries = gitCatFileBatch([...oids], {
        cwd: absoluteRepo, maxBodyBytes: TODO_LIMITS.narrativeSectionBytes + 1,
      });
    } catch { continue; }
    let index = 0;
    for (const oid of oids) {
      const entry = entries[index];
      index += 1;
      // seedしないだけで正誤は変えない: 上限超過bodyは単体読みのmaxBufferでは読めない
      // （＝従来は未検証）ので、batch同乗の予算合算で検証済みへ昇格させない。cacheが
      // 満杯なら追い出さずseedを止める——seeding自身の追い出しは自分のseedを連鎖破壊し、
      // 513件以上で全件個別spawnへ戻る。溢れた分はper-item経路が従来どおり扱う。
      if (entry.missing || entry.type !== 'blob'
        || entry.bytes.length > TODO_LIMITS.narrativeSectionBytes
        || evidenceBlobCache.size >= EVIDENCE_BLOB_CACHE_LIMIT) continue;
      evidenceBlobCache.set(`${absoluteRepo}\0${oid}`, entry.bytes);
    }
  }
  const pinnedNames = [...pinnedCommits, ...pinnedSpecs];
  if (pinnedNames.length === 0) return;
  let entries;
  try {
    entries = gitCatFileBatch(pinnedNames, {
      cwd: repoRoot, maxBodyBytes: TODO_LIMITS.narrativeSectionBytes + 1,
    });
  } catch { return; }
  let index = 0;
  for (const commit of pinnedCommits) {
    const entry = entries[index];
    index += 1;
    if (!entry.missing && entry.type === 'commit') pinnedSourceCache.commits.add(commit);
  }
  for (const spec of pinnedSpecs) {
    const entry = entries[index];
    index += 1;
    if (!entry.missing && entry.type === 'blob'
      && entry.bytes.length <= TODO_LIMITS.narrativeSectionBytes) {
      pinnedSourceCache.blobs.set(spec, entry.bytes);
    }
  }
}

function markdownCheckboxState(lineBytes) {
  if (lineBytes.length >= 3 && lineBytes[0] === 0xef && lineBytes[1] === 0xbb && lineBytes[2] === 0xbf) return null;
  let line;
  try { line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes); } catch { return null; }
  const match = /^[\t ]*(?:[-+*]|\d+[A-Za-z]?\.|\d+\))[\t ]+\[([ xX])\](?:[\t ]+.*?)?\r?$/u.exec(line);
  if (match === null) return null;
  return match[1] === ' ' ? 'unchecked' : 'checked';
}

function liveReplacementPreservesListStructure(lineBytes, replacement) {
  let line;
  try { line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes); } catch { return false; }
  const source = /^([\t ]*)([-+*]|\d+[A-Za-z]?\.|\d+\))[\t ]+\[[ xX]\](?:[\t ]+.*)?\r?$/u.exec(line);
  const target = /^([\t ]*)([-+*]|\d+[A-Za-z]?\.|\d+\))[\t ]+.+$/u.exec(replacement);
  return source !== null && target !== null && source[1] === target[1] && source[2] === target[2];
}

function importSourceVerifier(repoRoot, hard, cache = null, newEventDigest = null) {
  return (descriptor, context = {}) => {
    if (!validateTodoImportSource(descriptor)) fail('STORE_INCONSISTENT', 'import_source_descriptor_invalid');
    try {
      pinnedSourceLine(repoRoot, descriptor, cache);
      return true;
    } catch {
      if (newEventDigest !== null && context.event_digest !== newEventDigest) return false;
      if (hard) fail('STORE_INCONSISTENT', 'import_source_unverified', {
        ...context,
        next_action: 'verify_source_commit_origin_path_and_line_then_retry',
      });
      return false;
    }
  };
}

function narrativeAnchorSource(value) {
  return exactRecord(value, [
    'task_id', 'origin_plan_ref', 'origin_line', 'source_commit', 'checkbox_state',
  ]) && isTodoIdentifier(value.task_id)
    && ['checked', 'unchecked', 'absent', 'ambiguous'].includes(value.checkbox_state)
    && validateTodoImportSource({
      schema: 'lattice.todo_import_source.v1', origin_plan_ref: value.origin_plan_ref,
      origin_line: value.origin_line, source_commit: value.source_commit,
    });
}

function materializeImportedNarrativeAnchors(repoRoot, planInput, sources, cache = null) {
  if (sources === undefined) return planInput;
  if (!['lattice.todo_plan.v2', 'lattice.todo_plan.v6'].includes(planInput?.schema)
    || !Array.isArray(sources)
    || sources.length > TODO_LIMITS.tasksPerPlan || !sources.every(narrativeAnchorSource)) {
    throw new TypeError('imported narrative anchor sources are invalid');
  }
  const byTask = new Map(sources.map((source) => [source.task_id, source]));
  if (byTask.size !== sources.length
    || sources.some(({ task_id: taskId }) => !planInput.tasks.some((task) => task.task_id === taskId))) {
    throw new TypeError('imported narrative anchor sources do not match plan tasks');
  }
  return {
    ...planInput,
    tasks: planInput.tasks.map((task) => {
      const source = byTask.get(task.task_id);
      let narrativeAnchor = null;
      if (source !== undefined && task.narrative_ref === source.origin_plan_ref
        && ['checked', 'unchecked'].includes(source.checkbox_state)) {
        try {
          const line = pinnedSourceLine(repoRoot, source, cache);
          if (markdownCheckboxState(line) === source.checkbox_state) {
            narrativeAnchor = {
              origin_plan_ref: source.origin_plan_ref,
              origin_line: source.origin_line,
              source_commit: source.source_commit,
              source_line_digest: sha256Bytes(line),
            };
          }
        } catch {
          narrativeAnchor = null;
        }
      }
      return { ...task, narrative_anchor: narrativeAnchor };
    }),
  };
}

function verifyPlanNarrativeAnchors(repoRoot, plan, trustedPlan = null, cache = null) {
  if (!['lattice.todo_plan.v2', 'lattice.todo_plan.v3', 'lattice.todo_plan.v4',
    'lattice.todo_plan.v5', 'lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(plan.schema)) return;
  const trusted = new Map((['lattice.todo_plan.v2', 'lattice.todo_plan.v3', 'lattice.todo_plan.v4',
    'lattice.todo_plan.v5', 'lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(trustedPlan?.schema)
    ? trustedPlan.tasks : [])
    .map((task) => [task.task_id, task.narrative_anchor]));
  for (const task of plan.tasks) {
    const anchor = task.narrative_anchor;
    if (anchor === null) continue;
    const previous = trusted.get(task.task_id);
    if (previous !== undefined
      && canonicalizeTodoArtifact(previous) === canonicalizeTodoArtifact(anchor)) continue;
    try {
      const line = pinnedSourceLine(repoRoot, anchor, cache);
      if (!matchesTodoSourceLineDigest(line, anchor.source_line_digest)
        || markdownCheckboxState(line) === null) {
        throw new Error('anchor mismatch');
      }
    } catch {
      fail('STORE_INCONSISTENT', 'narrative_anchor_unverified', {
        plan_key: plan.plan_key, task_id: task.task_id,
      });
    }
  }
}

function recoverableReadError(error) {
  return error instanceof TodoStoreError && [
    'manifest_journal_head_mismatch', 'snapshot_stale',
    'source_cutover_recovery_required', 'cross_plan_import_recovery_required',
  ].includes(error.detail.reason);
}

export async function readTodoStore(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  let view;
  let observedError;
  try {
    view = await readTodoStoreView(options);
    const lockPresent = await lstat(path.join(repoRoot, STORE_ROOT_REF, '.write.lock'))
      .then(() => true, (error) => { if (error?.code === 'ENOENT') return false; throw error; });
    if (!view.snapshot_stale && !lockPresent) return view;
  } catch (error) {
    if (!recoverableReadError(error)) throw error;
    observedError = error;
  }
  try { return await withLock(repoRoot, () => readTodoStoreLocked(options)); }
  catch (error) {
    // A concurrent writer owns its publication window; stable readers retry it.
    if (error instanceof TodoStoreError && error.code === 'STORE_WRITE_CONFLICT') {
      if (view) return view;
      if (error.detail.reason !== 'store_locked' || error.detail.cause) throw error;
      if (observedError) throw observedError;
    }
    throw error;
  }
}

async function readTodoStoreLocked(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (options.sourceCutoverRecoveryCapability !== SOURCE_CUTOVER_RECOVERY_CAPABILITY) {
    await recoverSourceCutover(repoRoot, options.now);
  }
  await recoverCrossPlanImports(repoRoot);
  const recovery = { manifestDirty: false };
  const store = await readTodoStoreView({ ...options, recovery });
  if (options.assertHeld) {
    store.cross_plan_repairs = await repairCrossPlanBindings(repoRoot, store, options.repairContext);
  }
  // Every member and merged graph has validated before any derived publication.
  for (const member of store.members) {
    if (!member.snapshot_stale) continue;
    await atomicWrite(path.resolve(repoRoot, member.descriptor.snapshot_ref), canonicalLine(member.snapshot));
    member.snapshot_stale = false;
  }
  if (recovery.manifestDirty) {
    store.manifest.manifest_digest = todoSelfDigest(store.manifest, 'manifest_digest');
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(store.manifest));
  }
  store.snapshot_stale = false;
  return store;
}

async function readTodoStoreView(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const barrier = await exactFileOrNull(path.resolve(repoRoot, SOURCE_CUTOVER_BARRIER_REF));
  if (barrier !== null) {
    let value;
    try { value = JSON.parse(decodeUtf8(barrier, 'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid')); }
    catch (error) {
      if (error instanceof TodoStoreError) throw error;
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid');
    }
    const revisionRecovery = value?.schema === 'lattice.todo_source_cutover_barrier.v1'
      && value.revision_digest === options.allowSourceCutoverRevisionDigest;
    const revisionSetRecovery = value?.schema === 'lattice.todo_source_cutover_set_barrier.v1'
      && value.revision_set_digest === options.allowSourceCutoverRevisionSetDigest;
    if (options.sourceCutoverRecoveryCapability !== SOURCE_CUTOVER_RECOVERY_CAPABILITY
      || (!revisionRecovery && !revisionSetRecovery)) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
    }
  }
  await assertNoCrossPlanImportRecoveryNeeded(repoRoot);
  const pinnedSourceCache = { commits: new Set(), blobs: new Map() };
  const manifest = await readManifest(repoRoot);
  const loaded = [];
  for (const descriptor of manifest.members) {
    const plan = await readArtifact(repoRoot, descriptor.plan_ref, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoPlan,
    });
    if (plan.project_id !== manifest.project_id || plan.plan_key !== descriptor.plan_key
      || plan.plan_version !== descriptor.active_plan_version || plan.topology_digest !== descriptor.topology_digest) {
      fail('STORE_INCONSISTENT', 'manifest_plan_binding_mismatch');
    }
    const journal = await readJournal(repoRoot, descriptor.journal_ref);
    if (journal.events.at(-1).event_digest !== descriptor.journal_head_digest) {
      if (!options.recovery || !journal.events.some(({ event_digest: digest }) => (
        digest === descriptor.journal_head_digest))) {
        fail('STORE_INCONSISTENT', 'manifest_journal_head_mismatch');
      }
      options.recovery.manifestDirty = true;
      descriptor.journal_head_digest = journal.events.at(-1).event_digest;
    }
    let revision = null;
    const genesis = journal.events[0];
    if (['lattice.todo_event.v2', 'lattice.todo_event.v4'].includes(genesis.schema)) {
      const revisionRef = path.posix.join(path.posix.dirname(descriptor.plan_ref), 'revision.json');
      const phaseRevision = genesis.schema === 'lattice.todo_event.v4';
      revision = await readArtifact(repoRoot, revisionRef, {
        code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes,
        validate: (value) => {
          rejectUnsupportedRevisionSchema(value, phaseRevision ? {
            family: 'phase_todo_revision', supportedSchemas: PHASE_TODO_REVISION_SCHEMAS,
          } : {
            family: 'todo_revision', supportedSchemas: TODO_REVISION_SCHEMAS,
          });
          return phaseRevision ? validatePhaseTodoRevision(value) : validateTodoRevision(value);
        },
      });
      const migrationProjection = genesis.state_migration.map((entry) => ({
        from_task_id: entry.from_task_id, to_task_id: entry.to_task_id,
        state_policy: entry.state_policy,
      }));
      if (canonicalizeTodoArtifact(revision.desired_plan) !== canonicalizeTodoArtifact(plan)
        || revision.revision_digest !== genesis.revision_digest
        || revision.predecessor.plan_digest !== genesis.payload.predecessor_plan_digest
        || revision.predecessor.journal_head_digest !== genesis.previous_digest
        || canonicalizeTodoArtifact(revision.task_migration)
          !== canonicalizeTodoArtifact(migrationProjection)) {
        fail('STORE_INCONSISTENT', 'revision_genesis_binding_mismatch');
      }
      if (manifest.schema === 'lattice.todo_manifest.v2'
        && descriptor.active_revision_digest !== genesis.revision_digest) {
        fail('STORE_INCONSISTENT', 'manifest_revision_binding_mismatch');
      }
      if (genesis.schema === 'lattice.todo_event.v2'
        && revision.reconciliation.reconciliation_digest !== genesis.reconciliation_digest) {
        fail('STORE_INCONSISTENT', 'revision_genesis_binding_mismatch');
      }
      if (genesis.schema === 'lattice.todo_event.v4') {
        const phaseProjection = revision.phase_migration
          .filter(({ to_phase_id }) => to_phase_id !== 'removed')
          .map(({ to_phase_id, state_policy }) => ({ phase_id: to_phase_id, state_policy }))
          .sort((left, right) => left.phase_id.localeCompare(right.phase_id));
        const genesisProjection = genesis.phase_state_migration
          .map(({ phase_id, state_policy }) => ({ phase_id, state_policy }));
        if (canonicalizeTodoArtifact(phaseProjection) !== canonicalizeTodoArtifact(genesisProjection)) {
          fail('STORE_INCONSISTENT', 'revision_genesis_binding_mismatch');
        }
      }
    }
    if (manifest.schema === 'lattice.todo_manifest.v2' && revision === null
      && descriptor.active_revision_digest !== plan.plan_digest) {
      fail('STORE_INCONSISTENT', 'manifest_revision_binding_mismatch');
    }
    prefetchVerificationObjects(manifest, repoRoot, journal.events, pinnedSourceCache);
    const verifyEvidence = evidenceVerifier(manifest, repoRoot, false);
    const verifyImportSource = importSourceVerifier(repoRoot, false, pinnedSourceCache);
    const tasks = replay(plan, journal.events, {
      now: options.now ? new Date(options.now) : new Date(),
      verifyEvidence: options.forWrite === true ? verifyEvidence : undefined,
      verifyImportSource: options.forWrite === true ? verifyImportSource : undefined,
    });
    const expectedSnapshot = snapshotFor(plan, journal.events, structuredClone(tasks));
    // Read-time evidence failure is annotation, never store rejection.
    for (const task of tasks) if (task.evidence !== null) {
      const context = {
        plan_key: plan.plan_key,
        task_id: task.task_id,
        event_digest: null,
      };
      const verified = validateTodoImportSource(task.evidence)
        ? verifyImportSource(task.evidence, context) : verifyEvidence(task.evidence, context);
      if (!verified) task.evidence_unverified = true;
    }
    let snapshot = null;
    let snapshotStale = false;
    try {
      snapshot = await readSnapshotArtifact(repoRoot, descriptor.snapshot_ref);
      snapshotStale = snapshot === null || canonicalizeTodoArtifact(snapshot) !== canonicalizeTodoArtifact(expectedSnapshot);
    } catch (error) {
      if (error instanceof TodoStoreError && error.code === 'SNAPSHOT_INVALID'
        && !['unsafe_artifact_path', 'path_alias_or_escape', 'path_outside_store']
          .includes(error.detail.reason)) snapshotStale = true;
      else throw error;
    }
    if (options.forWrite === true && snapshotStale && !options.recovery) fail('STORE_WRITE_REFUSED', 'snapshot_stale');
    // 導出済みphase状態(ADR 0147)。snapshot artifactの形式(v1/v2)には縛られず、v4/v5・
    // phase無しplanのどちらでも同じ形(暗黙のterminal-audit Phase込み)で常に埋める。
    // 消費者はここを読み、snapshot.phases(v1には存在しない)を直接読まない。
    const phases = projectPhaseStates(plan, journal.events, new Map(tasks.map((task) => [task.task_id, task])));
    // 調整方式の宣言(ob03)。lifecycle journalとは別chainから読む。phasesと同じく
    // snapshot artifactの形式には縛られない導出ビューで、未宣言はnull（「まだ選んでいない」）。
    const planScoped = await readPlanScopedJournal(repoRoot, descriptor.journal_ref);
    const coordination = projectTodoCoordination(planScoped.events)
      ?? await inheritedTodoCoordination(repoRoot, plan);
    loaded.push({ descriptor, plan, revision, journal, plan_scoped: planScoped,
      snapshot: snapshotStale ? expectedSnapshot : snapshot,
      tasks, phases, coordination, snapshot_stale: snapshotStale });
  }
  const crossPlanFindings = validateMergedGraph(loaded, projectTodoCrossPlanDependencies(loaded));
  return {
    schema: 'lattice.todo_store_read.v1', project_id: manifest.project_id, manifest,
    members: loaded, snapshot_stale: loaded.some((member) => member.snapshot_stale),
    cross_plan_findings: crossPlanFindings,
  };
}

/** The plan's other retained versions, by plan digest (unreadable ones are skipped). */
async function retainedPlanVersions(repoRoot, activePlan) {
  const base = `${STORE_ROOT_REF}/plans/${activePlan.plan_key}`;
  const byDigest = new Map();
  let names = [];
  try { names = await readdir(path.resolve(repoRoot, base)); } catch { /* no retained versions */ }
  for (const version of names) {
    if (version === activePlan.plan_version || !isTodoIdentifier(version)) continue;
    const plan = await readArtifact(repoRoot, `${base}/${version}/plan.json`, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoPlan, missing: true,
    }).catch(() => null);
    if (plan !== null) byDigest.set(plan.plan_digest, { plan, journalRef: `${base}/${version}/journal/active.jsonl` });
  }
  return byDigest;
}

/**
 * a35: the coordination declaration belongs to the plan, not to one version (ADR 0160 Decision 2).
 * A revision does not copy the declaration into the new plan-scoped chain, so a version that has not declared its own reads the
 * newest declaration along its retained predecessors. Read only: nothing is copied into the new chain.
 * An unreadable predecessor ends the walk as undeclared, which is what the version showed before a35.
 */
async function inheritedTodoCoordination(repoRoot, plan) {
  if (!plan.predecessor_plan_digest) return null;
  const byDigest = await retainedPlanVersions(repoRoot, plan);
  for (let digest = plan.predecessor_plan_digest, steps = 0; digest && steps < byDigest.size; steps += 1) {
    const predecessor = byDigest.get(digest);
    if (predecessor === undefined) return null;
    const chain = await readPlanScopedJournal(repoRoot, predecessor.journalRef).catch(() => null);
    if (chain === null) return null;
    const declared = projectTodoCoordination(chain.events);
    if (declared !== null) return declared;
    digest = predecessor.plan.predecessor_plan_digest;
  }
  return null;
}

/**
 * blockers-carry (Ludmila agreed): for each of `taskIds` (blocked, no block event in this version), the block event in
 * effect when it was carried blocked, from the retained predecessor journals along predecessor_plan_digest (walked
 * once per member). Follows a carry only when it carried the task blocked. Read only; a missing version, an uncarried
 * or non-blocked carry, or any read error leaves the task null.
 */
export async function readTodoCarriedBlocks({ repoRoot = process.cwd(), member, taskIds }) {
  const found = new Map(taskIds.map((id) => [id, null]));
  const carriedBlocked = (genesis, id) => (genesis?.state_migration ?? []).find((migration) => migration.to_task_id === id
    && CARRY_STATE_POLICIES.includes(migration.state_policy) && migration.state?.status === 'blocked')?.from_task_id ?? null;
  if (!member.plan.predecessor_plan_digest || taskIds.length === 0) return found;
  try {
    const byDigest = await retainedPlanVersions(repoRoot, member.plan);
    let open = new Map(taskIds.map((id) => [id, carriedBlocked(member.journal.events[0], id)]).filter(([, from]) => from));
    for (let digest = member.plan.predecessor_plan_digest, steps = 0; open.size > 0 && digest && steps < byDigest.size; steps += 1) {
      const predecessor = byDigest.get(digest);
      if (predecessor === undefined) break;
      const { events } = await readJournal(repoRoot, predecessor.journalRef);
      const next = new Map();
      for (const [taskId, id] of open) {
        const block = events.findLast((event) => event.kind === 'block' && event.task_id === id);
        if (block !== undefined) found.set(taskId, block);
        else if (carriedBlocked(events[0], id)) next.set(taskId, carriedBlocked(events[0], id));
      }
      open = next;
      digest = predecessor.plan.predecessor_plan_digest;
    }
  } catch { /* an unreadable predecessor leaves the remaining tasks null */ }
  return found;
}

/**
 * Composes the source plan's recorded task migrations back to the version whose topology the
 * connection names (u03): returns the source task id it maps to now, 'removed', or null (unknown).
 */
async function carriedSourceTask(repoRoot, source, ref, versionsCache) {
  if (!versionsCache.has(source)) versionsCache.set(source, await retainedPlanVersions(repoRoot, source.plan));
  const byDigest = versionsCache.get(source);
  // Newest first: the active genesis maps its predecessor's ids onto the active ids.
  const migrations = [source.journal.events[0].payload.task_migration ?? []];
  for (let plan = source.plan; migrations.length <= byDigest.size;) {
    const predecessor = byDigest.get(plan.predecessor_plan_digest);
    if (predecessor === undefined) return null;
    if (predecessor.plan.topology_digest === ref.expected_topology_digest) {
      let taskId = ref.task_id;
      for (const migration of migrations.reverse()) {
        const entry = migration.find(({ from_task_id: from }) => from === taskId);
        if (entry === undefined) return null;
        if (entry.to_task_id === 'removed') return 'removed';
        taskId = entry.to_task_id;
      }
      return taskId;
    }
    let journal;
    try { journal = await readJournal(repoRoot, predecessor.journalRef); } catch { return null; }
    migrations.push(journal.events[0].payload.task_migration ?? []);
    plan = predecessor.plan;
  }
  return null;
}

/**
 * u03 A24/A25b: a live connection whose source plan was revised follows the source's recorded
 * task migrations (Plan's revision decision, the carry proof): carried -> tombstone + replacement,
 * removed -> tombstone. A repair that would duplicate an edge or close a cycle is dropped alone and
 * stays a finding; the rest publish once per owner chain and update the in-memory store.
 */
async function repairCrossPlanBindings(repoRoot, store, { assertHeld, actor, recordedAt }) {
  const stale = (store.cross_plan_findings ?? []).filter(({ event_digest: digest, side }) => (
    digest !== null && side === 'from'));
  if (stale.length === 0) return [];
  const live = new Map(projectTodoCrossPlanDependencies(store.members)
    .map((dependency) => [dependency.event_digest, dependency]));
  const versionsCache = new Map();
  const staged = new Map();
  const repairs = [];
  let findings = store.cross_plan_findings;
  for (const finding of stale) {
    const dependency = live.get(finding.event_digest);
    const source = store.members.find(({ plan }) => plan.project_id === finding.ref.project_id
      && plan.plan_key === finding.ref.plan_key);
    const owner = store.members.find(({ plan_scoped: chain }) => (chain?.events ?? [])
      .some(({ event_digest: digest }) => digest === finding.event_digest));
    if (!dependency || !source || !owner) continue;
    const mapped = await carriedSourceTask(repoRoot, source, dependency.from, versionsCache);
    if (mapped === null) continue;
    if (!staged.has(owner)) {
      staged.set(owner, { ...owner, plan_scoped: { ...owner.plan_scoped,
        events: [...owner.plan_scoped.events], activeBytes: owner.plan_scoped.activeBytes } });
    }
    const target = staged.get(owner);
    const before = { events: target.plan_scoped.events.length, activeBytes: target.plan_scoped.activeBytes };
    const inputs = [{ kind: 'cross_plan_dependency_removed', payload: {
      target_event_digest: dependency.event_digest,
      reason: `source ${source.plan.plan_key} ${source.plan.plan_version} ${mapped === 'removed'
        ? 'removed the task' : 'carried the task'}`,
    } }];
    if (mapped !== 'removed') inputs.push({ kind: 'cross_plan_dependency', payload: {
      from: { ...dependency.from, task_id: mapped, expected_topology_digest: source.plan.topology_digest },
      to: dependency.to, reason: dependency.reason,
    } });
    for (const input of inputs) {
      const event = buildPlanScopedEvent(target, { ...input, actor, recorded_at: recordedAt });
      target.plan_scoped.activeBytes = Buffer.concat([target.plan_scoped.activeBytes,
        planScopedEventBytes(target, event)]);
      target.plan_scoped.events.push(event);
    }
    const prospective = store.members.map((member) => staged.get(member) ?? member);
    const keys = projectTodoCrossPlanDependencies(prospective)
      .map(({ from, to }) => `${mergedTaskKey(from)}\0${mergedTaskKey(to)}`);
    try {
      if (new Set(keys).size !== keys.length) fail('DEPENDENCY_EXISTS', 'cross_plan_dependency_duplicate');
      findings = validateMergedGraph(prospective);
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      target.plan_scoped.events.length = before.events;
      target.plan_scoped.activeBytes = before.activeBytes;
      continue;
    }
    repairs.push({ owner_plan_key: owner.plan.plan_key, original_event_digest: dependency.event_digest,
      replacement_event_digest: mapped === 'removed' ? null : target.plan_scoped.events.at(-1).event_digest,
      action: mapped === 'removed' ? 'tombstoned' : 'rebound' });
  }
  if (repairs.length === 0) return [];
  await assertHeld();
  for (const [owner, target] of staged) {
    if (target.plan_scoped.events.length === owner.plan_scoped.events.length) continue;
    await atomicWrite(path.resolve(repoRoot, owner.plan_scoped.ref), target.plan_scoped.activeBytes);
    owner.plan_scoped = target.plan_scoped;
    owner.coordination = projectTodoCoordination(target.plan_scoped.events) ?? owner.coordination;
  }
  store.cross_plan_findings = findings;
  return repairs;
}

/**
 * xchart S1: read another chart without touching it: the non-recovering view (no lock, no recovery, no write).
 * Throws where that chart's own writer must recover (manifest_journal_head_mismatch after the stable-read attempts,
 * cross_plan_import_recovery_required, source_cutover_recovery_required) and STORE_UNINITIALIZED; Plan reads any
 * throw as "that chart is unreadable" for its edges only.
 */
export async function readTodoStoreReadOnly({ repoRoot }) {
  return readStoreStableWith({ repoRoot }, readTodoStoreView);
}

export async function readTodoStoreStable(options = {}) {
  return readStoreStableWith(options, readTodoStore);
}

async function readStoreStableWith(options, readStore) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const maximumAttempts = options.maximumAttempts ?? 4;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 16) {
    throw new TypeError('maximumAttempts must be 1..16');
  }
  // `manifest_journal_head_mismatch`/`manifest_plan_binding_mismatch`は、manifestを最後に
  // publishする並行writerの一時窓でも、crash後に残った恒久的な千切れでも同じ形に見える。
  // 同じdigestを2回観測しただけでは両者を判別できないため、この2 reasonだけはattempt
  // 上限まで待つ。上限内に閉じれば正常storeを返し、閉じなければ最後のtyped errorを返す。
  // これにより一時窓を早計に破損扱いせず、恒久破損もSTORE_BUSYへ丸めない。
  let lastError = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const before = await readManifest(repoRoot);
    try {
      const store = await readStore(options);
      const after = await readManifest(repoRoot);
      if (before.manifest_digest === after.manifest_digest
        && store.manifest.manifest_digest === after.manifest_digest) return store;
    } catch (error) {
      if (!(error instanceof TodoStoreError)) throw error;
      const after = await readManifest(repoRoot);
      const transientWriteWindow = error.code === 'STORE_INCONSISTENT'
        && ['manifest_journal_head_mismatch', 'manifest_plan_binding_mismatch']
          .includes(error.detail.reason);
      if (before.manifest_digest === after.manifest_digest
        && !transientWriteWindow) throw error;
      lastError = error;
    }
    if (attempt < maximumAttempts) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(16, 2 ** attempt)));
    }
  }
  // Exhausted without ever observing a genuinely closing write. Surface the last typed
  // STORE_INCONSISTENT reason rather than a bare STORE_BUSY — the caller (and a human
  // reading the error) needs to know which store artifact actually disagrees, not just
  // that reads kept failing.
  if (lastError !== null) throw lastError;
  fail('STORE_BUSY', 'stable_read_exhausted', { attempts: maximumAttempts });
}

// Store display read (dfd-store-display-read.md). Read-only toward canonical Store files:
// no lock, recovery or writer; the only write is the derived checkpoint below.
const DISPLAY_CHECKPOINT_REF = '.lattice/generated/store-display/last-verified.json';
const DISPLAY_CHECKPOINT_SCHEMA = 'lattice.todo_store_display_checkpoint.v1';
const DISPLAY_SOURCE_SCHEMA = 'lattice.todo_store_display_source.v1';
const DISPLAY_CHECKPOINT_MAX_BYTES = 64 * 1_048_576;

const nullableString = (value) => (typeof value === 'string' ? value : null);

/** Any display-read error as public {code, detail}; an untyped fault is warned server-side only. */
function displayFault(error) {
  if (error instanceof TodoStoreError) return { code: error.code, detail: { ...error.detail } };
  process.emitWarning(`Store display read fault: ${error?.stack ?? error}`, { code: 'LATTICE_STORE_DISPLAY_READ_FAULT' });
  return { code: 'STORE_READ_FAULT', detail: { reason: 'unexpected_error' } };
}

function displayFailure(error) {
  const { code, detail } = displayFault(error);
  return { code, reason: detail.reason ?? null };
}

async function canonicalRepoRoot(repoRoot) {
  try { return await realpath(repoRoot); } catch { return path.resolve(repoRoot); }
}

/** Bounded raw bytes of a contained `.lattice/todo` file; no schema or digest checks. */
async function readRawStoreFile(repoRoot, ref, maxBytes, { missing = false } = {}) {
  if (typeof ref !== 'string') fail('STORE_INCONSISTENT', 'ref_invalid');
  const state = await pathState(repoRoot, ref, 'STORE_INCONSISTENT', { missing });
  if (state === null) return null;
  if (state.stats.size > maxBytes) fail('STORE_INCONSISTENT', 'size_limit_exceeded', { ref });
  try { return await readFile(state.absolute); } catch { fail('STORE_INCONSISTENT', 'artifact_read_failed', { ref }); }
}

async function readRawStoreJson(repoRoot, ref, maxBytes) {
  const bytes = await readRawStoreFile(repoRoot, ref, maxBytes);
  const text = decodeUtf8(bytes, 'STORE_INCONSISTENT', 'invalid_utf8');
  try { return JSON.parse(text); } catch { fail('STORE_INCONSISTENT', 'json_invalid', { ref }); }
}

async function rawLastEventDigest(repoRoot, ref, { missing = false } = {}) {
  const bytes = await readRawStoreFile(repoRoot, ref, TODO_LIMITS.journalSegmentBytes, { missing });
  if (bytes === null) return null;
  const lines = decodeUtf8(bytes, 'STORE_INCONSISTENT', 'invalid_utf8').split('\n').filter(Boolean);
  let digest;
  try { digest = JSON.parse(lines.at(-1)).event_digest; } catch { fail('STORE_INCONSISTENT', 'json_invalid', { ref }); }
  if (typeof digest !== 'string') fail('STORE_INCONSISTENT', 'event_digest_missing', { ref });
  return digest;
}

async function readRawManifest(repoRoot) {
  if (await readRawStoreFile(repoRoot, MANIFEST_REF, TODO_LIMITS.snapshotBytes, { missing: true }) === null) {
    await failManifestMissing(repoRoot);
  }
  const manifest = await readRawStoreJson(repoRoot, MANIFEST_REF, TODO_LIMITS.snapshotBytes);
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.members)) {
    fail('STORE_INCONSISTENT', 'manifest_members_unenumerable', { ref: MANIFEST_REF });
  }
  return manifest;
}

function sortDisplayMembers(members) {
  return members.sort((left, right) => String(left.plan_key).localeCompare(String(right.plan_key)));
}

async function observeDisplaySource(repoRoot, manifest) {
  const diagnostics = [];
  const members = [];
  for (const descriptor of manifest.members) {
    const entry = descriptor !== null && typeof descriptor === 'object' ? descriptor : {};
    const planKey = nullableString(entry.plan_key);
    const observe = async (field, read) => {
      try { return await read(); } catch (error) {
        diagnostics.push({ plan_key: planKey, field, ...displayFailure(error) });
        return null;
      }
    };
    const journalRef = nullableString(entry.journal_ref);
    members.push({
      plan_key: planKey,
      active_plan_version: nullableString(entry.active_plan_version),
      plan_digest: await observe('plan_digest', async () => {
        const digest = (await readRawStoreJson(repoRoot, entry.plan_ref, TODO_LIMITS.snapshotBytes))?.plan_digest;
        if (typeof digest !== 'string') fail('STORE_INCONSISTENT', 'plan_digest_missing');
        return digest;
      }),
      topology_digest: nullableString(entry.topology_digest),
      lifecycle_head: await observe('lifecycle_head', () => rawLastEventDigest(repoRoot, journalRef)),
      plan_scoped_head: journalRef === null ? null : await observe('plan_scoped_head', () => (
        rawLastEventDigest(repoRoot, planScopedJournalRef(journalRef), { missing: true }))),
    });
  }
  return {
    schema: DISPLAY_SOURCE_SCHEMA,
    repository_identity: sha256Bytes(Buffer.from(await canonicalRepoRoot(repoRoot), 'utf8')),
    project_id: nullableString(manifest.project_id),
    manifest_digest: nullableString(manifest.manifest_digest),
    members: sortDisplayMembers(members),
    diagnostics,
  };
}

async function verifiedDisplaySource(repoRoot, store) {
  return {
    schema: DISPLAY_SOURCE_SCHEMA,
    repository_identity: sha256Bytes(Buffer.from(await canonicalRepoRoot(repoRoot), 'utf8')),
    project_id: store.project_id,
    manifest_digest: store.manifest.manifest_digest,
    members: sortDisplayMembers(store.members.map(({ descriptor, plan, journal, plan_scoped: planScoped }) => ({
      plan_key: descriptor.plan_key,
      active_plan_version: descriptor.active_plan_version,
      plan_digest: plan.plan_digest,
      topology_digest: descriptor.topology_digest,
      lifecycle_head: journal.events.at(-1).event_digest,
      plan_scoped_head: planScoped.events.at(-1)?.event_digest ?? null,
    }))),
    diagnostics: [],
  };
}

/** The existing read model without implementation bytes; JSON-serializable. */
function displayStoreView(store) {
  return JSON.parse(JSON.stringify({
    schema: store.schema, project_id: store.project_id, manifest: store.manifest,
    members: store.members.map(({ journal, plan_scoped: planScoped, ...member }) => ({
      ...member,
      journal: { events: journal.events },
      plan_scoped: { ref: planScoped.ref, events: planScoped.events },
    })),
  }));
}

function checkpointDigest(checkpoint) {
  const { checkpoint_digest: _digest, ...body } = checkpoint;
  return sha256Bytes(Buffer.from(JSON.stringify(body), 'utf8'));
}

/**
 * Returns the checkpoint attributable to this repository, or null. Never writes.
 * A readable current projectId must match; without one (broken manifest) the realpath
 * repository identity attributes it, since the file lives in this repository's .lattice.
 */
async function readDisplayCheckpoint(repoRoot, projectId) {
  const root = await canonicalRepoRoot(repoRoot);
  const absolute = path.resolve(root, DISPLAY_CHECKPOINT_REF);
  let checkpoint;
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > DISPLAY_CHECKPOINT_MAX_BYTES) return null;
    if (await realpath(absolute) !== absolute) return null;
    checkpoint = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute)));
  } catch { return null; }
  const valid = exactRecord(checkpoint, ['schema', 'verified_at', 'source', 'store', 'checkpoint_digest'])
    && checkpoint.schema === DISPLAY_CHECKPOINT_SCHEMA
    && isStrictTodoTimestamp(checkpoint.verified_at)
    && checkpoint.checkpoint_digest === checkpointDigest(checkpoint)
    && checkpoint.source?.schema === DISPLAY_SOURCE_SCHEMA
    && checkpoint.source.repository_identity === sha256Bytes(Buffer.from(root, 'utf8'))
    && typeof checkpoint.source.project_id === 'string'
    && (typeof projectId !== 'string' || checkpoint.source.project_id === projectId)
    && checkpoint.store?.project_id === checkpoint.source.project_id && Array.isArray(checkpoint.store.members);
  return valid ? checkpoint : null;
}

async function publishDisplayCheckpoint(repoRoot, { verified_at: verifiedAt, source, store }) {
  const root = await canonicalRepoRoot(repoRoot);
  let directory = root;
  for (const segment of path.posix.dirname(DISPLAY_CHECKPOINT_REF).split('/')) {
    directory = path.join(directory, segment);
    if (segment !== '.lattice') await mkdir(directory).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(directory) !== directory) {
      fail('STORE_DISPLAY_CHECKPOINT_UNSAFE', 'unsafe_checkpoint_directory', { ref: path.relative(root, directory) });
    }
  }
  const checkpoint = { schema: DISPLAY_CHECKPOINT_SCHEMA, verified_at: verifiedAt, source, store, checkpoint_digest: '' };
  checkpoint.checkpoint_digest = checkpointDigest(checkpoint);
  await atomicWrite(path.resolve(root, DISPLAY_CHECKPOINT_REF), Buffer.from(JSON.stringify(checkpoint), 'utf8'));
}

async function readRawDisplayMembers(repoRoot, manifest) {
  const members = [];
  const dropped = [];
  for (const descriptor of manifest.members) {
    const entry = descriptor !== null && typeof descriptor === 'object' ? descriptor : {};
    const planKey = nullableString(entry.plan_key);
    let snapshot;
    try { snapshot = await readRawStoreJson(repoRoot, entry.snapshot_ref, TODO_LIMITS.snapshotBytes); } catch (error) {
      dropped.push({ plan_key: planKey, snapshot_ref: nullableString(entry.snapshot_ref), ...displayFailure(error) });
      continue;
    }
    // Plans are immutable per version; an unreadable plan drops only the plan, not the member.
    let plan = null;
    try { plan = await readRawStoreJson(repoRoot, entry.plan_ref, TODO_LIMITS.snapshotBytes); } catch (error) {
      dropped.push({ plan_key: planKey, plan_ref: nullableString(entry.plan_ref), ...displayFailure(error) });
    }
    members.push({ descriptor, plan, snapshot });
  }
  return { members, dropped };
}

/** Cheap unverified change hint for display polling; never validation or recovery. */
export async function readTodoStoreDisplaySource({ repoRoot = process.cwd() } = {}) {
  const root = path.resolve(repoRoot);
  let manifest;
  try { manifest = await readRawManifest(root); } catch (error) {
    // No Store yet is an observation like display read's, not a probe failure.
    if (error?.code !== 'STORE_UNINITIALIZED') throw error;
    const source = await observeDisplaySource(root, { members: [] });
    source.diagnostics.push({ plan_key: null, field: 'manifest', code: error.code, reason: error.detail.reason });
    return source;
  }
  return observeDisplaySource(root, manifest);
}

/** Display-only envelope: verified > unverified current raw > last_verified > unavailable. */
export async function readTodoStoreForDisplay({ repoRoot = process.cwd(), now } = {}) {
  const root = path.resolve(repoRoot);
  const verifiedAt = new Date(now ?? Date.now()).toISOString();
  let inconsistency;
  try {
    const strict = await readStoreStableWith({ repoRoot: root, now }, readTodoStoreView);
    const store = displayStoreView(strict);
    const source = await verifiedDisplaySource(root, strict);
    try {
      const retained = await readDisplayCheckpoint(root, source.project_id);
      if (JSON.stringify(retained?.source) !== JSON.stringify(source)) {
        await publishDisplayCheckpoint(root, { verified_at: verifiedAt, source, store });
      }
    } catch (error) {
      process.emitWarning(`Store display checkpoint was not published: ${error?.detail?.reason ?? error?.code ?? error}`, {
        code: 'LATTICE_STORE_DISPLAY_CHECKPOINT_PUBLICATION_FAILED',
      });
    }
    return { state: 'verified', store, verified_at: verifiedAt, source, inconsistency: null, dropped_members: [] };
  } catch (error) {
    inconsistency = displayFault(error);
  }
  let manifest = null;
  try { manifest = await readRawManifest(root); } catch (error) { displayFault(error); }
  let dropped = [];
  if (manifest !== null) {
    const raw = await readRawDisplayMembers(root, manifest);
    dropped = raw.dropped;
    if (raw.members.length > 0) {
      return {
        state: 'unverified',
        store: { project_id: nullableString(manifest.project_id), manifest, members: raw.members },
        verified_at: null,
        source: await observeDisplaySource(root, manifest),
        inconsistency,
        dropped_members: dropped,
      };
    }
  }
  const checkpoint = await readDisplayCheckpoint(root, nullableString(manifest?.project_id));
  if (checkpoint !== null) {
    return {
      state: 'last_verified', store: checkpoint.store, verified_at: checkpoint.verified_at,
      source: checkpoint.source, inconsistency, dropped_members: dropped,
    };
  }
  return { state: 'unavailable', store: null, verified_at: null, source: null, inconsistency, dropped_members: dropped };
}

export async function atomicWrite(absolute, bytes) {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await syncPublishedFile(handle, absolute);
    await handle.close(); handle = null;
    await renamePublishedFile(temporary, absolute);
    await fsyncDirectory(path.dirname(absolute));
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

async function atomicWriteMode(absolute, bytes, mode) {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(bytes); await handle.chmod(mode);
    await syncPublishedFile(handle, absolute);
    await handle.close(); handle = null;
    await renamePublishedFile(temporary, absolute);
    await fsyncDirectory(path.dirname(absolute));
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}


async function withLock(repoRoot, callback, {
  onProtocolStage = null, lockCapability = null, initialize = false, repairAfter = null,
} = {}) {
  if (lockCapability === STORE_LOCK_HELD) return callback(async () => {});
  // u03 A24/A25b: a successor writer rebinds or tombstones the connections it left stale.
  const run = repairAfter === null ? callback : async (assertHeld) => {
    const result = await callback(assertHeld);
    // The successor is already published: a failed repair leaves findings for the next locked write.
    try {
      const repairs = await repairCrossPlanBindings(repoRoot, await readTodoStoreView({ repoRoot }),
        { assertHeld, actor: repairAfter.actor, recordedAt: repairAfter.recordedAt ?? new Date().toISOString() });
      // Results stay digest-bound; the caller learns the repairs through its own callback.
      if (repairs.length > 0 && typeof repairAfter.onRepairs === 'function') await repairAfter.onRepairs(repairs);
    } catch (error) {
      if (!(error instanceof TodoStoreError || error instanceof StoreLockError)) throw error;
    }
    return result;
  };
  try {
    if (!initialize) {
      const root = await lstat(path.join(repoRoot, STORE_ROOT_REF)).catch((error) => {
        if (error?.code === 'ENOENT') failUninitialized();
        throw error;
      });
      const parent = await lstat(path.join(repoRoot, '.lattice')).catch((error) => {
        if (error?.code === 'ENOENT') failUninitialized();
        throw error;
      });
      if (!root.isDirectory() || root.isSymbolicLink()
        || !parent.isDirectory() || parent.isSymbolicLink()) {
        fail('STORE_INCONSISTENT', 'unsafe_artifact_path', { ref: STORE_ROOT_REF });
      }
    }
    return await withStoreLock({
      lockPath: path.join(repoRoot, STORE_ROOT_REF, '.write.lock'),
      createParent: initialize,
      waitMs: LOCK_WAIT_MS,
      recoveryClaimsPath: path.join(repoRoot, CROSS_PLAN_RECOVERY_CLAIMS_REF),
      onRecoveryClaim: typeof onProtocolStage === 'function'
        ? () => onProtocolStage('cross_plan_lock_recovery_mutex_acquired') : null,
    }, run);
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  }
}

export async function rebuildTodoSnapshot(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, now: options.now });
    const member = store.members.find(({ descriptor }) => descriptor.plan_key === options.planKey);
    if (!member) fail('STORE_INCONSISTENT', 'plan_not_active');
    await atomicWrite(path.resolve(repoRoot, member.descriptor.snapshot_ref), canonicalLine(member.snapshot));
    return member.snapshot;
  });
}

function nextEvent(input, storeMember) {
  const previous = storeMember.journal.events.at(-1);
  let payload = input.payload;
  if (input.kind === 'done' && (exactRecord(input.payload, ['evidence'])
    || exactRecord(input.payload, ['evidence', 'test_result']))) {
    payload = {
      done_mode: 'authored', imported: false, evidence: input.payload.evidence,
      ...(input.payload.test_result === undefined ? {} : { test_result: input.payload.test_result }),
    };
  }
  const phaseCapablePlan = isPhaseTodoPlanSchema(storeMember.plan.schema);
  const phaseKind = ['phase_review', 'phase_accept', 'phase_reject', 'phase_reopen', 'phase_close_unaudited']
    .includes(input.kind);
  // ADR 0147: phase無しplanでも、暗黙のterminal-audit Phaseへのphase_*eventだけは
  // v3 tail eventとして書く(readJournalのlegacyOrImplicitPhaseTailが同じ規則で受理する)。
  // task側のevent(start/done等)はphase無しplanのままv1で書き続ける——既存の
  // canonical形式を変えるのはphase_*eventの新設分だけに限る。
  const usesPhaseEventShape = phaseCapablePlan || phaseKind;
  const event = {
    schema: usesPhaseEventShape ? 'lattice.todo_event.v3' : 'lattice.todo_event.v1',
    project_id: storeMember.plan.project_id,
    plan_key: storeMember.plan.plan_key, plan_version: storeMember.plan.plan_version,
    sequence: previous.sequence + 1, previous_digest: previous.event_digest,
    kind: input.kind, task_id: input.task_id ?? null,
    ...(usesPhaseEventShape ? { phase_id: input.phase_id ?? null } : {}),
    actor: input.actor, recorded_at: input.recorded_at,
    provenance: input.provenance ?? null, payload, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('todo event input violates its declared schema');
  return event;
}

/**
 * The digest replay binds a task's completion to.
 *
 * A ToDo completed inside this plan version binds to its own `done` event. A
 * ToDo carried across a revision has no `done` event in the successor journal —
 * its completion arrives with the `plan_genesis` state migration, and replay
 * binds it to the genesis digest (see the carry branch in `replay`). Resolving
 * only the first case is what made `reopen` unusable on carried work.
 *
 * Returns null when the task has no completion to bind to at all.
 */
function resolveDoneBindingDigest(storeMember, taskId) {
  const events = storeMember.journal.events;
  const authored = [...events].reverse().find((event) => (
    event.kind === 'done' && event.task_id === taskId
  ));
  if (authored !== undefined) return authored.event_digest;
  const genesis = events[0];
  if (genesis?.kind !== 'plan_genesis' || !Array.isArray(genesis.state_migration)) return null;
  const carried = genesis.state_migration.some((migration) => (
    ['carry', 'carry_reconciled_metadata', 'acquire_phase'].includes(migration.state_policy)
    && migration.to_task_id === taskId && migration.state?.status === 'done'
  ));
  return carried ? genesis.event_digest : null;
}

function resolveTargetedEvent(input, storeMember) {
  if (input.kind === 'reopen' && exactRecord(input.payload, [
    'reason', 'override_reason',
  ])) {
    // a32: only a done task reopens; any other state is the seat's order, not a damaged store.
    const status = storeMember.tasks?.find(({ task_id: id }) => id === input.task_id)?.status;
    if (status !== undefined && status !== 'done') {
      fail('TODO_TRANSITION_REFUSED', 'invalid_reopen_transition', {
        cause: 'task_state', status, plan_key: storeMember.plan.plan_key, task_id: input.task_id });
    }
    const targetDigest = resolveDoneBindingDigest(storeMember, input.task_id);
    if (targetDigest === null) fail('STORE_INCONSISTENT', 'invalid_reopen_binding');
    return {
      ...input,
      // retract-anyone (B1): a reopened task is unstarted; the redo records a start.
      payload: { ...input.payload, target_done_digest: targetDigest, to_status: 'pending' },
    };
  }
  if (input.kind === 'done'
    && (exactRecord(input.payload, ['done_mode', 'evidence'])
      || exactRecord(input.payload, ['done_mode', 'imported', 'evidence']))
    && input.payload.done_mode === 'evidence_promotion') {
    // Same binding as `reopen`: a completion carried across a revision is bound
    // to the carrying `plan_genesis`, while an authored/re-promoted completion is
    // bound to its latest done event. imported/authored is canonical state, not a
    // caller assertion; resolving both under the store lock avoids a stale read.
    const targetDigest = resolveDoneBindingDigest(storeMember, input.task_id);
    const state = storeMember.tasks.find(({ task_id: taskId }) => taskId === input.task_id);
    if (targetDigest === null || state?.status !== 'done') {
      fail('STORE_INCONSISTENT', 'invalid_evidence_promotion', {
        task_id: input.task_id,
        status: state?.status ?? null,
        expected_target_done_digest: targetDigest,
        eligible_status: 'done',
        next_action: 'complete_the_task_before_promoting_evidence',
      });
    }
    return {
      ...input,
      payload: {
        done_mode: 'evidence_promotion',
        imported: state.imported,
        target_done_digest: targetDigest,
        evidence: input.payload.evidence,
      },
    };
  }
  if (input.kind === 'phase_reopen' && exactRecord(input.payload, ['reason', 'override_reason'])) {
    // ADR 0148裁定5: closed_unauditedもaccept/rejectと同じ「決定event」なので、reopenの
    // 結びつけ先として同列に探す。ここへ足し忘れると、監査なしで閉じたPhaseをreopenする
    // 手段が無くなる(target_decision_digestを解決できずphase_reopen_binding_invalidで拒否される)。
    const target = [...storeMember.journal.events].reverse().find((event) => (
      ['phase_accept', 'phase_reject', 'phase_close_unaudited'].includes(event.kind)
      && event.phase_id === input.phase_id
    ));
    if (target === undefined) fail('STORE_INCONSISTENT', 'phase_reopen_binding_invalid');
    return { ...input, payload: { ...input.payload, target_decision_digest: target.event_digest } };
  }
  return input;
}

function resolveCanonicalTaskId(plan, requestedTaskId) {
  if (requestedTaskId === null || requestedTaskId === undefined) return requestedTaskId;
  const exact = plan.tasks.find(({ task_id: taskId }) => taskId === requestedTaskId);
  if (exact) return exact.task_id;
  const folded = requestedTaskId.toLowerCase();
  const matches = plan.tasks.filter(({ task_id: taskId }) => taskId.toLowerCase() === folded);
  if (matches.length === 0) fail('TASK_NOT_FOUND', 'task_not_found', {
    requested_task_id: requestedTaskId,
  });
  if (matches.length > 1) fail('TASK_ID_AMBIGUOUS', 'task_id_case_ambiguous', {
    requested_task_id: requestedTaskId,
    matching_task_ids: matches.map(({ task_id: taskId }) => taskId).sort(),
  });
  return matches[0].task_id;
}

export async function appendTodoEvent(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  if (typeof options.validateProspectiveEvent !== 'function') {
    throw new TypeError('appendTodoEvent requires a Plan-supplied validateProspectiveEvent');
  }
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return withLock(repoRoot, async (assertHeld) => {
    const store = await readTodoStoreLocked({
      repoRoot, forWrite: true, now: options.now, assertHeld,
      repairContext: { assertHeld, actor: options.event.actor,
        recordedAt: options.event.recorded_at ?? new Date().toISOString() },
    });
    const member = store.members.find(({ descriptor }) => descriptor.plan_key === options.planKey);
    if (!member) fail('STORE_INCONSISTENT', 'plan_not_active');
    // planへ帰属するeventは別chainへ積む。task状態もPhase状態も直接は動かさないので、
    // replay・snapshot・manifestへは触れない——lifecycle journalのheadを進めるのは
    // 「作業が進んだ」の意味であり、方式選択や依存接続でそこを動かすと意味がずれる。
    if (TODO_PLAN_SCOPED_EVENT_KINDS.includes(options.event.kind)) {
      if (options.event.kind === 'cross_plan_dependency') {
        validateCrossPlanDependencyTransition(store, member, options.event, { foreignFrom: true });
      }
      if (options.event.kind === 'cross_plan_dependency_removed') {
        const digest = options.event.payload.target_event_digest;
        const events = member.plan_scoped?.events ?? [];
        const target = events.find((entry) => entry.kind === 'cross_plan_dependency'
          && entry.event_digest === digest);
        if (target === undefined) {
          fail('DEPENDENCY_NOT_FOUND', 'cross_plan_dependency_not_found', { target_event_digest: digest });
        }
        if (events.some((entry) => entry.kind === 'cross_plan_dependency_removed'
          && entry.payload.target_event_digest === digest)) {
          fail('DEPENDENCY_INVALID', 'cross_plan_dependency_already_removed', { target_event_digest: digest });
        }
      }
      return { cross_plan_repairs: store.cross_plan_repairs, ...await appendPlanScopedEvent({
        repoRoot, member, assertHeld,
        input: { ...options.event, recorded_at: options.event.recorded_at ?? new Date().toISOString() },
      }) };
    }
    const input = resolveTargetedEvent({
      ...options.event,
      task_id: resolveCanonicalTaskId(member.plan, options.event.task_id),
      recorded_at: options.event.recorded_at ?? new Date().toISOString(),
    }, member);
    const event = nextEvent(input, member);
    if ((event.kind === 'start' && event.payload.start_mode === 'historical_import')
      || (event.kind === 'done' && event.payload.done_mode === 'historical_import')) {
      fail('STORE_WRITE_CONFLICT', 'historical_import_writer_required');
    }
    // Validate the prospective history, including hard evidence and transitions, before any write.
    const validation = options.validateProspectiveEvent({ store, member, event });
    if (validation?.ok === false) {
      const { reason, ...detail } = validation.detail;
      fail(validation.code, reason, detail);
    }
    if (validation?.ok !== true) throw new TypeError('prospective validator must return an ok result');
    const appendSourceCache = { commits: new Set(), blobs: new Map() };
    prefetchVerificationObjects(store.manifest, repoRoot,
      [...member.journal.events, event], appendSourceCache);
    replay(member.plan, [...member.journal.events, event], {
      now: options.now ? new Date(options.now) : new Date(),
      verifyEvidence: evidenceVerifier(store.manifest, repoRoot, true, event.event_digest),
      verifyImportSource: importSourceVerifier(repoRoot, true, appendSourceCache, event.event_digest),
    });
    if (options.materializedEvidence !== null && options.materializedEvidence !== undefined) {
      const asset = options.materializedEvidence;
      const descriptor = event.kind === 'done' ? event.payload.evidence : null;
      if (!exactRecord(asset, ['ref', 'bytes']) || !Buffer.isBuffer(asset.bytes)
        || descriptor === null || asset.ref !== descriptor.path
        || !asset.ref.startsWith(`${STORE_ROOT_REF}/evidence/`)
        || sha256Bytes(asset.bytes) !== descriptor.content_digest) {
        throw new TypeError('materialized evidence input invalid');
      }
      // prospective replayが成立した後、journalより先に実体を同じstore lock内へ置く。
      // content-addressed pathなので再試行と同文面の並行要求も同じbytesへ収束する。
      await atomicWrite(path.resolve(repoRoot, asset.ref), asset.bytes);
    }
    const eventBytes = canonicalLine(event);
    const activeRef = member.descriptor.journal_ref;
    const activeAbsolute = path.resolve(repoRoot, activeRef);
    // A holder that lost its lock while suspended must not overwrite the new owner's journal.
    await assertHeld();
    if (member.journal.activeBytes.length + eventBytes.length > TODO_LIMITS.journalSegmentBytes) {
      const activeEvents = member.journal.segments.at(-1).events;
      const previousSegmentDigest = member.journal.segments.length > 1
        ? member.journal.segments.at(-2).events.at(-1).event_digest : '0'.repeat(64);
      const segmentDigest = sha256Bytes(member.journal.activeBytes);
      const name = `${String(activeEvents[0].sequence).padStart(12, '0')}-${String(activeEvents.at(-1).sequence).padStart(12, '0')}-${previousSegmentDigest}-${segmentDigest}.jsonl`;
      await atomicWrite(path.join(path.dirname(activeAbsolute), 'sealed', name), member.journal.activeBytes);
      await atomicWrite(activeAbsolute, eventBytes);
    } else {
      await atomicWrite(activeAbsolute, Buffer.concat([member.journal.activeBytes, eventBytes]));
    }
    await protocolStage(options, 'event_journal_published');
    const tasks = replay(member.plan, [...member.journal.events, event], {
      now: options.now ? new Date(options.now) : new Date(),
      verifyEvidence: evidenceVerifier(store.manifest, repoRoot, false),
      verifyImportSource: importSourceVerifier(repoRoot, false, appendSourceCache),
    });
    const snapshot = snapshotFor(member.plan, [...member.journal.events, event], tasks);
    await atomicWrite(path.resolve(repoRoot, member.descriptor.snapshot_ref), canonicalLine(snapshot));
    await protocolStage(options, 'event_snapshot_published');
    member.descriptor.journal_head_digest = event.event_digest;
    store.manifest.manifest_digest = todoSelfDigest(store.manifest, 'manifest_digest');
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(store.manifest));
    await protocolStage(options, 'event_manifest_published');
    // snapshot artifactの形式(v1/v2)はplanのschemaで決まったまま変えない。呼び出し側
    // (todo-cli.mjsのphaseMutation・done advisory)がPhase状態(暗黙のterminal-audit含む)を
    // 見るための導出ビューは、snapshotと分けてここで別途返す。
    const phases = projectPhaseStates(member.plan, [...member.journal.events, event],
      new Map(tasks.map((task) => [task.task_id, task])));
    return { event, snapshot, plan: member.plan, phases, cross_plan_repairs: store.cross_plan_repairs };
  });
}

/**
 * plan-scoped chainへ1件積む（ob03）。
 *
 * lifecycle journalとは独立したsequenceとhash chainを持つ。`member_heads`の
 * `through_sequence`／`journal_head_digest`は**task chainだけ**を指し続ける——
 * 「この planの lifecycleがどこまで進んだか」という意味を、方式の宣言で動かさない
 * （合成すると型も値域も同じまま意味だけずれ、消費者はexact検証を通してしまう）。
 */
function buildPlanScopedEvent(member, input) {
  const previous = member.plan_scoped.events.at(-1) ?? null;
  const event = {
    schema: 'lattice.todo_event.v3',
    project_id: member.plan.project_id,
    plan_key: member.plan.plan_key, plan_version: member.plan.plan_version,
    // chainの先頭は sequence 0（`verifyLinearHashChain`は sequence 0 ⟺ previous_digest null を
    // genesis束縛として検証する）。lifecycle journalのsequenceとは独立に数える。
    sequence: previous === null ? 0 : previous.sequence + 1,
    previous_digest: previous?.event_digest ?? null,
    kind: input.kind, task_id: null, phase_id: null,
    actor: input.actor, recorded_at: input.recorded_at,
    provenance: input.provenance ?? null, payload: input.payload, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('todo event input violates its declared schema');
  return event;
}

function planScopedEventBytes(member, event) {
  const bytes = canonicalLine(event);
  if (member.plan_scoped.activeBytes.length + bytes.length > TODO_LIMITS.journalSegmentBytes) {
    // 宣言は1 planあたり数件の想定なので封緘機構は持たない。上限へ達したら黙って捨てず、
    // typedに止めて「この設計では足りない」ことを表に出す。
    fail('STORE_WRITE_REFUSED', 'plan_scoped_journal_segment_limit_exceeded', {
      ref: member.plan_scoped.ref, limit: TODO_LIMITS.journalSegmentBytes,
    });
  }
  return bytes;
}

async function appendPlanScopedEvent({ repoRoot, member, input, assertHeld }) {
  const event = buildPlanScopedEvent(member, input);
  const bytes = planScopedEventBytes(member, event);
  await assertHeld();
  await atomicWrite(path.resolve(repoRoot, member.plan_scoped.ref),
    Buffer.concat([member.plan_scoped.activeBytes, bytes]));
  const events = [...member.plan_scoped.events, event];
  return {
    event, plan: member.plan, snapshot: member.snapshot,
    plan_scoped_head_digest: event.event_digest,
    coordination: projectTodoCoordination(events) ?? member.coordination ?? null,
  };
}

/**
 * edge-carry: a successor's plan-scoped chain starts with the predecessor's live incoming connections, so a revision
 * no longer drops them. `to` and a same-plan `from` follow the genesis task_migration onto the successor topology; a
 * removed endpoint, a self edge or a duplicate after mapping drops the edge; any other `from` stays as recorded (its
 * own plan's revision is the u03 repair's, another chart's is Plan's). Actor, time and provenance stay the
 * connection's, so the bytes depend only on the predecessor chain and the successor and a resumed transaction rebuilds
 * them. Coordination declarations are not copied (read-time inheritance, a35).
 */
function carriedPlanScopedChain(store, previous, plan, journalRef, taskMigration) {
  const live = new Set(projectTodoCrossPlanDependencies(store.members).map(({ event_digest: digest }) => digest));
  const ids = new Map(taskMigration.map(({ from_task_id: from, to_task_id: to }) => [from, to]));
  const carry = (ref) => {
    if (ref.project_id !== plan.project_id || ref.plan_key !== plan.plan_key) return ref;
    const taskId = ids.get(ref.task_id);
    return taskId === undefined || taskId === 'removed' ? null
      : { ...ref, task_id: taskId, expected_topology_digest: plan.topology_digest };
  };
  const successor = { plan, plan_scoped: { ref: planScopedJournalRef(journalRef), events: [], activeBytes: Buffer.alloc(0) } };
  const seen = new Set();
  for (const event of previous.plan_scoped?.events ?? []) {
    if (event.kind !== 'cross_plan_dependency' || !live.has(event.event_digest)) continue;
    const from = carry(event.payload.from); const to = carry(event.payload.to);
    if (from === null || to === null || mergedTaskKey(from) === mergedTaskKey(to)) continue;
    const key = `${mergedTaskKey(from)}\0${mergedTaskKey(to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const carried = buildPlanScopedEvent(successor, { kind: event.kind, actor: event.actor,
      recorded_at: event.recorded_at, provenance: event.provenance,
      payload: { from, to, reason: event.payload.reason } });
    successor.plan_scoped.activeBytes = Buffer.concat([successor.plan_scoped.activeBytes,
      planScopedEventBytes(successor, carried)]);
    successor.plan_scoped.events.push(carried);
  }
  return successor.plan_scoped;
}

/** Written before the manifest switch; the version is not active yet, so a retry rewrites it from the current predecessor. */
async function writeCarriedPlanScopedChain(repoRoot, chain) {
  const absolute = path.resolve(repoRoot, chain.ref);
  if (chain.events.length === 0) await rm(absolute, { force: true });
  else await atomicWrite(absolute, chain.activeBytes);
}

/** Rebind existing connections to a carried source without changing their endpoints. */
export async function rebindTodoCrossPlanDependencies(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  if (typeof options.validateBindingCarry !== 'function'
    || !isTodoIdentifier(options.planKey) || !isTodoIdentifier(options.sourcePlanKey)
    || !isTodoDigest(options.expectedManifestDigest)
    || !isTodoDigest(options.expectedPlanScopedHeadDigest)
    || !Array.isArray(options.eventDigests) || options.eventDigests.length === 0
    || !options.eventDigests.every(isTodoDigest)
    || new Set(options.eventDigests).size !== options.eventDigests.length
    || typeof options.reason !== 'string' || options.reason.length === 0) {
    throw new TypeError('dependency rebind requires exact bindings and a Plan carry validator');
  }
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return withLock(repoRoot, async () => {
    // The repair read must not publish derived state before the complete strict graph check.
    const store = await readTodoStoreView({ repoRoot, now: options.now });
    const owner = store.members.find(({ plan }) => plan.plan_key === options.planKey);
    const source = store.members.find(({ plan }) => plan.plan_key === options.sourcePlanKey);
    if (store.manifest.manifest_digest !== options.expectedManifestDigest
      || owner?.plan_scoped.events.at(-1)?.event_digest !== options.expectedPlanScopedHeadDigest) {
      fail('STORE_WRITE_CONFLICT', 'dependency_rebind_binding_changed');
    }
    if (!source || source === owner) fail('DEPENDENCY_INVALID', 'dependency_rebind_source_invalid');
    const dependencies = projectTodoCrossPlanDependencies(store.members)
      .filter(({ event_digest: digest }) => options.eventDigests.includes(digest));
    if (dependencies.length !== options.eventDigests.length || dependencies.some(({ from, to, event_digest: digest }) => (
      from.project_id !== source.plan.project_id || from.plan_key !== source.plan.plan_key
      || from.expected_topology_digest === source.plan.topology_digest
      || to.project_id !== owner.plan.project_id || to.plan_key !== owner.plan.plan_key
      || !owner.plan_scoped.events.some((event) => event.event_digest === digest)
    ))) fail('DEPENDENCY_INVALID', 'dependency_rebind_original_mismatch');
    const predecessorBinding = source.revision?.predecessor;
    if (!predecessorBinding) fail('DEPENDENCY_INVALID', 'dependency_rebind_predecessor_missing');
    const predecessor = await readArtifact(repoRoot,
      `${STORE_ROOT_REF}/plans/${source.plan.plan_key}/${predecessorBinding.plan_version}/plan.json`, {
        code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoPlan,
      });
    if (predecessor.project_id !== source.plan.project_id || predecessor.plan_key !== source.plan.plan_key
      || predecessor.plan_version !== predecessorBinding.plan_version
      || predecessor.plan_digest !== predecessorBinding.plan_digest) {
      fail('STORE_INCONSISTENT', 'dependency_rebind_predecessor_mismatch');
    }
    const validation = await options.validateBindingCarry({ store, source, dependencies,
      predecessor: { plan_version: predecessor.plan_version, plan_digest: predecessor.plan_digest,
        topology_digest: predecessor.topology_digest } });
    if (validation?.ok === false) {
      if (typeof validation.code !== 'string' || typeof validation.detail?.reason !== 'string') {
        throw new TypeError('binding carry validator must return a typed refusal');
      }
      const { reason, ...detail } = validation.detail;
      fail(validation.code, reason, detail);
    }
    if (validation?.ok !== true) throw new TypeError('binding carry validator must return an ok result');
    const staged = { ...owner, plan_scoped: { ...owner.plan_scoped,
      events: [...owner.plan_scoped.events] } };
    const replacements = [];
    for (const dependency of dependencies) {
      for (const input of [
        { kind: 'cross_plan_dependency_removed', payload: {
          target_event_digest: dependency.event_digest, reason: options.reason,
        } },
        { kind: 'cross_plan_dependency', payload: {
          from: { ...dependency.from, expected_topology_digest: source.plan.topology_digest },
          to: dependency.to, reason: dependency.reason,
        } },
      ]) {
        const event = buildPlanScopedEvent(staged, { ...input, actor: options.actor,
          recorded_at: options.recordedAt ?? new Date().toISOString() });
        const bytes = planScopedEventBytes(staged, event);
        staged.plan_scoped.events.push(event);
        staged.plan_scoped.activeBytes = Buffer.concat([staged.plan_scoped.activeBytes, bytes]);
      }
      replacements.push({ original_event_digest: dependency.event_digest,
        replacement_event_digest: staged.plan_scoped.events.at(-1).event_digest });
    }
    const prospective = store.members.map((member) => member === owner ? staged : member);
    const projected = projectTodoCrossPlanDependencies(prospective);
    const edgeKeys = projected.map(({ from, to }) => `${mergedTaskKey(from)}\0${mergedTaskKey(to)}`);
    if (new Set(edgeKeys).size !== edgeKeys.length) {
      fail('DEPENDENCY_EXISTS', 'cross_plan_dependency_duplicate');
    }
    validateMergedGraph(prospective, projected);
    await protocolStage(options, 'dependency_rebind_validated');
    await atomicWrite(path.resolve(repoRoot, owner.plan_scoped.ref), staged.plan_scoped.activeBytes);
    await protocolStage(options, 'dependency_rebind_published');
    return { schema: 'lattice.todo_dependency_rebind_result.v1', project_id: store.project_id,
      plan_key: owner.plan.plan_key, source_plan_key: source.plan.plan_key,
      source_topology_digest: source.plan.topology_digest, replacements,
      plan_scoped_head_digest: staged.plan_scoped.events.at(-1).event_digest };
  });
}

export function buildTodoPlan(input) {
  const plan = { ...input, topology_digest: '', plan_digest: '' };
  plan.topology_digest = digestTodoArtifact({
    project_id: plan.project_id, plan_key: plan.plan_key, plan_version: plan.plan_version,
    tasks: plan.tasks, hard_dependencies: plan.hard_dependencies, joins: plan.joins,
    ...(isPhaseTodoPlanSchema(plan.schema) ? { phases: plan.phases } : {}),
    ...(isDecoupledPhaseTodoPlanSchema(plan.schema)
      ? { phase_accept_dependencies: plan.phase_accept_dependencies } : {}),
  });
  plan.plan_digest = todoSelfDigest(plan, 'plan_digest');
  if (!validateTodoPlan(plan)) {
    const { reason, path: pointer, ...values } = explainTodoPlan(plan);
    throw Object.assign(new TypeError('todo plan input violates its declared schema'), {
      detail: { violation_kind: reason, pointer, ...values },
    });
  }
  return plan;
}

function boundPlanBackchain(plan, chain) {
  if (chain === null || chain === undefined) return null;
  if (chain.schema !== 'lattice.plan_backchain.v1'
    || chain.project_id !== plan.project_id || chain.plan_key !== plan.plan_key
    || chain.plan_version !== plan.plan_version
    || !isTodoDigest(chain.chain_digest)
    || chain.chain_digest !== todoSelfDigest(chain, 'chain_digest')) {
    fail('STORE_INCONSISTENT', 'backchain_plan_binding_invalid');
  }
  const binding = {
    schema: 'lattice.plan_backchain_binding.v1',
    plan_digest: plan.plan_digest, chain, binding_digest: '',
  };
  binding.binding_digest = todoSelfDigest(binding, 'binding_digest');
  if (Buffer.byteLength(JSON.stringify(binding), 'utf8') > TODO_LIMITS.snapshotBytes) {
    fail('STORE_WRITE_REFUSED', 'backchain_binding_too_large');
  }
  return binding;
}

export function buildPlanGenesis(plan, input) {
  const event = {
    schema: isPhaseTodoPlanSchema(plan.schema)
      ? 'lattice.todo_event.v3' : 'lattice.todo_event.v1',
    project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, sequence: 0, previous_digest: input.previous_digest ?? null,
    kind: 'plan_genesis', task_id: null,
    ...(isPhaseTodoPlanSchema(plan.schema) ? { phase_id: null } : {}),
    actor: input.actor, recorded_at: input.recorded_at,
    provenance: input.provenance ?? null,
    payload: { plan_digest: plan.plan_digest, topology_digest: plan.topology_digest,
      predecessor_plan_digest: plan.predecessor_plan_digest, task_migration: input.task_migration ?? [],
      ...(input.historical_import === true ? { historical_import: true } : {}) },
    event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('genesis input violates its declared schema');
  return event;
}

export function buildRevisionGenesis(plan, input) {
  const event = {
    schema: 'lattice.todo_event.v2', project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, sequence: 0, previous_digest: input.previous_digest,
    kind: 'plan_genesis', task_id: null, actor: input.actor, recorded_at: input.recorded_at,
    provenance: input.provenance ?? null,
    payload: { plan_digest: plan.plan_digest, topology_digest: plan.topology_digest,
      predecessor_plan_digest: plan.predecessor_plan_digest,
      task_migration: input.state_migration.map(({ from_task_id, to_task_id }) => ({
        from_task_id, to_task_id,
      })) },
    reconciliation_state: 'reconciled', revision_digest: input.revision_digest,
    reconciliation_digest: input.reconciliation_digest,
    state_migration: input.state_migration, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('revision genesis violates lattice.todo_event.v2');
  return event;
}

export function buildPhaseRevisionGenesis(plan, input) {
  const event = {
    schema: 'lattice.todo_event.v4', project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, sequence: 0, previous_digest: input.previous_digest,
    kind: 'plan_genesis', task_id: null, phase_id: null, actor: input.actor,
    recorded_at: input.recorded_at, provenance: input.provenance ?? null,
    payload: { plan_digest: plan.plan_digest, topology_digest: plan.topology_digest,
      predecessor_plan_digest: plan.predecessor_plan_digest,
      task_migration: input.state_migration.map(({ from_task_id, to_task_id }) => ({
        from_task_id, to_task_id,
      })) },
    revision_digest: input.revision_digest, state_migration: input.state_migration,
    phase_state_migration: input.phase_state_migration, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('phase revision genesis violates lattice.todo_event.v4');
  return event;
}

function buildHistoricalDone(plan, previous, input, genesis) {
  const event = {
    schema: 'lattice.todo_event.v1', project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, sequence: previous.sequence + 1, previous_digest: previous.event_digest,
    kind: 'done', task_id: input.task_id, actor: input.actor ?? genesis.actor,
    recorded_at: input.recorded_at ?? genesis.recorded_at, provenance: input.provenance ?? null,
    payload: { done_mode: 'historical_import', imported: true, status: 'done',
      completed_at: input.completed_at, evidence: input.evidence }, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('historical done input violates lattice.todo_event.v1');
  return event;
}

function buildHistoricalStart(plan, previous, input, genesis) {
  const event = {
    schema: 'lattice.todo_event.v1', project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, sequence: previous.sequence + 1, previous_digest: previous.event_digest,
    kind: 'start', task_id: input.task_id, actor: input.actor ?? genesis.actor,
    recorded_at: input.recorded_at ?? genesis.recorded_at, provenance: input.provenance ?? null,
    payload: { start_mode: 'historical_import', imported: true, status: 'in-progress',
      started_at: input.started_at, evidence: input.evidence }, event_digest: '',
  };
  event.event_digest = todoSelfDigest(event, 'event_digest');
  if (!validateTodoEvent(event)) throw new TypeError('historical start input violates lattice.todo_event.v1');
  return event;
}

function historicalImportInputs(value, timestampKey) {
  const required = ['task_id', timestampKey, 'evidence'];
  const allowed = new Set([...required, 'actor', 'recorded_at', 'provenance']);
  return Array.isArray(value) && value.length <= TODO_LIMITS.tasksPerPlan
    && value.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && Object.getPrototypeOf(entry) === Object.prototype
      && required.every((key) => Object.hasOwn(entry, key))
      && Object.keys(entry).every((key) => allowed.has(key)));
}

function prepareImportedArtifacts(repoRoot, options, projectId, memberPlans) {
  const importSourceCache = { commits: new Set(), blobs: new Map() };
  const planInput = materializeImportedNarrativeAnchors(
    repoRoot, options.plan, options.narrativeAnchorSources, importSourceCache,
  );
  const plan = buildTodoPlan(planInput);
  if (plan.project_id !== projectId || plan.predecessor_plan_digest !== null) {
    throw new TypeError('imported plan must be a project-local genesis plan');
  }
  verifyPlanNarrativeAnchors(repoRoot, plan, null, importSourceCache);
  const genesis = buildPlanGenesis(plan, { ...options.genesis, historical_import: true });
  const events = [genesis];
  const inProgressTasks = options.inProgressTasks ?? [];
  const completedTasks = options.completedTasks ?? [];
  if (!historicalImportInputs(inProgressTasks, 'started_at')
    || !historicalImportInputs(completedTasks, 'completed_at')) {
    fail('STORE_INCONSISTENT', 'historical_import_disposition_invalid');
  }
  const inProgressIds = new Set(inProgressTasks.map(({ task_id: taskId }) => taskId));
  const completedIds = new Set(completedTasks.map(({ task_id: taskId }) => taskId));
  if (inProgressIds.size !== inProgressTasks.length
    || completedIds.size !== completedTasks.length
    || [...inProgressIds].some((taskId) => completedIds.has(taskId))) {
    fail('STORE_INCONSISTENT', 'historical_import_disposition_conflict');
  }
  for (const input of inProgressTasks) events.push(buildHistoricalStart(plan, events.at(-1), input, genesis));
  for (const input of completedTasks) events.push(buildHistoricalDone(plan, events.at(-1), input, genesis));
  const verifyImportSource = importSourceVerifier(repoRoot, true, importSourceCache);
  const tasks = replay(plan, events, {
    now: options.now ? new Date(options.now) : new Date(), verifyImportSource,
  });
  validateMergedGraph([...memberPlans, { plan }], undefined, { newPlanKey: plan.plan_key });
  return { plan, genesis, events, tasks, snapshot: snapshotFor(plan, events, tasks) };
}

async function bootstrapImportedPlan(repoRoot, options) {
  const initialization = options.initializeIfMissing;
  if (!exactRecord(initialization, ['projectId', 'repositories'])
    || initialization.projectId !== options.plan?.project_id) {
    throw new TypeError('historical import initialization input invalid');
  }
  const prepared = prepareImportedArtifacts(repoRoot, options, initialization.projectId, []);
  const { plan, genesis, events, snapshot } = prepared;
  const backchain = boundPlanBackchain(plan, options.featureChain);
  const base = `${STORE_ROOT_REF}/plans/${plan.plan_key}/${plan.plan_version}`;
  const planRef = `${base}/plan.json`;
  const journalRef = `${base}/journal/active.jsonl`;
  const snapshotRef = `${base}/snapshot.json`;
  const descriptor = { plan_key: plan.plan_key, active_plan_version: plan.plan_version,
    plan_ref: planRef, journal_ref: journalRef, snapshot_ref: snapshotRef,
    topology_digest: plan.topology_digest, journal_head_digest: events.at(-1).event_digest };
  const manifest = { schema: 'lattice.todo_manifest.v1', project_id: initialization.projectId,
    repositories: initialization.repositories, members: [descriptor], manifest_digest: '' };
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  if (!validateTodoManifest(manifest)) throw new TypeError('manifest input violates lattice.todo_manifest.v1');

  const stage = path.join(repoRoot, `.lattice-todo-bootstrap-${process.pid}-${randomBytes(6).toString('hex')}`);
  const latticeRoot = path.join(repoRoot, '.lattice');
  const storeRoot = path.join(repoRoot, STORE_ROOT_REF);
  let createdLatticeRoot = false;
  let activated = false;
  try {
    await mkdir(stage, { mode: 0o700 });
    const stagedBase = path.join(stage, 'plans', plan.plan_key, plan.plan_version);
    await atomicWrite(path.join(stagedBase, 'plan.json'), canonicalLine(plan));
    await atomicWrite(path.join(stagedBase, 'journal', 'active.jsonl'), Buffer.concat(events.map(canonicalLine)));
    await atomicWrite(path.join(stagedBase, 'snapshot.json'), canonicalLine(snapshot));
    if (backchain !== null) await atomicWrite(path.join(stagedBase, 'backchain.json'), canonicalLine(backchain));
    await atomicWrite(path.join(stage, 'manifest.json'), canonicalLine(manifest));
    await protocolStage(options, 'bootstrap_staged');

    try {
      const state = await lstat(latticeRoot);
      if (state.isSymbolicLink() || !state.isDirectory()) fail('STORE_INCONSISTENT', 'unsafe_lattice_root');
    } catch (error) {
      if (error instanceof TodoStoreError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(latticeRoot, { mode: 0o700 });
      createdLatticeRoot = true;
      await fsyncDirectory(repoRoot);
    }
    await ensureLatticeEolProtection(latticeRoot);
    await protocolStage(options, 'bootstrap_parent_prepared');
    try { await rename(stage, storeRoot); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
        fail('STORE_WRITE_CONFLICT', 'store_bootstrap_raced');
      }
      throw error;
    }
    activated = true;
    await fsyncDirectory(latticeRoot);
    await protocolStage(options, 'bootstrap_activated');
    return { plan, genesis, events, snapshot, descriptor };
  } finally {
    if (!activated) await rm(stage, { recursive: true, force: true });
    if (!activated && createdLatticeRoot) {
      // 自分で作ったroot直下の同梱.gitattributesを先に消さないとrmdirがENOTEMPTYで残る。
      await rm(path.join(latticeRoot, '.gitattributes'), { force: true });
      try { await rmdir(latticeRoot); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
    }
  }
}

// storeはcanonical JSON+LFのバイト列契約。保護をrepo側任せにすると、store生成先の消費者repoが
// Windows autocrlf checkoutでstore全体をfail closedさせる（0.52.1で実害）。生成物と一緒に敷く。
// 既存の.gitattributesは所有者の編集として尊重し、上書きしない。
const LATTICE_ROOT_GITATTRIBUTES = '# Lattice store artifacts are canonical JSON+LF bytes; EOL conversion corrupts the store.\n* -text\n';

async function ensureLatticeEolProtection(latticeRoot) {
  const target = path.join(latticeRoot, '.gitattributes');
  try { await lstat(target); return; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await atomicWrite(target, Buffer.from(LATTICE_ROOT_GITATTRIBUTES, 'utf8'));
}

async function protocolStage(options, stage) {
  if (typeof options.onProtocolStage === 'function') await options.onProtocolStage(stage);
}

function cloneImportedDependencyMember(member) {
  return {
    ...member,
    plan_scoped: {
      ...(member.plan_scoped ?? {}),
      events: [...(member.plan_scoped?.events ?? [])],
      activeBytes: Buffer.from(member.plan_scoped?.activeBytes ?? Buffer.alloc(0)),
    },
  };
}

function importedDependencyRef(ref, plan) {
  if (ref.project_id !== plan.project_id || ref.plan_key !== plan.plan_key
    || ref.expected_topology_digest !== undefined) return ref;
  return { ...ref, expected_topology_digest: plan.topology_digest };
}

function prepareCrossPlanDependencies({ store, dependencies, genesis, imported = null }) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    return { events: [], artifacts: [] };
  }
  const members = [...store.members.map(cloneImportedDependencyMember)];
  if (imported !== null) {
    members.push({
      plan: imported.plan, tasks: imported.tasks,
      plan_scoped: {
        ref: planScopedJournalRef(imported.journalRef), events: [], activeBytes: Buffer.alloc(0),
      },
    });
  }
  const artifacts = new Map();
  const events = [];
  for (const dependency of dependencies) {
    const from = imported === null ? dependency.from : importedDependencyRef(dependency.from, imported.plan);
    const to = imported === null ? dependency.to : importedDependencyRef(dependency.to, imported.plan);
    const target = members.find(({ plan: targetPlan }) => targetPlan.project_id === to.project_id
      && targetPlan.plan_key === to.plan_key);
    if (target === undefined) {
      // Reuse the existing dependency presence diagnostic for an unknown target plan.
      crossPlanDependencyTask({ ...store, members }, to);
    }
    const input = {
      kind: 'cross_plan_dependency', actor: genesis.actor, recorded_at: genesis.recorded_at,
      provenance: genesis.provenance ?? null,
      payload: { from, to, reason: dependency.reason },
    };
    const validationStore = { ...store, members };
    validateCrossPlanDependencyTransition(validationStore, target, input);
    const event = buildPlanScopedEvent(target, input);
    const bytes = planScopedEventBytes(target, event);
    const key = target.plan_scoped.ref;
    const artifact = artifacts.get(key) ?? {
      ref: key,
      originalBytes: Buffer.from(target.plan_scoped.activeBytes),
      finalBytes: Buffer.from(target.plan_scoped.activeBytes),
      events: [],
    };
    artifact.finalBytes = Buffer.concat([artifact.finalBytes, bytes]);
    artifact.events.push(event);
    artifacts.set(key, artifact);
    target.plan_scoped.events.push(event);
    target.plan_scoped.activeBytes = Buffer.concat([target.plan_scoped.activeBytes, bytes]);
    events.push(event);
  }
  return { events, artifacts: [...artifacts.values()] };
}

function prepareImportedCrossPlanDependencies({ store, plan, tasks, dependencies, genesis, journalRef }) {
  return prepareCrossPlanDependencies({
    store, dependencies, genesis, imported: { plan, tasks, journalRef },
  });
}

function importedTransactionDescriptor(value) {
  const v1Keys = [
    'plan_key', 'active_plan_version', 'plan_ref', 'journal_ref', 'snapshot_ref',
    'topology_digest', 'journal_head_digest',
  ];
  const v2Keys = [...v1Keys, 'active_revision_digest'];
  return (exactRecord(value, v1Keys) || exactRecord(value, v2Keys))
    && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.active_plan_version)
    && [value.plan_ref, value.journal_ref, value.snapshot_ref].every((ref) => isTodoRef(ref)
      && ref.startsWith(`${STORE_ROOT_REF}/plans/`))
    && [value.topology_digest, value.journal_head_digest,
      ...(Object.hasOwn(value, 'active_revision_digest') ? [value.active_revision_digest] : [])]
      .every(isTodoDigest);
}

function transactionStoreRef(value) {
  return isTodoRef(value) && value.startsWith(`${STORE_ROOT_REF}/`);
}

function validateCrossPlanImportTransaction(value) {
  return exactRecord(value, [
    'schema', 'transaction_digest', 'descriptor', 'artifacts', 'events',
  ]) && value.schema === CROSS_PLAN_IMPORT_TRANSACTION_SCHEMA
    && isTodoDigest(value.transaction_digest) && importedTransactionDescriptor(value.descriptor)
    && Array.isArray(value.artifacts) && value.artifacts.length === 1
    && value.artifacts.every((artifact) => exactRecord(artifact, [
      'ref', 'staged_ref', 'bytes_digest',
    ]) && transactionStoreRef(artifact.ref) && transactionStoreRef(artifact.staged_ref)
      && artifact.staged_ref.startsWith(`${CROSS_PLAN_IMPORT_TRANSACTIONS_REF}/`)
      && isTodoDigest(artifact.bytes_digest))
    && Array.isArray(value.events) && value.events.length === 1
    && value.events.every((event) => validateTodoEvent(event)
      && event.kind === 'cross_plan_dependency');
}

function importedPlanTransactionDigest(options) {
  const input = {
    schema: 'lattice.todo_cross_plan_import_request.v1', plan: options.plan,
    genesis: options.genesis, cross_plan_dependencies: options.crossPlanDependencies ?? [],
    narrative_anchor_sources: options.narrativeAnchorSources ?? [],
    completed_tasks: options.completedTasks ?? [], in_progress_tasks: options.inProgressTasks ?? [],
    transaction_digest: '',
  };
  return todoSelfDigest(input, 'transaction_digest');
}

function importedCrossPlanTransaction({ transactionDigest, descriptor, transactionRef, importedCrossPlan }) {
  return {
    schema: CROSS_PLAN_IMPORT_TRANSACTION_SCHEMA,
    transaction_digest: transactionDigest,
    descriptor: structuredClone(descriptor),
    artifacts: importedCrossPlan.artifacts.map((artifact, index) => ({
      ref: artifact.ref,
      staged_ref: path.posix.join(transactionRef, 'plan-scoped', `${index}.jsonl`),
      bytes_digest: sha256Bytes(artifact.finalBytes),
    })),
    events: structuredClone(importedCrossPlan.events),
  };
}

async function crossPlanImportTransactions(repoRoot) {
  const root = path.resolve(repoRoot, CROSS_PLAN_IMPORT_TRANSACTIONS_REF);
  let names;
  try { names = (await readdir(root)).sort(); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const transactions = [];
  for (const name of names) {
    if (!isTodoIdentifier(name)) fail('STORE_INCONSISTENT', 'cross_plan_transaction_name_invalid', { name });
    const transactionRef = path.posix.join(CROSS_PLAN_IMPORT_TRANSACTIONS_REF, name);
    const markerRef = path.posix.join(transactionRef, 'transaction.json');
    const marker = await readArtifact(repoRoot, markerRef, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes,
      validate: validateCrossPlanImportTransaction, missing: true,
    });
    // marker durable前にprocessが止まったdirectoryはstoreへ一切公開されていない。
    // 同一入力の次回writerがtransaction pathを作り直すまで、通常readからは無視する。
    if (marker === null) continue;
    transactions.push({ transactionRef, marker });
  }
  return transactions;
}

function transactionManifestMember(manifest, marker) {
  const member = manifest.members.find(({ plan_key: planKey }) => planKey === marker.descriptor.plan_key);
  if (member === undefined) return null;
  if (canonicalizeTodoArtifact(member) !== canonicalizeTodoArtifact(marker.descriptor)) {
    fail('STORE_INCONSISTENT', 'cross_plan_transaction_manifest_conflict', {
      plan_key: marker.descriptor.plan_key,
    });
  }
  return member;
}

async function finalizeVisibleCrossPlanImport(repoRoot, transaction, { removeTransaction }) {
  for (const artifact of transaction.marker.artifacts) {
    const state = await pathState(repoRoot, artifact.staged_ref, 'STORE_INCONSISTENT');
    const bytes = await readFile(state.absolute);
    if (sha256Bytes(bytes) !== artifact.bytes_digest) {
      fail('STORE_INCONSISTENT', 'cross_plan_transaction_staging_digest_mismatch', {
        ref: artifact.staged_ref,
      });
    }
    const eventBytes = canonicalLine(transaction.marker.events[0]);
    if (!bytes.subarray(-eventBytes.length).equals(eventBytes)) {
      fail('STORE_INCONSISTENT', 'cross_plan_transaction_staging_digest_mismatch', { ref: artifact.staged_ref });
    }
    const target = await pathState(repoRoot, artifact.ref, 'STORE_INCONSISTENT', { missing: true });
    const current = target === null ? Buffer.alloc(0) : normalizeCheckoutEol(await readFile(target.absolute));
    const before = bytes.subarray(0, bytes.length - eventBytes.length);
    if (!current.equals(before) && !current.equals(bytes)) {
      fail('STORE_INCONSISTENT', 'cross_plan_transaction_staging_digest_mismatch', { ref: artifact.ref });
    }
    if (!current.equals(bytes)) await atomicWrite(path.resolve(repoRoot, artifact.ref), bytes);
  }
  if (removeTransaction) {
    await rm(path.resolve(repoRoot, transaction.transactionRef), { recursive: true, force: true });
  }
}

async function assertNoCrossPlanImportRecoveryNeeded(repoRoot) {
  const transactions = await crossPlanImportTransactions(repoRoot);
  if (transactions.length === 0) return;
  let manifest;
  try {
    manifest = await readArtifact(repoRoot, MANIFEST_REF, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
    });
  } catch (error) {
    if (error instanceof TodoStoreError && error.detail.reason === 'artifact_missing') manifest = null;
    else throw error;
  }
  const transaction = transactions[0];
  const visible = manifest !== null
    && transactionManifestMember(manifest, transaction.marker) !== null;
  fail('STORE_RECOVERY_REQUIRED', 'cross_plan_import_recovery_required', {
    plan_key: transaction.marker.descriptor.plan_key,
    transaction_digest: transaction.marker.transaction_digest,
    state: visible ? 'manifest_activated' : 'pre_activation',
    next_action: 'lattice todo status --json',
  });
}

async function recoverCrossPlanImports(repoRoot) {
  const transactions = await crossPlanImportTransactions(repoRoot);
  if (transactions.length === 0) return [];
  let manifest;
  try {
    manifest = await readArtifact(repoRoot, MANIFEST_REF, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
    });
  } catch (error) {
    if (error instanceof TodoStoreError && error.detail.reason === 'artifact_missing') manifest = null;
    else throw error;
  }
  const recovered = [];
  for (const transaction of transactions) {
    const member = manifest === null ? null : transactionManifestMember(manifest, transaction.marker);
    if (member !== null) {
      await finalizeVisibleCrossPlanImport(repoRoot, transaction, {
        removeTransaction: true,
      });
      recovered.push(transaction.marker);
      continue;
    }
    await rm(path.dirname(path.resolve(repoRoot, transaction.marker.descriptor.plan_ref)), {
      recursive: true, force: true,
    });
    await rm(path.resolve(repoRoot, transaction.transactionRef), { recursive: true, force: true });
  }
  return recovered;
}

async function recoveredImportedPlanResult(repoRoot, marker, now) {
  const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === marker.descriptor.plan_key);
  if (member === undefined) fail('STORE_INCONSISTENT', 'cross_plan_transaction_recovery_missing_plan');
  return {
    plan: member.plan, genesis: member.journal.events[0], events: member.journal.events,
    snapshot: member.snapshot, descriptor: member.descriptor,
    crossPlanDependencies: marker.events, recovered: true,
  };
}

async function appendExistingCrossPlanDependency(options) {
  if (!exactRecord(options.connectionPlan, ['project_id', 'plan_key', 'plan_version'])
    || !isTodoIdentifier(options.connectionPlan.project_id)
    || !isTodoIdentifier(options.connectionPlan.plan_key)
    || !isTodoIdentifier(options.connectionPlan.plan_version)
    || !Array.isArray(options.crossPlanDependencies) || options.crossPlanDependencies.length !== 1) {
    throw new TypeError('existing cross-plan dependency input invalid');
  }
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const source = store.members.find(({ plan }) => plan.project_id === options.connectionPlan.project_id
      && plan.plan_key === options.connectionPlan.plan_key);
    if (source === undefined) {
      fail('DEPENDENCY_INVALID', 'dependency_plan_not_found', { ref: options.connectionPlan });
    }
    if (source.plan.plan_version !== options.connectionPlan.plan_version) {
      fail('DEPENDENCY_STALE', 'connection_plan_version_stale', {
        expected_plan_version: options.connectionPlan.plan_version,
        actual_plan_version: source.plan.plan_version,
      });
    }
    const prepared = prepareCrossPlanDependencies({
      store, dependencies: options.crossPlanDependencies, genesis: options.genesis,
    });
    if (prepared.artifacts.length !== 1 || prepared.events.length !== 1) {
      throw new TypeError('existing cross-plan dependency must produce one target event');
    }
    const artifact = prepared.artifacts[0];
    await protocolStage(options, 'cross_plan_connection_validated');
    await atomicWrite(path.resolve(repoRoot, artifact.ref), artifact.finalBytes);
    await protocolStage(options, 'cross_plan_connection_activated');
    return {
      plan: source.plan, genesis: source.journal.events[0], events: source.journal.events,
      snapshot: source.snapshot, descriptor: source.descriptor,
      crossPlanDependencies: prepared.events, connectionOnly: true,
    };
  }, { onProtocolStage: options.onProtocolStage });
}

/** G4-only atomic import, with optional all-or-nothing store bootstrap. */
export async function appendImportedPlan(options = {}) {
  requireWriter(options.writer, 'g4-migration');
  if (options.connectionOnly === true) return appendExistingCrossPlanDependency(options);
  if (Array.isArray(options.crossPlanDependencies) && options.crossPlanDependencies.length > 1) {
    throw new TypeError('cross-plan migration accepts at most one dependency');
  }
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (options.initializeIfMissing !== undefined) {
    try { await lstat(path.join(repoRoot, STORE_ROOT_REF)); }
    catch (error) {
      if (error?.code === 'ENOENT') return bootstrapImportedPlan(repoRoot, options);
      throw error;
    }
    if (await isUninitializedTodoStore({ repoRoot })) {
      fail('STORE_INCONSISTENT', 'artifact_missing', {
        ref: MANIFEST_REF,
        next_action: `Confirm no writer, then clear only abandoned lock/tmp residue from ${path.join(repoRoot, STORE_ROOT_REF)} and retry the same migration input; preserve any member or note data.`,
      });
    }
  }
  return appendPlanMembership(repoRoot, options, false);
}

/** G5-only new membership; existing keys are never revisions or idempotent creates. */
export async function appendAuthoredTodoPlan(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const keys = ['repoRoot', 'writer', 'plan', 'genesis'];
  if (options.featureChain !== undefined) keys.push('featureChain');
  if (options.onProtocolStage !== undefined) keys.push('onProtocolStage');
  if (!exactRecord(options, keys)
    || (options.onProtocolStage !== undefined && typeof options.onProtocolStage !== 'function')
    || !(exactRecord(options.genesis, ['actor', 'recorded_at'])
      || exactRecord(options.genesis, ['actor', 'recorded_at', 'provenance']))) {
    throw new TypeError('authored plan addition input invalid');
  }
  return appendPlanMembership(path.resolve(options.repoRoot), options, true);
}

function prepareAuthoredArtifacts(repoRoot, options, store) {
  if (!validateTodoPlan(options.plan) || options.plan.predecessor_plan_digest !== null) {
    throw new TypeError('authored plan must be a valid genesis plan');
  }
  const plan = options.plan;
  if (plan.project_id !== store.project_id) fail('STORE_WRITE_CONFLICT', 'project_id_mismatch', {
    expected: store.project_id, actual: plan.project_id,
  });
  verifyPlanNarrativeAnchors(repoRoot, plan);
  const genesis = buildPlanGenesis(plan, options.genesis);
  const events = [genesis];
  const tasks = replay(plan, events);
  validateMergedGraph([...store.members, { plan }], undefined, { newPlanKey: plan.plan_key });
  return { plan, genesis, events, tasks, snapshot: snapshotFor(plan, events, tasks) };
}

async function assertUnpublishedPlanFiles(directory, expected) {
  const occupied = (ref) => fail('REVISION_CONFLICT', 'revision_bytes_conflict', {
    ref,
    next_action: `Restore the expected unpublished files at ${directory} or use another plan key/version; existing bytes were preserved.`,
  });
  async function visit(current, prefix = '') {
    const state = await lstat(current).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    });
    if (state === null) return;
    if (state.isSymbolicLink() || !state.isDirectory()) occupied(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory() && [...expected.keys()].some((ref) => ref.startsWith(`${relative}/`))) {
        await visit(path.join(current, entry.name), `${relative}/`);
      } else if (!entry.isFile() || !expected.has(relative)
        || !(await readFile(path.join(current, entry.name))).equals(expected.get(relative))) {
        occupied(path.join(directory, relative));
      }
    }
    if (!sameDirectoryIdentity(state, await lstat(current))) occupied(current);
  }
  await visit(directory);
}

async function appendPlanMembership(repoRoot, options, authored) {
  const transactionDigest = authored ? null : importedPlanTransactionDigest(options);
  return withLock(repoRoot, async () => {
    const recovered = await recoverCrossPlanImports(repoRoot);
    const recoveredOwnTransaction = recovered.find((marker) => marker.transaction_digest === transactionDigest);
    if (!authored && recoveredOwnTransaction !== undefined) {
      return recoveredImportedPlanResult(repoRoot, recoveredOwnTransaction, options.now);
    }
    // 1. Validate canonical manifest bytes and every current member before preparing output.
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const expectedManifestDigest = store.manifest.manifest_digest;
    await protocolStage(options, 'manifest_validated');

    // 2. A plan key is never overwritten, merged, or treated as an idempotent success.
    const existing = store.members.find(({ descriptor }) => descriptor.plan_key === options.plan?.plan_key);
    if (existing) {
      const imported = !authored && existing.journal.events[0]?.payload.historical_import === true;
      fail('STORE_WRITE_CONFLICT', imported ? 'plan_key_already_imported' : 'plan_key_already_exists');
    }
    await protocolStage(options, 'plan_key_absent');

    const prepared = authored ? prepareAuthoredArtifacts(repoRoot, options, store) : prepareImportedArtifacts(
      repoRoot, options, store.project_id, store.members.map(({ plan: memberPlan }) => ({ plan: memberPlan })),
    );
    const { plan, genesis, events, snapshot, tasks } = prepared;
    const backchain = boundPlanBackchain(plan, options.featureChain);

    const base = `${STORE_ROOT_REF}/plans/${plan.plan_key}/${plan.plan_version}`;
    const planRef = `${base}/plan.json`;
    const journalRef = `${base}/journal/active.jsonl`;
    const snapshotRef = `${base}/snapshot.json`;
    const importedCrossPlan = authored ? { artifacts: [], events: [] } : prepareImportedCrossPlanDependencies({
      store, plan, tasks, dependencies: options.crossPlanDependencies, genesis, journalRef,
    });
    const hasCrossPlanDependencies = importedCrossPlan.artifacts.length > 0;
    const transactionRef = hasCrossPlanDependencies
      ? `${CROSS_PLAN_IMPORT_TRANSACTIONS_REF}/${transactionDigest}`
      : `${STORE_ROOT_REF}/transactions/${plan.plan_key}-${plan.plan_version}`;
    const transactionAbsolute = path.resolve(repoRoot, transactionRef);
    const finalBaseAbsolute = path.resolve(repoRoot, base);
    await ensureSafeStoreDirectory(repoRoot, path.dirname(transactionAbsolute));
    await ensureSafeStoreDirectory(repoRoot, path.dirname(finalBaseAbsolute));
    const expected = new Map([
      ['plan.json', canonicalLine(plan)], ['journal/active.jsonl', Buffer.concat(events.map(canonicalLine))],
      ['snapshot.json', canonicalLine(snapshot)],
      ...(backchain === null ? [] : [['backchain.json', canonicalLine(backchain)]]),
    ]);
    const stagedExpected = new Map([...expected].map(([ref, bytes]) => [
      hasCrossPlanDependencies ? `plan/${ref}` : ref === 'journal/active.jsonl' ? 'active.jsonl' : ref,
      bytes,
    ]));
    for (const [index, artifact] of importedCrossPlan.artifacts.entries()) {
      stagedExpected.set(`plan-scoped/${index}.jsonl`, artifact.finalBytes);
    }
    await assertUnpublishedPlanFiles(transactionAbsolute, stagedExpected);
    await assertUnpublishedPlanFiles(finalBaseAbsolute, expected);
    // Only enumerated, byte-identical unpublished artifacts can be replaced.
    await rm(transactionAbsolute, { recursive: true, force: true });
    await rm(finalBaseAbsolute, { recursive: true, force: true });

    // 3. All future member artifacts are durable while still outside manifest membership.
    const stagedBase = hasCrossPlanDependencies ? path.join(transactionAbsolute, 'plan') : transactionAbsolute;
    const stagedPlan = path.join(stagedBase, 'plan.json');
    const stagedJournal = hasCrossPlanDependencies
      ? path.join(stagedBase, 'journal', 'active.jsonl') : path.join(stagedBase, 'active.jsonl');
    const stagedSnapshot = path.join(stagedBase, 'snapshot.json');
    await atomicWrite(stagedPlan, canonicalLine(plan));
    await atomicWrite(stagedJournal, Buffer.concat(events.map(canonicalLine)));
    await atomicWrite(stagedSnapshot, canonicalLine(snapshot));
    if (backchain !== null) await atomicWrite(path.join(stagedBase, 'backchain.json'), canonicalLine(backchain));
    for (const [index, artifact] of importedCrossPlan.artifacts.entries()) {
      artifact.stagedAbsolute = path.join(transactionAbsolute, 'plan-scoped', `${index}.jsonl`);
      await atomicWrite(artifact.stagedAbsolute, artifact.finalBytes);
    }
    if (importedCrossPlan.artifacts.length > 0) {
      await protocolStage(options, 'cross_plan_dependencies_staged');
    }
    await protocolStage(options, 'staging_fsynced');

    // 4. Re-read canonical manifest bytes under the lock and compare the captured digest.
    const currentManifest = await readArtifact(repoRoot, MANIFEST_REF, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
    });
    const originalManifest = structuredClone(currentManifest);
    if (currentManifest.manifest_digest !== expectedManifestDigest) {
      fail('STORE_WRITE_CONFLICT', 'manifest_digest_changed');
    }
    await protocolStage(options, 'manifest_cas_matched');

    // 5. Pre-activation paths remain invisible until the final manifest rename.
    const descriptor = { plan_key: plan.plan_key, active_plan_version: plan.plan_version,
      plan_ref: planRef, journal_ref: journalRef, snapshot_ref: snapshotRef,
      topology_digest: plan.topology_digest, journal_head_digest: events.at(-1).event_digest,
      ...(currentManifest.schema === 'lattice.todo_manifest.v2'
        ? { active_revision_digest: plan.plan_digest } : {}) };
    if (hasCrossPlanDependencies) {
      const transaction = importedCrossPlanTransaction({
        transactionDigest, descriptor, transactionRef, importedCrossPlan,
      });
      await atomicWrite(path.join(transactionAbsolute, 'transaction.json'), canonicalLine(transaction));
      await protocolStage(options, 'cross_plan_transaction_durable');
    }
    try {
      if (hasCrossPlanDependencies) {
        await mkdir(path.dirname(finalBaseAbsolute), { recursive: true });
        await rename(stagedBase, finalBaseAbsolute);
        await fsyncDirectory(path.dirname(finalBaseAbsolute));
        await protocolStage(options, 'plan_directory_renamed');
      } else {
        await mkdir(path.dirname(path.resolve(repoRoot, planRef)), { recursive: true });
        await mkdir(path.dirname(path.resolve(repoRoot, journalRef)), { recursive: true });
        await rename(stagedPlan, path.resolve(repoRoot, planRef));
        await rename(stagedJournal, path.resolve(repoRoot, journalRef));
        await rename(stagedSnapshot, path.resolve(repoRoot, snapshotRef));
        if (backchain !== null) {
          await rename(path.join(stagedBase, 'backchain.json'), path.join(finalBaseAbsolute, 'backchain.json'));
        }
        await fsyncDirectory(path.dirname(path.resolve(repoRoot, planRef)));
        await fsyncDirectory(path.dirname(path.resolve(repoRoot, journalRef)));
      }
      await protocolStage(options, 'pre_activation_renamed');

      currentManifest.members.push(descriptor);
      currentManifest.members.sort((left, right) => left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1 : 0);
      currentManifest.manifest_digest = todoSelfDigest(currentManifest, 'manifest_digest');
      if (!validateTodoManifest(currentManifest)) throw new TypeError('import activation manifest invalid');
      await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(currentManifest));
      await protocolStage(options, 'manifest_activated');

      for (const artifact of importedCrossPlan.artifacts) {
        await atomicWrite(path.resolve(repoRoot, artifact.ref), artifact.finalBytes);
      }
      if (importedCrossPlan.artifacts.length > 0) {
        await protocolStage(options, 'cross_plan_dependencies_activated');
      }
      await rm(transactionAbsolute, { recursive: true, force: true });
      if (authored) return readTodoStoreLocked({ repoRoot, forWrite: true });
      return {
        plan, genesis, events, snapshot, descriptor,
        crossPlanDependencies: importedCrossPlan.events,
      };
    } catch (error) {
      // The normal historical-import recovery contract intentionally leaves a
      // manifest-activated plan for retry. Once a cross-plan edge is part of
      // the request, roll back every activated artifact so plan and edge never
      // become independently durable.
      if (importedCrossPlan.artifacts.length > 0) {
        for (const artifact of [...importedCrossPlan.artifacts].reverse()) {
          const targetAbsolute = path.resolve(repoRoot, artifact.ref);
          if (artifact.originalBytes.length > 0) {
            await atomicWrite(targetAbsolute, artifact.originalBytes);
          } else {
            await rm(targetAbsolute, { force: true });
          }
        }
        await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(originalManifest));
        await rm(finalBaseAbsolute, { recursive: true, force: true });
        await rm(transactionAbsolute, { recursive: true, force: true });
      }
      throw error;
    }
  }, { onProtocolStage: options.onProtocolStage });
}

export async function initializeTodoStore(options = {}) {
  requireWriter(options.writer, 'g4-migration');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (!Array.isArray(options.plans) || options.plans.length === 0) throw new TypeError('plans required');
  return withLock(repoRoot, async () => {
    try { await lstat(path.resolve(repoRoot, MANIFEST_REF)); fail('STORE_WRITE_CONFLICT', 'store_already_exists'); }
    catch (error) { if (error instanceof TodoStoreError) throw error; if (error?.code !== 'ENOENT') throw error; }
    const members = [];
    for (const entry of options.plans) {
      const plan = buildTodoPlan(entry.plan);
      verifyPlanNarrativeAnchors(repoRoot, plan);
      const genesis = buildPlanGenesis(plan, entry.genesis);
      const base = `${STORE_ROOT_REF}/plans/${plan.plan_key}/${plan.plan_version}`;
      const planRef = `${base}/plan.json`; const journalRef = `${base}/journal/active.jsonl`; const snapshotRef = `${base}/snapshot.json`;
      await atomicWrite(path.resolve(repoRoot, planRef), canonicalLine(plan));
      await atomicWrite(path.resolve(repoRoot, journalRef), canonicalLine(genesis));
      const snapshot = snapshotFor(plan, [genesis], replay(plan, [genesis], { now: options.now ? new Date(options.now) : new Date() }));
      await atomicWrite(path.resolve(repoRoot, snapshotRef), canonicalLine(snapshot));
      members.push({ plan_key: plan.plan_key, active_plan_version: plan.plan_version, plan_ref: planRef,
        journal_ref: journalRef, snapshot_ref: snapshotRef, topology_digest: plan.topology_digest,
        journal_head_digest: genesis.event_digest });
    }
    members.sort((left, right) => left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1 : 0);
    const manifest = { schema: 'lattice.todo_manifest.v1', project_id: options.projectId,
      repositories: options.repositories, members, manifest_digest: '' };
    manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
    if (!validateTodoManifest(manifest)) throw new TypeError('manifest input violates lattice.todo_manifest.v1');
    // Activation is last: a crash before this point leaves the new store/version unpublished.
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(manifest));
    return readTodoStoreLocked({ repoRoot, now: options.now });
  }, { initialize: true });
}

const sameDirectoryIdentity = (left, right) => left !== null && right !== null
  && left.dev === right.dev && left.ino === right.ino;

// Host-local notice ack sets and wait files (and their temp files) of a store that is gone; see todo-notice-store.mjs.
const NOTICE_ACK_RESIDUE = /^(?:\.gitignore|\.?(?:wait-)?[0-9a-f]{16}\.json(?:\.\d+\.[0-9a-f]{12}\.tmp)?)$/u;

async function transientStoreDirectory(root, allowNotes = true, allowAcks = false) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === '.write.lock' || /^\.write\.lock\..+\.(?:tmp|stale)$/u.test(entry.name)
      || (allowAcks && NOTICE_ACK_RESIDUE.test(entry.name)))) continue;
    if (!entry.isDirectory()) return false;
    const child = path.join(root, entry.name);
    if (allowNotes && ['notes', 'notices'].includes(entry.name)) {
      if (!await transientStoreDirectory(child, false, entry.name === 'notices')) return false;
    } else if (['.cross-plan-recovery', '.write.lock.recovery'].includes(entry.name)) {
      for (const claim of await readdir(child, { withFileTypes: true })) {
        if (!claim.isDirectory() || (await readdir(path.join(child, claim.name))).length !== 0) return false;
      }
    } else return false;
  }
  return true;
}

async function uninitializedStoreLayout(repoRoot) {
  const parent = await lstat(path.join(repoRoot, '.lattice')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (parent === null) return { uninitialized: true, identity: null };
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    return { uninitialized: false, identity: null, unsafeParent: true };
  }
  const root = path.join(repoRoot, STORE_ROOT_REF);
  const identity = await lstat(root).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (identity === null) return { uninitialized: true, identity };
  if (identity.isSymbolicLink() || !identity.isDirectory()) return { uninitialized: false, identity };
  try { return { identity, uninitialized: await transientStoreDirectory(root) }; }
  catch (error) {
    if (error?.code === 'ENOENT' && await lstat(root).catch((missing) => {
      if (missing?.code !== 'ENOENT') throw missing;
      return null;
    }) === null) return { uninitialized: true, identity: null };
    throw error;
  }
}

/** Discovery only; liveness and the final publication decision stay in the transaction. */
export async function isUninitializedTodoStore({ repoRoot = process.cwd() } = {}) {
  return (await uninitializedStoreLayout(path.resolve(repoRoot))).uninitialized;
}

async function prepareAuthoredStoreRoot(repoRoot, options) {
  const observed = await uninitializedStoreLayout(repoRoot);
  if (observed.unsafeParent) fail('STORE_INCONSISTENT', 'unsafe_lattice_root');
  if (!observed.uninitialized) fail('STORE_WRITE_CONFLICT', 'store_already_exists');
  if (observed.identity === null) return;
  const root = path.join(repoRoot, STORE_ROOT_REF);
  try { await withLock(repoRoot, async () => {
    const fresh = await uninitializedStoreLayout(repoRoot);
    if (!sameDirectoryIdentity(observed.identity, fresh.identity)) {
      fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
    }
    if (!fresh.uninitialized) fail('STORE_WRITE_CONFLICT', 'store_already_exists');
    const notes = path.join(root, 'notes');
    const notesIdentity = await lstat(notes).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    });
    if (notesIdentity !== null) {
      await withStoreLock({ lockPath: path.join(notes, '.write.lock'), createParent: false }, async () => {
        if (!sameDirectoryIdentity(notesIdentity, await lstat(notes))
          || !await transientStoreDirectory(notes, false)) {
          fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
        }
      });
      if (!sameDirectoryIdentity(notesIdentity, await lstat(notes))) {
        fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
      }
      try { await rmdir(notes); }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
        throw new StoreLockError('store_locked', path.join(notes, '.write.lock'), {
          next_action: `Confirm no writer before clearing abandoned host-local note lock residue in ${notes}`,
        });
      }
    }
    // Acks of the store that is gone name notices that cannot open again; losing them is redelivery at most.
    const notices = path.join(root, 'notices');
    const noticesIdentity = await lstat(notices).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    });
    if (noticesIdentity !== null) {
      await withStoreLock({ lockPath: path.join(notices, '.write.lock'), createParent: false }, async () => {
        if (!sameDirectoryIdentity(noticesIdentity, await lstat(notices))
          || !await transientStoreDirectory(notices, false, true)) {
          fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
        }
        for (const name of await readdir(notices)) {
          if (NOTICE_ACK_RESIDUE.test(name)) await rm(path.join(notices, name), { force: true });
        }
      });
      try { await rmdir(notices); }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
        throw new StoreLockError('store_locked', path.join(notices, '.write.lock'), {
          next_action: `Confirm no writer before clearing abandoned host-local notice lock residue in ${notices}`,
        });
      }
    }
    await protocolStage(options, 'authoring_residue_locked');
  }); } catch (error) {
    const gone = (await uninitializedStoreLayout(repoRoot)).identity === null;
    if (gone && error instanceof TodoStoreError
      && ['store_locked', 'artifact_missing', 'store_uninitialized'].includes(error.detail.reason)) return;
    throw error;
  }
  await protocolStage(options, 'authoring_residue_released');
  const fresh = await uninitializedStoreLayout(repoRoot);
  if (fresh.identity === null && fresh.uninitialized) return;
  if (!sameDirectoryIdentity(observed.identity, fresh.identity)) {
    if (!fresh.uninitialized) fail('STORE_WRITE_CONFLICT', 'store_bootstrap_raced');
    fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
  }
  const busy = () => fail('STORE_WRITE_CONFLICT', 'store_locked', {
    lock_path: path.join(root, '.write.lock'),
    next_action: `Retry after writers exit; confirm no writer before manually clearing unidentified host-local residue in ${root}`,
  });
  if (!fresh.uninitialized) fail('STORE_WRITE_CONFLICT', 'store_already_exists');
  const entries = await readdir(root).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
    return null;
  });
  if (entries === null) return;
  if (entries.length !== 0) busy();
  try { await rmdir(root); }
  catch (error) {
    if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) busy();
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await fsyncDirectory(path.dirname(root));
}

async function withInitialStoreLocks(stage, currentRoot, callback) {
  await mkdir(path.join(stage, 'notes'));
  const lockOptions = (relative) => ({
    lockPath: path.join(stage, relative), createParent: false,
    releasePath: async () => {
      const root = await currentRoot();
      return root === null ? null : path.join(root, relative);
    },
  });
  return withStoreLock(lockOptions('.write.lock'), () => (
    withStoreLock(lockOptions('notes/.write.lock'), callback)
  ));
}

/** G5-only initial authoring transaction. Store membership appears by one final directory rename. */
export async function initializeAuthoredTodoStore(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const optionKeys = [
    'repoRoot', 'writer', 'projectId', 'repositories', 'plan', 'genesis',
  ];
  const allowedOptions = options.featureChain === undefined ? optionKeys : [...optionKeys, 'featureChain'];
  if (!(exactRecord(options, allowedOptions)
    || (exactRecord(options, [...allowedOptions, 'onProtocolStage'])
      && typeof options.onProtocolStage === 'function'))
    || options.projectId !== options.plan?.project_id
    || options.plan?.predecessor_plan_digest !== null) {
    throw new TypeError('authored store initialization input invalid');
  }
  const plan = buildTodoPlan(options.plan);
  const backchain = boundPlanBackchain(plan, options.featureChain);
  verifyPlanNarrativeAnchors(repoRoot, plan);
  const genesis = buildPlanGenesis(plan, options.genesis);
  const tasks = replay(plan, [genesis]);
  validateMergedGraph([{ plan }], undefined, { newPlanKey: plan.plan_key });
  const snapshot = snapshotFor(plan, [genesis], tasks);
  const base = `plans/${plan.plan_key}/${plan.plan_version}`;
  const planRef = `${STORE_ROOT_REF}/${base}/plan.json`;
  const journalRef = `${STORE_ROOT_REF}/${base}/journal/active.jsonl`;
  const snapshotRef = `${STORE_ROOT_REF}/${base}/snapshot.json`;
  const descriptor = {
    plan_key: plan.plan_key, active_plan_version: plan.plan_version,
    plan_ref: planRef, journal_ref: journalRef, snapshot_ref: snapshotRef,
    topology_digest: plan.topology_digest, journal_head_digest: genesis.event_digest,
  };
  const manifest = {
    schema: 'lattice.todo_manifest.v1', project_id: options.projectId,
    repositories: options.repositories, members: [descriptor], manifest_digest: '',
  };
  manifest.manifest_digest = todoSelfDigest(manifest, 'manifest_digest');
  if (!validateTodoManifest(manifest)) throw new TypeError('manifest input violates lattice.todo_manifest.v1');

  const stage = path.join(repoRoot, `.lattice-todo-authoring-${process.pid}-${randomBytes(6).toString('hex')}`);
  const latticeRoot = path.join(repoRoot, '.lattice');
  const storeRoot = path.join(repoRoot, STORE_ROOT_REF);
  let createdLatticeRoot = false;
  let renamed = false;
  let activated = false;
  let stageIdentity = null;
  let latticeIdentity = null;
  const sameIdentity = sameDirectoryIdentity;
  await prepareAuthoredStoreRoot(repoRoot, options);
  await mkdir(stage, { mode: 0o700 });
  stageIdentity = await lstat(stage);
  try {
    return await withInitialStoreLocks(stage, async () => {
        const current = renamed ? storeRoot : stage;
        const identity = await lstat(current).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
          return null;
        });
        return sameIdentity(stageIdentity, identity) && identity.isDirectory() && !identity.isSymbolicLink()
          ? current : null;
    }, async () => {
      try {
        stageIdentity = await lstat(stage);
        await atomicWrite(path.join(stage, base, 'plan.json'), canonicalLine(plan));
        await atomicWrite(path.join(stage, base, 'journal', 'active.jsonl'), canonicalLine(genesis));
        await atomicWrite(path.join(stage, base, 'snapshot.json'), canonicalLine(snapshot));
        if (backchain !== null) await atomicWrite(path.join(stage, base, 'backchain.json'), canonicalLine(backchain));
        await atomicWrite(path.join(stage, 'manifest.json'), canonicalLine(manifest));

        try {
          const state = await lstat(latticeRoot);
          if (state.isSymbolicLink() || !state.isDirectory()) fail('STORE_INCONSISTENT', 'unsafe_lattice_root');
        } catch (error) {
          if (error instanceof TodoStoreError) throw error;
          if (error?.code !== 'ENOENT') throw error;
          try { await mkdir(latticeRoot, { mode: 0o700 }); createdLatticeRoot = true; }
          catch (race) { if (race?.code !== 'EEXIST') throw race; }
          await fsyncDirectory(repoRoot);
        }
        await ensureLatticeEolProtection(latticeRoot);
        latticeIdentity = await lstat(latticeRoot);
        const stagedBeforeRename = await lstat(stage);
        const parentBeforeRename = await lstat(latticeRoot);
        if (!sameIdentity(stageIdentity, stagedBeforeRename)
          || !sameIdentity(latticeIdentity, parentBeforeRename)
          || stagedBeforeRename.isSymbolicLink() || !stagedBeforeRename.isDirectory()
          || parentBeforeRename.isSymbolicLink() || !parentBeforeRename.isDirectory()) {
          fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
        }
        try { await rename(stage, storeRoot); }
        catch (error) {
          if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) fail('STORE_WRITE_CONFLICT', 'store_bootstrap_raced');
          if (error?.code === 'EPERM') {
            const remainingStage = await lstat(stage).catch(() => null);
            if (sameIdentity(stageIdentity, remainingStage)
              && remainingStage.isDirectory() && !remainingStage.isSymbolicLink()) {
              const destination = await lstat(storeRoot).catch(() => null);
              if (destination !== null) {
                let complete = false;
                if (destination.isDirectory() && !destination.isSymbolicLink()) {
                  try {
                    await readArtifact(repoRoot, MANIFEST_REF, {
                      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes,
                      validate: validateTodoManifest,
                    });
                    complete = sameIdentity(destination, await lstat(storeRoot));
                  } catch { /* An unreadable manifest cannot prove a completed publisher. */ }
                }
                const reason = complete ? 'store_bootstrap_raced' : 'bootstrap_destination_incomplete';
                const layout = complete ? null : await uninitializedStoreLayout(repoRoot).catch(() => null);
                const nextAction = complete
                  ? `Read the published Store at ${storeRoot}; add further membership with a new plan key.`
                  : layout?.uninitialized
                    ? `Retry the same initial operation after the writer exits; transient residue at ${storeRoot} recovers automatically.`
                    : `Finish or restore the original bootstrap at ${storeRoot}, preserving existing data, then retry.`;
                throw Object.assign(new TodoStoreError('STORE_WRITE_CONFLICT', reason, reason, {
                  ref: STORE_ROOT_REF, cause: error.code, next_action: nextAction,
                }), { cause: error });
              }
            }
          }
          throw error;
        }
        renamed = true;
        await fsyncDirectory(latticeRoot);
        if (typeof options.onProtocolStage === 'function') await options.onProtocolStage('authoring_renamed');
        const activatedStore = await lstat(storeRoot);
        const activatedParent = await lstat(latticeRoot);
        if (!sameIdentity(stageIdentity, activatedStore)
          || !sameIdentity(latticeIdentity, activatedParent)
          || activatedStore.isSymbolicLink() || !activatedStore.isDirectory()
          || activatedParent.isSymbolicLink() || !activatedParent.isDirectory()) {
          fail('STORE_WRITE_CONFLICT', 'authoring_activation_path_changed');
        }
        const store = await readTodoStoreView({ repoRoot });
        const member = store.members[0];
        if (store.project_id !== options.projectId || store.members.length !== 1
          || store.snapshot_stale !== false || member?.journal?.events?.length !== 1
          || canonicalizeTodoArtifact(store.manifest) !== canonicalizeTodoArtifact(manifest)
          || canonicalizeTodoArtifact(member?.descriptor) !== canonicalizeTodoArtifact(descriptor)
          || canonicalizeTodoArtifact(member?.plan) !== canonicalizeTodoArtifact(plan)
          || canonicalizeTodoArtifact(member?.journal?.events?.[0]) !== canonicalizeTodoArtifact(genesis)
          || canonicalizeTodoArtifact(member?.snapshot) !== canonicalizeTodoArtifact(snapshot)) {
          fail('STORE_WRITE_CONFLICT', 'authoring_activation_verification_failed');
        }
        activated = true;
        return store;
      } finally {
        if (renamed && !activated) {
          try {
            const currentParent = await lstat(latticeRoot);
            const currentStore = await lstat(storeRoot);
            if (sameIdentity(latticeIdentity, currentParent) && sameIdentity(stageIdentity, currentStore)
              && !currentParent.isSymbolicLink() && currentParent.isDirectory()
              && !currentStore.isSymbolicLink() && currentStore.isDirectory()) {
              await rm(storeRoot, { recursive: true, force: true });
              await fsyncDirectory(latticeRoot);
            }
          } catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
          }
        }
        const published = await lstat(storeRoot).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
          return null;
        });
        if (!activated && createdLatticeRoot && published === null) {
          // 自分で作ったroot直下の同梱.gitattributesを先に消さないとrmdirがENOTEMPTYで残る。
          await rm(path.join(latticeRoot, '.gitattributes'), { force: true });
          try { await rmdir(latticeRoot); }
          catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error; }
        }
      }
    });
  } catch (error) {
    if (error instanceof StoreLockError) fail('STORE_WRITE_CONFLICT', error.reason, error.detail);
    throw error;
  } finally {
    if (!renamed) {
      const currentStage = await lstat(stage).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
        return null;
      });
      if (sameIdentity(stageIdentity, currentStage) && currentStage.isDirectory() && !currentStage.isSymbolicLink()) {
        await rm(stage, { recursive: true, force: true });
      }
    }
  }
}

async function sourceItemBytes(repoRoot, sourceRef) {
  const parsed = parseTodoSourceRef(sourceRef);
  if (parsed === null) fail('RECONCILIATION_INCOMPLETE', 'source_ref_invalid', { source_ref: sourceRef });
  const canonicalRoot = await realpath(repoRoot);
  const absolute = path.resolve(canonicalRoot, parsed.path);
  if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail('RECONCILIATION_INCOMPLETE', 'source_path_outside_repo', { source_ref: sourceRef });
  }
  let current = canonicalRoot;
  for (const part of path.relative(canonicalRoot, absolute).split(path.sep)) {
    current = path.join(current, part);
    let state;
    try { state = await lstat(current); }
    catch { fail('RECONCILIATION_INCOMPLETE', 'source_path_missing', { source_ref: sourceRef }); }
    if (state.isSymbolicLink()) {
      fail('RECONCILIATION_INCOMPLETE', 'source_path_symlink', { source_ref: sourceRef });
    }
  }
  const state = await lstat(absolute);
  if (!state.isFile() || await realpath(absolute) !== absolute) {
    fail('RECONCILIATION_INCOMPLETE', 'source_path_not_regular', { source_ref: sourceRef });
  }
  const bytes = await readFile(absolute);
  decodeUtf8(bytes, 'RECONCILIATION_INCOMPLETE', 'source_invalid_utf8');
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  const line = lines[parsed.line - 1];
  if (line === undefined) fail('RECONCILIATION_INCOMPLETE', 'source_line_missing', { source_ref: sourceRef });
  return line;
}

async function verifyRevisionSources(repoRoot, inventory) {
  for (const entry of [...inventory.active, ...inventory.excluded_tombstones]) {
    const line = await sourceItemBytes(repoRoot, entry.source_ref);
    if (!matchesTodoSourceLineDigest(line, entry.source_digest)) {
      fail('RECONCILIATION_INCOMPLETE', 'source_digest_mismatch', { source_ref: entry.source_ref });
    }
    if (markdownCheckboxState(line) === null) {
      fail('RECONCILIATION_INCOMPLETE', 'source_item_not_todo', { source_ref: entry.source_ref });
    }
  }
}

export async function verifyTodoRevisionSources(options = {}) {
  const revision = options.revision;
  if (!validateTodoRevision(revision)) fail('REVISION_INVALID', 'revision_schema_or_digest_invalid');
  await verifyRevisionSources(path.resolve(options.repoRoot ?? process.cwd()), revision.source_inventory);
  return true;
}

export async function verifyPhaseTodoRevisionSources(options = {}) {
  const revision = options.revision;
  if (!validatePhaseTodoRevision(revision)) {
    fail('REVISION_INVALID', 'phase_revision_schema_or_digest_invalid');
  }
  if (revision.schema !== 'lattice.phase_todo_revision.v3') {
    fail('REVISION_INVALID', 'phase_revision_source_inventory_unsupported');
  }
  await verifyRevisionSources(path.resolve(options.repoRoot ?? process.cwd()), revision.source_inventory);
  return true;
}

function stateMigrationFor(previous, revision) {
  if (['lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(previous.plan.schema)
    && !['lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8']
      .includes(revision.desired_plan.schema)) {
    fail('REVISION_INVALID', 'design_memo_schema_downgrade', {
      predecessor_schema: previous.plan.schema, desired_schema: revision.desired_plan.schema,
    });
  }
  if (previous.plan.schema === 'lattice.todo_plan.v8'
    && revision.desired_plan.schema !== 'lattice.todo_plan.v8') {
    fail('REVISION_INVALID', 'done_condition_schema_downgrade', {
      predecessor_schema: previous.plan.schema, desired_schema: revision.desired_plan.schema,
    });
  }
  const oldIds = previous.plan.tasks.map(({ task_id }) => task_id);
  const migrationIds = revision.task_migration.map(({ from_task_id }) => from_task_id);
  if (canonicalizeTodoArtifact([...oldIds].sort()) !== canonicalizeTodoArtifact([...migrationIds].sort())) {
    fail('REVISION_INVALID', 'predecessor_task_migration_incomplete');
  }
  const states = new Map(previous.tasks.map((state) => [state.task_id, state]));
  return revision.task_migration.map((migration) => {
    const carriesState = ['carry', 'carry_reconciled_metadata', 'acquire_phase'].includes(migration.state_policy);
    if (!carriesState) return { ...migration, state: null };
    const state = states.get(migration.from_task_id);
    if (!state) fail('STORE_INCONSISTENT', 'predecessor_task_state_missing');
    // u03 A38/A39: every schema uses the u12 light-carry rule. Authored fields, edges, joins and
    // phase assignment may change at any state; only the id mapping and compile_binding bind
    // carried state (the claim 1-4 impact binding must not carry onto another compiled spec).
    const predecessorTask = previous.plan.tasks.find(({ task_id }) => task_id === migration.from_task_id);
    const desiredTask = revision.desired_plan.tasks.find(({ task_id }) => task_id === migration.to_task_id);
    if (!desiredTask || canonicalizeTodoArtifact(predecessorTask?.compile_binding ?? null)
      !== canonicalizeTodoArtifact(desiredTask.compile_binding ?? null)) {
      fail('REVISION_INVALID', 'carry_semantics_changed', { from_task_id: migration.from_task_id });
    }
    return { ...migration, state: {
      status: state.status, started_at: state.started_at, done_at: state.done_at,
      blocked_reason: state.blocked_reason, evidence: state.evidence, imported: state.imported,
      ...(typeof state.test_result === 'string' ? { test_result: state.test_result } : {}),
    } };
  });
}

function phaseStateMigrationFor(previous, revision) {
  const predecessorPhases = isPhaseTodoPlanSchema(previous.plan.schema)
    ? previous.plan.phases : [];
  const sourceIds = revision.phase_migration
    .filter(({ from_phase_id }) => from_phase_id !== null).map(({ from_phase_id }) => from_phase_id);
  if (canonicalizeTodoArtifact([...sourceIds].sort())
    !== canonicalizeTodoArtifact(predecessorPhases.map(({ phase_id }) => phase_id).sort())) {
    fail('REVISION_INVALID', 'predecessor_phase_migration_incomplete');
  }
  const previousStates = new Map((previous.snapshot.phases ?? []).map((state) => [state.phase_id, state]));
  return revision.phase_migration
    .filter(({ to_phase_id }) => to_phase_id !== 'removed')
    .map((migration) => {
      if (migration.state_policy === 'reset') {
        return { phase_id: migration.to_phase_id, state_policy: 'reset', state: null };
      }
      const after = revision.desired_plan.phases.find(({ phase_id }) => phase_id === migration.to_phase_id);
      // u12/u03 A38: the revision chose carry vs reset; Store checks only the id mapping.
      if (!after) fail('REVISION_INVALID', 'phase_carry_semantics_changed', { from_phase_id: migration.from_phase_id });
      const state = previousStates.get(migration.from_phase_id);
      if (state === undefined) fail('STORE_INCONSISTENT', 'predecessor_phase_state_missing');
      return { phase_id: migration.to_phase_id, state_policy: 'carry', state: {
        status: state.status, review_event_digest: state.review_event_digest,
        decision_event_digest: state.decision_event_digest, decision_evidence: state.decision_evidence,
      } };
    }).sort((left, right) => left.phase_id.localeCompare(right.phase_id));
}

function phaseRevisionResult(revision, genesis, recovered = false) {
  const result = {
    schema: 'lattice.phase_todo_revise_result.v1', project_id: revision.project_id,
    plan_key: revision.plan_key, predecessor_plan_digest: revision.predecessor.plan_digest,
    predecessor_journal_head_digest: revision.predecessor.journal_head_digest,
    plan_version: revision.desired_plan.plan_version, plan_digest: revision.desired_plan.plan_digest,
    topology_digest: revision.desired_plan.topology_digest, journal_head_digest: genesis.event_digest,
    revision_digest: revision.revision_digest, recovered, result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

function sourceCutoverCleanupBinding(revision, stagingRef) {
  return { schema: 'lattice.source_cutover_cleanup_binding.v1',
    revision_digest: revision.revision_digest, staging_ref: stagingRef,
    cleanup_state: 'cleanup_complete' };
}

function sourceCutoverArchiveRootList(revision, entries) {
  return { schema: 'lattice.source_cutover_archive_root_list.v1', roots: [{
    archive_ref: revision.source_cutover_batch.archive_ref,
    entry_digests: entries.map(({ entry_digest: digest }) => digest),
  }] };
}

async function buildPhaseV3SourceReceipt(repoRoot, revision, transactionRef) {
  const stagingRef = `${transactionRef}/source-originals.md`;
  const entries = [];
  for (const [operationIndex, operation] of revision.source_cutover_batch.operations.entries()) {
    const publishedBytes = await sourceItemBytes(repoRoot, operation.source_ref);
    const archiveRef = todoCutoverArchiveSourceRef(revision.source_cutover_batch, operationIndex);
    const archivedBytes = await sourceItemBytes(repoRoot, archiveRef);
    const expectedPublishedBytes = phaseV3PublishedSourceBytes(operation, archivedBytes);
    const entry = { operation_index: operationIndex, task_id: operation.task_id,
      disposition: operation.disposition, source_ref: operation.source_ref,
      staging_ref: `${stagingRef}#L${operationIndex + 1}`, published_ref: operation.source_ref,
      archive_ref: archiveRef, replacement: operation.live_replacement,
      staged_source_bytes_digest: operation.source_digest,
      published_source_bytes_digest: sha256Bytes(publishedBytes),
      archived_source_bytes_digest: operation.source_digest, entry_digest: '' };
    if (entry.published_source_bytes_digest !== sha256Bytes(expectedPublishedBytes)
      || !matchesTodoSourceLineDigest(archivedBytes, operation.source_digest)) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_receipt_bytes_mismatch');
    }
    entry.entry_digest = todoSelfDigest(entry, 'entry_digest');
    entries.push(entry);
  }
  const cleanupBinding = sourceCutoverCleanupBinding(revision, stagingRef);
  const receipt = { schema: 'lattice.source_cutover_receipt.v1', project_id: revision.project_id,
    plan_key: revision.plan_key, plan_version: revision.desired_plan.plan_version,
    revision_digest: revision.revision_digest,
    source_cutover_batch_digest: revision.source_cutover_batch.batch_digest, entries,
    archive_root_list_digest: digestTodoArtifact(sourceCutoverArchiveRootList(revision, entries)),
    published_state: 'source_and_archive_published',
    cleanup_binding_digest: digestTodoArtifact(cleanupBinding), receipt_digest: '' };
  receipt.receipt_digest = todoSelfDigest(receipt, 'receipt_digest');
  return receipt;
}

function phaseV3PublishedSourceBytes(operation, archivedBytes) {
  return Buffer.from(`${operation.live_replacement}${archivedBytes.at(-1) === 0x0d ? '\r' : ''}`,
    'utf8');
}

function validSourceCutoverReceipt(value, revision) {
  if (!exactRecord(value, ['schema', 'project_id', 'plan_key', 'plan_version', 'revision_digest',
    'source_cutover_batch_digest', 'entries', 'archive_root_list_digest', 'published_state',
    'cleanup_binding_digest', 'receipt_digest'])
    || value.schema !== 'lattice.source_cutover_receipt.v1'
    || value.project_id !== revision.project_id || value.plan_key !== revision.plan_key
    || value.plan_version !== revision.desired_plan.plan_version
    || value.revision_digest !== revision.revision_digest
    || value.source_cutover_batch_digest !== revision.source_cutover_batch.batch_digest
    || value.published_state !== 'source_and_archive_published'
    || !Array.isArray(value.entries)
    || value.entries.length !== revision.source_cutover_batch.operations.length
    || value.receipt_digest !== todoSelfDigest(value, 'receipt_digest')) return false;
  for (const [index, entry] of value.entries.entries()) {
    const operation = revision.source_cutover_batch.operations[index];
    if (!exactRecord(entry, ['operation_index', 'task_id', 'disposition', 'source_ref',
      'staging_ref', 'published_ref', 'archive_ref', 'replacement',
      'staged_source_bytes_digest', 'published_source_bytes_digest',
      'archived_source_bytes_digest', 'entry_digest'])
      || entry.operation_index !== index || entry.task_id !== operation.task_id
      || entry.disposition !== operation.disposition || entry.source_ref !== operation.source_ref
      || entry.published_ref !== operation.source_ref
      || entry.archive_ref !== todoCutoverArchiveSourceRef(revision.source_cutover_batch, index)
      || entry.replacement !== operation.live_replacement
      || entry.staged_source_bytes_digest !== operation.source_digest
      || !isTodoDigest(entry.published_source_bytes_digest)
      || entry.archived_source_bytes_digest !== operation.source_digest
      || entry.entry_digest !== todoSelfDigest(entry, 'entry_digest')) return false;
  }
  const expectedRootDigest = digestTodoArtifact(sourceCutoverArchiveRootList(revision, value.entries));
  const stagingRef = value.entries[0].staging_ref.replace(/#L[1-9]\d*$/u, '');
  const expectedStagingRef = `${STORE_ROOT_REF}/transactions/phase-v3/${revision.plan_key}/${revision.desired_plan.plan_version}/source-originals.md`;
  return stagingRef === expectedStagingRef
    && value.entries.every((entry, index) => entry.staging_ref === `${stagingRef}#L${index + 1}`)
    && value.archive_root_list_digest === expectedRootDigest
    && value.cleanup_binding_digest
      === digestTodoArtifact(sourceCutoverCleanupBinding(revision, stagingRef));
}

async function verifyPhaseV3SourceReceipt(repoRoot, revision, receipt) {
  if (!validSourceCutoverReceipt(receipt, revision)) return false;
  const stagingRef = receipt.entries[0].staging_ref.replace(/#L[1-9]\d*$/u, '');
  if (await exactFileOrNull(path.resolve(repoRoot, stagingRef)) !== null) return false;
  for (const [index, entry] of receipt.entries.entries()) {
    const source = parseTodoSourceRef(entry.published_ref);
    const archive = parseTodoSourceRef(entry.archive_ref);
    if (source === null || archive === null) return false;
    await safeRepoFile(repoRoot, source.path);
    await safeRepoFile(repoRoot, archive.path);
    const publishedBytes = await sourceItemBytes(repoRoot, entry.published_ref);
    const archivedBytes = await sourceItemBytes(repoRoot, entry.archive_ref);
    if (!matchesTodoSourceLineDigest(publishedBytes, entry.published_source_bytes_digest)
      || !matchesTodoSourceLineDigest(archivedBytes, entry.archived_source_bytes_digest)
      || !matchesTodoSourceLineDigest(phaseV3PublishedSourceBytes(
        revision.source_cutover_batch.operations[index], archivedBytes),
      entry.published_source_bytes_digest)) return false;
  }
  return true;
}

function validPhaseRevisionCommitReceipt(value, revision, descriptor, genesis, sourceReceipt) {
  return exactRecord(value, ['schema', 'project_id', 'plan_key', 'plan_version', 'revision_digest',
    'committed_member_digest', 'active_plan_digest', 'journal_genesis_digest',
    'reconciliation_digest', 'source_cutover_receipt_digest', 'committed_at', 'receipt_digest'])
    && value.schema === 'lattice.phase_revision_commit_receipt.v1'
    && value.project_id === revision.project_id && value.plan_key === revision.plan_key
    && value.plan_version === revision.desired_plan.plan_version
    && value.revision_digest === revision.revision_digest
    && value.committed_member_digest === digestTodoArtifact(descriptor)
    && value.active_plan_digest === revision.desired_plan.plan_digest
    && value.journal_genesis_digest === genesis.event_digest
    && value.reconciliation_digest === revision.reconciliation.reconciliation_digest
    && value.source_cutover_receipt_digest === sourceReceipt.receipt_digest
    && isStrictTodoTimestamp(value.committed_at)
    && value.receipt_digest === todoSelfDigest(value, 'receipt_digest');
}

function revisionResult(revision, genesis, { recovered = false } = {}) {
  const result = {
    schema: revision.schema === 'lattice.todo_revision.v2'
      ? 'lattice.todo_revise_result.v2' : 'lattice.todo_revise_result.v1',
    project_id: revision.project_id,
    plan_key: revision.plan_key, predecessor_plan_digest: revision.predecessor.plan_digest,
    predecessor_journal_head_digest: revision.predecessor.journal_head_digest,
    plan_version: revision.desired_plan.plan_version, plan_digest: revision.desired_plan.plan_digest,
    topology_digest: revision.desired_plan.topology_digest, journal_head_digest: genesis.event_digest,
    revision_digest: revision.revision_digest,
    reconciliation_digest: revision.reconciliation.reconciliation_digest,
    ...(revision.schema === 'lattice.todo_revision.v2' ? { source_cutover: {
      batch_id: revision.source_cutover_batch.batch_id,
      operation_count: revision.source_cutover_batch.operations.length,
      archive_ref: revision.source_cutover_batch.archive_ref,
      recovered,
    } } : {}),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

async function exactFileOrNull(absolute) {
  try {
    const state = await lstat(absolute);
    if (state.isSymbolicLink() || !state.isFile()) fail('REVISION_CONFLICT', 'revision_artifact_unsafe');
    return readFile(absolute);
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeStoreDirectory(repoRoot, target) {
  const requestedStoreRoot = path.resolve(repoRoot, STORE_ROOT_REF);
  const requested = path.resolve(target);
  if (requested !== requestedStoreRoot && !requested.startsWith(`${requestedStoreRoot}${path.sep}`)) {
    fail('REVISION_CONFLICT', 'revision_directory_outside_store');
  }
  const canonicalRepoRoot = await realpath(repoRoot);
  const storeRoot = path.resolve(canonicalRepoRoot, STORE_ROOT_REF);
  const absolute = path.resolve(storeRoot, path.relative(requestedStoreRoot, requested));
  let current = storeRoot;
  const parts = path.relative(storeRoot, absolute).split(path.sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part !== '') current = path.join(current, part);
    let state;
    try { state = await lstat(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
      state = await lstat(current);
    }
    if (state.isSymbolicLink() || !state.isDirectory() || await realpath(current) !== current) {
      fail('REVISION_CONFLICT', 'revision_directory_unsafe');
    }
  }
}

function parseRevisionMarker(bytes) {
  return parseCanonicalJsonLine(bytes, {
    code: 'REVISION_CONFLICT', reason: 'revision_marker_invalid',
    maxBytes: TODO_LIMITS.snapshotBytes,
    validate: (value) => exactRecord(value, ['schema', 'revision', 'genesis'])
      && value.schema === 'lattice.todo_revision_transaction.v1'
      && validateTodoRevision(value.revision) && validateTodoEvent(value.genesis),
  });
}

function parsePhaseRevisionMarker(bytes) {
  return parseCanonicalJsonLine(bytes, {
    code: 'REVISION_CONFLICT', reason: 'phase_revision_marker_invalid',
    maxBytes: TODO_LIMITS.snapshotBytes,
    validate: (value) => exactRecord(value, ['schema', 'revision', 'genesis'])
      && value.schema === 'lattice.phase_todo_revision_transaction.v1'
      && validatePhaseTodoRevision(value.revision) && validateTodoEvent(value.genesis),
  });
}

function parseRevisionSetMarker(bytes) {
  return parseCanonicalJsonLine(bytes, {
    code: 'REVISION_CONFLICT', reason: 'revision_set_marker_invalid',
    maxBytes: TODO_LIMITS.snapshotBytes,
    validate: (value) => exactRecord(value, [
      'schema', 'project_id', 'revision_set_digest', 'entries',
    ]) && ['lattice.todo_revision_set_transaction.v1',
      'lattice.todo_revision_set_transaction.v2'].includes(value.schema)
      && isTodoIdentifier(value.project_id) && isTodoDigest(value.revision_set_digest)
      && Array.isArray(value.entries) && value.entries.length > 0
      && value.entries.every((entry) => {
        const phase = ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2']
          .includes(entry?.revision?.schema);
        return exactRecord(entry, phase && value.schema.endsWith('.v2') ? [
          'revision', 'state_migration', 'phase_state_migration', 'genesis',
        ] : ['revision', 'state_migration', 'genesis'])
          && (phase ? validatePhaseTodoRevision(entry.revision) : validateTodoRevision(entry.revision))
          && Array.isArray(entry.state_migration)
          && (!phase || Array.isArray(entry.phase_state_migration))
          && validateTodoEvent(entry.genesis);
      }),
  });
}

async function recoverSourceCutover(repoRoot, now) {
  const barrierBytes = await exactFileOrNull(path.resolve(repoRoot, SOURCE_CUTOVER_BARRIER_REF));
  if (barrierBytes === null) return;
  const barrier = parseCanonicalJsonLine(barrierBytes, {
    code: 'SOURCE_CUTOVER_RECOVERY_REQUIRED', reason: 'barrier_invalid',
    maxBytes: TODO_LIMITS.snapshotBytes,
    validate: (value) => (exactRecord(value, ['schema', 'revision_digest'])
      && value.schema === 'lattice.todo_source_cutover_barrier.v1' && isTodoDigest(value.revision_digest))
      || (exactRecord(value, ['schema', 'revision_set_digest', 'revision_digests'])
        && value.schema === 'lattice.todo_source_cutover_set_barrier.v1'
        && isTodoDigest(value.revision_set_digest) && Array.isArray(value.revision_digests)
        && value.revision_digests.every(isTodoDigest)),
  });
  const isSet = barrier.schema === 'lattice.todo_source_cutover_set_barrier.v1';
  const matches = [];
  async function visit(ref, depth, parse) {
    const directory = path.resolve(repoRoot, ref);
    let entries;
    try {
      const state = await lstat(directory);
      if (!state.isDirectory() || state.isSymbolicLink()) fail('REVISION_CONFLICT', 'revision_directory_unsafe');
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!isTodoIdentifier(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        fail('REVISION_CONFLICT', 'revision_directory_unsafe');
      }
      const childRef = path.posix.join(ref, entry.name);
      if (depth > 1) { await visit(childRef, depth - 1, parse); continue; }
      const markerState = await pathState(repoRoot, `${childRef}/marker.json`, 'REVISION_CONFLICT', { missing: true });
      if (markerState === null) continue;
      const bytes = await exactFileOrNull(markerState.absolute);
      if (bytes === null) continue;
      const marker = parse(bytes);
      if ((isSet ? marker.revision_set_digest : marker.revision.revision_digest)
        === (isSet ? barrier.revision_set_digest : barrier.revision_digest)) matches.push(marker);
    }
  }
  if (isSet) {
    await visit(`${STORE_ROOT_REF}/transactions/revision-sets`, 1, parseRevisionSetMarker);
  } else {
    await visit(`${STORE_ROOT_REF}/transactions/revisions`, 2, parseRevisionMarker);
    await visit(`${STORE_ROOT_REF}/transactions/phase-v3`, 2, parsePhaseRevisionMarker);
  }
  if (matches.length !== 1) fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
  const marker = matches[0];
  const genesis = isSet ? marker.entries[0].genesis : marker.genesis;
  const options = { repoRoot, now, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    actor: genesis.actor, recordedAt: genesis.recorded_at, provenance: genesis.provenance,
    [STORE_LOCK_HELD]: STORE_LOCK_HELD };
  if (!isSet) {
    const apply = marker.revision.schema.startsWith('lattice.phase_')
      ? applyPhaseTodoRevision : applyTodoRevision;
    await apply({ ...options, revision: marker.revision });
    return;
  }
  const revisions = marker.entries.map(({ revision }) => revision);
  if (canonicalizeTodoArtifact(barrier.revision_digests) !== canonicalizeTodoArtifact(revisions
    .filter(({ schema }) => schema === 'lattice.todo_revision.v2').map(({ revision_digest: digest }) => digest))) {
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid');
  }
  for (const schema of ['lattice.todo_revision_set.v1', 'lattice.todo_revision_set.v2', 'lattice.todo_revision_set.v3']) {
    const revisionSet = { schema, project_id: marker.project_id, revisions, revision_set_digest: '' };
    revisionSet.revision_set_digest = todoSelfDigest(revisionSet, 'revision_set_digest');
    if (revisionSet.revision_set_digest === marker.revision_set_digest && validateTodoRevisionSet(revisionSet)) {
      await applyTodoRevisionSet({ ...options, revisionSet });
      return;
    }
  }
  fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
}

async function rejectCompetingRevisionTransaction(repoRoot, revision) {
  const root = path.join(repoRoot, STORE_ROOT_REF, 'transactions', 'revisions', revision.plan_key);
  let names;
  try {
    const state = await lstat(root);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      fail('REVISION_CONFLICT', 'revision_transaction_root_unsafe');
    }
    names = await readdir(root);
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!isTodoIdentifier(name)) fail('REVISION_CONFLICT', 'revision_transaction_entry_invalid');
    const markerBytes = await exactFileOrNull(path.join(root, name, 'marker.json'));
    if (markerBytes === null) fail('REVISION_CONFLICT', 'revision_marker_missing');
    const marker = parseRevisionMarker(markerBytes);
    if (canonicalizeTodoArtifact(marker.revision.predecessor)
        === canonicalizeTodoArtifact(revision.predecessor)
      && marker.revision.revision_digest !== revision.revision_digest) {
      fail('REVISION_CONFLICT', 'revision_bytes_conflict');
    }
  }
}

async function rejectCompetingPhaseV3Transaction(repoRoot, revision) {
  const root = path.join(repoRoot, STORE_ROOT_REF, 'transactions', 'phase-v3', revision.plan_key);
  let names;
  try {
    const state = await lstat(root);
    const canonicalRepoRoot = await realpath(repoRoot);
    const canonicalRoot = path.resolve(canonicalRepoRoot, path.relative(repoRoot, root));
    if (state.isSymbolicLink() || !state.isDirectory() || await realpath(root) !== canonicalRoot) {
      fail('REVISION_CONFLICT', 'revision_transaction_root_unsafe');
    }
    names = await readdir(root);
  } catch (error) {
    if (error instanceof TodoStoreError) throw error;
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (!isTodoIdentifier(name)) fail('REVISION_CONFLICT', 'revision_transaction_entry_invalid');
    const directory = path.join(root, name);
    const state = await lstat(directory);
    const canonicalDirectory = path.join(await realpath(root), name);
    if (state.isSymbolicLink() || !state.isDirectory()
      || await realpath(directory) !== canonicalDirectory) {
      fail('REVISION_CONFLICT', 'revision_transaction_entry_invalid');
    }
    const markerBytes = await exactFileOrNull(path.join(directory, 'marker.json'));
    if (markerBytes === null) {
      if (name !== revision.desired_plan.plan_version) {
        fail('REVISION_CONFLICT', 'revision_marker_missing');
      }
      for (const artifact of await readdir(directory, { withFileTypes: true })) {
        if (!artifact.isFile() || artifact.isSymbolicLink()
          || !/^\.marker\.json\.\d+\.[0-9a-f]{12}\.tmp$/u.test(artifact.name)) {
          fail('REVISION_CONFLICT', 'revision_marker_missing');
        }
      }
      continue;
    }
    const marker = parsePhaseRevisionMarker(markerBytes);
    if (canonicalizeTodoArtifact(marker.revision.predecessor)
        === canonicalizeTodoArtifact(revision.predecessor)
      && marker.revision.revision_digest !== revision.revision_digest) {
      fail('REVISION_CONFLICT', 'revision_bytes_conflict');
    }
  }
}

async function publishRevisionArtifact(staged, finalAbsolute, expected) {
  const finalBytes = await exactFileOrNull(finalAbsolute);
  if (finalBytes !== null) {
    if (!finalBytes.equals(expected)) fail('REVISION_CONFLICT', 'revision_bytes_conflict');
    return;
  }
  let stagedBytes = await exactFileOrNull(staged);
  if (stagedBytes === null) {
    await atomicWrite(staged, expected);
    stagedBytes = expected;
  }
  if (!stagedBytes.equals(expected)) fail('REVISION_CONFLICT', 'revision_bytes_conflict');
  await mkdir(path.dirname(finalAbsolute), { recursive: true });
  await rename(staged, finalAbsolute);
  await fsyncDirectory(path.dirname(finalAbsolute));
}

function splitSourceLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0a) {
      lines.push({ start, end: index, bytes: bytes.subarray(start, index) });
      start = index + 1;
    }
  }
  return lines;
}

async function safeRepoFile(repoRoot, ref, { missing = false } = {}) {
  const canonicalRoot = await realpath(repoRoot);
  const absolute = path.resolve(canonicalRoot, ref);
  if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail('RECONCILIATION_INCOMPLETE', 'source_path_outside_repo', { ref });
  }
  let current = canonicalRoot;
  const parts = path.relative(canonicalRoot, absolute).split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let state;
    try { state = await lstat(current); }
    catch (error) {
      if (missing && error?.code === 'ENOENT') return { absolute, missingParent: current };
      fail('RECONCILIATION_INCOMPLETE', 'source_path_missing', { ref });
    }
    if (state.isSymbolicLink() || !state.isDirectory() || await realpath(current) !== current) {
      fail('RECONCILIATION_INCOMPLETE', 'source_path_symlink', { ref });
    }
  }
  let state;
  try { state = await lstat(absolute); }
  catch (error) {
    if (missing && error?.code === 'ENOENT') return { absolute, missing: true };
    fail('RECONCILIATION_INCOMPLETE', 'source_path_missing', { ref });
  }
  if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1
    || await realpath(absolute) !== absolute) {
    fail('RECONCILIATION_INCOMPLETE', 'source_path_not_regular', { ref });
  }
  return { absolute, state, missing: false };
}

async function ensureSafeRepoParent(repoRoot, absolute) {
  const canonicalRoot = await realpath(repoRoot);
  if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail('REVISION_CONFLICT', 'source_path_outside_repo');
  }
  let current = canonicalRoot;
  for (const part of path.relative(canonicalRoot, path.dirname(absolute)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink() || !state.isDirectory() || await realpath(current) !== current) {
        fail('REVISION_CONFLICT', 'source_directory_unsafe');
      }
    } catch (error) {
      if (error instanceof TodoStoreError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
    }
  }
}

function sourceCutoverArchiveBytes(revision, originals) {
  const header = [
    '# Lattice ToDo archive',
    `Plan: ${revision.plan_key}`,
    `Batch: ${revision.source_cutover_batch.batch_id}`,
    `Revision: ${revision.revision_digest}`,
    '',
  ].join('\n');
  return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'),
    ...originals.flatMap((line) => [line, Buffer.from('\n')])]);
}

async function buildSourceCutoverImages(repoRoot, revision) {
  const batch = revision.source_cutover_batch;
  const archiveState = await safeRepoFile(repoRoot, batch.archive_ref, { missing: true });
  if (!archiveState.missing && !archiveState.missingParent) {
    fail('REVISION_CONFLICT', 'source_cutover_archive_exists', { archive_ref: batch.archive_ref });
  }
  const groups = new Map();
  const originals = [];
  for (const operation of batch.operations) {
    const parsed = parseTodoSourceRef(operation.source_ref);
    const state = await safeRepoFile(repoRoot, parsed.path);
    let group = groups.get(parsed.path);
    if (!group) {
      const before = await readFile(state.absolute);
      decodeUtf8(before, 'RECONCILIATION_INCOMPLETE', 'source_invalid_utf8');
      group = { ref: parsed.path, absolute: state.absolute, before,
        mode: state.state.mode & 0o7777, replacements: [] };
      groups.set(parsed.path, group);
    }
    const line = splitSourceLines(group.before)[parsed.line - 1]?.bytes;
    if (line === undefined) fail('RECONCILIATION_INCOMPLETE', 'source_line_missing', {
      source_ref: operation.source_ref,
    });
    if (!matchesTodoSourceLineDigest(line, operation.source_digest)) {
      fail('RECONCILIATION_INCOMPLETE', 'source_digest_mismatch', { source_ref: operation.source_ref });
    }
    if (markdownCheckboxState(line) === null) {
      fail('RECONCILIATION_INCOMPLETE', 'source_item_not_todo', { source_ref: operation.source_ref });
    }
    if (!liveReplacementPreservesListStructure(line, operation.live_replacement)) {
      fail('RECONCILIATION_INCOMPLETE', 'live_replacement_breaks_list_structure', {
        source_ref: operation.source_ref,
      });
    }
    originals.push(line);
    const replacement = Buffer.from(`${operation.live_replacement}${line.at(-1) === 0x0d ? '\r' : ''}`, 'utf8');
    group.replacements.push({ line: parsed.line, replacement });
  }
  const files = [...groups.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  for (const file of files) {
    const lines = splitSourceLines(file.before);
    let after = file.before;
    for (const replacement of file.replacements.sort((left, right) => right.line - left.line)) {
      const target = lines[replacement.line - 1];
      after = Buffer.concat([after.subarray(0, target.start), replacement.replacement,
        after.subarray(target.end)]);
    }
    file.after = after;
  }
  return { files, archive: { ref: batch.archive_ref, absolute: archiveState.absolute,
    bytes: sourceCutoverArchiveBytes(revision, originals) } };
}

async function stageSourceCutover(transaction, revision, images) {
  const files = [];
  for (const [index, file] of images.files.entries()) {
    const beforeName = `source-${index}-before.bin`;
    const afterName = `source-${index}-after.bin`;
    await atomicWrite(path.join(transaction, beforeName), file.before);
    await atomicWrite(path.join(transaction, afterName), file.after);
    files.push({ ref: file.ref, before: beforeName, after: afterName, mode: file.mode,
      before_digest: sha256Bytes(file.before), after_digest: sha256Bytes(file.after) });
  }
  await atomicWrite(path.join(transaction, 'source-archive.bin'), images.archive.bytes);
  const descriptor = {
    schema: 'lattice.todo_source_cutover_stage.v1', revision_digest: revision.revision_digest,
    archive_ref: images.archive.ref, archive_digest: sha256Bytes(images.archive.bytes), files,
  };
  await atomicWrite(path.join(transaction, 'source-cutover.json'), canonicalLine(descriptor));
  return descriptor;
}

async function loadSourceCutoverStage(repoRoot, transaction, revision) {
  const bytes = await exactFileOrNull(path.join(transaction, 'source-cutover.json'));
  if (bytes === null) fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_missing');
  let descriptor;
  try { descriptor = JSON.parse(decodeUtf8(bytes, 'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'stage_invalid')); }
  catch (error) {
    if (error instanceof TodoStoreError) throw error;
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'stage_invalid');
  }
  if (!bytes.equals(canonicalLine(descriptor))) {
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'stage_invalid');
  }
  const expectedRefs = [...new Set(revision.source_cutover_batch.operations.map((operation) => (
    parseTodoSourceRef(operation.source_ref).path)))].sort();
  if (!exactRecord(descriptor, [
    'schema', 'revision_digest', 'archive_ref', 'archive_digest', 'files',
  ]) || descriptor.schema !== 'lattice.todo_source_cutover_stage.v1'
    || descriptor.revision_digest !== revision.revision_digest
    || descriptor.archive_ref !== revision.source_cutover_batch.archive_ref
    || !isTodoDigest(descriptor.archive_digest) || !Array.isArray(descriptor.files)
    || descriptor.files.length !== expectedRefs.length) {
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'stage_invalid');
  }
  const files = [];
  for (const [index, file] of descriptor.files.entries()) {
    const expectedBefore = `source-${index}-before.bin`;
    const expectedAfter = `source-${index}-after.bin`;
    if (!exactRecord(file, [
      'ref', 'before', 'after', 'mode', 'before_digest', 'after_digest',
    ]) || file.ref !== expectedRefs[index] || file.before !== expectedBefore
      || file.after !== expectedAfter || !isTodoDigest(file.before_digest)
      || !isTodoDigest(file.after_digest)) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    const beforeAbsolute = path.resolve(transaction, file.before);
    const afterAbsolute = path.resolve(transaction, file.after);
    if (path.dirname(beforeAbsolute) !== transaction || path.dirname(afterAbsolute) !== transaction) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    const before = await exactFileOrNull(beforeAbsolute);
    const after = await exactFileOrNull(afterAbsolute);
    if (before === null || after === null || sha256Bytes(before) !== file.before_digest
      || sha256Bytes(after) !== file.after_digest) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    const state = await safeRepoFile(repoRoot, file.ref);
    if ((state.state.mode & 0o7777) !== file.mode) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    const lines = splitSourceLines(before);
    let expectedAfterBytes = before;
    const replacements = [];
    for (const operation of revision.source_cutover_batch.operations) {
      const source = parseTodoSourceRef(operation.source_ref);
      if (source.path !== file.ref) continue;
      const line = lines[source.line - 1];
      if (line === undefined || !matchesTodoSourceLineDigest(line.bytes, operation.source_digest)
        || markdownCheckboxState(line.bytes) === null
        || !liveReplacementPreservesListStructure(line.bytes, operation.live_replacement)) {
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
      }
      replacements.push({ line: source.line, start: line.start, end: line.end,
        bytes: phaseV3PublishedSourceBytes(operation, line.bytes) });
    }
    for (const replacement of replacements.sort((left, right) => right.line - left.line)) {
      expectedAfterBytes = Buffer.concat([expectedAfterBytes.subarray(0, replacement.start),
        replacement.bytes, expectedAfterBytes.subarray(replacement.end)]);
    }
    if (!after.equals(expectedAfterBytes)) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    files.push({ ...file, absolute: state.absolute, beforeAbsolute, afterAbsolute, before, after });
  }
  const archiveBytes = await exactFileOrNull(path.join(transaction, 'source-archive.bin'));
  const originalByRef = new Map(files.map((file) => [file.ref, splitSourceLines(file.before)]));
  const originals = revision.source_cutover_batch.operations.map((operation) => {
    const source = parseTodoSourceRef(operation.source_ref);
    return originalByRef.get(source.path)?.[source.line - 1]?.bytes;
  });
  if (archiveBytes === null || sha256Bytes(archiveBytes) !== descriptor.archive_digest
    || originals.some((line) => line === undefined)
    || !archiveBytes.equals(sourceCutoverArchiveBytes(revision, originals))) {
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
  }
  const archiveAbsolute = path.resolve(await realpath(repoRoot), descriptor.archive_ref);
  return { descriptor, files, archive: { absolute: archiveAbsolute, bytes: archiveBytes } };
}

async function publishSourceCutover(repoRoot, staged) {
  await ensureSafeRepoParent(repoRoot, staged.archive.absolute);
  const existingArchive = await exactFileOrNull(staged.archive.absolute);
  if (existingArchive === null) await atomicWriteMode(staged.archive.absolute, staged.archive.bytes, 0o644);
  else if (!existingArchive.equals(staged.archive.bytes)) {
    fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'archive_bytes_conflict');
  }
  for (const file of staged.files) {
    const current = await readFile(file.absolute);
    if (current.equals(file.after)) continue;
    if (!current.equals(file.before)) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_bytes_conflict', { source_ref: file.ref });
    }
    await atomicWriteMode(file.absolute, file.after, file.mode);
  }
}

async function rollbackSourceCutover(staged, barrierAbsolute, { removeBarrier = true } = {}) {
  for (const file of staged.files) {
    const current = await readFile(file.absolute);
    if (current.equals(file.after)) await atomicWriteMode(file.absolute, file.before, file.mode);
    else if (!current.equals(file.before)) return false;
  }
  const archive = await exactFileOrNull(staged.archive.absolute);
  if (archive !== null) {
    if (!archive.equals(staged.archive.bytes)) return false;
    await rm(staged.archive.absolute);
    await fsyncDirectory(path.dirname(staged.archive.absolute));
  }
  if (removeBarrier) {
    await rm(barrierAbsolute, { force: true });
    await fsyncDirectory(path.dirname(barrierAbsolute));
  }
  return true;
}

async function cleanupPhaseV3Staging(transaction, staged) {
  const known = new Set(['source-archive.bin', 'source-cutover.json', 'source-originals.md']);
  await rm(path.join(transaction, 'source-cutover.json'), { force: true });
  await fsyncDirectory(transaction);
  for (const file of staged.files ?? []) {
    if (path.dirname(file.beforeAbsolute) !== transaction || path.dirname(file.afterAbsolute) !== transaction) {
      fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_stage_invalid');
    }
    await rm(file.beforeAbsolute, { force: true });
    await rm(file.afterAbsolute, { force: true });
  }
  for (const name of await readdir(transaction)) {
    if (known.has(name) || /^source-\d+-(?:before|after)\.bin$/u.test(name)) {
      await rm(path.join(transaction, name), { force: true });
    }
  }
  await fsyncDirectory(transaction);
}

export async function predecessorSourceInventory(repoRoot, previous) {
  if (previous.revision?.source_inventory !== undefined) return previous.revision.source_inventory;
  const versionsRoot = path.join(repoRoot, STORE_ROOT_REF, 'plans', previous.plan.plan_key);
  const plansByDigest = new Map();
  for (const entry of await readdir(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const planBytes = await exactFileOrNull(path.join(versionsRoot, entry.name, 'plan.json'));
    if (planBytes === null) continue;
    let plan;
    try { plan = JSON.parse(decodeUtf8(planBytes, 'STORE_INCONSISTENT', 'plan_invalid')); }
    catch { continue; }
    if (!planBytes.equals(canonicalLine(plan)) || !validateTodoPlan(plan)
      || plan.plan_key !== previous.plan.plan_key) continue;
    plansByDigest.set(plan.plan_digest, { plan, directory: path.join(versionsRoot, entry.name) });
  }
  const visited = new Set();
  let digest = previous.plan.predecessor_plan_digest;
  while (digest !== null && !visited.has(digest) && visited.size < 512) {
    visited.add(digest);
    const candidate = plansByDigest.get(digest);
    if (candidate === undefined) break;
    const revisionBytes = await exactFileOrNull(path.join(candidate.directory, 'revision.json'));
    if (revisionBytes !== null) {
      let revision;
      try { revision = JSON.parse(decodeUtf8(revisionBytes,
        'STORE_INCONSISTENT', 'revision_invalid')); } catch { revision = null; }
      if (revision !== null && revisionBytes.equals(canonicalLine(revision))
        && (validateTodoRevision(revision) || validatePhaseTodoRevision(revision))
        && revision.project_id === candidate.plan.project_id
        && revision.plan_key === candidate.plan.plan_key
        && canonicalizeTodoArtifact(revision.desired_plan)
          === canonicalizeTodoArtifact(candidate.plan)
        && revision.source_inventory !== undefined) return revision.source_inventory;
    }
    digest = candidate.plan.predecessor_plan_digest;
  }
  return { active: [], excluded_tombstones: [] };
}

export async function verifyEffectivePhaseTodoRevisionSources(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const member = options.member;
  const revision = member?.revision;
  if (!validatePhaseTodoRevision(revision)
    || canonicalizeTodoArtifact(revision.desired_plan)
      !== canonicalizeTodoArtifact(member?.plan)) {
    fail('REVISION_INVALID', 'phase_revision_schema_or_digest_invalid');
  }
  const inventory = revision.schema === 'lattice.phase_todo_revision.v3'
    ? revision.source_inventory : await predecessorSourceInventory(repoRoot, member);
  await verifyRevisionSources(repoRoot, inventory);
  return inventory;
}

function validatePhaseV3SourceInventoryDiff(previousInventory, revision) {
  const desired = revision.source_inventory;
  const previousActive = new Map(previousInventory.active.map((entry) => [entry.task_id, entry]));
  const desiredTombstoneKeys = new Set(desired.excluded_tombstones.map((entry) => (
    `${entry.source_ref}\0${entry.source_digest}`)));
  for (const entry of previousInventory.active) {
    const active = desired.active.find(({ task_id }) => task_id === entry.task_id);
    const continued = active?.source_ref === entry.source_ref && active.source_digest === entry.source_digest;
    const relocated = revision.source_cutover_batch.operations.some((operation, index) => {
      if (operation.source_ref !== entry.source_ref || operation.source_digest !== entry.source_digest) {
        return false;
      }
      const archiveRef = todoCutoverArchiveSourceRef(revision.source_cutover_batch, index);
      return operation.disposition === 'active'
        ? desired.active.some((candidate) => candidate.task_id === operation.task_id
          && candidate.source_ref === archiveRef && candidate.source_digest === operation.source_digest)
        : desired.excluded_tombstones.some((candidate) => candidate.source_ref === archiveRef
          && candidate.source_digest === operation.source_digest);
    });
    if (!continued && !relocated
      && !desiredTombstoneKeys.has(`${entry.source_ref}\0${entry.source_digest}`)) {
      fail('REVISION_INVALID', 'predecessor_source_silently_dropped', { task_id: entry.task_id });
    }
  }
  const previousTombstoneKeys = new Set(previousInventory.excluded_tombstones.map((entry) => (
    `${entry.source_ref}\0${entry.source_digest}`)));
  const previousSourceKeys = new Set([...previousTombstoneKeys,
    ...previousInventory.active.map((entry) => `${entry.source_ref}\0${entry.source_digest}`)]);
  if ([...previousTombstoneKeys].some((key) => !desiredTombstoneKeys.has(key))) {
    fail('REVISION_INVALID', 'predecessor_source_silently_dropped');
  }
  const expected = [
    ...desired.active.filter((entry) => {
      const old = previousActive.get(entry.task_id);
      return old?.source_ref !== entry.source_ref || old.source_digest !== entry.source_digest;
    }).map((entry) => `active\0${entry.task_id}\0${entry.source_ref}\0${entry.source_digest}`),
    ...desired.excluded_tombstones.filter((entry) => (
      !previousSourceKeys.has(`${entry.source_ref}\0${entry.source_digest}`)
    )).map((entry) => `excluded\0null\0${entry.source_ref}\0${entry.source_digest}`),
  ].sort();
  const actual = revision.source_cutover_batch.operations.map((operation, index) => (
    `${operation.disposition}\0${operation.task_id}\0${todoCutoverArchiveSourceRef(
      revision.source_cutover_batch, index)}\0${operation.source_digest}`)).sort();
  if (canonicalizeTodoArtifact(actual) !== canonicalizeTodoArtifact(expected)) {
    fail('REVISION_INVALID', 'source_cutover_inventory_diff_mismatch');
  }
}

async function applyPhaseTodoRevisionV3(options, revision, repoRoot) {
  return withLock(repoRoot, async () => {
    const barrierAbsolute = path.resolve(repoRoot, SOURCE_CUTOVER_BARRIER_REF);
    const barrierBytes = await exactFileOrNull(barrierAbsolute);
    let recovering = false;
    if (barrierBytes !== null) {
      let barrier;
      try { barrier = JSON.parse(decodeUtf8(barrierBytes,
        'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid')); }
      catch (error) {
        if (error instanceof TodoStoreError) throw error;
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid');
      }
      if (barrier?.schema !== 'lattice.todo_source_cutover_barrier.v1'
        || barrier.revision_digest !== revision.revision_digest) {
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
      }
      recovering = true;
    }
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now,
      ...(recovering ? { allowSourceCutoverRevisionDigest: revision.revision_digest,
        sourceCutoverRecoveryCapability: SOURCE_CUTOVER_RECOVERY_CAPABILITY } : {}) });
    const previous = store.members.find(({ descriptor }) => descriptor.plan_key === revision.plan_key);
    if (!previous || revision.project_id !== store.project_id) fail('STORE_INCONSISTENT', 'plan_not_active');
    const base = `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}`;
    const revisionRef = `${base}/revision.json`; const planRef = `${base}/plan.json`;
    const journalRef = `${base}/journal/active.jsonl`; const snapshotRef = `${base}/snapshot.json`;
    const sourceReceiptRef = `${base}/source-cutover-receipt.json`;
    const commitReceiptRef = `${base}/phase-revision-commit-receipt.json`;
    const transactionRef = `${STORE_ROOT_REF}/transactions/phase-v3/${revision.plan_key}/${revision.desired_plan.plan_version}`;
    const transaction = path.resolve(repoRoot, transactionRef);
    const activeGenesis = previous.journal.events[0];
    if (previous.plan.plan_digest === revision.desired_plan.plan_digest
      && activeGenesis.schema === 'lattice.todo_event.v4'
      && activeGenesis.revision_digest === revision.revision_digest) {
      const sourceReceiptBytes = await exactFileOrNull(path.resolve(repoRoot, sourceReceiptRef));
      const commitReceiptBytes = await exactFileOrNull(path.resolve(repoRoot, commitReceiptRef));
      if (sourceReceiptBytes === null || commitReceiptBytes === null
        || previous.descriptor.active_revision_digest !== revision.revision_digest) {
        fail('STORE_INCONSISTENT', 'phase_revision_receipt_missing');
      }
      const sourceReceipt = JSON.parse(decodeUtf8(sourceReceiptBytes,
        'STORE_INCONSISTENT', 'phase_revision_receipt_invalid'));
      const commitReceipt = JSON.parse(decodeUtf8(commitReceiptBytes,
        'STORE_INCONSISTENT', 'phase_revision_receipt_invalid'));
      if (!sourceReceiptBytes.equals(canonicalLine(sourceReceipt))
        || !commitReceiptBytes.equals(canonicalLine(commitReceipt))
        || !await verifyPhaseV3SourceReceipt(repoRoot, revision, sourceReceipt)
        || !validPhaseRevisionCommitReceipt(commitReceipt, revision, previous.descriptor,
          activeGenesis, sourceReceipt)) fail('STORE_INCONSISTENT', 'phase_revision_receipt_invalid');
      await rm(barrierAbsolute, { force: true });
      await rm(transaction, { recursive: true, force: true });
      return commitReceipt;
    }
    if (previous.plan.plan_digest !== revision.predecessor.plan_digest
      || previous.plan.plan_version !== revision.predecessor.plan_version
      || previous.journal.events.at(-1).event_digest !== revision.predecessor.journal_head_digest) {
      fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
    }
    const predecessorGenesis = previous.journal.events[0];
    const predecessorReconciliationDigest = predecessorGenesis.schema === 'lattice.todo_event.v2'
      ? predecessorGenesis.reconciliation_digest
      : previous.revision?.reconciliation?.reconciliation_digest
        ?? todoLegacyReconciliationDigest({ planDigest: previous.plan.plan_digest,
          journalHeadDigest: previous.journal.events.at(-1).event_digest });
    if (revision.reconciliation.predecessor_reconciliation_digest
      !== predecessorReconciliationDigest) fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
    const previousInventory = await predecessorSourceInventory(repoRoot, previous);
    await verifyRevisionSources(repoRoot, previousInventory);
    validatePhaseV3SourceInventoryDiff(previousInventory, revision);
    await rejectCompetingPhaseV3Transaction(repoRoot, revision);
    verifyPlanNarrativeAnchors(repoRoot, revision.desired_plan, previous.plan);
    const stateMigration = stateMigrationFor(previous, revision);
    const phaseStateMigration = phaseStateMigrationFor(previous, revision);
    const carriedChain = carriedPlanScopedChain(store, previous, revision.desired_plan, journalRef, stateMigration);
    validateMergedGraph(store.members.map((member) => member === previous
      ? { ...member, plan: revision.desired_plan, plan_scoped: carriedChain } : member));
    const candidateGenesis = buildPhaseRevisionGenesis(revision.desired_plan, {
      previous_digest: revision.predecessor.journal_head_digest, actor: options.actor,
      recorded_at: options.recordedAt, provenance: options.provenance ?? null,
      revision_digest: revision.revision_digest, state_migration: stateMigration,
      phase_state_migration: phaseStateMigration,
    });
    await ensureSafeStoreDirectory(repoRoot, transaction);
    for (const ref of [revisionRef, planRef, journalRef, snapshotRef,
      sourceReceiptRef, commitReceiptRef]) {
      await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, ref)));
    }
    const markerAbsolute = path.join(transaction, 'marker.json');
    const markerBytes = await exactFileOrNull(markerAbsolute);
    let genesis = candidateGenesis;
    if (markerBytes === null) {
      await atomicWrite(markerAbsolute, canonicalLine({
        schema: 'lattice.phase_todo_revision_transaction.v1', revision, genesis,
      }));
    } else {
      const marker = parsePhaseRevisionMarker(markerBytes);
      if (canonicalizeTodoArtifact(marker.revision) !== canonicalizeTodoArtifact(revision)
        || canonicalizeTodoArtifact(marker.genesis.state_migration)
          !== canonicalizeTodoArtifact(stateMigration)
        || canonicalizeTodoArtifact(marker.genesis.phase_state_migration)
          !== canonicalizeTodoArtifact(phaseStateMigration)) {
        fail('REVISION_CONFLICT', 'revision_bytes_conflict');
      }
      genesis = marker.genesis;
    }
    await protocolStage(options, 'phase_v3_marker_durable');
    const tasks = replay(revision.desired_plan, [genesis], {
      now: options.now ? new Date(options.now) : new Date(),
      verifyEvidence: evidenceVerifier(store.manifest, repoRoot, false),
      verifyImportSource: importSourceVerifier(repoRoot, false),
    });
    const snapshot = snapshotFor(revision.desired_plan, [genesis], tasks);
    for (const [stage, ref, bytes] of [
      ['phase_v3_revision_durable', revisionRef, canonicalLine(revision)],
      ['phase_v3_plan_durable', planRef, canonicalLine(revision.desired_plan)],
      ['phase_v3_genesis_durable', journalRef, canonicalLine(genesis)],
      ['phase_v3_snapshot_durable', snapshotRef, canonicalLine(snapshot)],
    ]) {
      await publishRevisionArtifact(path.join(transaction, path.basename(ref)),
        path.resolve(repoRoot, ref), bytes);
      await protocolStage(options, stage);
    }
    let sourceReceiptBytes = await exactFileOrNull(path.resolve(repoRoot, sourceReceiptRef));
    let sourceReceipt;
    if (sourceReceiptBytes === null) {
      let staged;
      if (recovering) {
        try { staged = await loadSourceCutoverStage(repoRoot, transaction, revision); }
        catch (error) {
          if (!(error instanceof TodoStoreError)
            || error.code !== 'SOURCE_CUTOVER_RECOVERY_REQUIRED'
            || error.detail?.reason !== 'source_cutover_stage_missing') throw error;
          staged = { descriptor: { files: [] }, files: [] };
        }
      } else {
        const images = await buildSourceCutoverImages(repoRoot, revision);
        const originals = await Promise.all(revision.source_cutover_batch.operations
          .map((operation) => sourceItemBytes(repoRoot, operation.source_ref)));
        await atomicWrite(path.join(transaction, 'source-originals.md'),
          Buffer.concat(originals.flatMap((bytes) => [bytes, Buffer.from('\n')])));
        await stageSourceCutover(transaction, revision, images);
        staged = await loadSourceCutoverStage(repoRoot, transaction, revision);
        await atomicWrite(barrierAbsolute, canonicalLine({
          schema: 'lattice.todo_source_cutover_barrier.v1', revision_digest: revision.revision_digest,
        }));
        await protocolStage(options, 'phase_v3_cutover_barrier_durable');
      }
      if (staged.descriptor.files.length > 0) await publishSourceCutover(repoRoot, staged);
      await protocolStage(options, 'phase_v3_source_published');
      try {
        await verifyRevisionSources(repoRoot, revision.source_inventory);
        sourceReceipt = await buildPhaseV3SourceReceipt(repoRoot, revision, transactionRef);
      } catch (error) {
        if (!(error instanceof TodoStoreError)) throw error;
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_postimage_invalid');
      }
      await cleanupPhaseV3Staging(transaction, staged);
      await protocolStage(options, 'phase_v3_source_cleanup');
      await publishRevisionArtifact(path.join(transaction, 'source-cutover-receipt.json'),
        path.resolve(repoRoot, sourceReceiptRef), canonicalLine(sourceReceipt));
      await protocolStage(options, 'phase_v3_source_receipt_durable');
    } else {
      sourceReceipt = JSON.parse(decodeUtf8(sourceReceiptBytes,
        'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_receipt_invalid'));
      if (!sourceReceiptBytes.equals(canonicalLine(sourceReceipt))
        || !await verifyPhaseV3SourceReceipt(repoRoot, revision, sourceReceipt)) {
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_receipt_invalid');
      }
    }
    const currentManifest = await readArtifact(repoRoot, MANIFEST_REF, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
    });
    if (currentManifest.manifest_digest !== store.manifest.manifest_digest) {
      fail('STORE_WRITE_CONFLICT', 'manifest_digest_changed');
    }
    const members = currentManifest.members.map((member) => ({ ...member,
      active_revision_digest: member.plan_key === revision.plan_key ? revision.revision_digest
        : store.members.find(({ descriptor }) => descriptor.plan_key === member.plan_key)
          ?.revision?.revision_digest ?? store.members.find(({ descriptor }) => (
          descriptor.plan_key === member.plan_key))?.plan.plan_digest }));
    const descriptor = members.find(({ plan_key: key }) => key === revision.plan_key);
    Object.assign(descriptor, { active_plan_version: revision.desired_plan.plan_version,
      plan_ref: planRef, journal_ref: journalRef, snapshot_ref: snapshotRef,
      topology_digest: revision.desired_plan.topology_digest,
      journal_head_digest: genesis.event_digest, active_revision_digest: revision.revision_digest });
    const commitReceipt = { schema: 'lattice.phase_revision_commit_receipt.v1',
      project_id: revision.project_id, plan_key: revision.plan_key,
      plan_version: revision.desired_plan.plan_version, revision_digest: revision.revision_digest,
      committed_member_digest: digestTodoArtifact(descriptor),
      active_plan_digest: revision.desired_plan.plan_digest,
      journal_genesis_digest: genesis.event_digest,
      reconciliation_digest: revision.reconciliation.reconciliation_digest,
      source_cutover_receipt_digest: sourceReceipt.receipt_digest,
      committed_at: genesis.recorded_at, receipt_digest: '' };
    commitReceipt.receipt_digest = todoSelfDigest(commitReceipt, 'receipt_digest');
    await publishRevisionArtifact(path.join(transaction, 'phase-revision-commit-receipt.json'),
      path.resolve(repoRoot, commitReceiptRef), canonicalLine(commitReceipt));
    await protocolStage(options, 'phase_v3_commit_receipt_durable');
    await writeCarriedPlanScopedChain(repoRoot, carriedChain);
    const nextManifest = { schema: 'lattice.todo_manifest.v2', project_id: currentManifest.project_id,
      repositories: currentManifest.repositories, members, manifest_digest: '' };
    nextManifest.manifest_digest = todoSelfDigest(nextManifest, 'manifest_digest');
    if (!validateTodoManifest(nextManifest)) fail('REVISION_INVALID', 'manifest_v2_invalid');
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(nextManifest));
    await protocolStage(options, 'phase_v3_manifest_activated');
    await rm(barrierAbsolute, { force: true });
    await fsyncDirectory(path.dirname(barrierAbsolute));
    await rm(transaction, { recursive: true, force: true });
    return commitReceipt;
  }, { lockCapability: options[STORE_LOCK_HELD],
    repairAfter: { actor: options.actor, recordedAt: options.recordedAt,
      onRepairs: options.onCrossPlanRepairs } });
}

/** Native successor transaction for first-class Phase plans; no Markdown source inventory is involved. */
export async function applyPhaseTodoRevision(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const revision = options.revision;
  if (!validatePhaseTodoRevision(revision)) fail('REVISION_INVALID', 'phase_revision_schema_or_digest_invalid');
  if (revision.schema === 'lattice.phase_todo_revision.v3') {
    return applyPhaseTodoRevisionV3(options, revision, repoRoot);
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const previous = store.members.find(({ descriptor }) => descriptor.plan_key === revision.plan_key);
    if (!previous || revision.project_id !== store.project_id) fail('STORE_INCONSISTENT', 'plan_not_active');
    const transaction = path.join(repoRoot, STORE_ROOT_REF, 'transactions', 'phase-revisions',
      revision.plan_key, revision.desired_plan.plan_version);
    const markerAbsolute = path.join(transaction, 'marker.json');
    const activeGenesis = previous.journal.events[0];
    if (previous.plan.plan_digest === revision.desired_plan.plan_digest
      && activeGenesis.schema === 'lattice.todo_event.v4'
      && activeGenesis.revision_digest === revision.revision_digest) {
      await rm(transaction, { recursive: true, force: true });
      return phaseRevisionResult(revision, activeGenesis, true);
    }
    if (previous.plan.plan_digest !== revision.predecessor.plan_digest
      || previous.plan.plan_version !== revision.predecessor.plan_version
      || previous.journal.events.at(-1).event_digest !== revision.predecessor.journal_head_digest) {
      fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
    }
    verifyPlanNarrativeAnchors(repoRoot, revision.desired_plan, previous.plan);
    const stateMigration = stateMigrationFor(previous, revision);
    const phaseStateMigration = phaseStateMigrationFor(previous, revision);
    const base = `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}`;
    const revisionRef = `${base}/revision.json`; const planRef = `${base}/plan.json`;
    const journalRef = `${base}/journal/active.jsonl`; const snapshotRef = `${base}/snapshot.json`;
    const carriedChain = carriedPlanScopedChain(store, previous, revision.desired_plan, journalRef, stateMigration);
    const prospective = store.members.map((member) => member === previous
      ? { ...member, plan: revision.desired_plan, plan_scoped: carriedChain } : member);
    validateMergedGraph(prospective);
    const candidateGenesis = buildPhaseRevisionGenesis(revision.desired_plan, {
      previous_digest: revision.predecessor.journal_head_digest,
      actor: options.actor, recorded_at: options.recordedAt, provenance: options.provenance ?? null,
      revision_digest: revision.revision_digest, state_migration: stateMigration,
      phase_state_migration: phaseStateMigration,
    });
    await ensureSafeStoreDirectory(repoRoot, transaction);
    const markerBytes = await exactFileOrNull(markerAbsolute);
    let genesis = candidateGenesis;
    if (markerBytes !== null) {
      const marker = parsePhaseRevisionMarker(markerBytes);
      if (canonicalizeTodoArtifact(marker.revision) !== canonicalizeTodoArtifact(revision)
        || canonicalizeTodoArtifact(marker.genesis.state_migration)
          !== canonicalizeTodoArtifact(stateMigration)
        || canonicalizeTodoArtifact(marker.genesis.phase_state_migration)
          !== canonicalizeTodoArtifact(phaseStateMigration)) {
        fail('REVISION_CONFLICT', 'revision_bytes_conflict');
      }
      genesis = marker.genesis;
    } else {
      await atomicWrite(markerAbsolute, canonicalLine({
        schema: 'lattice.phase_todo_revision_transaction.v1', revision, genesis,
      }));
    }
    await protocolStage(options, 'phase_revision_marker_durable');
    const tasks = replay(revision.desired_plan, [genesis], {
      now: options.now ? new Date(options.now) : new Date(),
      verifyEvidence: evidenceVerifier(store.manifest, repoRoot, false),
      verifyImportSource: importSourceVerifier(repoRoot, false),
    });
    const snapshot = snapshotFor(revision.desired_plan, [genesis], tasks);
    const artifacts = [
      ['phase_revision_input_durable', revisionRef, canonicalLine(revision)],
      ['phase_revision_plan_durable', planRef, canonicalLine(revision.desired_plan)],
      ['phase_revision_genesis_durable', journalRef, canonicalLine(genesis)],
      ['phase_revision_snapshot_durable', snapshotRef, canonicalLine(snapshot)],
      ...(revision.schema === 'lattice.phase_todo_revision.v4'
        ? [['phase_revision_backchain_durable', `${base}/backchain.json`,
          canonicalLine(boundPlanBackchain(revision.desired_plan, revision.backchain))]] : []),
    ];
    for (const [stage, ref, bytes] of artifacts) {
      const absolute = path.resolve(repoRoot, ref);
      const existing = await exactFileOrNull(absolute);
      if (existing === null) await atomicWrite(absolute, bytes);
      else if (!existing.equals(bytes)) fail('REVISION_CONFLICT', 'revision_bytes_conflict');
      await protocolStage(options, stage);
    }
    await writeCarriedPlanScopedChain(repoRoot, carriedChain);
    const currentManifest = await readArtifact(repoRoot, MANIFEST_REF, {
      code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
    });
    if (currentManifest.manifest_digest !== store.manifest.manifest_digest) {
      fail('STORE_WRITE_CONFLICT', 'manifest_digest_changed');
    }
    const descriptor = currentManifest.members.find(({ plan_key }) => plan_key === revision.plan_key);
    Object.assign(descriptor, { active_plan_version: revision.desired_plan.plan_version,
      plan_ref: planRef, journal_ref: journalRef, snapshot_ref: snapshotRef,
      topology_digest: revision.desired_plan.topology_digest, journal_head_digest: genesis.event_digest,
      // manifest v2はactive_revision_digestがgenesisのrevision_digestと一致することを読み取り時に
      // 要求する。v3昇格後のstoreでここを据え置くと、書込みは成功したように見えるのに以後の
      // readがmanifest_revision_binding_mismatchで落ちる。v1 memberはこのkeyを持てない。
      ...(currentManifest.schema === 'lattice.todo_manifest.v2'
        ? { active_revision_digest: revision.revision_digest } : {}) });
    currentManifest.manifest_digest = todoSelfDigest(currentManifest, 'manifest_digest');
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(currentManifest));
    await protocolStage(options, 'phase_revision_manifest_activated');
    await rm(transaction, { recursive: true, force: true });
    return phaseRevisionResult(revision, genesis, false);
  }, { lockCapability: options[STORE_LOCK_HELD],
    repairAfter: { actor: options.actor, recordedAt: options.recordedAt,
      onRepairs: options.onCrossPlanRepairs } });
}

/** G5 revision transaction: exact successor, state migration, and manifest-CAS activation. */
export async function applyTodoRevision(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const revision = options.revision;
  if (!validateTodoRevision(revision)) fail('REVISION_INVALID', 'revision_schema_or_digest_invalid');
  return withLock(repoRoot, async () => {
    const barrierAbsolute = path.resolve(repoRoot, SOURCE_CUTOVER_BARRIER_REF);
    const barrierBytes = await exactFileOrNull(barrierAbsolute);
    let recovering = false;
    if (barrierBytes !== null) {
      let barrier;
      try { barrier = JSON.parse(decodeUtf8(barrierBytes, 'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid')); }
      catch (error) {
        if (error instanceof TodoStoreError) throw error;
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid');
      }
      if (revision.schema !== 'lattice.todo_revision.v2'
        || barrier?.schema !== 'lattice.todo_source_cutover_barrier.v1'
        || barrier.revision_digest !== revision.revision_digest) {
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
      }
      recovering = true;
    }
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now,
      ...(recovering ? { allowSourceCutoverRevisionDigest: revision.revision_digest,
        sourceCutoverRecoveryCapability: SOURCE_CUTOVER_RECOVERY_CAPABILITY } : {}) });
    const previous = store.members.find(({ descriptor }) => descriptor.plan_key === revision.plan_key);
    if (!previous || revision.project_id !== store.project_id) fail('STORE_INCONSISTENT', 'plan_not_active');
    const activeGenesis = previous.journal.events[0];
    if (previous.plan.plan_digest === revision.desired_plan.plan_digest
      && activeGenesis.schema === 'lattice.todo_event.v2'
      && activeGenesis.revision_digest === revision.revision_digest) {
      const transaction = path.join(repoRoot, STORE_ROOT_REF, 'transactions', 'revisions',
        revision.plan_key, revision.desired_plan.plan_version);
      if (revision.schema === 'lattice.todo_revision.v2' && recovering) {
        const staged = await loadSourceCutoverStage(repoRoot, transaction, revision);
        await publishSourceCutover(repoRoot, staged);
        await rm(barrierAbsolute, { force: true });
        await fsyncDirectory(path.dirname(barrierAbsolute));
      }
      await rm(transaction, { recursive: true, force: true });
      return revisionResult(revision, activeGenesis, { recovered: recovering });
    }
    if (activeGenesis.schema === 'lattice.todo_event.v2'
      && activeGenesis.payload.predecessor_plan_digest === revision.predecessor.plan_digest
      && activeGenesis.previous_digest === revision.predecessor.journal_head_digest) {
      fail('REVISION_CONFLICT', 'revision_bytes_conflict');
    }
    if (previous.plan.plan_digest !== revision.predecessor.plan_digest
      || previous.plan.plan_version !== revision.predecessor.plan_version
      || previous.journal.events.at(-1).event_digest !== revision.predecessor.journal_head_digest) {
      fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
    }
    const predecessorReconciliationDigest = activeGenesis.schema === 'lattice.todo_event.v2'
      ? activeGenesis.reconciliation_digest
      : todoLegacyReconciliationDigest({
        planDigest: previous.plan.plan_digest,
        journalHeadDigest: previous.journal.events.at(-1).event_digest,
      });
    if (revision.reconciliation.predecessor_reconciliation_digest
      !== predecessorReconciliationDigest) fail('STORE_WRITE_CONFLICT', 'stale_predecessor');

    await rejectCompetingRevisionTransaction(repoRoot, revision);
    const cutoverImages = revision.schema === 'lattice.todo_revision.v2' && !recovering
      ? await buildSourceCutoverImages(repoRoot, revision) : null;
    if (revision.schema === 'lattice.todo_revision.v1') {
      await verifyRevisionSources(repoRoot, revision.source_inventory);
    }
    verifyPlanNarrativeAnchors(repoRoot, revision.desired_plan, previous.plan);
    const stateMigration = stateMigrationFor(previous, revision);
    const carriedChain = carriedPlanScopedChain(store, previous, revision.desired_plan,
      `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}/journal/active.jsonl`,
      stateMigration);
    const prospective = store.members.map((member) => member === previous
      ? { ...member, plan: revision.desired_plan, plan_scoped: carriedChain } : member);
    validateMergedGraph(prospective);

    const candidateGenesis = buildRevisionGenesis(revision.desired_plan, {
      previous_digest: revision.predecessor.journal_head_digest,
      actor: options.actor, recorded_at: options.recordedAt,
      provenance: options.provenance ?? null, state_migration: stateMigration,
      revision_digest: revision.revision_digest,
      reconciliation_digest: revision.reconciliation.reconciliation_digest,
    });
    const base = `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}`;
    const revisionRef = `${base}/revision.json`;
    const planRef = `${base}/plan.json`;
    const journalRef = `${base}/journal/active.jsonl`;
    const snapshotRef = `${base}/snapshot.json`;
    const transactionRef = `${STORE_ROOT_REF}/transactions/revisions/${revision.plan_key}/${revision.desired_plan.plan_version}`;
    const transaction = path.resolve(repoRoot, transactionRef);
    const markerAbsolute = path.join(transaction, 'marker.json');
    await ensureSafeStoreDirectory(repoRoot, transaction);
    await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, planRef)));
    const markerBytes = await exactFileOrNull(markerAbsolute);
    let genesis = candidateGenesis;
    if (markerBytes !== null) {
      const marker = parseRevisionMarker(markerBytes);
      if (canonicalizeTodoArtifact(marker.revision) !== canonicalizeTodoArtifact(revision)
        || canonicalizeTodoArtifact(marker.genesis.state_migration)
          !== canonicalizeTodoArtifact(stateMigration)) {
        fail('REVISION_CONFLICT', 'revision_bytes_conflict');
      }
      genesis = marker.genesis;
    } else {
      await atomicWrite(markerAbsolute, canonicalLine({
        schema: 'lattice.todo_revision_transaction.v1', revision, genesis,
      }));
    }
    await protocolStage(options, 'revision_marker_durable');

    const verifyEvidence = evidenceVerifier(store.manifest, repoRoot, false);
    const verifyImportSource = importSourceVerifier(repoRoot, false);
    const tasks = replay(revision.desired_plan, [genesis], {
      now: options.now ? new Date(options.now) : new Date(), verifyEvidence, verifyImportSource,
    });
    const snapshot = snapshotFor(revision.desired_plan, [genesis], tasks);
    const planBytes = canonicalLine(revision.desired_plan);
    const journalBytes = canonicalLine(genesis);
    const snapshotBytes = canonicalLine(snapshot);
    await publishRevisionArtifact(path.join(transaction, 'revision.json'),
      path.resolve(repoRoot, revisionRef), canonicalLine(revision));
    await protocolStage(options, 'revision_input_durable');
    await publishRevisionArtifact(path.join(transaction, 'plan.json'), path.resolve(repoRoot, planRef), planBytes);
    await protocolStage(options, 'revision_plan_durable');
    await publishRevisionArtifact(path.join(transaction, 'active.jsonl'), path.resolve(repoRoot, journalRef), journalBytes);
    await protocolStage(options, 'revision_genesis_durable');
    await publishRevisionArtifact(path.join(transaction, 'snapshot.json'), path.resolve(repoRoot, snapshotRef), snapshotBytes);
    await protocolStage(options, 'revision_snapshot_durable');

    let stagedCutover = null;
    if (revision.schema === 'lattice.todo_revision.v2') {
      if (recovering) stagedCutover = await loadSourceCutoverStage(repoRoot, transaction, revision);
      else {
        const descriptor = await stageSourceCutover(transaction, revision, cutoverImages);
        stagedCutover = await loadSourceCutoverStage(repoRoot, transaction, revision);
        if (descriptor.revision_digest !== revision.revision_digest) {
          fail('REVISION_CONFLICT', 'source_cutover_stage_invalid');
        }
        await protocolStage(options, 'source_cutover_staged');
        await atomicWrite(barrierAbsolute, canonicalLine({
          schema: 'lattice.todo_source_cutover_barrier.v1',
          revision_digest: revision.revision_digest,
        }));
        await protocolStage(options, 'source_cutover_barrier_durable');
      }
      await publishSourceCutover(repoRoot, stagedCutover);
      await protocolStage(options, 'source_cutover_published');
    }

    try {
      await writeCarriedPlanScopedChain(repoRoot, carriedChain);
      const currentManifest = await readArtifact(repoRoot, MANIFEST_REF, {
        code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
      });
      if (currentManifest.manifest_digest !== store.manifest.manifest_digest) {
        fail('STORE_WRITE_CONFLICT', 'manifest_digest_changed');
      }
      const descriptor = currentManifest.members.find(({ plan_key }) => plan_key === revision.plan_key);
      if (!descriptor || descriptor.active_plan_version !== revision.predecessor.plan_version
        || descriptor.journal_head_digest !== revision.predecessor.journal_head_digest) {
        fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
      }
      Object.assign(descriptor, {
        active_plan_version: revision.desired_plan.plan_version, plan_ref: planRef,
        journal_ref: journalRef, snapshot_ref: snapshotRef,
        topology_digest: revision.desired_plan.topology_digest,
        journal_head_digest: genesis.event_digest,
        ...(currentManifest.schema === 'lattice.todo_manifest.v2'
          ? { active_revision_digest: revision.revision_digest } : {}),
      });
      currentManifest.manifest_digest = todoSelfDigest(currentManifest, 'manifest_digest');
      await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(currentManifest));
      await protocolStage(options, 'revision_manifest_activated');
    } catch (error) {
      if (stagedCutover !== null && error instanceof TodoStoreError) {
        const rolledBack = await rollbackSourceCutover(stagedCutover, barrierAbsolute);
        if (!rolledBack) fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'rollback_incomplete');
      }
      throw error;
    }
    if (revision.schema === 'lattice.todo_revision.v2') {
      await rm(barrierAbsolute, { force: true });
      await fsyncDirectory(path.dirname(barrierAbsolute));
      await protocolStage(options, 'source_cutover_cleanup');
    }
    await rm(transaction, { recursive: true, force: true });
    return revisionResult(revision, genesis, { recovered: recovering });
  }, { lockCapability: options[STORE_LOCK_HELD],
    repairAfter: { actor: options.actor, recordedAt: options.recordedAt,
      onRepairs: options.onCrossPlanRepairs } });
}

function revisionSetResult(projectId, revisionSetDigest, entries, { recovered }) {
  const result = {
    schema: 'lattice.todo_revision_set_result.v1',
    project_id: projectId,
    revision_set_digest: revisionSetDigest,
    members: entries.map(({ revision, genesis }) => ({
      plan_key: revision.plan_key,
      plan_version: revision.desired_plan.plan_version,
      revision_digest: revision.revision_digest,
      journal_head_digest: genesis.event_digest,
    })),
    recovered,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * Multiple plan successors are prepared independently but become active through one manifest replace.
 * Set v2 additionally binds all Markdown cutovers behind one recovery barrier.
 */
export async function applyTodoRevisionSet(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const revisionSet = options.revisionSet ?? null;
  if (revisionSet !== null && !validateTodoRevisionSet(revisionSet)) {
    fail('REVISION_SET_INVALID', 'revision_set_schema_invalid');
  }
  const revisions = revisionSet?.revisions ?? options.revisions;
  if (!Array.isArray(revisions) || revisions.length < 2 || revisions.length > 64
    || revisions.some((revision) => !validateTodoRevision(revision)
      && !validatePhaseTodoRevision(revision))) {
    fail('REVISION_SET_INVALID', 'revision_set_schema_invalid');
  }
  if (revisionSet === null && revisions.some((revision) => revision.schema !== 'lattice.todo_revision.v1')) {
    fail('REVISION_SET_INVALID', 'revision_set_v2_required');
  }
  if (revisions.some((revision, index) => index > 0
    && revisions[index - 1].plan_key >= revision.plan_key)) {
    fail('REVISION_SET_INVALID', 'revision_set_order_invalid');
  }
  const projectId = revisions[0].project_id;
  if (revisions.some((revision) => revision.project_id !== projectId)) {
    fail('REVISION_SET_INVALID', 'revision_set_project_mismatch');
  }
  const revisionSetDigest = revisionSet?.revision_set_digest ?? digestTodoArtifact({
    schema: 'lattice.todo_revision_set.v1',
    project_id: projectId,
    revision_digests: revisions.map(({ plan_key, revision_digest }) => ({ plan_key, revision_digest })),
  });

  return withLock(repoRoot, async () => {
    const transactionRef = `${STORE_ROOT_REF}/transactions/revision-sets/${revisionSetDigest}`;
    const transaction = path.resolve(repoRoot, transactionRef);
    const barrierAbsolute = path.resolve(repoRoot, SOURCE_CUTOVER_BARRIER_REF);
    const barrierBytes = await exactFileOrNull(barrierAbsolute);
    let recovering = false;
    if (barrierBytes !== null) {
      let barrier;
      try { barrier = JSON.parse(decodeUtf8(barrierBytes, 'SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid')); }
      catch (error) {
        if (error instanceof TodoStoreError) throw error;
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'barrier_invalid');
      }
      if (barrier?.schema !== 'lattice.todo_source_cutover_set_barrier.v1'
        || barrier.revision_set_digest !== revisionSetDigest) {
        fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'source_cutover_recovery_required');
      }
      recovering = true;
    }
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now,
      ...(recovering ? {
        allowSourceCutoverRevisionSetDigest: revisionSetDigest,
        sourceCutoverRecoveryCapability: SOURCE_CUTOVER_RECOVERY_CAPABILITY,
      } : {}) });
    if (store.project_id !== projectId) fail('REVISION_SET_INVALID', 'revision_set_project_mismatch');
    const byPlan = new Map(store.members.map((member) => [member.descriptor.plan_key, member]));
    const activeDesired = revisions.map((revision) => {
      const member = byPlan.get(revision.plan_key);
      const genesis = member?.journal.events[0];
      const expectedGenesisSchema = ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2']
        .includes(revision.schema)
        ? 'lattice.todo_event.v4' : 'lattice.todo_event.v2';
      return member !== undefined
        && member.plan.plan_digest === revision.desired_plan.plan_digest
        && genesis.schema === expectedGenesisSchema
        && genesis.revision_digest === revision.revision_digest;
    });
    if (activeDesired.every(Boolean)) {
      const entries = revisions.map((revision) => ({
        revision,
        genesis: byPlan.get(revision.plan_key).journal.events[0],
      }));
      if (recovering) {
        for (const entry of entries.filter(({ revision }) => revision.schema === 'lattice.todo_revision.v2')) {
          const staged = await loadSourceCutoverStage(repoRoot,
            path.join(transaction, entry.revision.plan_key, 'source'), entry.revision);
          await publishSourceCutover(repoRoot, staged);
        }
        await rm(barrierAbsolute, { force: true });
        await fsyncDirectory(path.dirname(barrierAbsolute));
        await rm(transaction, { recursive: true, force: true });
      }
      return revisionSetResult(projectId, revisionSetDigest, entries, { recovered: true });
    }
    if (activeDesired.some(Boolean)) fail('REVISION_SET_RECOVERY_REQUIRED', 'partial_manifest_activation');

    const prepared = [];
    for (const revision of revisions) {
      const previous = byPlan.get(revision.plan_key);
      if (previous === undefined) fail('STORE_INCONSISTENT', 'plan_not_active');
      if (previous.plan.plan_digest !== revision.predecessor.plan_digest
        || previous.plan.plan_version !== revision.predecessor.plan_version
        || previous.journal.events.at(-1).event_digest !== revision.predecessor.journal_head_digest) {
        fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
      }
      const phaseRevision = ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2']
        .includes(revision.schema);
      const activeGenesis = previous.journal.events[0];
      if (!phaseRevision) {
        const predecessorReconciliationDigest = activeGenesis.schema === 'lattice.todo_event.v2'
          ? activeGenesis.reconciliation_digest
          : todoLegacyReconciliationDigest({
            planDigest: previous.plan.plan_digest,
            journalHeadDigest: previous.journal.events.at(-1).event_digest,
          });
        if (revision.reconciliation.predecessor_reconciliation_digest
          !== predecessorReconciliationDigest) fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
        await rejectCompetingRevisionTransaction(repoRoot, revision);
      }
      const cutoverImages = revision.schema === 'lattice.todo_revision.v2' && !recovering
        ? await buildSourceCutoverImages(repoRoot, revision) : null;
      if (revision.schema === 'lattice.todo_revision.v1') {
        await verifyRevisionSources(repoRoot, revision.source_inventory);
      }
      verifyPlanNarrativeAnchors(repoRoot, revision.desired_plan, previous.plan);
      const stateMigration = stateMigrationFor(previous, revision);
      const phaseStateMigration = phaseRevision ? phaseStateMigrationFor(previous, revision) : null;
      const commonGenesis = {
        previous_digest: revision.predecessor.journal_head_digest, actor: options.actor,
        recorded_at: options.recordedAt, provenance: options.provenance ?? null,
        state_migration: stateMigration, revision_digest: revision.revision_digest,
      };
      const genesis = phaseRevision
        ? buildPhaseRevisionGenesis(revision.desired_plan, {
          ...commonGenesis, phase_state_migration: phaseStateMigration,
        })
        : buildRevisionGenesis(revision.desired_plan, {
          ...commonGenesis, reconciliation_digest: revision.reconciliation.reconciliation_digest,
        });
      const carriedChain = carriedPlanScopedChain(store, previous, revision.desired_plan,
        `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}/journal/active.jsonl`,
        stateMigration);
      prepared.push({ revision, previous, stateMigration, phaseStateMigration, genesis, cutoverImages, carriedChain });
    }

    const desiredByPlan = new Map(prepared.map((entry) => [entry.revision.plan_key, entry]));
    validateMergedGraph(store.members.map((member) => desiredByPlan.has(member.descriptor.plan_key)
      ? { ...member, plan: desiredByPlan.get(member.descriptor.plan_key).revision.desired_plan,
        plan_scoped: desiredByPlan.get(member.descriptor.plan_key).carriedChain } : member));

    await ensureSafeStoreDirectory(repoRoot, transaction);
    const mixedPhaseSet = prepared.some(({ revision }) => ([
      'lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2',
    ].includes(revision.schema)));
    let marker = {
      schema: mixedPhaseSet
        ? 'lattice.todo_revision_set_transaction.v2' : 'lattice.todo_revision_set_transaction.v1',
      project_id: projectId,
      revision_set_digest: revisionSetDigest,
      entries: prepared.map(({ revision, stateMigration, phaseStateMigration, genesis }) => ({
        revision, state_migration: stateMigration,
        ...(phaseStateMigration === null ? {} : { phase_state_migration: phaseStateMigration }), genesis,
      })),
    };
    const markerAbsolute = path.join(transaction, 'marker.json');
    const existingMarker = await exactFileOrNull(markerAbsolute);
    if (existingMarker === null) await atomicWrite(markerAbsolute, canonicalLine(marker));
    else {
      const durable = parseRevisionSetMarker(existingMarker);
      const expectedIdentity = marker.entries.map(({ revision, state_migration: stateMigration,
        phase_state_migration: phaseStateMigration }) => ({
        revision, state_migration: stateMigration,
        ...(phaseStateMigration === undefined ? {} : { phase_state_migration: phaseStateMigration }),
      }));
      const durableIdentity = durable.entries.map(({ revision, state_migration: stateMigration,
        phase_state_migration: phaseStateMigration }) => ({
        revision, state_migration: stateMigration,
        ...(phaseStateMigration === undefined ? {} : { phase_state_migration: phaseStateMigration }),
      }));
      if (durable.project_id !== projectId || durable.revision_set_digest !== revisionSetDigest
        || canonicalizeTodoArtifact(durableIdentity) !== canonicalizeTodoArtifact(expectedIdentity)) {
        fail('REVISION_CONFLICT', 'revision_set_bytes_conflict');
      }
      marker = durable;
      for (const [index, entry] of prepared.entries()) entry.genesis = marker.entries[index].genesis;
    }
    await protocolStage(options, 'revision_set_marker_durable');

    const verifyEvidence = evidenceVerifier(store.manifest, repoRoot, false);
    const verifyImportSource = importSourceVerifier(repoRoot, false);
    for (const entry of prepared) {
      const { revision, genesis } = entry;
      const tasks = replay(revision.desired_plan, [genesis], {
        now: options.now ? new Date(options.now) : new Date(), verifyEvidence, verifyImportSource,
      });
      const snapshot = snapshotFor(revision.desired_plan, [genesis], tasks);
      const base = `${STORE_ROOT_REF}/plans/${revision.plan_key}/${revision.desired_plan.plan_version}`;
      entry.refs = {
        revision_ref: `${base}/revision.json`,
        plan_ref: `${base}/plan.json`,
        journal_ref: `${base}/journal/active.jsonl`,
        snapshot_ref: `${base}/snapshot.json`,
      };
      const staged = path.join(transaction, revision.plan_key);
      await publishRevisionArtifact(path.join(staged, 'revision.json'),
        path.resolve(repoRoot, entry.refs.revision_ref), canonicalLine(revision));
      await publishRevisionArtifact(path.join(staged, 'plan.json'),
        path.resolve(repoRoot, entry.refs.plan_ref), canonicalLine(revision.desired_plan));
      await publishRevisionArtifact(path.join(staged, 'active.jsonl'),
        path.resolve(repoRoot, entry.refs.journal_ref), canonicalLine(genesis));
      await publishRevisionArtifact(path.join(staged, 'snapshot.json'),
        path.resolve(repoRoot, entry.refs.snapshot_ref), canonicalLine(snapshot));
    }
    await protocolStage(options, 'revision_set_artifacts_durable');

    const stagedCutovers = [];
    if (prepared.some(({ revision }) => revision.schema === 'lattice.todo_revision.v2')) {
      const sourceRefs = new Set();
      const archiveRefs = new Set();
      for (const entry of prepared.filter(({ revision }) => revision.schema === 'lattice.todo_revision.v2')) {
        if (archiveRefs.has(entry.revision.source_cutover_batch.archive_ref)) {
          fail('REVISION_SET_INVALID', 'source_cutover_archive_conflict');
        }
        archiveRefs.add(entry.revision.source_cutover_batch.archive_ref);
        for (const operation of entry.revision.source_cutover_batch.operations) {
          if (sourceRefs.has(operation.source_ref)) {
            fail('REVISION_SET_INVALID', 'source_cutover_source_conflict');
          }
          sourceRefs.add(operation.source_ref);
        }
        const sourceTransaction = path.join(transaction, entry.revision.plan_key, 'source');
        if (!recovering) await stageSourceCutover(sourceTransaction, entry.revision, entry.cutoverImages);
        stagedCutovers.push(await loadSourceCutoverStage(repoRoot, sourceTransaction, entry.revision));
      }
      if (!recovering) {
        await atomicWrite(barrierAbsolute, canonicalLine({
          schema: 'lattice.todo_source_cutover_set_barrier.v1',
          revision_set_digest: revisionSetDigest,
          revision_digests: prepared.filter(({ revision }) => revision.schema === 'lattice.todo_revision.v2')
            .map(({ revision }) => revision.revision_digest),
        }));
        await protocolStage(options, 'revision_set_source_barrier_durable');
      }
      for (const [index, staged] of stagedCutovers.entries()) {
        await publishSourceCutover(repoRoot, staged);
        await protocolStage(options, `revision_set_source_published_${index}`);
      }
    }

    try {
      for (const entry of prepared) await writeCarriedPlanScopedChain(repoRoot, entry.carriedChain);
      const currentManifest = await readArtifact(repoRoot, MANIFEST_REF, {
        code: 'STORE_INCONSISTENT', maxBytes: TODO_LIMITS.snapshotBytes, validate: validateTodoManifest,
      });
      if (currentManifest.manifest_digest !== store.manifest.manifest_digest) {
        fail('STORE_WRITE_CONFLICT', 'manifest_digest_changed');
      }
      for (const entry of prepared) {
        const descriptor = currentManifest.members.find(({ plan_key }) => plan_key === entry.revision.plan_key);
        if (descriptor === undefined
          || descriptor.active_plan_version !== entry.revision.predecessor.plan_version
          || descriptor.journal_head_digest !== entry.revision.predecessor.journal_head_digest) {
          fail('STORE_WRITE_CONFLICT', 'stale_predecessor');
        }
        Object.assign(descriptor, {
          active_plan_version: entry.revision.desired_plan.plan_version,
          plan_ref: entry.refs.plan_ref,
          journal_ref: entry.refs.journal_ref,
          snapshot_ref: entry.refs.snapshot_ref,
          topology_digest: entry.revision.desired_plan.topology_digest,
          journal_head_digest: entry.genesis.event_digest,
        });
      }
      currentManifest.manifest_digest = todoSelfDigest(currentManifest, 'manifest_digest');
      await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(currentManifest));
      await protocolStage(options, 'revision_set_manifest_activated');
    } catch (error) {
      if (stagedCutovers.length > 0 && error instanceof TodoStoreError) {
        let rolledBack = true;
        for (const staged of [...stagedCutovers].reverse()) {
          rolledBack = await rollbackSourceCutover(staged, barrierAbsolute, { removeBarrier: false })
            && rolledBack;
        }
        if (!rolledBack) fail('SOURCE_CUTOVER_RECOVERY_REQUIRED', 'rollback_incomplete');
        await rm(barrierAbsolute, { force: true });
        await fsyncDirectory(path.dirname(barrierAbsolute));
      }
      throw error;
    }
    if (stagedCutovers.length > 0) {
      await rm(barrierAbsolute, { force: true });
      await fsyncDirectory(path.dirname(barrierAbsolute));
      await protocolStage(options, 'revision_set_source_cleanup');
    }
    await rm(transaction, { recursive: true, force: true });
    return revisionSetResult(projectId, revisionSetDigest, prepared, { recovered: recovering });
  }, { lockCapability: options[STORE_LOCK_HELD],
    repairAfter: { actor: options.actor, recordedAt: options.recordedAt,
      onRepairs: options.onCrossPlanRepairs } });
}

/** G5 revise primitive: topology changes only by publishing a successor version. */
export async function createSuccessorTodoPlan(options = {}) {
  requireWriter(options.writer, 'g5-authoring');
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const previous = store.members.find(({ descriptor }) => descriptor.plan_key === options.planKey);
    if (!previous) fail('STORE_INCONSISTENT', 'plan_not_active');
    if (options.plan.predecessor_plan_digest !== previous.plan.plan_digest
      || options.plan.plan_version === previous.plan.plan_version) throw new TypeError('successor predecessor/version binding invalid');
    const plan = buildTodoPlan(options.plan);
    if (plan.project_id !== store.project_id || plan.plan_key !== previous.plan.plan_key) {
      throw new TypeError('successor identity must match active plan');
    }
    const schemaRank = new Map([
      ['lattice.todo_plan.v1', 1], ['lattice.todo_plan.v2', 2], ['lattice.todo_plan.v3', 3],
      // v6はphase無しv3へdesign_memoを追加した枝であり、phase世代より後という意味ではない。
      ['lattice.todo_plan.v4', 4], ['lattice.todo_plan.v5', 5], ['lattice.todo_plan.v6', 3],
      ['lattice.todo_plan.v7', 5], ['lattice.todo_plan.v8', 5],
    ]);
    if (schemaRank.get(plan.schema) < schemaRank.get(previous.plan.schema)) {
      throw new TypeError(previous.plan.schema === 'lattice.todo_plan.v2'
        && plan.schema === 'lattice.todo_plan.v1'
        ? 'todo plan schema cannot regress from v2 to v1'
        : 'todo plan schema cannot regress');
    }
    if (['lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(previous.plan.schema)
      && !['lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(plan.schema)) {
      fail('REVISION_INVALID', 'design_memo_schema_downgrade', {
        predecessor_schema: previous.plan.schema, desired_schema: plan.schema,
      });
    }
    if (previous.plan.schema === 'lattice.todo_plan.v8' && plan.schema !== 'lattice.todo_plan.v8') {
      fail('REVISION_INVALID', 'done_condition_schema_downgrade', {
        predecessor_schema: previous.plan.schema, desired_schema: plan.schema,
      });
    }
    verifyPlanNarrativeAnchors(repoRoot, plan, previous.plan);
    const migration = options.genesis.task_migration ?? [];
    const oldIds = previous.plan.tasks.map(({ task_id }) => task_id).sort();
    const migrationIds = migration.map(({ from_task_id }) => from_task_id).sort();
    if (canonicalizeTodoArtifact(oldIds) !== canonicalizeTodoArtifact(migrationIds)
      || new Set(migrationIds).size !== migrationIds.length) throw new TypeError('every predecessor task requires one migration entry');
    const newIds = new Set(plan.tasks.map(({ task_id }) => task_id));
    if (migration.some(({ to_task_id }) => to_task_id !== 'removed' && !newIds.has(to_task_id))) {
      throw new TypeError('task migration targets missing successor task');
    }
    const genesis = buildPlanGenesis(plan, {
      ...options.genesis, previous_digest: previous.journal.events.at(-1).event_digest,
    });
    const base = `${STORE_ROOT_REF}/plans/${plan.plan_key}/${plan.plan_version}`;
    const planRef = `${base}/plan.json`; const journalRef = `${base}/journal/active.jsonl`; const snapshotRef = `${base}/snapshot.json`;
    const carriedChain = carriedPlanScopedChain(store, previous, plan, journalRef, migration);
    const prospective = store.members.map((member) => member === previous ? { ...member, plan, plan_scoped: carriedChain } : member);
    validateMergedGraph(prospective);
    try { await lstat(path.resolve(repoRoot, planRef)); fail('STORE_WRITE_CONFLICT', 'successor_version_exists'); }
    catch (error) { if (error instanceof TodoStoreError) throw error; if (error?.code !== 'ENOENT') throw error; }
    const tasks = replay(plan, [genesis], { now: options.now ? new Date(options.now) : new Date() });
    const snapshot = snapshotFor(plan, [genesis], tasks);
    // Required order: plan, genesis journal, then manifest activation. Snapshot is
    // prepared before activation so a newly active version is immediately writable.
    await atomicWrite(path.resolve(repoRoot, planRef), canonicalLine(plan));
    await atomicWrite(path.resolve(repoRoot, journalRef), canonicalLine(genesis));
    await atomicWrite(path.resolve(repoRoot, snapshotRef), canonicalLine(snapshot));
    await writeCarriedPlanScopedChain(repoRoot, carriedChain);
    Object.assign(previous.descriptor, {
      active_plan_version: plan.plan_version, plan_ref: planRef, journal_ref: journalRef,
      snapshot_ref: snapshotRef, topology_digest: plan.topology_digest,
      journal_head_digest: genesis.event_digest,
    });
    store.manifest.manifest_digest = todoSelfDigest(store.manifest, 'manifest_digest');
    await atomicWrite(path.resolve(repoRoot, MANIFEST_REF), canonicalLine(store.manifest));
    return { plan, genesis, snapshot };
  }, { repairAfter: { actor: options.genesis.actor, recordedAt: options.genesis.recorded_at,
    onRepairs: options.onCrossPlanRepairs } });
}

const INDEPENDENCE_ARTIFACT_NAME = 'independence.json';
const INDEPENDENCE_ARTIFACT_BYTES = 1_048_576;

/**
 * planと同じversionディレクトリに置く並置artifactのref（ADR 0127 Decision 1）。
 * manifestへは登録しない。plan versionが変われば旧artifactは自然に非アクティブになる。
 */
export function todoIndependenceRef(planKey, planVersion) {
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/${INDEPENDENCE_ARTIFACT_NAME}`;
}

function activeMember(store, planKey) {
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (!member) fail('STORE_INCONSISTENT', 'plan_not_active', { plan_key: planKey });
  return member;
}

/**
 * independence artifactを、active planへbindしてから書く。
 *
 * plan versionとtopology digestが現在のactive planと一致しない記録は、書いた瞬間から
 * 別topologyについての主張になるため受理しない。planの正本（journal・snapshot・manifest）
 * には触れない。
 */
export async function writeTodoIndependenceArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { artifact } = options;
  if (!validateTodoIndependence(artifact)) {
    fail('INDEPENDENCE_ARTIFACT_INVALID', 'independence_artifact_invalid');
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    if (store.project_id !== artifact.project_id) {
      fail('INDEPENDENCE_BINDING_MISMATCH', 'project_id_mismatch', {
        expected: store.project_id, actual: artifact.project_id,
      });
    }
    const member = activeMember(store, artifact.plan_key);
    if (member.plan.plan_version !== artifact.plan_version) {
      fail('INDEPENDENCE_BINDING_MISMATCH', 'plan_version_mismatch', {
        expected: member.plan.plan_version, actual: artifact.plan_version,
      });
    }
    if (member.plan.topology_digest !== artifact.topology_digest) {
      fail('INDEPENDENCE_BINDING_MISMATCH', 'topology_digest_mismatch', {
        expected: member.plan.topology_digest, actual: artifact.topology_digest,
      });
    }
    const planTaskIds = new Set(member.plan.tasks.map(({ task_id: taskId }) => taskId));
    const absent = artifact.task_ids.filter((taskId) => !planTaskIds.has(taskId));
    if (absent.length > 0) {
      fail('INDEPENDENCE_BINDING_MISMATCH', 'task_absent_from_plan', { task_ids: absent });
    }
    const ref = todoIndependenceRef(artifact.plan_key, artifact.plan_version);
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(artifact));
    return { ref, artifact };
  });
}

/**
 * active planに紐づくindependence artifactを読む。
 *
 * 記録が無ければnull（「まだ判定していない」）を返す。壊れている・非canonical・
 * 契約違反はnullへ丸めずtyped failにする。無い状態と読めない状態を同じ顔にしない。
 */
export async function readTodoIndependenceArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const store = options.store ?? await readTodoStore({ repoRoot, now: options.now });
  const member = activeMember(store, options.planKey);
  const ref = todoIndependenceRef(member.plan.plan_key, member.plan.plan_version);
  try {
    const artifact = await readArtifact(repoRoot, ref, {
      code: 'INDEPENDENCE_ARTIFACT_INVALID',
      maxBytes: INDEPENDENCE_ARTIFACT_BYTES,
      // 旧契約は本体を信用せず、canonical JSONと版をまたいで不変なidentityの型だけを見る。
      // schema名だけの壊れた記録や現行v3をこの分岐へ逃がさず、旧版集合も明示したものだけに閉じる。
      validate: (value) => validateTodoIndependence(value)
        || isTodoIndependenceLegacyArtifactIdentity(value),
      missing: true,
    });
    if (artifact === null || validateTodoIndependence(artifact)) return artifact;
    return {
      schema: TODO_INDEPENDENCE_LEGACY_MARKER_SCHEMA,
      legacy_schema: artifact.schema,
      project_id: member.plan.project_id,
      plan_key: member.plan.plan_key,
      plan_version: null,
      topology_digest: null,
      base_sha: null,
    };
  } catch (error) {
    // 読めない記録は握りつぶさない。ただしどのplanをどう直すかまで言わないと、
    // 消費者は「壊れている」以上のことができない。
    if (error instanceof TodoStoreError && error.code === 'INDEPENDENCE_ARTIFACT_INVALID') {
      throw new TodoStoreError(error.code, error.detail.reason, undefined, {
        ...error.detail,
        plan_key: member.plan.plan_key,
        artifact_ref: ref,
        next_action: 'recompile_independence_or_remove_stale_record',
      });
    }
    throw error;
  }
}

const SEAM_PROPOSAL_ARTIFACT_NAME = 'seam-proposal.json';
const SEAM_PROPOSAL_ARTIFACT_BYTES = 4_194_304;

/** independence.jsonと同じplan versionディレクトリへ並置し、manifestへ登録しない。 */
export function todoSeamProposalRef(planKey, planVersion) {
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/${SEAM_PROPOSAL_ARTIFACT_NAME}`;
}

/**
 * seam proposal artifactをactive planと現在のindependence artifactへbindして書く。
 * planの正本とmanifestには触れない。
 */
export async function writeTodoSeamProposalArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { artifact } = options;
  if (!validateSeamProposal(artifact)) {
    fail('SEAM_PROPOSAL_ARTIFACT_INVALID', 'seam_proposal_artifact_invalid');
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    if (store.project_id !== artifact.project_id) {
      fail('SEAM_PROPOSAL_BINDING_MISMATCH', 'project_id_mismatch', {
        expected: store.project_id, actual: artifact.project_id,
      });
    }
    const member = activeMember(store, artifact.plan_key);
    const binding = artifact.source_binding;
    if (member.plan.plan_version !== binding.plan_version) {
      fail('SEAM_PROPOSAL_BINDING_MISMATCH', 'plan_version_mismatch', {
        expected: member.plan.plan_version, actual: binding.plan_version,
      });
    }
    if (member.plan.topology_digest !== binding.topology_digest) {
      fail('SEAM_PROPOSAL_BINDING_MISMATCH', 'topology_digest_mismatch', {
        expected: member.plan.topology_digest, actual: binding.topology_digest,
      });
    }
    const independenceArtifact = await readTodoIndependenceArtifact({
      repoRoot, store, planKey: artifact.plan_key,
    });
    if (independenceArtifact === null
      || !validateTodoIndependence(independenceArtifact)
      || independenceArtifact.schema !== binding.independence_schema
      || independenceArtifact.result_digest !== binding.independence_result_digest
      || independenceArtifact.witness_set_digest !== binding.witness_set_digest
      || independenceArtifact.plan_version !== binding.plan_version
      || independenceArtifact.topology_digest !== binding.topology_digest
      || independenceArtifact.base_sha !== binding.base_sha) {
      fail('SEAM_PROPOSAL_BINDING_MISMATCH', 'independence_binding_mismatch');
    }
    const ref = todoSeamProposalRef(artifact.plan_key, binding.plan_version);
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(artifact));
    return { ref, artifact };
  });
}

/**
 * active planに並置されたseam proposal artifactを読む。
 * 無ければnull、壊れた記録はtyped failureとし、missingへ丸めない。
 */
export async function readTodoSeamProposalArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const store = options.store ?? await readTodoStore({ repoRoot, now: options.now });
  const member = activeMember(store, options.planKey);
  const ref = todoSeamProposalRef(member.plan.plan_key, member.plan.plan_version);
  try {
    return await readArtifact(repoRoot, ref, {
      code: 'SEAM_PROPOSAL_ARTIFACT_INVALID',
      maxBytes: SEAM_PROPOSAL_ARTIFACT_BYTES,
      validate: validateSeamProposal,
      missing: true,
    });
  } catch (error) {
    if (error instanceof TodoStoreError && error.code === 'SEAM_PROPOSAL_ARTIFACT_INVALID') {
      throw new TodoStoreError(error.code, error.detail.reason, undefined, {
        ...error.detail,
        plan_key: member.plan.plan_key,
        artifact_ref: ref,
        next_action: 'recompile_seam_proposal_or_remove_stale_record',
      });
    }
    throw error;
  }
}

const WITNESS_SET_BYTES = 4_194_304;

/**
 * witness set宣言の置き場（ADR 0128 Decision 6）。
 *
 * 運用規約だった規則をコードの所有へ移す。`todoIndependenceRef`が判定結果のpathを持つのに対し、
 * こちらは入力のpathを持つ。plan versionで分けないのは、宣言はtopologyでなくtaskについての
 * 記述であり、revisionを跨いで移行して使い続けるためである。
 */
export function todoWitnessRef(planKey) {
  return `${STORE_ROOT_REF}/witness/${planKey}.json`;
}

/** witness setを読む。無ければnull、壊れていればtyped fail（両者を同じ顔にしない）。 */
export async function readTodoWitnessSet(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return readArtifact(repoRoot, todoWitnessRef(options.planKey), {
    code: 'INVALID_TODO_WITNESS_SET',
    maxBytes: WITNESS_SET_BYTES,
    validate: validateTodoWitnessSet,
    missing: true,
  });
}

/** witness setを書く。canonical JSON+LFで、契約を満たさないものは書かせない。 */
export async function writeTodoWitnessSet(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { witnessSet } = options;
  if (!validateTodoWitnessSet(witnessSet)) {
    fail('INVALID_TODO_WITNESS_SET', 'witness_set_invalid');
  }
  const ref = todoWitnessRef(witnessSet.plan_key);
  await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(witnessSet));
  return { ref, witnessSet };
}

const STRUCTURE_SOURCE_BYTES = 8_388_608;
const STRUCTURE_COMPILE_ARTIFACT_BYTES = 67_108_864;
const STRUCTURE_REALIZATION_CHAIN_BYTES = 8_388_608;

/** AI-authored planned sourceの正規ref。derived artifact／bindingとは所有を分ける。 */
export function todoStructureSourceRef(planKey) {
  if (!isTodoIdentifier(planKey)) throw new TypeError('planKey must be a todo identifier');
  return `${STORE_ROOT_REF}/structure/${planKey}.json`;
}

/** plan versionごとのimmutable activation binding ref。sourceだけでは有効化しない。 */
export function todoStructureBindingRef(planKey, planVersion) {
  if (!isTodoIdentifier(planKey) || !isTodoIdentifier(planVersion)) {
    throw new TypeError('planKey and planVersion must be todo identifiers');
  }
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/structure/binding.json`;
}

/** plan versionへ並置するderived compile artifactの正規ref。 */
export function todoStructureCompileArtifactRef(planKey, planVersion) {
  if (!isTodoIdentifier(planKey) || !isTodoIdentifier(planVersion)) {
    throw new TypeError('planKey and planVersion must be todo identifiers');
  }
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/structure/compile.json`;
}

/** plan終端で再compileした最終構造artifactの正規ref。 */
export function todoStructureFinalizationRef(planKey, planVersion) {
  if (!isTodoIdentifier(planKey) || !isTodoIdentifier(planVersion)) {
    throw new TypeError('planKey and planVersion must be todo identifiers');
  }
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/structure/finalization.json`;
}

/** task単位append-only realization chainの正規ref。 */
export function todoStructureRealizationRef(planKey, planVersion, taskId) {
  if (![planKey, planVersion, taskId].every(isTodoIdentifier)) {
    throw new TypeError('planKey, planVersion and taskId must be todo identifiers');
  }
  return `${STORE_ROOT_REF}/plans/${planKey}/${planVersion}/structure/realizations/${taskId}.jsonl`;
}

/** sourceが無ければnull、壊れていればtyped failure。missingをinvalidへ丸めない。 */
export async function readTodoStructureSource(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return readArtifact(repoRoot, todoStructureSourceRef(options.planKey), {
    code: 'INVALID_TODO_STRUCTURE_SET', maxBytes: STRUCTURE_SOURCE_BYTES,
    validate: validateTodoStructureSet, missing: true,
  });
}

/**
 * dry-run済みplanned sourceをcanonical JSON+LFで保存する唯一のwriter。
 * bindingは発行しない——authoritative compileが成功するまではdraftであり、完了gateを有効化しない。
 */
export async function writeTodoStructureSource(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { structureSet } = options;
  const explained = explainTodoStructureSet(structureSet);
  if (!explained.valid) {
    fail('INVALID_TODO_STRUCTURE_SET', explained.reason, { path: explained.path });
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    if (store.project_id !== structureSet.project_id) {
      fail('STRUCTURE_BINDING_MISMATCH', 'project_id_mismatch', {
        expected: store.project_id, actual: structureSet.project_id,
      });
    }
    const member = activeMember(store, structureSet.plan_key);
    if (member.plan.plan_version !== structureSet.plan_version) {
      fail('STRUCTURE_BINDING_MISMATCH', 'plan_version_mismatch', {
        expected: member.plan.plan_version, actual: structureSet.plan_version,
      });
    }
    if (member.plan.topology_digest !== structureSet.topology_digest) {
      fail('STRUCTURE_BINDING_MISMATCH', 'topology_digest_mismatch', {
        expected: member.plan.topology_digest, actual: structureSet.topology_digest,
      });
    }
    const bindingRef = todoStructureBindingRef(structureSet.plan_key, structureSet.plan_version);
    const binding = await readTodoStructureBinding({
      repoRoot, planKey: structureSet.plan_key, planVersion: structureSet.plan_version,
    });
    if (binding !== null && binding.structure_set_digest !== structureSet.structure_set_digest) {
      fail('STRUCTURE_ALREADY_ENABLED', 'immutable_binding_exists', {
        binding_ref: bindingRef,
        next_action: 'revise_the_plan_or_run_authoritative_compile_with_the_existing_source',
      });
    }
    // binding前は現在の未完taskをexact coverageする。binding後は進行によりtaskがdoneへ
    // 移っていても、bindingと同じlogical sourceのcanonical bytes復旧だけを許す。
    if (binding === null) {
      const expectedTaskIds = member.tasks.filter(({ status }) => status !== 'done')
        .map(({ task_id: taskId }) => taskId);
      const coverage = explainTodoStructureSet(structureSet, { expectedTaskIds });
      if (!coverage.valid) {
        fail('STRUCTURE_BINDING_MISMATCH', coverage.reason, {
          path: coverage.path, ...(coverage.detail ?? {}),
        });
      }
    }
    const ref = todoStructureSourceRef(structureSet.plan_key);
    try {
      await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, ref)));
    } catch (error) {
      if (error instanceof TodoStoreError && error.code === 'REVISION_CONFLICT') {
        fail('INVALID_TODO_STRUCTURE_SET', 'structure_source_directory_unsafe', { source_ref: ref });
      }
      throw error;
    }
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(structureSet));
    return { ref, structureSet };
  });
}

/** bindingが無ければnull、壊れていればtyped failure。 */
export async function readTodoStructureBinding(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return readArtifact(repoRoot, todoStructureBindingRef(options.planKey, options.planVersion), {
    code: 'INVALID_TODO_STRUCTURE_BINDING', maxBytes: TODO_LIMITS.snapshotBytes,
    validate: validateTodoStructureBinding, missing: true,
  });
}

/** derived artifactが無ければnull、壊れていればtyped failure。 */
export async function readTodoStructureCompileArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return readArtifact(repoRoot,
    todoStructureCompileArtifactRef(options.planKey, options.planVersion), {
      code: 'INVALID_TODO_STRUCTURE_COMPILE_ARTIFACT',
      maxBytes: STRUCTURE_COMPILE_ARTIFACT_BYTES,
      validate: validateTodoStructureCompileArtifact,
      missing: true,
    });
}

/** finalizationが無ければnull、壊れていればtyped failure。 */
export async function readTodoStructureFinalization(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return readArtifact(repoRoot, todoStructureFinalizationRef(options.planKey, options.planVersion), {
    code: 'INVALID_TODO_STRUCTURE_FINALIZATION',
    maxBytes: STRUCTURE_COMPILE_ARTIFACT_BYTES,
    validate: validateTodoStructureCompileArtifact,
    missing: true,
  });
}

/**
 * active planとplanned sourceへ束縛したderived artifactを書く。
 * activation前は再生成可能artifactとして置換できるが、binding発行後は固定する。
 */
export async function writeTodoStructureCompileArtifact(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { artifact } = options;
  if (!validateTodoStructureCompileArtifact(artifact)) {
    fail('INVALID_TODO_STRUCTURE_COMPILE_ARTIFACT', 'compile_artifact_invalid');
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    if (store.project_id !== artifact.project_id) {
      fail('STRUCTURE_BINDING_MISMATCH', 'project_id_mismatch');
    }
    const member = activeMember(store, artifact.plan_key);
    if (member.plan.plan_version !== artifact.plan_version) {
      fail('STRUCTURE_BINDING_MISMATCH', 'plan_version_mismatch');
    }
    if (member.plan.topology_digest !== artifact.topology_digest) {
      fail('STRUCTURE_BINDING_MISMATCH', 'topology_digest_mismatch');
    }
    const source = await readTodoStructureSource({ repoRoot, planKey: artifact.plan_key });
    if (source === null) fail('STRUCTURE_SOURCE_MISSING', 'planned_source_missing');
    if (source.structure_set_digest !== artifact.structure_set_digest
      || source.baseline_sha !== artifact.baseline_sha
      || source.plan_version !== artifact.plan_version
      || source.topology_digest !== artifact.topology_digest) {
      fail('STRUCTURE_BINDING_MISMATCH', 'planned_source_mismatch');
    }
    let currentHead;
    try {
      currentHead = gitSync(['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      fail('STRUCTURE_GIT_HEAD_UNAVAILABLE', 'current_head_unavailable');
    }
    if (currentHead !== artifact.current_head_sha) {
      fail('STRUCTURE_COMPILE_STALE', 'current_head_changed_before_store');
    }
    const realizationHeads = [];
    for (const task of source.tasks.filter(({ applicability }) => applicability === 'graph')) {
      const chain = await readTodoStructureRealizationChain({
        repoRoot, structureSet: source, taskId: task.task_id,
      });
      const head = chain.at(-1);
      if (head !== undefined) realizationHeads.push({
        task_id: task.task_id, sequence: head.sequence,
        realization_digest: head.realization_digest,
      });
    }
    if (artifact.realization_head_digest
      !== digestTodoStructureRealizationHeads(realizationHeads)) {
      fail('STRUCTURE_COMPILE_STALE', 'realization_changed_before_store');
    }
    const ref = todoStructureCompileArtifactRef(artifact.plan_key, artifact.plan_version);
    const bindingRef = todoStructureBindingRef(artifact.plan_key, artifact.plan_version);
    if (await exactFileOrNull(path.resolve(repoRoot, bindingRef)) !== null) {
      fail('STRUCTURE_ALREADY_ENABLED', 'immutable_binding_exists', {
        binding_ref: bindingRef,
      });
    }
    await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, ref)));
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(artifact));
    return { ref, artifact };
  });
}

/** compile artifactをexactに指すimmutable activation bindingを書く。 */
export async function writeTodoStructureBinding(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { binding } = options;
  if (!validateTodoStructureBinding(binding)) {
    fail('INVALID_TODO_STRUCTURE_BINDING', 'structure_binding_invalid');
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    if (store.project_id !== binding.project_id) {
      fail('STRUCTURE_BINDING_MISMATCH', 'project_id_mismatch');
    }
    const member = activeMember(store, binding.plan_key);
    if (member.plan.plan_version !== binding.plan_version
      || member.plan.topology_digest !== binding.topology_digest) {
      fail('STRUCTURE_BINDING_MISMATCH', 'active_plan_mismatch');
    }
    const source = await readTodoStructureSource({ repoRoot, planKey: binding.plan_key });
    const artifact = await readTodoStructureCompileArtifact({
      repoRoot, planKey: binding.plan_key, planVersion: binding.plan_version,
    });
    if (source === null || artifact === null
      || source.structure_set_digest !== binding.structure_set_digest
      || source.baseline_sha !== binding.baseline_sha
      || artifact.artifact_digest !== binding.compile_artifact_digest
      || artifact.current_head_sha !== binding.compiled_head_sha) {
      fail('STRUCTURE_BINDING_MISMATCH', 'source_or_compile_artifact_mismatch');
    }
    let currentHead;
    try {
      currentHead = gitSync(['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      fail('STRUCTURE_GIT_HEAD_UNAVAILABLE', 'current_head_unavailable');
    }
    if (currentHead !== artifact.current_head_sha) {
      fail('STRUCTURE_COMPILE_STALE', 'current_head_changed_before_activation');
    }
    const realizationHeads = [];
    for (const task of source.tasks.filter(({ applicability }) => applicability === 'graph')) {
      const chain = await readTodoStructureRealizationChain({
        repoRoot, structureSet: source, taskId: task.task_id,
      });
      const head = chain.at(-1);
      if (head !== undefined) realizationHeads.push({
        task_id: task.task_id, sequence: head.sequence,
        realization_digest: head.realization_digest,
      });
    }
    if (artifact.realization_head_digest
      !== digestTodoStructureRealizationHeads(realizationHeads)) {
      fail('STRUCTURE_COMPILE_STALE', 'realization_changed_before_activation');
    }
    const ref = todoStructureBindingRef(binding.plan_key, binding.plan_version);
    if (await exactFileOrNull(path.resolve(repoRoot, ref)) !== null) {
      fail('STRUCTURE_ALREADY_ENABLED', 'immutable_binding_exists', { binding_ref: ref });
    }
    await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, ref)));
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(binding));
    return { ref, binding };
  });
}

/** 全task done後のfresh consistent artifactだけをfinalization refへ固定する。 */
export async function writeTodoStructureFinalization(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { artifact } = options;
  if (!validateTodoStructureCompileArtifact(artifact) || artifact.overlay.verdict !== 'consistent') {
    fail('INVALID_TODO_STRUCTURE_FINALIZATION', 'finalization_not_consistent');
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const member = activeMember(store, artifact.plan_key);
    if (store.project_id !== artifact.project_id || member.plan.project_id !== artifact.project_id) {
      fail('STRUCTURE_BINDING_MISMATCH', 'project_id_mismatch');
    }
    if (member.plan.plan_version !== artifact.plan_version
      || member.plan.topology_digest !== artifact.topology_digest
      || member.tasks.some(({ status }) => status !== 'done')) {
      fail('STRUCTURE_FINALIZATION_UNAVAILABLE', 'plan_not_fully_done');
    }
    const source = await readTodoStructureSource({ repoRoot, planKey: artifact.plan_key });
    const binding = await readTodoStructureBinding({
      repoRoot, planKey: artifact.plan_key, planVersion: artifact.plan_version,
    });
    if (source === null || binding === null
      || source.structure_set_digest !== artifact.structure_set_digest
      || binding.structure_set_digest !== artifact.structure_set_digest) {
      fail('STRUCTURE_FINALIZATION_UNAVAILABLE', 'structure_not_enabled_or_stale');
    }
    const heads = [];
    for (const task of source.tasks.filter(({ applicability }) => applicability === 'graph')) {
      const chain = await readTodoStructureRealizationChain({
        repoRoot, structureSet: source, taskId: task.task_id,
      });
      const head = chain.at(-1);
      if (head === undefined) {
        fail('STRUCTURE_FINALIZATION_UNAVAILABLE', 'realization_missing', { task_id: task.task_id });
      }
      heads.push({
        task_id: task.task_id, sequence: head.sequence,
        realization_digest: head.realization_digest,
      });
    }
    if (artifact.realization_head_digest !== digestTodoStructureRealizationHeads(heads)) {
      fail('STRUCTURE_FINALIZATION_STALE', 'realization_head_changed');
    }
    let currentHead;
    try {
      currentHead = gitSync(['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      fail('STRUCTURE_GIT_HEAD_UNAVAILABLE', 'current_head_unavailable');
    }
    if (artifact.current_head_sha !== currentHead) {
      fail('STRUCTURE_FINALIZATION_STALE', 'current_head_changed');
    }
    const ref = todoStructureFinalizationRef(artifact.plan_key, artifact.plan_version);
    await ensureSafeStoreDirectory(repoRoot, path.dirname(path.resolve(repoRoot, ref)));
    await atomicWrite(path.resolve(repoRoot, ref), canonicalLine(artifact));
    return { ref, artifact };
  });
}

function parseTodoStructureRealizationChain(bytes, { structureSet, taskId }) {
  if (bytes.length === 0 || bytes.length > STRUCTURE_REALIZATION_CHAIN_BYTES) {
    fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN',
      bytes.length > STRUCTURE_REALIZATION_CHAIN_BYTES ? 'size_limit_exceeded' : 'chain_empty');
  }
  const text = decodeUtf8(bytes, 'INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', 'invalid_utf8');
  if (!text.endsWith('\n') || text.includes('\r') || text.startsWith('\uFEFF')) {
    fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', 'chain_byte_contract');
  }
  const records = []; let previous = null; const priorDigests = new Set();
  for (const [index, line] of text.slice(0, -1).split('\n').entries()) {
    if (line.length === 0) fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', 'empty_record');
    let value;
    try { value = JSON.parse(line); } catch {
      fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', 'record_json_invalid', { index });
    }
    if (line !== canonicalizeTodoArtifact(value)) {
      fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', 'record_non_canonical', { index });
    }
    const explained = explainTodoStructureRealization(value, {
      structureSet, previous, priorDigests,
    });
    if (!explained.valid || value.task_id !== taskId) {
      fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN',
        explained.valid ? 'task_id_mismatch' : explained.reason,
        { index, path: explained.path ?? '/task_id' });
    }
    records.push(value); previous = value; priorDigests.add(value.realization_digest);
  }
  return records;
}

/** chain未作成は[]、存在するchainの破損はtyped failure。 */
export async function readTodoStructureRealizationChain(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (!validateTodoStructureSet(options.structureSet)) {
    throw new TypeError('structureSet must be valid');
  }
  const ref = todoStructureRealizationRef(
    options.structureSet.plan_key, options.structureSet.plan_version, options.taskId,
  );
  const state = await pathState(repoRoot, ref, 'INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', {
    missing: true,
  });
  if (state === null) return [];
  return parseTodoStructureRealizationChain(normalizeCheckoutEol(await readFile(state.absolute)), {
    structureSet: options.structureSet, taskId: options.taskId,
  });
}

/**
 * active binding配下のtask realizationをappend-onlyで追記する。
 * Git objectと他task chainを追記前に照合し、拒否時はchain bytesを変えない。
 */
export async function appendTodoStructureRealization(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const { realization } = options;
  const initial = explainTodoStructureRealization(realization);
  if (!initial.valid) {
    fail('INVALID_TODO_STRUCTURE_REALIZATION', initial.reason, { path: initial.path });
  }
  return withLock(repoRoot, async () => {
    const store = await readTodoStoreLocked({ repoRoot, forWrite: true, now: options.now });
    const member = activeMember(store, realization.plan_key);
    if (store.project_id !== realization.project_id
      || member.plan.plan_version !== realization.plan_version) {
      fail('STRUCTURE_REALIZATION_BINDING_MISMATCH', 'active_plan_identity_mismatch');
    }
    const structureSet = await readTodoStructureSource({
      repoRoot, planKey: realization.plan_key,
    });
    const binding = await readTodoStructureBinding({
      repoRoot, planKey: realization.plan_key, planVersion: realization.plan_version,
    });
    if (structureSet === null || binding === null
      || structureSet.structure_set_digest !== binding.structure_set_digest
      || realization.structure_set_digest !== binding.structure_set_digest) {
      fail('STRUCTURE_REALIZATION_BINDING_MISMATCH', 'structure_not_enabled_or_stale');
    }
    const task = structureSet.tasks.find(({ task_id: id }) => id === realization.task_id);
    if (task?.applicability !== 'graph') {
      fail('STRUCTURE_REALIZATION_BINDING_MISMATCH', 'task_not_graph_applicable');
    }
    let currentHead;
    try {
      currentHead = gitSync(['rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      fail('STRUCTURE_GIT_HEAD_UNAVAILABLE', 'current_head_unavailable');
    }
    if (realization.head_sha !== currentHead) {
      fail('STRUCTURE_REALIZATION_STALE', 'realization_head_mismatch', {
        expected: currentHead, actual: realization.head_sha,
      });
    }
    const chain = await readTodoStructureRealizationChain({
      repoRoot, structureSet, taskId: realization.task_id,
    });
    const priorDigests = new Set(chain.map(({ realization_digest: digest }) => digest));
    const explained = explainTodoStructureRealization(realization, {
      structureSet, previous: chain.at(-1) ?? null, priorDigests,
    });
    if (!explained.valid) {
      fail('INVALID_TODO_STRUCTURE_REALIZATION_CHAIN', explained.reason, {
        path: explained.path, task_id: realization.task_id,
      });
    }

    for (const otherTask of structureSet.tasks.filter(({ applicability, task_id: taskId }) => (
      applicability === 'graph' && taskId !== realization.task_id
    ))) {
      const otherChain = await readTodoStructureRealizationChain({
        repoRoot, structureSet, taskId: otherTask.task_id,
      });
      const claimed = new Set(otherChain.flatMap(({ commit_oids: commitOids }) => commitOids));
      const reused = realization.commit_oids.filter((commitOid) => claimed.has(commitOid));
      if (reused.length > 0) {
        fail('STRUCTURE_REALIZATION_COMMIT_CLAIMED', 'commit_claimed_by_other_task', {
          task_id: realization.task_id, other_task_id: otherTask.task_id,
          commit_oids: reused,
        });
      }
    }

    const provenance = collectTodoStructureGitProvenance({
      repoRoot, structureSet, requireClean: false,
    });
    bindTodoStructureRealizationCommits({ provenance, realizations: [realization] });
    const declared = new Set(realization.commit_oids);
    const changedPaths = new Set(provenance.changesets
      .filter(({ commit_oid: commitOid }) => declared.has(commitOid))
      .flatMap(({ changes }) => changes.flatMap(({ path: changedPath, previous_path: previousPath }) => (
        previousPath === null ? [changedPath] : [changedPath, previousPath]
      ))));
    const mutatingAnchors = realization.realized.code_anchors
      .filter(({ effect }) => ['create', 'modify', 'delete'].includes(effect));
    const unboundAnchors = mutatingAnchors.filter(({ path: anchorPath }) => !changedPaths.has(anchorPath));
    if (mutatingAnchors.length === 0 || unboundAnchors.length > 0) {
      fail('STRUCTURE_REALIZATION_ANCHOR_UNBOUND',
        mutatingAnchors.length === 0 ? 'mutating_code_anchor_missing' : 'commit_does_not_touch_anchor', {
          task_id: realization.task_id,
          anchor_ids: unboundAnchors.map(({ anchor_id: anchorId }) => anchorId).sort(),
          changed_paths: [...changedPaths].sort(),
        });
    }

    const ref = todoStructureRealizationRef(
      structureSet.plan_key, structureSet.plan_version, realization.task_id,
    );
    const absolute = path.resolve(repoRoot, ref);
    await ensureSafeStoreDirectory(repoRoot, path.dirname(absolute));
    const before = await exactFileOrNull(absolute);
    await atomicWrite(absolute, Buffer.concat([before ?? Buffer.alloc(0), canonicalLine(realization)]));
    return {
      ref, realization, history_length: chain.length + 1,
      previous_realization_digest: chain.at(-1)?.realization_digest ?? null,
    };
  });
}
