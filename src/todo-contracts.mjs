import { createHash } from 'node:crypto';
import { isCanonicalUtcTimestamp } from './timestamp-contract.mjs';

export const TODO_EVENT_KINDS = Object.freeze([
  'plan_genesis', 'start', 'start_retracted', 'block', 'unblock', 'retire', 'done', 'reopen',
  'phase_review', 'phase_accept', 'phase_reject', 'phase_reopen',
  // ADR 0148: 監査していない歴史を「監査なしで閉じた」として明示的に閉じるための専用kind。
  // phase_review/accept/reject/reopenと同じv3 tail event shape(phase_id持ち)に収め、
  // 新しいevent schema版は作らない。
  'phase_close_unaudited',
  // ob03: 調整方式(witness検証で並列するか、会話調整で行くか)の宣言。planに帰属する事実で
  // taskにもPhaseにも属さないため、task_idもphase_idも持たない最初のkindになる。actorが
  // 「誰が選んだか」の帰属を持つ——witnessが全planの暗黙義務だった時に帰属が無く、正確な
  // 案内が素通りされたことへの是正である(オーナー裁定C①)。
  'coordination_mode',
  // 開発中に発見したplan跨ぎの依存を、active plan topologyの追記改変ではなく
  // version-boundなplan-scoped eventとして接続する。推定はせず、AIが発見した時だけ積む。
  'cross_plan_dependency',
  // 誤って張った接続の除去（connectの対・2026-08-29オーナー裁定系）。対象eventのdigestを指す
  // tombstoneとして積み、projectionが両方を読んで線を消す。歴史は書き換えない。
  'cross_plan_dependency_removed',
  // 接続(他条件に接続): a task waits on a BellTeam schedule outside its own chart. Plan-scoped like the
  // dependency ledger; removed/resolved point at the connection_added digest and each add has at most one end.
  'connection_added', 'connection_removed', 'connection_resolved',
]);

/** planへ帰属し、taskにもPhaseにも属さないevent kind。 */
export const TODO_PLAN_SCOPED_EVENT_KINDS = Object.freeze([
  'coordination_mode', 'cross_plan_dependency', 'cross_plan_dependency_removed',
  'connection_added', 'connection_removed', 'connection_resolved',
]);

/** The schedule id is opaque to Lattice: printable ASCII without spaces. */
export const TODO_CONNECTION_SCHEDULE_ID = /^[!-~]{1,128}$/u;

/** 調整方式。witness=独立性を宣言し検証して並列する／conversation=会話で調整する。 */
// ADR 0200: `enforced` is witness coordination plus the gates that stop skipped steps.
export const TODO_COORDINATION_MODES = Object.freeze(['witness', 'conversation', 'enforced']);
export const TODO_NOTE_EVENT_SCHEMA = 'lattice.todo_note_event.v1';
/**
 * plan単位のnote event。工程レベルの義務(順序制約・一度きりの観測が在ること)は特定のtaskに
 * 属さないので、v1の`task_id`必須では書けない。v1は書き換えない——既存chainはhash連鎖で
 * 固定済みであり、taskノートの挙動も digest も動かさない。
 *
 * v2は**別のchain file**(`plan-active.jsonl`)へ積む。同じchainへ混ぜると、旧CLIは
 * 1 eventずつのbyte検証で chain全体を壊れと読み、noteの読みを前提条件とする`todo start`が
 * 落ちる。しかもstoreへ書いたものは戻せない。分離すれば旧CLIはfileの存在に気づかず、
 * task noteの読み書きは1バイトも変わらない。
 */
export const TODO_NOTE_EVENT_V2_SCHEMA = 'lattice.todo_note_event.v2';
// Per-lane startable-notice ack set and per-plan waits (host-local; todo-notice-store.mjs).
export const TODO_NOTICE_ACKS_SCHEMA = 'lattice.todo_notice_acks.v2';
export const TODO_NOTICE_WAITS_SCHEMA = 'lattice.todo_notice_waits.v1';
/** a101 K4: chart identity `.lattice/chart.json` (dfd-charts-read). */
export const TODO_CHART_META_SCHEMA = 'lattice.chart_meta.v1';
/** ADR 0204 a4: function-level conflict relations, one open relation per (task_a, task_b, path); dfd-store-relations. */
export const TODO_RELATION_EVENT_SCHEMA = 'lattice.todo_relation_event.v1';
export const TODO_RELATION_SUMMARY_SCHEMA = 'lattice.todo_relation_summary.v1';
export const TODO_RELATION_SUMMARY_OPEN = 20;
/** ADR 0205 b2: the verify outcome of one split task, one file `.lattice/todo/splits/<plan_key>/<task_id>.json`; dfd-store-split. */
export const TODO_SPLIT_RECORD_SCHEMA = 'lattice.todo_split_record.v1';
export const TODO_SPLIT_CONDITIONS = Object.freeze(['behaviour', 'tests', 'fresh', 'overlap', 'parallel']);
export const TODO_SPLIT_MAX_MEMBERS = 64;
/**
 * v2でnoteの`scope`とplan noteを載せる。v1のままでは`task_id`が identifier 必須・
 * `full_history_command`が`--task <id>`込みの文字列と完全一致で、どちらもplan noteを表せない。
 */
export const TODO_NOTE_CONTEXT_SCHEMA = 'lattice.todo_note_context.v2';
export const TODO_LIMITS = Object.freeze({
  // ADR 0201: no count caps on a plan's tasks, edges, joins or phases; its size is bounded by bytes (snapshotBytes).
  // The note context keeps its own entry count next to noteContextBytes.
  noteContextEntries: 512,
  journalSegmentBytes: 1_048_576,
  snapshotBytes: 8_388_608,
  narrativeSectionBytes: 262_144,
  noteBodyBytes: 16_384,
  noteContextBytes: 65_536,
  // statusのplan_notes entryが載せる最新noteの件数。本文を載せない代わりに
  // 「誰がいつ置いたか」だけを新しい順で数件出す（中身はnote listが持つ）。
  statusPlanNoteLatest: 3,
});

const DIGEST = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NOTE_FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const TODO_DESIGN_MEMO_PROMPT = 'あなたがこのToDoに対して、何も考えていないならば、設計メモに `NO_PLAN` と書いてください';
export const TODO_TEST_RESULT_CONTRACT_ID = 'lattice.todo_test_result.v1';

export const isTodoDigest = (value) => typeof value === 'string' && DIGEST.test(value);
export const isTodoIdentifier = (value) => typeof value === 'string' && IDENTIFIER.test(value);
export const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
export const isTodoTestResult = (value) => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value, 'utf8') <= TODO_LIMITS.noteBodyBytes
  && !NOTE_FORBIDDEN_CONTROL.test(value);

export function isStrictTodoTimestamp(value) {
  return isCanonicalUtcTimestamp(value);
}

export function assertStrictTodoTimestamp(value, field = 'timestamp') {
  if (!isStrictTodoTimestamp(value)) throw new TypeError(`${field}: strict timestamp required`);
  return value;
}

export function isTodoRef(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 1_024
    || CONTROL.test(value) || value.includes('\\') || value.startsWith('/')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalPart(value, seen, depth) {
  if (depth > 40) throw new TypeError('todo artifact nesting limit exceeded');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('todo artifact number must be a safe integer');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('todo artifact is not a JSON tree');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError('todo artifact array is not dense');
    result = `[${value.map((entry) => canonicalPart(entry, seen, depth + 1)).join(',')}]`;
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw new TypeError('todo artifact must use plain objects');
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPart(value[key], seen, depth + 1)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

export function canonicalizeTodoArtifact(value) {
  return canonicalPart(value, new Set(), 0);
}

export function digestTodoArtifact(value) {
  return createHash('sha256').update(canonicalizeTodoArtifact(value), 'utf8').digest('hex');
}

export function todoSelfDigest(value, field) {
  const projection = {};
  for (const key of Object.keys(value)) if (key !== field) projection[key] = value[key];
  return digestTodoArtifact(projection);
}

const noteBody = (value) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= TODO_LIMITS.noteBodyBytes
  && !NOTE_FORBIDDEN_CONTROL.test(value);

/**
 * lifecycle journalとは独立したnote eventを検証する。v1(task note)とv2(plan note)は
 * 別chainへ積まれるが、検証器は両方を受ける——どちらのchainを読んでいるかはpathが決め、
 * chainへ他scopeが混ざっていないことは`readTodoNoteEvents`が読み出し時に落とす。
 * v1は`scope`を持たない——定義上taskであり、投影の側で明示`scope`へ正規化する。
 */
export function validateTodoNoteEvent(value) {
  try {
    const keys = [
      'schema', 'project_id', 'plan_key', 'task_id', 'plan_version', 'sequence',
      'previous_digest', 'actor', 'recorded_at', 'body', 'supersedes', 'event_digest',
    ];
    const planScoped = value?.schema === TODO_NOTE_EVENT_V2_SCHEMA;
    return exactRecord(value, planScoped ? [...keys, 'scope'] : keys)
      && (planScoped
        // v2は今のところplan scopeだけを表す。phase scopeは配達面(audit_pending entry)を
        // 持つtaskと同じ波で足す——書けるが届かない面を作らないため。
        ? value.scope === 'plan' && value.task_id === null
        : value.schema === TODO_NOTE_EVENT_SCHEMA && isTodoIdentifier(value.task_id))
      && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
      && isTodoIdentifier(value.plan_version)
      && Number.isSafeInteger(value.sequence) && value.sequence >= 1
      && (value.sequence === 1 ? value.previous_digest === null : isTodoDigest(value.previous_digest))
      && actor(value.actor) && isStrictTodoTimestamp(value.recorded_at) && noteBody(value.body)
      && (value.supersedes === null || isTodoDigest(value.supersedes))
      && isTodoDigest(value.event_digest) && value.supersedes !== value.event_digest
      && value.event_digest === todoSelfDigest(value, 'event_digest');
  } catch {
    return false;
  }
}

/**
 * `scope`は投影が必ず埋める。読み手はここでv1/v2の区別を持たないので、`origin_task_id`が
 * nullであることから「plan単位だ」を推論させない——型で表現していない区別は、exact検証を
 * 通り抜けて受け手の解釈に落ちる。
 */
function noteContextEntry(value) {
  return exactRecord(value, [
    'event_digest', 'origin_plan_version', 'scope', 'origin_task_id', 'actor', 'recorded_at',
    'body', 'supersedes', 'superseded_by', 'correction_state',
  ]) && isTodoDigest(value.event_digest) && isTodoIdentifier(value.origin_plan_version)
    && ['plan', 'task'].includes(value.scope)
    && (value.scope === 'plan'
      ? value.origin_task_id === null : isTodoIdentifier(value.origin_task_id))
    && actor(value.actor)
    && isStrictTodoTimestamp(value.recorded_at) && noteBody(value.body)
    && (value.supersedes === null || isTodoDigest(value.supersedes))
    && (value.superseded_by === null || isTodoDigest(value.superseded_by))
    && ['current', 'superseded'].includes(value.correction_state)
    && ((value.correction_state === 'current' && value.superseded_by === null)
      || (value.correction_state === 'superseded' && isTodoDigest(value.superseded_by)));
}

/** 個別ToDo詳細とstart結果へ必ず同梱するbounded note contextを検証する。 */
export function validateTodoNoteContext(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'task_id', 'notes', 'note_head_digest',
      'plan_note_head_digest', 'overflow_count', 'full_history_command', 'context_digest',
    ]) || value.schema !== TODO_NOTE_CONTEXT_SCHEMA
      || !isTodoIdentifier(value.project_id) || !isTodoIdentifier(value.plan_key)
      || !isTodoIdentifier(value.task_id) || !Array.isArray(value.notes)
      || value.notes.length > TODO_LIMITS.noteContextEntries || !value.notes.every(noteContextEntry)
      || !(value.note_head_digest === null || isTodoDigest(value.note_head_digest))
      || !(value.plan_note_head_digest === null || isTodoDigest(value.plan_note_head_digest))
      || !isNonNegativeSafeInteger(value.overflow_count)
      // contextはplan noteも載せるので、案内するのはplan全体を返す形でなければならない。
      // `--task <id>`形はplan noteを落とすため、fullと名乗りながら全部を取りに行けなくなる。
      || value.full_history_command !== `lattice todo note list --plan ${value.plan_key} --json`
      || !isTodoDigest(value.context_digest)
      || value.context_digest !== todoSelfDigest(value, 'context_digest')) return false;
    // headはchainごとなので、同値もscopeで切る。task noteが空でplan noteが在る時に
    // 「notesが非空なのにheadがnull」を壊れと読まないため。overflowで本文が落ちても
    // headはchainの実在を述べ続ける——同値はnotesではなくoverflow込みの母集合で見る。
    const scoped = (scope) => value.notes.some((note) => note.scope === scope);
    if (value.overflow_count === 0) {
      if (scoped('task') !== (value.note_head_digest !== null)) return false;
      // n3: revision records about other tasks are left out by design, so a plan head may stand
      // with no plan note shown; a shown plan note still needs its head.
      if (scoped('plan') && value.plan_note_head_digest === null) return false;
    } else if (value.note_head_digest === null && value.plan_note_head_digest === null) {
      return false;
    }
    return value.notes.reduce((bytes, note) => bytes + Buffer.byteLength(note.body, 'utf8'), 0)
      <= TODO_LIMITS.noteContextBytes;
  } catch {
    return false;
  }
}

const nullableDigest = (value) => value === null || isTodoDigest(value);
/** k4: a done recorded as plain text. The task's `evidence` is `{message}` (carried across revisions like any evidence). */
export const isTodoDoneMessage = (value) => exactRecord(value, ['message']) && typeof value.message === 'string'
  && value.message.trim().length > 0 && Buffer.byteLength(value.message) <= TODO_LIMITS.noteBodyBytes;
const nullableText = (value) => value === null || (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 16_384);
/** 設計メモの拒否理由を、本文をerrorへ複製せずAIが訂正できる形で返す。 */
export function explainTodoDesignMemo(value) {
  const expected = {
    type: 'string', non_whitespace: true,
    max_characters: TODO_LIMITS.noteBodyBytes, max_utf8_bytes: TODO_LIMITS.noteBodyBytes,
    forbidden_control_characters: false,
  };
  if (typeof value !== 'string') {
    return { valid: false, reason: 'type', expected,
      actual: { type: value === null ? 'null' : typeof value } };
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (value.trim().length === 0) {
    return { valid: false, reason: 'blank', expected,
      actual: { byte_length: byteLength, non_whitespace: false } };
  }
  if (value.length > TODO_LIMITS.noteBodyBytes || byteLength > TODO_LIMITS.noteBodyBytes) {
    return { valid: false, reason: 'too_large', expected,
      actual: { character_length: value.length, byte_length: byteLength } };
  }
  if (NOTE_FORBIDDEN_CONTROL.test(value)) {
    return { valid: false, reason: 'forbidden_control', expected,
      actual: { byte_length: byteLength, contains_forbidden_control: true } };
  }
  return { valid: true };
}

export const isTodoDesignMemo = (value) => explainTodoDesignMemo(value).valid;
const actor = (value) => exactRecord(value, ['host', 'session', 'agent'])
  && [value.host, value.session, value.agent].every(isTodoIdentifier);
const provenance = (value) => value === null || (exactRecord(value, ['source_commit', 'source_event_digest'])
  && /^[0-9a-f]{40}$/u.test(value.source_commit) && isTodoDigest(value.source_event_digest));
const nodeRef = (value) => (exactRecord(value, ['project_id', 'plan_key', 'task_id'])
  || exactRecord(value, ['project_id', 'plan_key', 'task_id', 'expected_topology_digest']))
  && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
  && isTodoIdentifier(value.task_id)
  && (value.expected_topology_digest === undefined || isTodoDigest(value.expected_topology_digest));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const refKey = (value) => `${value.project_id}\0${value.plan_key}\0${value.task_id}`;
const phaseRef = (value) => (exactRecord(value, ['project_id', 'plan_key', 'phase_id'])
  || exactRecord(value, ['project_id', 'plan_key', 'phase_id', 'expected_topology_digest']))
  && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
  && isTodoIdentifier(value.phase_id)
  && (value.expected_topology_digest === undefined || isTodoDigest(value.expected_topology_digest));
const phaseRefKey = (value) => `${value.project_id}\0${value.plan_key}\0${value.phase_id}`;

function compileBinding(value) {
  return value === null || (exactRecord(value, [
    'boundary_manifest_digest', 'compiled_plan_digest', 'topology_digest', 'base_sha',
  ]) && isTodoDigest(value.boundary_manifest_digest) && isTodoDigest(value.compiled_plan_digest)
    && isTodoDigest(value.topology_digest) && /^[0-9a-f]{40}$/u.test(value.base_sha));
}

function taskV1(value) {
  return exactRecord(value, ['task_id', 'title', 'lane', 'narrative_ref', 'compile_binding'])
    && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref)) && compileBinding(value.compile_binding);
}

export function validateTodoNarrativeAnchor(value) {
  return exactRecord(value, ['origin_plan_ref', 'origin_line', 'source_commit', 'source_line_digest'])
    && isTodoRef(value.origin_plan_ref) && Number.isSafeInteger(value.origin_line) && value.origin_line >= 1
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.source_commit)
    && isTodoDigest(value.source_line_digest);
}

function taskV2(value) {
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'narrative_ref', 'narrative_anchor', 'compile_binding',
  ]) && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref))
    && (value.narrative_anchor === null || (validateTodoNarrativeAnchor(value.narrative_anchor)
      && value.narrative_ref === value.narrative_anchor.origin_plan_ref))
    && compileBinding(value.compile_binding);
}

function evidence(value) {
  return exactRecord(value, [
    'evidence_id', 'repo_id', 'path', 'git_blob_oid', 'content_digest', 'media_type', 'anchor_digest',
  ]) && isTodoIdentifier(value.evidence_id) && isTodoIdentifier(value.repo_id) && isTodoRef(value.path)
    && /^[0-9a-f]{40,64}$/u.test(value.git_blob_oid) && isTodoDigest(value.content_digest)
    && typeof value.media_type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(value.media_type)
    && nullableDigest(value.anchor_digest);
}

export function validateTodoImportSource(value) {
  return exactRecord(value, ['schema', 'origin_plan_ref', 'origin_line', 'source_commit'])
    && value.schema === 'lattice.todo_import_source.v1' && isTodoRef(value.origin_plan_ref)
    && Number.isSafeInteger(value.origin_line) && value.origin_line >= 1
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.source_commit);
}

function taskV3(value) {
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'narrative_ref', 'narrative_anchor', 'compile_binding',
    'parent_task_id',
  ]) && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref))
    && (value.narrative_anchor === null || (validateTodoNarrativeAnchor(value.narrative_anchor)
      && value.narrative_ref === value.narrative_anchor.origin_plan_ref))
    && compileBinding(value.compile_binding)
    && (value.parent_task_id === null || isTodoIdentifier(value.parent_task_id));
}

function taskV4(value) {
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'narrative_ref', 'narrative_anchor', 'compile_binding',
    'parent_task_id', 'phase_id',
  ]) && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref))
    && (value.narrative_anchor === null || (validateTodoNarrativeAnchor(value.narrative_anchor)
      && value.narrative_ref === value.narrative_anchor.origin_plan_ref))
    && compileBinding(value.compile_binding)
    && (value.parent_task_id === null || isTodoIdentifier(value.parent_task_id))
    && isTodoIdentifier(value.phase_id);
}

function taskV5(value) {
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'design_memo', 'narrative_ref', 'narrative_anchor',
    'compile_binding', 'parent_task_id',
  ]) && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && isTodoDesignMemo(value.design_memo)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref))
    && (value.narrative_anchor === null || (validateTodoNarrativeAnchor(value.narrative_anchor)
      && value.narrative_ref === value.narrative_anchor.origin_plan_ref))
    && compileBinding(value.compile_binding)
    && (value.parent_task_id === null || isTodoIdentifier(value.parent_task_id));
}

function taskV6(value) {
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'design_memo', 'narrative_ref', 'narrative_anchor',
    'compile_binding', 'parent_task_id', 'phase_id',
  ]) && isTodoIdentifier(value.task_id) && nullableText(value.title) && isTodoIdentifier(value.lane)
    && isTodoDesignMemo(value.design_memo)
    && (value.narrative_ref === null || isTodoRef(value.narrative_ref))
    && (value.narrative_anchor === null || (validateTodoNarrativeAnchor(value.narrative_anchor)
      && value.narrative_ref === value.narrative_anchor.origin_plan_ref))
    && compileBinding(value.compile_binding)
    && (value.parent_task_id === null || isTodoIdentifier(value.parent_task_id))
    && isTodoIdentifier(value.phase_id);
}

function taskV8(value) {
  const { done_condition: doneCondition, ...rest } = value ?? {};
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'design_memo', 'narrative_ref', 'narrative_anchor',
    'compile_binding', 'parent_task_id', 'phase_id', 'done_condition',
  ]) && taskV6(rest) && (doneCondition === null || isTodoDesignMemo(doneCondition));
}

const splitText = (value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 1_024
  && !CONTROL.test(value);

/** ADR 0205 §2: the split mark. `members` are sorted unique task ids (start order is never stored); the range is a snapshot. */
const functionSplit = (value) => exactRecord(value, ['path', 'symbol', 'start_line', 'end_line', 'members'])
  && isTodoRef(value.path) && splitText(value.symbol)
  && Number.isSafeInteger(value.start_line) && value.start_line >= 1
  && Number.isSafeInteger(value.end_line) && value.end_line >= value.start_line
  && Array.isArray(value.members) && value.members.length >= 2 && value.members.length <= TODO_SPLIT_MAX_MEMBERS
  && value.members.every((id, index) => isTodoIdentifier(id) && (index === 0 || compareText(value.members[index - 1], id) < 0));

function taskV9(value) {
  const { function_split: split, ...rest } = value ?? {};
  return exactRecord(value, [
    'task_id', 'title', 'lane', 'design_memo', 'narrative_ref', 'narrative_anchor',
    'compile_binding', 'parent_task_id', 'phase_id', 'done_condition', 'function_split',
  ]) && taskV8(rest) && (split === null || functionSplit(split));
}

function phaseV1(value) {
  return exactRecord(value, [
    'phase_id', 'title', 'gate_policy', 'predecessor_phase_ids', 'required_evidence_slots',
  ]) && isTodoIdentifier(value.phase_id) && nullableText(value.title)
    && isTodoIdentifier(value.gate_policy)
    && Array.isArray(value.predecessor_phase_ids)
    && value.predecessor_phase_ids.every(isTodoIdentifier)
    && value.predecessor_phase_ids.every((entry, index) => index === 0
      || compareText(value.predecessor_phase_ids[index - 1], entry) < 0)
    && Array.isArray(value.required_evidence_slots) && value.required_evidence_slots.length > 0
    && value.required_evidence_slots.every(isTodoIdentifier)
    && value.required_evidence_slots.every((entry, index) => index === 0
      || compareText(value.required_evidence_slots[index - 1], entry) < 0);
}

function validPhaseGraph(phases) {
  const ids = new Set(phases.map(({ phase_id }) => phase_id));
  const predecessors = new Map(phases.map(({ phase_id, predecessor_phase_ids }) => (
    [phase_id, predecessor_phase_ids]
  )));
  if (phases.some(({ phase_id, predecessor_phase_ids }) => predecessor_phase_ids.includes(phase_id)
    || predecessor_phase_ids.some((id) => !ids.has(id)))) return false;
  const colors = new Map();
  const visit = (id) => {
    if (colors.get(id) === 1) return false;
    if (colors.get(id) === 2) return true;
    colors.set(id, 1);
    if (!predecessors.get(id).every(visit)) return false;
    colors.set(id, 2);
    return true;
  };
  return [...ids].every(visit);
}

function validParentGraph(tasks) {
  const parents = new Map(tasks.map(({ task_id, parent_task_id }) => [task_id, parent_task_id]));
  for (const [taskId, parentTaskId] of parents) {
    if (parentTaskId !== null && (parentTaskId === taskId || !parents.has(parentTaskId))) return false;
    const seen = new Set([taskId]);
    let cursor = parentTaskId;
    while (cursor !== null) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
  }
  return true;
}

export function explainTodoOrder(values, key, pointer) {
  for (let index = 1; index < values.length; index += 1) {
    const previous = key(values[index - 1]);
    const actual = key(values[index]);
    if (compareText(previous, actual) >= 0) {
      return { reason: 'unsorted_or_duplicate_collection', path: `${pointer}/${index}`,
        expected: { order: 'ascending_unique', greater_than: previous }, actual };
    }
  }
  return null;
}

export function explainTodoPlan(value) {
  const reject = (reason, pointer) => ({ reason, path: pointer });
  try {
    const taskValidator = value?.schema === 'lattice.todo_plan.v1' ? taskV1
      : value?.schema === 'lattice.todo_plan.v2' ? taskV2
        : value?.schema === 'lattice.todo_plan.v3' ? taskV3
          : ['lattice.todo_plan.v4', 'lattice.todo_plan.v5'].includes(value?.schema) ? taskV4
            : value?.schema === 'lattice.todo_plan.v6' ? taskV5
              : value?.schema === 'lattice.todo_plan.v7' ? taskV6
                : value?.schema === 'lattice.todo_plan.v8' ? taskV8
                  : value?.schema === 'lattice.todo_plan.v9' ? taskV9 : null;
    const planKeys = [
      'schema', 'project_id', 'plan_key', 'plan_version', 'predecessor_plan_digest',
      'tasks', 'hard_dependencies', 'joins', 'topology_digest', 'plan_digest',
    ];
    const phased = ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7',
      'lattice.todo_plan.v8', 'lattice.todo_plan.v9'].includes(value?.schema);
    const decoupled = ['lattice.todo_plan.v5', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8', 'lattice.todo_plan.v9']
      .includes(value?.schema);
    if (phased) planKeys.push('phases');
    if (decoupled) planKeys.push('phase_accept_dependencies');
    if (!exactRecord(value, planKeys)) return reject('unexpected_or_missing_keys', '/');
    if (taskValidator === null) return reject('schema_mismatch', '/schema');
    for (const field of ['project_id', 'plan_key', 'plan_version']) {
      if (!isTodoIdentifier(value[field])) return reject('identifier_invalid', `/${field}`);
    }
    if (!nullableDigest(value.predecessor_plan_digest)) return reject('digest_invalid', '/predecessor_plan_digest');
    if (!Array.isArray(value.tasks) || value.tasks.length === 0) return reject('bounded_collection_violation', '/tasks');
    const invalidTask = value.tasks.findIndex((task) => !taskValidator(task));
    if (invalidTask >= 0) return reject('task_shape_invalid', `/tasks/${invalidTask}`);
    if (new Set(value.tasks.map(({ task_id }) => task_id)).size !== value.tasks.length) {
      return reject('duplicate_task_id', '/tasks');
    }
    if (value.schema === 'lattice.todo_plan.v9') {
      const ids = new Set(value.tasks.map(({ task_id: id }) => id));
      const stray = value.tasks.findIndex(({ task_id: id, function_split: split }) => split !== null
        && (split.members.includes(id) || !split.members.every((member) => ids.has(member))));
      if (stray >= 0) return reject('function_split_members_invalid', `/tasks/${stray}/function_split/members`);
    }
    if (!Array.isArray(value.hard_dependencies)) {
      return reject('bounded_collection_violation', '/hard_dependencies');
    }
    const invalidEdge = value.hard_dependencies.findIndex((edge) => !exactRecord(edge, ['from', 'to'])
      || !nodeRef(edge.from) || !nodeRef(edge.to));
    if (invalidEdge >= 0) return reject('edge_shape_invalid', `/hard_dependencies/${invalidEdge}`);
    if (!Array.isArray(value.joins)) {
      return reject('bounded_collection_violation', '/joins');
    }
    const invalidJoin = value.joins.findIndex((join) => !exactRecord(join, ['id', 'after', 'before'])
      || !isTodoIdentifier(join.id) || !Array.isArray(join.after) || join.after.length === 0
      || !join.after.every(nodeRef) || !nodeRef(join.before));
    if (invalidJoin >= 0) return reject('join_shape_invalid', `/joins/${invalidJoin}`);
    for (const field of ['topology_digest', 'plan_digest']) {
      if (!isTodoDigest(value[field])) return reject('digest_invalid', `/${field}`);
    }
    if (['lattice.todo_plan.v3', 'lattice.todo_plan.v4', 'lattice.todo_plan.v5',
      'lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8', 'lattice.todo_plan.v9'].includes(value.schema)
      && !validParentGraph(value.tasks)) return reject('parent_graph_invalid', '/tasks');
    if (phased) {
      if (!Array.isArray(value.phases) || value.phases.length === 0) return reject('bounded_collection_violation', '/phases');
      const invalidPhase = value.phases.findIndex((phase) => !phaseV1(phase));
      if (invalidPhase >= 0) return reject('phase_shape_invalid', `/phases/${invalidPhase}`);
      const order = explainTodoOrder(value.phases, (phase) => phase.phase_id, '/phases');
      if (order !== null) return order;
      const orphanTask = value.tasks.findIndex(({ phase_id }) => !value.phases.some((phase) => phase.phase_id === phase_id));
      if (orphanTask >= 0) return reject('unknown_phase_reference', `/tasks/${orphanTask}/phase_id`);
      if (!validPhaseGraph(value.phases)) return reject('phase_graph_invalid', '/phases');
    }
    if (decoupled) {
      if (!Array.isArray(value.phase_accept_dependencies)) {
        return reject('bounded_collection_violation', '/phase_accept_dependencies');
      }
      const invalid = value.phase_accept_dependencies.findIndex((edge) => !exactRecord(edge, ['from', 'to'])
        || !phaseRef(edge.from) || !nodeRef(edge.to));
      if (invalid >= 0) return reject('edge_shape_invalid', `/phase_accept_dependencies/${invalid}`);
      const order = explainTodoOrder(value.phase_accept_dependencies,
        (edge) => `${phaseRefKey(edge.from)}\0${refKey(edge.to)}`, '/phase_accept_dependencies');
      if (order !== null) return order;
    }
    for (const [values, key, pointer] of [
      [value.tasks, (task) => task.task_id, '/tasks'],
      [value.hard_dependencies, (edge) => `${refKey(edge.from)}\0${refKey(edge.to)}`, '/hard_dependencies'],
      [value.joins, (join) => join.id, '/joins'],
    ]) {
      const order = explainTodoOrder(values, key, pointer);
      if (order !== null) return order;
    }
    for (const [index, join] of value.joins.entries()) {
      const order = explainTodoOrder(join.after, refKey, `/joins/${index}/after`);
      if (order !== null) return order;
    }
    const topology = {
      project_id: value.project_id, plan_key: value.plan_key, plan_version: value.plan_version,
      tasks: value.tasks, hard_dependencies: value.hard_dependencies, joins: value.joins,
      ...(phased ? { phases: value.phases } : {}),
      ...(decoupled ? { phase_accept_dependencies: value.phase_accept_dependencies } : {}),
    };
    if (value.topology_digest !== digestTodoArtifact(topology)) return reject('topology_digest_mismatch', '/topology_digest');
    if (value.plan_digest !== todoSelfDigest(value, 'plan_digest')) return reject('plan_digest_mismatch', '/plan_digest');
    return null;
  } catch { return reject('diagnosis_failed', '/'); }
}

export function validateTodoPlan(value) {
  return explainTodoPlan(value) === null;
}

export function validateEvidenceDescriptor(value) { return evidence(value); }

function validPayload(event) {
  const payload = event.payload;
  if (event.kind === 'plan_genesis') return (exactRecord(payload, [
    'plan_digest', 'topology_digest', 'predecessor_plan_digest', 'task_migration',
  ]) || exactRecord(payload, [
    'plan_digest', 'topology_digest', 'predecessor_plan_digest', 'task_migration', 'historical_import',
  ])) && (payload.historical_import === undefined || payload.historical_import === true)
    && isTodoDigest(payload.plan_digest) && isTodoDigest(payload.topology_digest)
    && nullableDigest(payload.predecessor_plan_digest) && Array.isArray(payload.task_migration)
    && payload.task_migration.every((entry) => exactRecord(entry, ['from_task_id', 'to_task_id'])
      && isTodoIdentifier(entry.from_task_id) && (entry.to_task_id === 'removed' || isTodoIdentifier(entry.to_task_id)));
  if (event.kind === 'start' && payload?.start_mode === 'historical_import') {
    return exactRecord(payload, ['start_mode', 'imported', 'status', 'started_at', 'evidence'])
      && payload.imported === true && payload.status === 'in-progress'
      && (payload.started_at === 'unknown_requires_evidence' || isStrictTodoTimestamp(payload.started_at))
      && validateTodoImportSource(payload.evidence);
  }
  if (event.kind === 'coordination_mode') {
    return exactRecord(payload, ['mode', 'reason'])
      && TODO_COORDINATION_MODES.includes(payload.mode)
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'cross_plan_dependency') {
    const dependencyRef = (value) => exactRecord(value, [
      'project_id', 'plan_key', 'task_id', 'expected_topology_digest',
    ]) && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
      && isTodoIdentifier(value.task_id) && isTodoDigest(value.expected_topology_digest);
    return exactRecord(payload, ['from', 'to', 'reason'])
      && dependencyRef(payload.from) && dependencyRef(payload.to)
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'cross_plan_dependency_removed') {
    return exactRecord(payload, ['target_event_digest', 'reason'])
      && isTodoDigest(payload.target_event_digest)
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'connection_added') {
    return exactRecord(payload, ['task_id', 'to', 'reason']) && isTodoIdentifier(payload.task_id)
      && exactRecord(payload.to, ['kind', 'id']) && payload.to.kind === 'schedule'
      && typeof payload.to.id === 'string' && TODO_CONNECTION_SCHEDULE_ID.test(payload.to.id)
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'connection_removed') {
    return exactRecord(payload, ['target_event_digest', 'reason']) && isTodoDigest(payload.target_event_digest)
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'connection_resolved') {
    return exactRecord(payload, ['target_event_digest', 'evidence']) && isTodoDigest(payload.target_event_digest)
      && nullableText(payload.evidence) && payload.evidence !== null;
  }
  // rebind: plan改訂でcarryされたin-progress ToDoへ、現plan_versionの明示的start束縛を積み直す
  // （runtime intakeはliteral startだけを束縛に使い、carryを推定しない。ADR 0191）
  if (event.kind === 'start' && payload?.start_mode === 'rebind') {
    return exactRecord(payload, ['start_mode', 'reason'])
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'start') return exactRecord(payload, ['override_reason']) && nullableText(payload.override_reason);
  if (event.kind === 'start_retracted') return exactRecord(payload, ['reason', 'target_start_digest'])
    && nullableText(payload.reason) && payload.reason !== null
    && isTodoDigest(payload.target_start_digest);
  if (event.kind === 'block') return exactRecord(payload, ['reason']) && nullableText(payload.reason) && payload.reason !== null;
  if (event.kind === 'unblock') return exactRecord(payload, []);
  // retire: 消費計画が消えた工程の恒久除去（ADR 0147系の状態遷移に足す軽量kind・2026-08-29オーナー裁定）。
  // 理由必須。blocked_reasonのfieldを理由の置き場として再利用し、state recordの形を変えない。
  if (event.kind === 'retire') {
    return (exactRecord(payload, ['reason'])
      || (exactRecord(payload, ['reason', 'prior_status'])
        && ['pending', 'blocked', 'in-progress', 'done'].includes(payload.prior_status)))
      && nullableText(payload.reason) && payload.reason !== null;
  }
  if (event.kind === 'done' && payload?.done_mode === 'authored' && typeof payload.message === 'string') {
    // k4: a new done record is plain text in the event (no blob, descriptor or digest). Legacy `evidence` records stay valid below.
    return (exactRecord(payload, ['done_mode', 'imported', 'message'])
      || exactRecord(payload, ['done_mode', 'imported', 'message', 'test_result']))
      && payload.imported === false && payload.message.trim().length > 0
      && Buffer.byteLength(payload.message) <= TODO_LIMITS.noteBodyBytes
      && (payload.test_result === undefined || isTodoTestResult(payload.test_result));
  }
  if (event.kind === 'done' && payload?.done_mode === 'authored') {
    return (exactRecord(payload, ['done_mode', 'imported', 'evidence'])
      || exactRecord(payload, ['done_mode', 'imported', 'evidence', 'test_result']))
      && payload.imported === false && evidence(payload.evidence)
      && (payload.test_result === undefined || isTodoTestResult(payload.test_result));
  }
  if (event.kind === 'done' && payload?.done_mode === 'historical_import') {
    return exactRecord(payload, ['done_mode', 'imported', 'status', 'completed_at', 'evidence'])
      && payload.imported === true && payload.status === 'done'
      && (payload.completed_at === 'unknown_requires_evidence' || isStrictTodoTimestamp(payload.completed_at))
      && validateTodoImportSource(payload.evidence);
  }
  if (event.kind === 'done' && payload?.done_mode === 'evidence_promotion') {
    return exactRecord(payload, ['done_mode', 'imported', 'target_done_digest', 'evidence'])
      && typeof payload.imported === 'boolean'
      && isTodoDigest(payload.target_done_digest) && evidence(payload.evidence);
  }
  // retract-anyone (B1): new reopens carry to_status 'pending' (unstarted); legacy ones (no key) reopened in-progress.
  if (event.kind === 'reopen') return (exactRecord(payload, ['reason', 'target_done_digest', 'override_reason'])
    || (exactRecord(payload, ['reason', 'target_done_digest', 'override_reason', 'to_status']) && payload.to_status === 'pending'))
    && nullableText(payload.reason) && payload.reason !== null && isTodoDigest(payload.target_done_digest)
    && nullableText(payload.override_reason);
  if (event.kind === 'phase_review') return exactRecord(payload, ['reason'])
    && nullableText(payload.reason) && payload.reason !== null;
  // k4: a new accept/reject carries no evidence descriptor or slots; an optional plain-text `message` (same limits as done's).
  const planMessage = (value) => typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= TODO_LIMITS.noteBodyBytes;
  if (event.kind === 'phase_accept' && (exactRecord(payload, ['review_event_digest'])
    || exactRecord(payload, ['review_event_digest', 'message']))) {
    return isTodoDigest(payload.review_event_digest) && (payload.message === undefined || planMessage(payload.message));
  }
  if (event.kind === 'phase_reject' && (exactRecord(payload, ['review_event_digest', 'reason'])
    || exactRecord(payload, ['review_event_digest', 'reason', 'message']))) {
    return isTodoDigest(payload.review_event_digest) && nullableText(payload.reason) && payload.reason !== null
      && (payload.message === undefined || planMessage(payload.message));
  }
  if (event.kind === 'phase_accept') return exactRecord(payload, [
    'review_event_digest', 'decision_evidence', 'evidence_slots',
  ]) && isTodoDigest(payload.review_event_digest) && evidence(payload.decision_evidence)
    && Array.isArray(payload.evidence_slots) && payload.evidence_slots.length > 0
    && payload.evidence_slots.every((entry) => exactRecord(entry, ['slot_id', 'evidence'])
      && isTodoIdentifier(entry.slot_id) && evidence(entry.evidence))
    && payload.evidence_slots.every((entry, index) => index === 0
      || compareText(payload.evidence_slots[index - 1].slot_id, entry.slot_id) < 0);
  if (event.kind === 'phase_reject') return exactRecord(payload, [
    'review_event_digest', 'reason', 'decision_evidence',
  ]) && isTodoDigest(payload.review_event_digest) && nullableText(payload.reason)
    && payload.reason !== null && evidence(payload.decision_evidence);
  if (event.kind === 'phase_reopen') return exactRecord(payload, [
    'reason', 'target_decision_digest', 'override_reason',
  ]) && nullableText(payload.reason) && payload.reason !== null
    && isTodoDigest(payload.target_decision_digest) && nullableText(payload.override_reason);
  // ADR 0148裁定1: 監査なしで閉じたことの理由は必須(payload.reason !== null)。証拠は無い
  // ——監査していないというのが事実であり、evidenceを要求すると「監査した体」を装う経路になる。
  if (event.kind === 'phase_close_unaudited') return exactRecord(payload, ['reason'])
    && nullableText(payload.reason) && payload.reason !== null;
  return false;
}

function validCarriedState(value) {
  const legacy = exactRecord(value, [
    'status', 'started_at', 'done_at', 'blocked_reason', 'evidence', 'imported',
  ]);
  const resultAware = exactRecord(value, [
    'status', 'started_at', 'done_at', 'blocked_reason', 'evidence', 'imported', 'test_result',
  ]);
  if ((!legacy && !resultAware) || !['pending', 'in-progress', 'blocked', 'retired', 'done'].includes(value.status)
    || (value.started_at !== null && !isStrictTodoTimestamp(value.started_at))
    || (value.done_at !== null && !isStrictTodoTimestamp(value.done_at))
    || (value.blocked_reason !== null && !nullableText(value.blocked_reason))
    || typeof value.imported !== 'boolean') return false;
  const testResult = resultAware ? value.test_result : null;
  if (testResult !== null && !isTodoTestResult(testResult)) return false;
  if (value.status === 'pending') return value.started_at === null && value.done_at === null
    && value.blocked_reason === null && value.evidence === null && value.imported === false
    && testResult === null;
  const activeEvidenceValid = value.imported
    ? value.evidence === null || validateTodoImportSource(value.evidence)
    : value.evidence === null;
  if (value.status === 'in-progress') return value.done_at === null && value.blocked_reason === null
    && activeEvidenceValid && testResult === null;
  if (value.status === 'blocked') return value.done_at === null && value.blocked_reason !== null
    && activeEvidenceValid && testResult === null;
  // retired: 実行されないまま恒久に閉じた工程。理由はblocked_reasonが持ち、証拠・試験結果は持たない。
  // done_at is kept only when retired from done (u12).
  if (value.status === 'retired') return value.blocked_reason !== null
    && value.evidence === null && testResult === null;
  return value.blocked_reason === null && value.evidence !== null
    // importedは完了状態の来歴を表す。evidence_promotion後もtrueを維持するため、
    // imported doneの現在証拠はimport sourceまたは通常evidence descriptorのどちらも有効。
    && (value.imported
      ? validateTodoImportSource(value.evidence) || evidence(value.evidence)
      : evidence(value.evidence) || isTodoDoneMessage(value.evidence));
}

function validStateMigration(value) {
  return Array.isArray(value)
    && value.every((entry) => exactRecord(entry, [
      'from_task_id', 'to_task_id', 'state_policy', 'state',
    ]) && isTodoIdentifier(entry.from_task_id)
      && (entry.to_task_id === 'removed' || isTodoIdentifier(entry.to_task_id))
      && ['carry', 'carry_reconciled_metadata', 'reset_pending', 'removed', 'acquire_phase'].includes(entry.state_policy)
      && ((['carry', 'carry_reconciled_metadata', 'acquire_phase'].includes(entry.state_policy)
        && entry.to_task_id !== 'removed' && validCarriedState(entry.state))
        || (entry.state_policy === 'reset_pending' && entry.to_task_id !== 'removed' && entry.state === null)
        || (entry.state_policy === 'removed' && entry.to_task_id === 'removed' && entry.state === null)))
    && new Set(value.map(({ from_task_id }) => from_task_id)).size === value.length
    && value.every((entry, index) => index === 0
      || compareText(value[index - 1].from_task_id, entry.from_task_id) < 0);
}

function validPhaseStateMigration(value) {
  return Array.isArray(value)
    && value.every((entry) => exactRecord(entry, ['phase_id', 'state_policy', 'state'])
      && isTodoIdentifier(entry.phase_id) && ['carry', 'reset'].includes(entry.state_policy)
      && (entry.state_policy === 'reset' ? entry.state === null
        : exactRecord(entry.state, [
          'status', 'review_event_digest', 'decision_event_digest', 'decision_evidence',
        ]) && ['locked', 'active', 'gate_ready', 'reviewing', 'accepted', 'rejected', 'closed_unaudited']
          .includes(entry.state.status)
          && nullableDigest(entry.state.review_event_digest)
          && nullableDigest(entry.state.decision_event_digest)
          && (entry.state.decision_evidence === null || evidence(entry.state.decision_evidence))))
    && value.every((entry, index) => index === 0
      || compareText(value[index - 1].phase_id, entry.phase_id) < 0);
}

export function validateTodoEvent(value) {
  try {
    const commonKeys = [
      'schema', 'project_id', 'plan_key', 'plan_version', 'sequence', 'previous_digest',
      'kind', 'task_id', 'actor', 'recorded_at', 'provenance', 'payload', 'event_digest',
    ];
    const v1 = value?.schema === 'lattice.todo_event.v1' && exactRecord(value, commonKeys);
    const v2 = value?.schema === 'lattice.todo_event.v2' && exactRecord(value, [
      ...commonKeys, 'reconciliation_state', 'revision_digest', 'reconciliation_digest',
      'state_migration',
    ]) && value.kind === 'plan_genesis' && value.task_id === null
      && value.reconciliation_state === 'reconciled' && isTodoDigest(value.revision_digest)
      && isTodoDigest(value.reconciliation_digest) && validStateMigration(value.state_migration);
    const v3 = value?.schema === 'lattice.todo_event.v3' && exactRecord(value, [
      ...commonKeys, 'phase_id',
    ]);
    const v4 = value?.schema === 'lattice.todo_event.v4' && exactRecord(value, [
      ...commonKeys, 'phase_id', 'revision_digest', 'state_migration', 'phase_state_migration',
    ]) && value.kind === 'plan_genesis' && value.task_id === null && value.phase_id === null
      && isTodoDigest(value.revision_digest) && validStateMigration(value.state_migration)
      && validPhaseStateMigration(value.phase_state_migration);
    const phaseKind = ['phase_review', 'phase_accept', 'phase_reject', 'phase_reopen', 'phase_close_unaudited']
      .includes(value?.kind);
    // planへ帰属するkindは、plan_genesisと同じくtask_idを持たない(v3/v4ではphase_idも持たない)。
    // plan_genesisと違うのはjournalの途中に何度でも積めることで、最後の1件が現在の宣言になる。
    const planScopedKind = TODO_PLAN_SCOPED_EVENT_KINDS.includes(value?.kind);
    const planLevel = value?.kind === 'plan_genesis' || planScopedKind;
    return (v1 || v2 || v3 || v4) && isTodoIdentifier(value.project_id)
      && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.plan_version)
      && isNonNegativeSafeInteger(value.sequence) && nullableDigest(value.previous_digest)
      && TODO_EVENT_KINDS.includes(value.kind)
      && (v3 || v4
        ? ((planLevel && value.task_id === null && value.phase_id === null)
          || (phaseKind && value.task_id === null && isTodoIdentifier(value.phase_id))
          || (!phaseKind && !planLevel && isTodoIdentifier(value.task_id)
            && value.phase_id === null))
        : !phaseKind && ((planLevel && value.task_id === null)
          || (!planLevel && isTodoIdentifier(value.task_id))))
      && actor(value.actor) && isStrictTodoTimestamp(value.recorded_at) && provenance(value.provenance)
      && validPayload(value) && isTodoDigest(value.event_digest)
      && value.event_digest === todoSelfDigest(value, 'event_digest');
  } catch { return false; }
}

export function validateTodoManifest(value) {
  try {
    const manifestV1 = value?.schema === 'lattice.todo_manifest.v1';
    const manifestV2 = value?.schema === 'lattice.todo_manifest.v2';
    return exactRecord(value, ['schema', 'project_id', 'repositories', 'members', 'manifest_digest'])
      && (manifestV1 || manifestV2) && isTodoIdentifier(value.project_id)
      && Array.isArray(value.repositories) && value.repositories.length > 0 && value.repositories.length <= 256
      && value.repositories.every((repo) => exactRecord(repo, ['repo_id', 'path'])
        && isTodoIdentifier(repo.repo_id) && (repo.path === '.' || isTodoRef(repo.path)))
      && new Set(value.repositories.map(({ repo_id }) => repo_id)).size === value.repositories.length
      && value.repositories.every((repo, index) => index === 0 || value.repositories[index - 1].repo_id < repo.repo_id)
      && Array.isArray(value.members) && value.members.length > 0 && value.members.length <= 256
      && value.members.every((member) => exactRecord(member, [
        'plan_key', 'active_plan_version', 'plan_ref', 'journal_ref', 'snapshot_ref',
        'topology_digest', 'journal_head_digest', ...(manifestV2 ? ['active_revision_digest'] : []),
      ]) && isTodoIdentifier(member.plan_key) && isTodoIdentifier(member.active_plan_version)
        && isTodoRef(member.plan_ref) && isTodoRef(member.journal_ref) && isTodoRef(member.snapshot_ref)
        && isTodoDigest(member.topology_digest) && isTodoDigest(member.journal_head_digest)
        && (!manifestV2 || isTodoDigest(member.active_revision_digest)))
      && value.members.every((member, index) => index === 0 || value.members[index - 1].plan_key < member.plan_key)
      && new Set(value.members.map(({ plan_key }) => plan_key)).size === value.members.length
      && isTodoDigest(value.manifest_digest) && value.manifest_digest === todoSelfDigest(value, 'manifest_digest');
  } catch { return false; }
}

export function validateTodoSnapshot(value) {
  try {
    const v1 = value?.schema === 'lattice.todo_snapshot.v1' && exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'projection_version', 'through_sequence',
      'journal_head_digest', 'tasks', 'snapshot_digest',
    ]);
    const v2 = value?.schema === 'lattice.todo_snapshot.v2' && exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'projection_version', 'through_sequence',
      'journal_head_digest', 'tasks', 'phases', 'snapshot_digest',
    ]);
    const v3 = value?.schema === 'lattice.todo_snapshot.v3' && exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'projection_version', 'through_sequence',
      'journal_head_digest', 'tasks', 'snapshot_digest',
    ]);
    const v4 = value?.schema === 'lattice.todo_snapshot.v4' && exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'projection_version', 'through_sequence',
      'journal_head_digest', 'tasks', 'phases', 'snapshot_digest',
    ]);
    const resultAware = v3 || v4;
    const phaseAware = v2 || v4;
    return (v1 || v2 || v3 || v4) && isTodoIdentifier(value.project_id)
      && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.plan_version)
      && value.projection_version === (v1 ? 1 : v2 ? 2 : v3 ? 3 : 4)
      && isNonNegativeSafeInteger(value.through_sequence)
      && isTodoDigest(value.journal_head_digest) && Array.isArray(value.tasks)
      && value.tasks.length > 0
      && value.tasks.every((entry) => exactRecord(entry, [
        'task_id', 'status', 'started_at', 'done_at', 'blocked_reason', 'evidence', 'evidence_unverified', 'imported',
        ...(resultAware ? ['test_result'] : []),
      ]) && isTodoIdentifier(entry.task_id) && ['pending', 'in-progress', 'blocked', 'retired', 'done'].includes(entry.status)
        && (entry.started_at === null || isStrictTodoTimestamp(entry.started_at))
        && (entry.done_at === null || isStrictTodoTimestamp(entry.done_at)) && nullableText(entry.blocked_reason)
        && (entry.evidence === null || evidence(entry.evidence) || validateTodoImportSource(entry.evidence)
          || isTodoDoneMessage(entry.evidence))
        && typeof entry.evidence_unverified === 'boolean' && typeof entry.imported === 'boolean'
        && (!resultAware || (entry.status === 'done'
          ? entry.test_result === null || isTodoTestResult(entry.test_result)
          : entry.test_result === null)))
      && value.tasks.every((entry, index) => index === 0 || value.tasks[index - 1].task_id < entry.task_id)
      && (!phaseAware || (Array.isArray(value.phases) && value.phases.length > 0
        && value.phases.every((entry) => exactRecord(entry, [
          'phase_id', 'status', 'review_event_digest', 'decision_event_digest', 'decision_evidence',
        ]) && isTodoIdentifier(entry.phase_id)
          && ['locked', 'active', 'gate_ready', 'reviewing', 'accepted', 'rejected', 'closed_unaudited']
            .includes(entry.status)
          && nullableDigest(entry.review_event_digest) && nullableDigest(entry.decision_event_digest)
          && (entry.decision_evidence === null || evidence(entry.decision_evidence)))
        && value.phases.every((entry, index) => index === 0
          || value.phases[index - 1].phase_id < entry.phase_id)))
      && isTodoDigest(value.snapshot_digest) && value.snapshot_digest === todoSelfDigest(value, 'snapshot_digest');
  } catch { return false; }
}

export function validateTodoChartMeta(value) {
  const text = (field) => field === null || (typeof field === 'string' && field.length > 0 && field.length <= 1024);
  const word = (field) => typeof field === 'string' && field.length > 0 && field.length <= 1024;
  const { repo } = value ?? {};
  // no_code_lanes is optional: a file without it stays valid, and an empty list is never written (old readers keep working).
  const lanes = value?.no_code_lanes;
  const lanesOk = lanes === undefined || (Array.isArray(lanes) && lanes.every((lane, index) => isTodoIdentifier(lane)
    && (index === 0 || lanes[index - 1] < lane)));
  return exactRecord(value, ['schema', 'name', 'created_by', 'created_at', 'repo', ...(lanes === undefined ? [] : ['no_code_lanes'])])
    && lanesOk && value.schema === TODO_CHART_META_SCHEMA && text(value.name) && text(value.created_by)
    && (value.created_at === null || isStrictTodoTimestamp(value.created_at))
    && (repo === null || (exactRecord(repo, ['url', 'branch', 'accepted_tip'])
      && word(repo.url) && word(repo.branch) && text(repo.accepted_tip)));
}

// ---- ADR 0204 a4 relations ------------------------------------------------------------------------------------
const relationText = (field) => typeof field === 'string' && field.length > 0 && field.length <= 1024;
const relationSha = (field) => field === null || relationText(field);
const lineNumber = (field) => Number.isSafeInteger(field) && field >= 1;

/** One side of an overlap. A whole-file claim has no symbol and no range (both null). */
function relationEntry(entry) {
  return exactRecord(entry, ['symbol', 'start_line', 'end_line', 'access'])
    && ['read', 'write'].includes(entry.access)
    && ((entry.symbol === null && entry.start_line === null && entry.end_line === null)
      || (relationText(entry.symbol) && lineNumber(entry.start_line) && lineNumber(entry.end_line)
        && entry.end_line >= entry.start_line));
}

/** The pair identity: task_a sorts before task_b, so a pair has one spelling. */
const relationKey = (value) => isTodoIdentifier(value.task_a) && isTodoIdentifier(value.task_b)
  && value.task_a < value.task_b && relationText(value.path);

export const todoRelationOverlapsValid = (overlaps) => Array.isArray(overlaps) && overlaps.length > 0
  && overlaps.every((overlap) => exactRecord(overlap, ['a', 'b']) && relationEntry(overlap.a) && relationEntry(overlap.b));

/** Content identity of a relation (head and time excluded): the same overlap re-found is not a new relation. */
export function todoRelationId(relation) {
  return digestTodoArtifact({ task_a: relation.task_a, task_b: relation.task_b, path: relation.path,
    overlaps: relation.overlaps });
}

export function validateTodoRelationEvent(value) {
  try {
    const common = value !== null && typeof value === 'object' && value.schema === TODO_RELATION_EVENT_SCHEMA
      && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && isTodoDigest(value.relation_id)
      && relationKey(value) && relationSha(value.head_sha) && isStrictTodoTimestamp(value.computed_at);
    if (!common) return false;
    if (value.kind === 'gone') {
      return exactRecord(value, ['schema', 'kind', 'sequence', 'relation_id', 'task_a', 'task_b', 'path', 'head_sha', 'computed_at']);
    }
    return value.kind === 'relation'
      && exactRecord(value, ['schema', 'kind', 'sequence', 'relation_id', 'task_a', 'task_b', 'path', 'overlaps', 'head_sha', 'computed_at'])
      && todoRelationOverlapsValid(value.overlaps) && value.relation_id === todoRelationId(value);
  } catch { return false; }
}

const summaryRelation = (entry) => exactRecord(entry, ['relation_id', 'task_a', 'task_b', 'path', 'overlaps'])
  && isTodoDigest(entry.relation_id) && relationKey(entry) && todoRelationOverlapsValid(entry.overlaps);

export function validateTodoRelationSummary(value) {
  try {
    return exactRecord(value, ['schema', 'plan_key', 'relation_count', 'open_relations', 'open_truncated',
      'unresolved_count', 'head_sha', 'log_sequence', 'computed_at'])
      && value.schema === TODO_RELATION_SUMMARY_SCHEMA && isTodoIdentifier(value.plan_key)
      && isNonNegativeSafeInteger(value.relation_count) && isNonNegativeSafeInteger(value.unresolved_count)
      && isNonNegativeSafeInteger(value.log_sequence) && Array.isArray(value.open_relations)
      && value.open_relations.length <= TODO_RELATION_SUMMARY_OPEN && value.open_relations.every(summaryRelation)
      && value.open_truncated === (value.relation_count > value.open_relations.length)
      && relationSha(value.head_sha) && isStrictTodoTimestamp(value.computed_at);
  } catch { return false; }
}

const splitCondition = (value) => exactRecord(value, ['passed', 'detail']) && typeof value.passed === 'boolean'
  && typeof value.detail === 'string' && Buffer.byteLength(value.detail, 'utf8') <= 2_048;
const splitMapEntry = (value) => exactRecord(value, ['task_id', 'path', 'symbol'])
  && isTodoIdentifier(value.task_id) && isTodoRef(value.path) && splitText(value.symbol);

/** ADR 0205 §2: `accepted` only when all five conditions passed; the map has at most one entry per task, sorted by task_id. */
export function validateTodoSplitRecord(value) {
  try {
    return exactRecord(value, ['schema', 'plan_key', 'task_id', 'attempt', 'map', 'commit', 'base', 'outcome',
      'conditions', 'recorded_at', 'actor'])
      && value.schema === TODO_SPLIT_RECORD_SCHEMA && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.task_id)
      && Number.isSafeInteger(value.attempt) && value.attempt >= 1
      && Array.isArray(value.map) && value.map.length <= TODO_SPLIT_MAX_MEMBERS && value.map.every(splitMapEntry)
      && value.map.every((entry, index) => index === 0 || compareText(value.map[index - 1].task_id, entry.task_id) < 0)
      && /^[0-9a-f]{40}$/u.test(value.commit) && /^[0-9a-f]{40}$/u.test(value.base)
      && ['accepted', 'rejected'].includes(value.outcome)
      && exactRecord(value.conditions, TODO_SPLIT_CONDITIONS) && TODO_SPLIT_CONDITIONS.every((key) => splitCondition(value.conditions[key]))
      && (value.outcome === 'rejected' || TODO_SPLIT_CONDITIONS.every((key) => value.conditions[key].passed))
      && isStrictTodoTimestamp(value.recorded_at) && actor(value.actor);
  } catch { return false; }
}
