/**
 * 宣言を書くための道具（AGENTS.md「装置の境界」）。
 *
 * 推定はしない。何を所有し、係争資源の中で何を触るかはAIが決める——Latticeを操作するAIは装置の
 * 一部であり、そこへ同じ能力を二重化しない。ここが供給するのは、AIには作れないものだけである。
 *
 * - `affected_tests`のfresh観測。宣言と観測はbinding単位でexact比較されるので、手で当てると外れる。
 * - `sensor_query_set`と`sensor_provenance`の配線。宣言と観測の裏付けが別の資源を指す事故を防ぐ。
 * - canonical bytesと自己digest。非canonicalな宣言は独立性判定を通ってseam提案でだけ落ちる。
 *
 * この3つは2026-07-27の作業で実際に踏んだ摩擦であり、道具が無いと毎回踏む。
 */

import { canonicalizeTodoArtifact, isTodoIdentifier, isTodoRef, todoSelfDigest } from './todo-contracts.mjs';
import { TODO_WITNESS_SET_SCHEMA } from './todo-independence-contracts.mjs';

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sortedUnique = (values) => [...new Set(values)].sort(compareText);

export const WITNESS_DRAFT_SCHEMA = 'lattice.todo_witness_draft.v1';
/** 創作宣言を書ける版。v1はstringのownsだけを受け、`creates`を表現できない。 */
export const WITNESS_DRAFT_SCHEMA_V2 = 'lattice.todo_witness_draft.v2';
const DRAFT_SCHEMAS = Object.freeze([WITNESS_DRAFT_SCHEMA, WITNESS_DRAFT_SCHEMA_V2]);

/**
 * ownsの1件を正規化する。
 *
 * v2では`{ path, creates: true }`を書ける。まだ存在しないpathを所有するToDo——新module・
 * 新doc・新testの追加——は、これが無いと道具で宣言を作れない（ADR 0136）。
 */
function ownEntry(value, { allowCreates }) {
  if (typeof value === 'string') return isTodoRef(value) ? { target: value, creates: false } : null;
  if (!allowCreates || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'creates' || keys[1] !== 'path') return null;
  if (!isTodoRef(value.path) || value.creates !== true) return null;
  // prefix形（末尾/）はaffectedがunresolvedを返すので、file単位に限る（ADR 0136）。
  if (value.path.endsWith('/')) return null;
  return { target: value.path, creates: true };
}

/** 下書きの1 taskが宣言する所有を正規化する。1件でも形が壊れていればnull。 */
export function draftOwnEntries(task, schema) {
  const allowCreates = schema === WITNESS_DRAFT_SCHEMA_V2;
  if (!Array.isArray(task?.owns)) return null;
  const entries = task.owns.map((own) => ownEntry(own, { allowCreates }));
  return entries.some((entry) => entry === null) ? null : entries;
}

function reject(reasons) {
  return { witnessSet: null, queries: [], reasons: sortedUnique(reasons) };
}

const DRAFT_TOP_LEVEL_KEYS = Object.freeze(['schema', 'project_id', 'plan_key', 'capacity', 'tasks']);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refList = (value) => value === undefined || (Array.isArray(value) && value.every(isTodoRef));

/** 1 taskの下書きの最初の違反（相対path）、無ければnull。validateWitnessDraftと同じ規則。 */
function explainDraftTask(task, schema) {
  if (!plainObject(task)) return { reason: 'not_an_object', path: '' };
  if (draftOwnEntries(task, schema) === null) return { reason: 'invalid_owns', path: '/owns' };
  for (const key of ['reads', 'writes']) {
    if (!refList(task[key])) return { reason: 'invalid_repo_relative_paths', path: `/${key}` };
  }
  if (task.unknowns !== undefined && !(Array.isArray(task.unknowns) && task.unknowns.every((entry) => plainObject(entry)
    && isTodoIdentifier(entry.kind) && typeof entry.ref === 'string' && entry.ref.length > 0))) {
    return { reason: 'invalid_unknowns', path: '/unknowns' };
  }
  if (task.concern_anchors !== undefined && !(Array.isArray(task.concern_anchors)
    && task.concern_anchors.every((anchor) => plainObject(anchor) && isTodoRef(anchor.within)
      && Array.isArray(anchor.symbols) && anchor.symbols.length > 0 && anchor.symbols.every(isTodoIdentifier)))) {
    return { reason: 'invalid_concern_anchors', path: '/concern_anchors' };
  }
  return null;
}

/**
 * 下書きの形。AIが書く欄だけを持ち、観測で埋まる欄は持たない。
 * a32: 拒否は最初に落ちた欄（JSON pointer）と理由、topの欠けたkeyを名指す。
 */
export function explainWitnessDraft(value) {
  const reject = (reason, at, extra = {}) => ({ valid: false, reason, path: at, ...extra });
  if (!plainObject(value)) return reject('not_an_object', '/');
  const missing = DRAFT_TOP_LEVEL_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) return reject('missing_top_level_keys', '/', { missing_keys: missing });
  if (!DRAFT_SCHEMAS.includes(value.schema)) return reject('schema_mismatch', '/schema', { expected: DRAFT_SCHEMAS });
  if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
  if (!isTodoIdentifier(value.plan_key)) return reject('invalid_identifier', '/plan_key');
  if (!plainObject(value.capacity) || !Number.isSafeInteger(value.capacity.executors) || value.capacity.executors < 1) {
    return reject('invalid_capacity', '/capacity/executors');
  }
  if (!plainObject(value.tasks)) return reject('not_an_object', '/tasks');
  const entries = Object.entries(value.tasks);
  if (entries.length === 0) return reject('empty_tasks', '/tasks');
  for (const [taskId, task] of entries) {
    if (!isTodoIdentifier(taskId)) return reject('invalid_identifier', `/tasks/${taskId}`);
    const failure = explainDraftTask(task, value.schema);
    if (failure !== null) return reject(failure.reason, `/tasks/${taskId}${failure.path}`);
  }
  return { valid: true };
}

export function validateWitnessDraft(value) {
  return explainWitnessDraft(value).valid;
}

/** a32: the starting draft for a plan: every task still to do, with nothing declared yet. */
export function witnessDraftTemplate({ projectId, planKey, taskIds }) {
  return {
    schema: WITNESS_DRAFT_SCHEMA_V2, project_id: projectId, plan_key: planKey, capacity: { executors: 1 },
    tasks: Object.fromEntries([...taskIds].sort(compareText).map((taskId) => [taskId, { owns: [], reads: [], writes: [] }])),
  };
}

function queryIdFor(index) {
  return `witness-affected-${String(index).padStart(3, '0')}`;
}

/** 下書きから、観測に要るquery setを組む。所有pathごとに1つのaffected queryを引く。 */
export function buildWitnessObservationQuerySet(draft) {
  const paths = sortedUnique(Object.values(draft.tasks)
    .flatMap((task) => (draftOwnEntries(task, draft.schema) ?? []).map(({ target }) => target)));
  return {
    queries: [
      { id: 'witness-status', operation: 'status' },
      ...paths.map((target, index) => ({
        id: queryIdFor(index), operation: 'affected', target,
      })),
    ],
    paths,
  };
}

/**
 * 下書きと観測から、そのまま通るwitness setを組む。
 *
 * @param {object} options
 * @param {object} options.draft `lattice.todo_witness_draft.v1`
 * @param {object} options.observationByPath 所有pathごとのfresh観測
 *   `{ state: 'absent'|'present', affectedTests: string[], changedFiles: string[] }`。
 *   観測できていないpathは**欄そのものを置かない**——空で置くと不在と区別できない。
 */
export function buildWitnessSet({ draft, observationByPath } = {}) {
  if (!validateWitnessDraft(draft)) return reject(['draft_invalid']);
  const { paths } = buildWitnessObservationQuerySet(draft);
  const queryIdByPath = new Map(paths.map((target, index) => [target, queryIdFor(index)]));

  const reasons = [];
  const manualWitness = {};
  for (const [taskId, task] of Object.entries(draft.tasks).sort(([left], [right]) => compareText(left, right))) {
    const entries = draftOwnEntries(task, draft.schema) ?? [];
    const owns = [...new Map(entries.map((entry) => [entry.target, entry])).values()]
      .sort((left, right) => compareText(left.target, right.target));
    const writeTargets = sortedUnique([
      ...owns.map(({ target }) => target),
      ...(Array.isArray(task.writes) ? task.writes : []),
    ]);
    const declaredTargets = new Set(writeTargets);
    const affected = sortedUnique(owns.flatMap(({ target }) => (
      observationByPath?.[target]?.affectedTests ?? []
    )));
    for (const anchor of task.concern_anchors ?? []) {
      // `within`はownsまたはwritesが指す資源に限る。
      if (!declaredTargets.has(anchor.within)) {
        reasons.push(`anchor_outside_owned:${taskId}:${anchor.within}`);
      }
    }
    manualWitness[taskId] = {
      owns: owns.map(({ target, creates }) => (
        creates ? { kind: 'path', target, creates: true } : { kind: 'path', target }
      )),
      reads: sortedUnique(task.reads ?? []),
      writes: writeTargets,
      resources: [],
      state_effects: [],
      sensor_provenance: {
        queries: owns.map(({ target }) => ({
          query_id: queryIdByPath.get(target), expect: { kind: 'affected', path: target },
        })),
      },
      affected_tests: affected,
      // 明示unknownは下書きが持つ。観測で埋まる欄ではなく、書き手が「ここは確定していない」と
      // 述べる欄なので、道具が発明も削除もしない。
      unknowns: [...(task.unknowns ?? [])]
        .map(({ kind, ref }) => ({ kind, ref }))
        .sort((left, right) => compareText(`${left.kind}\u0000${left.ref}`, `${right.kind}\u0000${right.ref}`)),
      ...(Array.isArray(task.concern_anchors) && task.concern_anchors.length > 0
        ? {
          concern_anchors: [...task.concern_anchors]
            .map((anchor) => ({
              within: { kind: 'path', target: anchor.within },
              symbols: sortedUnique(anchor.symbols),
            }))
            .sort((left, right) => compareText(left.within.target, right.within.target)),
        }
        : {}),
    };
  }
  if (reasons.length > 0) return reject(reasons);

  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: draft.project_id,
    plan_key: draft.plan_key,
    capacity: { executors: draft.capacity.executors },
    sensor_query_set: {
      queries: [
        ...paths.map((target) => ({
          id: queryIdByPath.get(target), operation: 'affected', target,
        })),
        { id: 'witness-status', operation: 'status' },
      ].sort((left, right) => compareText(left.id, right.id)),
    },
    manual_witness: manualWitness,
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  return { witnessSet, reasons: [] };
}

/** storeへ置くbytes。canonical＋末尾LFでないと、判定は通るのにseam提案で落ちる。 */
export function serializeWitnessSet(witnessSet) {
  return `${canonicalizeTodoArtifact(witnessSet)}\n`;
}
