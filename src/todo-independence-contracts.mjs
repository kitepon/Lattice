import {
  exactRecord,
  isNonNegativeSafeInteger,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoIdentifier,
  todoSelfDigest,
} from './todo-contracts.mjs';
import {
  RUN_REQUEST_CLAIM_MODE,
  RUN_REQUEST_DECLARATIVE_SCHEMA,
  RUN_REQUEST_PREDICTION_SCHEMA,
  RUN_REQUEST_SCHEMA,
  explainRunRequest,
  selfDigest as runtimeSelfDigest,
} from './runtime-contracts.mjs';
import { TODO_INDEPENDENCE_GUIDANCE_CODES } from './todo-independence-guidance.mjs';

export const TODO_WITNESS_SET_SCHEMA = 'lattice.todo_witness_set.v5';
/**
 * まだ受理する旧witness set契約。v3以前の厳密なcompile意味を変えず、
 * 既存宣言を書き換えさせないために読み口を残す。
 */
export const TODO_WITNESS_SET_LEGACY_SCHEMAS = Object.freeze([
  'lattice.todo_witness_set.v4',
  'lattice.todo_witness_set.v3',
  'lattice.todo_witness_set.v2',
  'lattice.todo_witness_set.v1',
]);
export const TODO_WITNESS_SET_SCHEMAS = Object.freeze([
  TODO_WITNESS_SET_SCHEMA,
  ...TODO_WITNESS_SET_LEGACY_SCHEMAS,
]);
/** 宣言できる欄はversionごとに違う。どの版から使えるかを1箇所で持つ。 */
const CONCERN_ANCHOR_SCHEMAS = Object.freeze([
  TODO_WITNESS_SET_SCHEMA,
  'lattice.todo_witness_set.v4',
  'lattice.todo_witness_set.v3',
  'lattice.todo_witness_set.v2',
]);
const CREATES_SCHEMAS = Object.freeze([
  TODO_WITNESS_SET_SCHEMA, 'lattice.todo_witness_set.v4', 'lattice.todo_witness_set.v3',
]);

/** 1 taskが宣言できるconcern anchorの資源数と、資源あたりのsymbol数の上限。 */
export const TODO_CONCERN_ANCHOR_LIMIT = 256;
export const TODO_INDEPENDENCE_SCHEMA = 'lattice.todo_independence.v5';
export const TODO_INDEPENDENCE_PROJECTION_SCHEMA = 'lattice.todo_independence_projection.v2';
export const TODO_INDEPENDENCE_LEGACY_MARKER_SCHEMA = 'lattice.todo_independence_legacy_marker.v1';
export const TODO_INDEPENDENCE_LEGACY_SCHEMAS = Object.freeze([
  'lattice.todo_independence.v1',
  'lattice.todo_independence.v2',
  'lattice.todo_independence.v3',
  // v4は`scope_expanded`を持つが`first_seen_path_count`/`growth_events`が整数固定だった。
  // v5でnull（＝subset gapで累計が分からない）を足したので、**同じ版名で形を変えず**版を上げる。
  // 同名変更は「新readerが旧artifactを読める」後方互換しか満たさず、**旧readerが新artifactを
  // 読めない前方互換破壊**になる（2026-08-09のP0と同型・suzune [1183] / kanade [1200]）。
  'lattice.todo_independence.v4',
]);

/** boundary compileが一度に扱えるToDo数（runtime front-endのMAX_COLLECTIONと同じ閉じ方）。 */
export const TODO_INDEPENDENCE_TASK_LIMIT = 256;
export const TODO_INDEPENDENCE_LIST_LIMIT = 4_096;
export const TODO_INDEPENDENCE_COVERAGE = Object.freeze([
  'verified', 'stale', 'superseded', 'missing',
]);

/** conflictを生んだresourceの種別。切断可能性の導出はこの種別だけを根拠にする。 */
export const TODO_INDEPENDENCE_CONFLICT_KINDS = Object.freeze([
  'symbol', 'path', 'state', 'effect', 'line',
]);

/** 切断可能性。code seamで切れるのはsymbol/path起因のconflictだけ（ADR 0128 Decision 2）。 */
export const TODO_INDEPENDENCE_SEVERABILITY = Object.freeze(['code_seam', 'serial']);

/**
 * conflict kindから切断可能性を導く。
 *
 * 共有state／effectと意味的なlineはcode seamでは切断できない（RC1 boundary compilerの分類規則と同一）。
 * read×write交差から実体化される`rw-*`はkind=stateなのでserialへ倒れる。seam候補を
 * 見逃す方向にしか外れない保守的な誤りであり、既知の限界として受け入れる。
 */
export function severabilityOfConflictKind(kind) {
  return ['symbol', 'path'].includes(kind) ? 'code_seam' : 'serial';
}

const GIT_SHA = /^[0-9a-f]{40}$/u;
const PROBE_BASE_SHA = '0'.repeat(40);

export const isGitSha = (value) => typeof value === 'string' && GIT_SHA.test(value);

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 既知の旧independence artifactを、単なるschema文字列だけでなく版をまたいで不変な
 * identity fieldの型までで識別する。本体構造や自己digestは旧契約validatorの再実装に
 * なるため、ここでは検査しない。
 */
export function isTodoIndependenceLegacyArtifactIdentity(value) {
  return plain(value) && TODO_INDEPENDENCE_LEGACY_SCHEMAS.includes(value.schema)
    && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
    && isTodoIdentifier(value.plan_version) && isTodoDigest(value.topology_digest)
    && isTodoDigest(value.witness_set_digest) && isTodoDigest(value.result_digest)
    && isGitSha(value.base_sha);
}

/**
 * task別の宣言膨張の記録（v4から）。**判定を持たない——事実だけを置く。**
 *
 * 何が膨張の原因か（上流の契約確定に追従したのか、自分の変更の後始末か、元から在った面の
 * 見落としか、思いつきで盛ったのか）は**機械には区別できない**。区別するのはAIであり、
 * 装置が言えるのは「増えた」「何が増減した」「何回目か」「合流点か」までである。
 * ここへ閾値も勧告も置かない（勧告はadvisory側の仕事）。
 *
 * `removed_paths`を持つのは、増加だけを見ると「盛った」と「宣言をやり直した」が同じ顔に
 * なるからである。増減を両方見ないと読み手が誤る。
 *
 * `first_seen_path_count`と`growth_events`が**null**なのは「**このtaskの履歴が分からない**」で、
 * 0とは違う。witnessはwave単位のsubsetで書き出せるので、比較相手のartifactに当該taskが
 * 居ないことがある——その時に今回を初回と置くと、本当の初回と膨張回数が消える。
 * 初回（比較相手が無い）は`compared_witness_digest=null`＋数値、
 * subset入替（比較相手はあるがtaskが居ない）は`compared_witness_digest=digest`＋nullで区別する。
 */
function scopeExpansionEntry(value) {
  return plain(value)
    && exactRecord(value, [
      'task_id', 'compared_witness_digest', 'first_seen_path_count', 'path_count',
      'added_paths', 'removed_paths', 'growth_events', 'gate_shape',
    ])
    && isTodoIdentifier(value.task_id)
    && (value.compared_witness_digest === null || isTodoDigest(value.compared_witness_digest))
    && (value.first_seen_path_count === null
      || (Number.isSafeInteger(value.first_seen_path_count) && value.first_seen_path_count >= 0))
    && Number.isSafeInteger(value.path_count) && value.path_count >= 0
    && boundedList(value.added_paths, (entry) => typeof entry === 'string' && entry.length > 0)
    && strictlySorted(value.added_paths)
    && boundedList(value.removed_paths, (entry) => typeof entry === 'string' && entry.length > 0)
    && strictlySorted(value.removed_paths)
    && (value.growth_events === null
      || (Number.isSafeInteger(value.growth_events) && value.growth_events >= 0))
    && typeof value.gate_shape === 'boolean';
}

function boundedList(value, validator, limit = TODO_INDEPENDENCE_LIST_LIMIT) {
  return Array.isArray(value) && value.length <= limit && value.every(validator);
}

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function strictlySorted(values, key = (value) => value) {
  return values.every((value, index) => index === 0 || compareText(key(values[index - 1]), key(value)) < 0);
}

function sorted(values, key = (value) => value) {
  return values.every((value, index) => index === 0 || compareText(key(values[index - 1]), key(value)) <= 0);
}

function boundedText(value, maximumBytes = 4_096) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= maximumBytes
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * witness setを、同じ宣言を持つ`lattice.run_request.v1`へ写す。
 *
 * manual witnessとsensor query setの判定正本は`explainRunRequest`だけが持つ（ADR 0123）。
 * ここで同じ規則を書き直すと契約が二箇所へ分裂するため、検証もcompileもこの合成を通す。
 * `requestId`はplan identityとwitness digestから導出され、run lifecycleへは登録されない。
 *
 * `concern_anchors`はここで落とす。並列可否の判定はこの合成requestだけを入力にするので、
 * 落としておけばconcern宣言が判定へ影響しないことが構造で保証される（testの主張ではない）。
 * 宣言はseam束縛の入力であり、witness setから直接読む。
 */
export function synthesizeWitnessRunRequest(witnessSet, { baseSha, requestId }) {
  const taskIds = Object.keys(witnessSet.manual_witness).sort(compareText);
  const request = {
    schema: witnessSet.schema === TODO_WITNESS_SET_SCHEMA
      ? RUN_REQUEST_SCHEMA
      : witnessSet.schema === 'lattice.todo_witness_set.v4'
        ? RUN_REQUEST_PREDICTION_SCHEMA
        : RUN_REQUEST_DECLARATIVE_SCHEMA,
    request_id: requestId,
    repo: { base_sha: baseSha, root_kind: 'git' },
    capacity: witnessSet.capacity,
    todos: taskIds.map((taskId) => ({ todo_id: taskId })),
    manual_witness: Object.fromEntries(taskIds.map((taskId) => {
      const { concern_anchors: _concernAnchors, ...boundary } = witnessSet.manual_witness[taskId];
      return [taskId, boundary];
    })),
    sensor_query_set: witnessSet.sensor_query_set,
    executor_capability: { adapters: ['todo-independence'] },
    claim_mode: RUN_REQUEST_CLAIM_MODE,
    request_digest: '',
  };
  request.request_digest = runtimeSelfDigest(request, 'request_digest');
  return request;
}

/**
 * 1 taskのconcern anchor宣言を検査する。
 *
 * `within`は`owns`または`writes`が指す資源に限る。触ると宣言した面の内側に担当を書ける。
 * 所有も書き込みも無い資源の内側には主張させない。
 */
function explainConcernAnchors(anchors, owns, writes, at) {
  const reject = (reason, path) => ({ valid: false, reason, path });
  if (!Array.isArray(anchors) || anchors.length > TODO_CONCERN_ANCHOR_LIMIT) {
    return reject('bounded_collection_violation', at);
  }
  const ownedKeys = new Set(owns.map((own) => `${own.kind}\0${own.target}`));
  if (Array.isArray(writes)) {
    for (const write of writes) {
      if (typeof write === 'string') ownedKeys.add(`path\0${write}`);
    }
  }
  for (const [index, entry] of anchors.entries()) {
    const entryAt = `${at}/${index}`;
    if (!exactRecord(entry, ['within', 'symbols'])) {
      return reject('unexpected_or_missing_keys', entryAt);
    }
    if (!exactRecord(entry.within, ['kind', 'target'])
      || !['symbol', 'path'].includes(entry.within.kind)) {
      return reject('invalid_concern_anchor_resource', `${entryAt}/within`);
    }
    const targetValid = entry.within.kind === 'path'
      ? repoRelativeResourceTarget(entry.within.target)
      : boundedText(entry.within.target, 1_024);
    if (!targetValid) return reject('invalid_concern_anchor_resource', `${entryAt}/within`);
    if (!ownedKeys.has(`${entry.within.kind}\0${entry.within.target}`)) {
      return reject('concern_anchor_resource_not_owned', `${entryAt}/within`);
    }
    if (!Array.isArray(entry.symbols) || entry.symbols.length < 1
      || entry.symbols.length > TODO_CONCERN_ANCHOR_LIMIT) {
      return reject('bounded_collection_violation', `${entryAt}/symbols`);
    }
    if (!entry.symbols.every((symbol) => boundedText(symbol, 1_024))) {
      return reject('invalid_concern_anchor_symbol', `${entryAt}/symbols`);
    }
    if (!strictlySorted(entry.symbols)) {
      return reject('unsorted_or_duplicate_collection', `${entryAt}/symbols`);
    }
  }
  if (!strictlySorted(anchors, (entry) => `${entry.within.kind}\0${entry.within.target}`)) {
    return reject('unsorted_or_duplicate_collection', at);
  }
  return { valid: true };
}

/**
 * `lattice.todo_witness_set.v2`（およびconcern anchorを持たない旧v1）を検証し、
 * 拒否理由とpathを返す。
 *
 * 自分のshapeだけをここで見て、witness本体はprobe requestへ合成して
 * `explainRunRequest`へ委譲する。probeのbase_shaは検証専用の定数であり永続化しない。
 * `concern_anchors`はprobeから落ちるので、ここだけが判定正本になる。
 */
export function explainTodoWitnessSet(value) {
  const reject = (reason, at = '') => ({ valid: false, reason, path: at });
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'capacity', 'sensor_query_set',
      'manual_witness', 'witness_set_digest',
    ])) return reject('unexpected_or_missing_top_level_keys');
    if (!TODO_WITNESS_SET_SCHEMAS.includes(value.schema)) return reject('schema_mismatch', '/schema');
    if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
    if (!isTodoIdentifier(value.plan_key)) return reject('invalid_identifier', '/plan_key');
    if (!plain(value.manual_witness)) return reject('not_an_object', '/manual_witness');
    const taskIds = Object.keys(value.manual_witness);
    if (taskIds.length < 1 || taskIds.length > TODO_INDEPENDENCE_TASK_LIMIT) {
      return reject('bounded_collection_violation', '/manual_witness');
    }
    if (!taskIds.every(isTodoIdentifier)) return reject('invalid_identifier', '/manual_witness');
    if (value.witness_set_digest !== todoSelfDigest(value, 'witness_set_digest')) {
      return reject('witness_set_digest_mismatch', '/witness_set_digest');
    }
    for (const taskId of taskIds) {
      const witness = value.manual_witness[taskId];
      if (plain(witness) && Object.hasOwn(witness, 'lines')
        && value.schema !== TODO_WITNESS_SET_SCHEMA) {
        return reject('lines_require_witness_set_v5', `/manual_witness/${taskId}/lines`);
      }
    }
    const probe = synthesizeWitnessRunRequest(value, {
      baseSha: PROBE_BASE_SHA, requestId: 'witness-set-probe',
    });
    const explained = explainRunRequest(probe);
    if (!explained.valid) return reject(explained.reason, explained.path);
    // 版ごとの欄。probeはRUN_REQUEST_SCHEMAで合成するので創作宣言はそこを通ってしまう。
    // 旧版の宣言に新しい欄を書けないことは、ここだけが見る。
    for (const taskId of taskIds) {
      const witness = value.manual_witness[taskId];
      if (!CREATES_SCHEMAS.includes(value.schema)
        && witness.owns.some((own) => Object.hasOwn(own, 'creates'))) {
        return reject('creates_require_witness_set_v3', `/manual_witness/${taskId}/owns`);
      }
      const at = `/manual_witness/${taskId}/concern_anchors`;
      if (!Object.hasOwn(witness, 'concern_anchors')) continue;
      if (!CONCERN_ANCHOR_SCHEMAS.includes(value.schema)) {
        return reject('concern_anchors_require_witness_set_v2', at);
      }
      const anchors = explainConcernAnchors(
        witness.concern_anchors, witness.owns, witness.writes, at,
      );
      if (!anchors.valid) return reject(anchors.reason, anchors.path);
    }
    return { valid: true };
  } catch {
    return reject('non_canonical_witness_set_bytes');
  }
}

export function validateTodoWitnessSet(value) {
  return explainTodoWitnessSet(value).valid;
}

function conflictEntry(value) {
  return exactRecord(value, ['task_ids', 'resource_id'])
    && Array.isArray(value.task_ids) && value.task_ids.length === 2
    && value.task_ids.every(isTodoIdentifier)
    && compareText(value.task_ids[0], value.task_ids[1]) < 0
    && boundedText(value.resource_id);
}

function repoRelativeResourceTarget(value) {
  if (!boundedText(value) || value.startsWith('/') || value.includes('\\')
    || /^[A-Za-z]:/u.test(value)) return false;
  const body = value.endsWith('/') ? value.slice(0, -1) : value;
  return body.length > 0 && body.split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function conflictResourceEntry(value) {
  if (!exactRecord(value, ['resource_id', 'kind', 'target'])
    || !boundedText(value.resource_id)
    || !TODO_INDEPENDENCE_CONFLICT_KINDS.includes(value.kind)) return false;
  return value.kind === 'path'
    ? repoRelativeResourceTarget(value.target)
    : boundedText(value.target);
}

export function isTodoIndependenceLegacyMarker(value) {
  return exactRecord(value, [
    'schema', 'legacy_schema', 'project_id', 'plan_key', 'plan_version',
    'topology_digest', 'base_sha',
  ])
    && value.schema === TODO_INDEPENDENCE_LEGACY_MARKER_SCHEMA
    && TODO_INDEPENDENCE_LEGACY_SCHEMAS.includes(value.legacy_schema)
    && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
    && value.plan_version === null && value.topology_digest === null && value.base_sha === null;
}

/**
 * task別の宣言境界。鮮度判定をartifactとgit diffだけで閉じるために持つ（ADR 0128 Decision 4）。
 * witness setを読み直さないので、参照コストは定数のまま保たれる。
 */
function taskBoundaryEntry(value) {
  return exactRecord(value, ['task_id', 'paths'])
    && isTodoIdentifier(value.task_id)
    && Array.isArray(value.paths) && value.paths.length <= TODO_INDEPENDENCE_LIST_LIMIT
    && value.paths.every((path) => boundedText(path)) && strictlySorted(value.paths);
}

function precedenceEntry(value) {
  return exactRecord(value, ['from_task_id', 'to_task_id', 'reason'])
    && isTodoIdentifier(value.from_task_id) && isTodoIdentifier(value.to_task_id)
    && value.from_task_id !== value.to_task_id && boundedText(value.reason);
}

function unknownEntry(value) {
  return exactRecord(value, ['task_id', 'kind', 'ref'])
    && isTodoIdentifier(value.task_id) && isTodoIdentifier(value.kind) && boundedText(value.ref);
}

function waveEntry(value) {
  return exactRecord(value, ['task_ids'])
    && Array.isArray(value.task_ids) && value.task_ids.length >= 1
    && value.task_ids.length <= TODO_INDEPENDENCE_TASK_LIMIT
    && value.task_ids.every(isTodoIdentifier) && strictlySorted(value.task_ids);
}

function wavePlan(value, taskIds) {
  if (value === null) return true;
  if (!exactRecord(value, ['waves', 'minimum_feasible_waves'])
    || !boundedList(value.waves, waveEntry, TODO_INDEPENDENCE_TASK_LIMIT)
    || !isNonNegativeSafeInteger(value.minimum_feasible_waves)
    || value.waves.length !== value.minimum_feasible_waves) return false;
  const scheduled = value.waves.flatMap((wave) => wave.task_ids).sort(compareText);
  return scheduled.length === taskIds.length
    && scheduled.every((taskId, index) => taskId === taskIds[index]);
}

/**
 * `lattice.todo_independence.v3`。
 *
 * conflict／precedence／unknownはnormalized boundary graphから採る（ADR 0127 Decision 4）。
 * conflictは`conflict_resources`のresource idを参照し、kindとnormalized targetを一度だけ保持する。
 * `task_boundaries`はtask別の宣言境界で、鮮度のdiff交差判定をartifactだけで閉じるために持つ。
 * `wave_plan`はschedulability compileが`compiled`を返した時だけ持ち、unknownが残る間はnullになる。
 * verdictに現れないペアをverified独立と読めるのは、両taskにunknownが無いときだけである。
 */
export function validateTodoIndependence(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'topology_digest', 'base_sha',
      'witness_set_digest', 'compiled_at', 'task_ids', 'task_boundaries', 'conflict_resources', 'conflicts',
      'precedences', 'unknowns', 'wave_plan', 'scope_expanded', 'outcome', 'result_digest',
    ])) return false;
    if (value.schema !== TODO_INDEPENDENCE_SCHEMA) return false;
    if (!isTodoIdentifier(value.project_id) || !isTodoIdentifier(value.plan_key)
      || !isTodoIdentifier(value.plan_version)) return false;
    if (!isTodoDigest(value.topology_digest) || !isGitSha(value.base_sha)
      || !isTodoDigest(value.witness_set_digest)
      || !isStrictTodoTimestamp(value.compiled_at)) return false;
    if (!Array.isArray(value.task_ids) || value.task_ids.length < 1
      || value.task_ids.length > TODO_INDEPENDENCE_TASK_LIMIT
      || !value.task_ids.every(isTodoIdentifier) || !strictlySorted(value.task_ids)) return false;
    const known = new Set(value.task_ids);
    // 宣言境界はcompile対象taskとちょうど一対一で対応する。欠けたtaskがあると、
    // そのtaskだけ交差判定ができないのに全体はverifiedを名乗れてしまう。
    if (!boundedList(value.task_boundaries, taskBoundaryEntry, TODO_INDEPENDENCE_TASK_LIMIT)
      || value.task_boundaries.length !== value.task_ids.length
      || !strictlySorted(value.task_boundaries, (entry) => entry.task_id)
      || !value.task_boundaries.every((entry, index) => entry.task_id === value.task_ids[index])) {
      return false;
    }
    // scope_expandedはtask_idsとちょうど一対一。欠けたtaskがあると「膨張していない」と
    // 「まだ見ていない」が同じ顔になる。
    if (!boundedList(value.scope_expanded, scopeExpansionEntry, TODO_INDEPENDENCE_TASK_LIMIT)
      || value.scope_expanded.length !== value.task_ids.length
      || !strictlySorted(value.scope_expanded, (entry) => entry.task_id)
      || !value.scope_expanded.every((entry, index) => entry.task_id === value.task_ids[index])) {
      return false;
    }
    if (!boundedList(value.conflict_resources, conflictResourceEntry)
      || !strictlySorted(value.conflict_resources, (entry) => entry.resource_id)) return false;
    const conflictResourceIds = new Set(value.conflict_resources.map(({ resource_id: id }) => id));
    if (!boundedList(value.conflicts, conflictEntry)
      || !value.conflicts.every((entry) => entry.task_ids.every((taskId) => known.has(taskId)))
      || !value.conflicts.every((entry) => conflictResourceIds.has(entry.resource_id))
      || !strictlySorted(value.conflicts, (entry) => (
        `${entry.task_ids[0]}\0${entry.task_ids[1]}\0${entry.resource_id}`))) return false;
    const referencedResourceIds = new Set(value.conflicts.map(({ resource_id: id }) => id));
    if (referencedResourceIds.size !== value.conflict_resources.length) return false;
    if (!boundedList(value.precedences, precedenceEntry)
      || !value.precedences.every((entry) => known.has(entry.from_task_id) && known.has(entry.to_task_id))
      || !strictlySorted(value.precedences, (entry) => (
        `${entry.from_task_id}\0${entry.to_task_id}\0${entry.reason}`))) return false;
    if (!boundedList(value.unknowns, unknownEntry)
      || !value.unknowns.every((entry) => known.has(entry.task_id))
      || !sorted(value.unknowns, (entry) => (
        `${entry.task_id}\0${entry.kind}\0${entry.ref}`))) return false;
    if (!['compiled', 'unknown'].includes(value.outcome)) return false;
    // unknownが残る限りwave planは主張しない。compiledならunknownは空でなければならない。
    if (value.outcome === 'compiled' && value.unknowns.length > 0) return false;
    if (value.outcome === 'unknown' && value.wave_plan !== null) return false;
    if (!wavePlan(value.wave_plan, value.task_ids)) return false;
    return isTodoDigest(value.result_digest)
      && value.result_digest === todoSelfDigest(value, 'result_digest');
  } catch {
    return false;
  }
}

function groupEntry(value) {
  return exactRecord(value, ['task_ids'])
    && Array.isArray(value.task_ids) && value.task_ids.length >= 1
    && value.task_ids.length <= TODO_INDEPENDENCE_TASK_LIMIT
    && value.task_ids.every(isTodoIdentifier) && strictlySorted(value.task_ids);
}

function pairKindAndSeverability(value) {
  // conflictはkindを持ちseverabilityがそこから導かれる。precedenceは順序制約であって
  // resource起因ではないためkindを持たず、常にserialになる。
  if (value.type === 'conflict') {
    return TODO_INDEPENDENCE_CONFLICT_KINDS.includes(value.kind)
      && value.severability === severabilityOfConflictKind(value.kind);
  }
  return value.kind === null && value.severability === 'serial';
}

function serializeEntry(value) {
  return exactRecord(value, ['task_ids', 'type', 'detail', 'kind', 'severability'])
    && Array.isArray(value.task_ids) && value.task_ids.length === 2
    && value.task_ids.every(isTodoIdentifier)
    && compareText(value.task_ids[0], value.task_ids[1]) < 0
    && ['conflict', 'precedence'].includes(value.type) && boundedText(value.detail)
    && pairKindAndSeverability(value);
}

/**
 * 着手候補と進行中ToDoの競合。
 *
 * v1は両端がready集合のペアだけを採っており、片端がactiveのペアを黙って捨てていた。
 * 着手する瞬間に最も危ないのはこの組み合わせなので、独立した面として持つ（ADR 0128 Decision 3）。
 */
function activeConflictEntry(value) {
  return exactRecord(value, [
    'ready_task_id', 'active_task_id', 'type', 'detail', 'kind', 'severability',
  ]) && isTodoIdentifier(value.ready_task_id) && isTodoIdentifier(value.active_task_id)
    && value.ready_task_id !== value.active_task_id
    && ['conflict', 'precedence'].includes(value.type) && boundedText(value.detail)
    && pairKindAndSeverability(value);
}

/**
 * 案内。単一正本のcatalogが返した形をそのまま載せる（ADR 0130 Decision 1・2）。
 * 面ごとに文言を組み立て直さないため、ここではshapeだけを検査する。
 */
// next_actionは実在コマンド（`lattice ...`）か'none'（a19）。
const commandOrNone = (value) => value === 'none' || (boundedText(value) && value.startsWith('lattice '));

function guidanceEntry(value) {
  return exactRecord(value, ['code', 'message', 'next_action'])
    && TODO_INDEPENDENCE_GUIDANCE_CODES.includes(value.code)
    && boundedText(value.message) && commandOrNone(value.next_action);
}

/**
 * 鮮度の内訳。`coverage`がsha水準の事実を述べるのに対し、こちらは
 * 「そのdiffが宣言境界に触れたか」というtask単位の事実を述べる（ADR 0128 Decision 4）。
 */
function driftEntry(value) {
  if (value === null) return true;
  return exactRecord(value, ['base_reachable', 'changed_path_count', 'intersecting_task_ids'])
    && typeof value.base_reachable === 'boolean'
    && isNonNegativeSafeInteger(value.changed_path_count)
    && Array.isArray(value.intersecting_task_ids)
    && value.intersecting_task_ids.length <= TODO_INDEPENDENCE_TASK_LIMIT
    && value.intersecting_task_ids.every(isTodoIdentifier)
    && strictlySorted(value.intersecting_task_ids);
}

function unknownTaskEntry(value) {
  return exactRecord(value, ['task_id', 'unknowns'])
    && isTodoIdentifier(value.task_id)
    && Array.isArray(value.unknowns) && value.unknowns.length >= 1
    && value.unknowns.length <= TODO_INDEPENDENCE_LIST_LIMIT
    && value.unknowns.every((entry) => exactRecord(entry, ['kind', 'ref'])
      && isTodoIdentifier(entry.kind) && boundedText(entry.ref));
}

/**
 * `lattice.todo_independence_projection.v2`。
 *
 * ready frontierを「検証済み並列グループ」「直列化すべき組」「未検査」へ分けた読み出し面。
 * v2は進行中ToDoとの競合（`conflicts_with_active`）と鮮度の内訳（`drift`）を加える。
 * `todo_status_result`と`dispatch_frontier`は変更せず、加算の別面として持つ（ADR 0124の規律）。
 */
export function validateTodoIndependenceProjection(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'coverage', 'compiled_base_sha', 'current_base_sha',
      'plan_version', 'topology_digest', 'active_task_ids', 'uncovered_active_task_ids',
      'drift', 'guidance', 'frontier', 'result_digest',
    ])) return false;
    if (value.schema !== TODO_INDEPENDENCE_PROJECTION_SCHEMA) return false;
    if (!isTodoIdentifier(value.project_id)) return false;
    if (value.plan_key !== null && !isTodoIdentifier(value.plan_key)) return false;
    if (!TODO_INDEPENDENCE_COVERAGE.includes(value.coverage)) return false;
    if (value.compiled_base_sha !== null && !isGitSha(value.compiled_base_sha)) return false;
    if (!isGitSha(value.current_base_sha)) return false;
    if (value.plan_version !== null && !isTodoIdentifier(value.plan_version)) return false;
    if (value.topology_digest !== null && !isTodoDigest(value.topology_digest)) return false;
    // 記録が無い状態でcompile済みidentityを名乗らない。
    if (value.coverage === 'missing'
      && (value.compiled_base_sha !== null || value.topology_digest !== null)) return false;
    if (['verified', 'stale'].includes(value.coverage) && value.compiled_base_sha === null) return false;
    if (value.coverage === 'superseded' && value.compiled_base_sha === null
      && (value.plan_version !== null || value.topology_digest !== null)) return false;
    for (const key of ['active_task_ids', 'uncovered_active_task_ids']) {
      if (!Array.isArray(value[key]) || value[key].length > TODO_INDEPENDENCE_TASK_LIMIT
        || !value[key].every(isTodoIdentifier) || !strictlySorted(value[key])) return false;
    }
    // 宣言のないactiveは考慮済みactiveの部分集合でなければならない。
    const activeSet = new Set(value.active_task_ids);
    if (!value.uncovered_active_task_ids.every((taskId) => activeSet.has(taskId))) return false;
    if (!driftEntry(value.drift)) return false;
    if (!guidanceEntry(value.guidance)) return false;
    // driftはstale時の内訳。それ以外で語ると鮮度の事実を二重に主張することになる。
    if (value.coverage !== 'stale' && value.drift !== null) return false;
    if (!exactRecord(value.frontier, [
      'parallel_groups', 'serialize_pairs', 'conflicts_with_active', 'unknown',
    ])) return false;
    if (!boundedList(value.frontier.parallel_groups, groupEntry, TODO_INDEPENDENCE_TASK_LIMIT)
      || !strictlySorted(value.frontier.parallel_groups, (entry) => entry.task_ids[0])) return false;
    if (!boundedList(value.frontier.serialize_pairs, serializeEntry)
      || !strictlySorted(value.frontier.serialize_pairs, (entry) => (
        `${entry.task_ids[0]}\0${entry.task_ids[1]}\0${entry.type}\0${entry.detail}`))) return false;
    if (!boundedList(value.frontier.conflicts_with_active, activeConflictEntry)
      || !strictlySorted(value.frontier.conflicts_with_active, (entry) => (
        `${entry.ready_task_id}\0${entry.active_task_id}\0${entry.type}\0${entry.detail}`))) {
      return false;
    }
    if (!boundedList(value.frontier.unknown, unknownTaskEntry, TODO_INDEPENDENCE_TASK_LIMIT)
      || !strictlySorted(value.frontier.unknown, (entry) => entry.task_id)) return false;
    return isTodoDigest(value.result_digest)
      && value.result_digest === todoSelfDigest(value, 'result_digest');
  } catch {
    return false;
  }
}
