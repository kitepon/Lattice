import { createHash } from 'node:crypto';

import { digestArtifact } from './artifact-contracts.mjs';
import { compileBoundaryObservationV2 } from './boundary-observation-compiler-v2.mjs';
import { portableSensorOutcome } from './sensor-adapter.mjs';
import { compileSchedulabilityGraphV2 } from './schedulability-compiler-v2.mjs';
import { verifySchedulabilityPlanV2 } from './schedulability-verifier-v2.mjs';
import {
  BOUNDARY_MANIFEST_SCHEMA,
  RUN_REQUEST_PREDICTION_SCHEMA,
  RUN_REQUEST_SCHEMA,
  SENSOR_EXPECT_KINDS,
  SENSOR_QUERY_OPERATIONS,
  selfDigest,
  validateRunRequest,
  validateRuntimeBoundaryManifest,
  validateRuntimePlan,
  verifyRuntimePlanBinding,
} from './runtime-contracts.mjs';

/**
 * RC3-D generic front-end（ADR 0044 Decision 2・8、plan RC3-D）。
 *
 * `lattice.run_request.v1`のmanual witnessとfresh LatticeSensor観測evidenceから、
 * fixture名・期待conflict・期待waveの分岐なしに`lattice.runtime_plan.v1`と
 * TODOごとの`lattice.boundary_manifest.v2`をcompileする。
 *
 * adapter契約（witness.sensor_provenance、RC3-Dで固定）:
 *   { queries: [{ query_id, expect }] }
 *   expect = { kind: 'symbol', name, path } — query outcomeにnode.name/filePathの
 *            exact一致がちょうど1件あることを要求（fuzzy解決の誤読防止）
 *          | { kind: 'path', path }       — outcomeにfilePath exact一致が1件以上
 *          | { kind: 'affected', path }   — affected outcomeのchangedFilesが[path]と
 *            exact一致し、affectedTestsがwitness.affected_testsとexact一致
 *
 * typed non-dispatchable（dispatchable planを発行しない、fail closed）:
 *   NODE_LIMIT_EXCEEDED / BOUNDARY_UNKNOWN / SEARCH_BUDGET_EXHAUSTED /
 *   QUERY_DRIFT / AFFECTED_TEST_DRIFT
 *
 * LatticeSensor raw telemetryはevidence captureに留め、plan・manifest identityへは
 * portable outcome projectionのcanonical digestだけを入れる（Decision 10.4）。
 */

// 閉集合の正本はruntime-contracts。ここでは輸入して使う。
const QUERY_OPERATIONS = SENSOR_QUERY_OPERATIONS;
const STRUCTURE_OPERATIONS = new Set(['query', 'callers', 'callees', 'impact']);
const EXPECT_KINDS = new Set(SENSOR_EXPECT_KINDS);
const IDENTIFIER = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;
const STATE_KIND_MAP = Object.freeze({
  state: 'state',
  schema: 'state',
  invariant: 'state',
  effect: 'effect',
  external_effect: 'effect',
});

export const RUNTIME_NON_DISPATCHABLE_CODES = Object.freeze([
  'NODE_LIMIT_EXCEEDED',
  'BOUNDARY_UNKNOWN',
  'SEARCH_BUDGET_EXHAUSTED',
  'QUERY_DRIFT',
  'AFFECTED_TEST_DRIFT',
]);

function fail(reason) {
  throw new TypeError(`runtime front-end契約違反: ${reason}`);
}

function plainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * repo相対pathだけを受理する（runtime-contracts.mjsと同じ規律、Decision 2・10.4）。
 * absolute path・`..`・空segment・制御文字・`\`をmanifest／plan identityへ混入させない。
 */
function repoRelativePath(value, { allowPrefix = false } = {}) {
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 1_024
    || CONTROL_CHARACTER.test(value)
    || value.includes('\\')
    || value.startsWith('/')) {
    return false;
  }
  const isPrefix = value.endsWith('/');
  if (isPrefix && !allowPrefix) return false;
  const body = isPrefix ? value.slice(0, -1) : value;
  return body.split('/').every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  ));
}

function sha16(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nonDispatchable(code, detail) {
  if (!RUNTIME_NON_DISPATCHABLE_CODES.includes(code)) fail(`未知のnon-dispatchable code: ${code}`);
  return { outcome: 'non_dispatchable', code, detail };
}

/** query set（run_request.sensor_query_set）のexact shapeを検査する。 */
function normalizeQuerySet(querySet) {
  if (!exactRecord(querySet, ['queries'])) fail('sensor_query_set shapeが不正');
  if (!Array.isArray(querySet.queries)) fail('sensor_query_set.queriesがarrayではない');
  const byId = new Map();
  for (const query of querySet.queries) {
    const keys = Object.hasOwn(query ?? {}, 'target')
      ? ['id', 'operation', 'target']
      : ['id', 'operation'];
    if (!exactRecord(query, keys)
      || !identifier(query.id)
      || !QUERY_OPERATIONS.includes(query.operation)
      || (keys.includes('target') && (typeof query.target !== 'string' || query.target.length === 0))) {
      fail('query set entry shapeが不正');
    }
    if (byId.has(query.id)) fail(`query idが重複している: ${query.id}`);
    byId.set(query.id, query);
  }
  return byId;
}

/**
 * captureされたevidenceをquery setとexact整合させ、portable projectionへ分離する。
 * evidence = { outcomes: [{ query_id, operation, status, raw }] }（query set順）
 */
function normalizeEvidence(evidence, queryById) {
  if (!exactRecord(evidence, ['outcomes'])) fail('sensor evidence shapeが不正');
  if (!Array.isArray(evidence.outcomes)) fail('evidence.outcomesがarrayではない');
  if (evidence.outcomes.length !== queryById.size) {
    fail(`evidence件数(${evidence.outcomes.length})がquery set件数(${queryById.size})と一致しない`);
  }
  const queries = [...queryById.values()];
  const byQueryId = new Map();
  evidence.outcomes.forEach((outcome, index) => {
    if (!exactRecord(outcome, ['query_id', 'operation', 'status', 'raw'])) {
      fail('evidence outcome shapeが不正');
    }
    const query = queries[index];
    if (outcome.query_id !== query.id || outcome.operation !== query.operation) {
      fail(`evidence outcomeがquery setと順序整合しない: ${outcome.query_id}`);
    }
    if (typeof outcome.status !== 'string' || outcome.status.length === 0) {
      fail('evidence outcome statusが不正');
    }
    const portable = portableSensorOutcome(outcome.raw);
    byQueryId.set(outcome.query_id, {
      query_id: outcome.query_id,
      operation: outcome.operation,
      status: outcome.status,
      raw: outcome.raw,
      portable,
      portable_digest: digestArtifact({
        query_id: outcome.query_id,
        operation: outcome.operation,
        status: outcome.status,
        portable,
      }),
    });
  });
  return byQueryId;
}

function normalizeProvenanceQueries(witness, todoId) {
  const provenance = witness.sensor_provenance;
  if (!exactRecord(provenance, ['queries']) || !Array.isArray(provenance.queries)) {
    fail(`witness ${todoId}.sensor_provenance shapeが不正`);
  }
  return provenance.queries.map((entry) => {
    if (!exactRecord(entry, ['query_id', 'expect']) || !identifier(entry.query_id)) {
      fail(`witness ${todoId}.sensor_provenance entry shapeが不正`);
    }
    const expect = entry.expect;
    if (!plainRecord(expect) || !EXPECT_KINDS.has(expect.kind)) {
      fail(`witness ${todoId}.expect shapeが不正`);
    }
    if (expect.kind === 'symbol') {
      if (!exactRecord(expect, ['kind', 'name', 'path'])
        || typeof expect.name !== 'string' || expect.name.length === 0
        || !repoRelativePath(expect.path)) {
        fail(`witness ${todoId}.symbol expectが不正`);
      }
    } else if (!exactRecord(expect, ['kind', 'path']) || !repoRelativePath(expect.path)) {
      fail(`witness ${todoId}.${expect.kind} expectが不正`);
    }
    return { query_id: entry.query_id, expect };
  });
}

const STRUCTURE_EXPECT_OPERATIONS = new Set(['query', 'callers', 'callees', 'impact']);

/**
 * witness expectとquery set entryのcross-binding（別targetのreceiptへの再ラベル防止）。
 * 不一致はQUERY_DRIFT。
 */
function bindingMatchesQuery(binding, query) {
  const { expect } = binding;
  if (expect.kind === 'affected') {
    return query.operation === 'affected' && query.target === expect.path;
  }
  if (expect.kind === 'symbol') {
    return STRUCTURE_EXPECT_OPERATIONS.has(query.operation) && query.target === expect.name;
  }
  return (STRUCTURE_EXPECT_OPERATIONS.has(query.operation) || query.operation === 'affected')
    && query.target === expect.path;
}

/** raw outcome（`{operation, data}`包み、RC2 evidence互換）のpayloadを取り出す。 */
function rawPayload(raw) {
  return plainRecord(raw) && Object.hasOwn(raw, 'data') ? raw.data : raw;
}

/**
 * affected outcomeのpayloadを取り出す。lattice-sensor-adapterのper-target形
 * （`{targets: [{target, outcome, data}]}`）と直接data形の両方を受ける。
 */
function affectedPayload(raw, expectPath) {
  if (plainRecord(raw) && Array.isArray(raw.targets)) {
    const entry = raw.targets.find((candidate) => (
      plainRecord(candidate) && candidate.target === expectPath
    ));
    return plainRecord(entry) && plainRecord(entry.data) ? entry.data : null;
  }
  const payload = rawPayload(raw);
  return plainRecord(payload) ? payload : null;
}

/**
 * 収集済みsensor evidenceから、あるpathのaffected testを読む。
 *
 * 実行時の翻訳段（宣言を観測へ合わせる）が同じ観測を必要とする。payloadの形の解釈をあちらへ
 * 書き直すと、driftを判定する規則と、driftを起こさない宣言を作る規則が別々に育つ。
 *
 * @returns {string[]|null} 観測できなければnull（空配列と区別する）
 */
export function affectedTestsFromEvidence({ sensorEvidence, querySet, path: target } = {}) {
  const queries = (querySet?.queries ?? [])
    .filter((query) => query.operation === 'affected' && query.target === target);
  if (queries.length !== 1) return null;
  const outcome = (sensorEvidence?.outcomes ?? [])
    .find((entry) => entry.query_id === queries[0].id);
  if (!plainRecord(outcome) || outcome.status !== 'ready') return null;
  const payload = affectedPayload(outcome.raw, target);
  return Array.isArray(payload?.affectedTests) ? [...payload.affectedTests].sort(compareText) : null;
}

function affectedTarget(raw, expectPath) {
  if (!plainRecord(raw) || !Array.isArray(raw.targets)) return null;
  const entry = raw.targets.find((candidate) => (
    plainRecord(candidate) && candidate.target === expectPath
  ));
  return plainRecord(entry) ? entry : null;
}

function rawEntries(raw) {
  const payload = rawPayload(raw);
  return Array.isArray(payload) ? payload : null;
}

function entryNode(entry) {
  if (plainRecord(entry) && plainRecord(entry.node)) return entry.node;
  if (plainRecord(entry)) return entry;
  return null;
}

/**
 * 創作宣言されたpathの裏付けを決める（ADR 0136）。
 *
 * 宣言と観測が一致する時だけ`ready`にする。fresh absentは推測ではなくfsのlstat結果なので、
 * 「観測できなかった」ではなく「観測して、無かった」である。存在しないfileに依存するものは
 * 構造的に存在しえないため、affected testが空であることまで確かめれば裏付けは閉じる。
 *
 * 既に存在するpathへ創作を宣言していたら`creates_path_present`で止める。実害は無いが、
 * 宣言が実態からずれているのを黙って通すと、宣言と観測が一致しているという前提が崩れる。
 * 宣言していないabsent pathは従来どおり`path_absent`のままにする——綴り違いを
 * 「黙って通る創作境界」にしないための線である。
 */
function creationBoundaryStatus(outcome, expectPath) {
  // sensorが答えられていない状況は、この関数の管轄でない。通常のstatus判定へ返す。
  if (!['ready', 'empty'].includes(outcome.status)) return null;
  const target = affectedTarget(outcome.raw, expectPath);
  // fs観測が記録に無いなら、不存在は確かめられていない。宣言だけで裏付けにしない。
  if (target === null || target === undefined) return 'creates_unverified';
  if (target.path_state !== 'absent') return 'creates_path_present';
  const payload = affectedPayload(outcome.raw, expectPath);
  if (payload === null
    || !Array.isArray(payload.changedFiles)
    || payload.changedFiles.length !== 1
    || payload.changedFiles[0] !== expectPath
    || !Array.isArray(payload.affectedTests)
    || payload.affectedTests.length !== 0) return 'creates_unverified';
  return 'ready';
}

/**
 * 束縛queryのoutcomeへexpectをexact照合し、sensor statusを決める。
 * fuzzy解決・空結果は依存なしへ丸めず、unknown系statusへ落とす（AGENTS.md）。
 */
function resolveBindingStatus(binding, outcome) {
  if (binding.expect.kind === 'affected' && binding.creates === true) {
    const declared = creationBoundaryStatus(outcome, binding.expect.path);
    if (declared !== null) return declared;
  }
  if (outcome.status !== 'ready') return outcome.status;
  const { expect } = binding;
  if (expect.kind === 'affected') {
    if (affectedTarget(outcome.raw, expect.path)?.path_state === 'absent') return 'path_absent';
    const payload = affectedPayload(outcome.raw, expect.path);
    if (payload === null
      || !Array.isArray(payload.changedFiles)
      || payload.changedFiles.length !== 1
      || payload.changedFiles[0] !== expect.path) {
      return 'empty';
    }
    return 'ready';
  }
  const entries = rawEntries(outcome.raw);
  if (entries === null) return 'invalid_json';
  if (expect.kind === 'symbol') {
    const matches = entries.filter((entry) => {
      const node = entryNode(entry);
      return node !== null && node.name === expect.name && node.filePath === expect.path;
    });
    if (matches.length === 1) return 'ready';
    return matches.length === 0 ? 'symbol_absent' : 'unresolved';
  }
  const matches = entries.filter((entry) => {
    const node = entryNode(entry);
    return node !== null && node.filePath === expect.path;
  });
  return matches.length >= 1 ? 'ready' : 'empty';
}

function bindingCoversOwn(binding, own) {
  if (own.kind === 'symbol') {
    return binding.expect.kind === 'symbol' && binding.expect.name === own.target;
  }
  return (binding.expect.kind === 'path' || binding.expect.kind === 'affected')
    && binding.expect.path === own.target;
}

function pathPrefixOverlap(left, right) {
  const leftIsPrefix = left.endsWith('/');
  const rightIsPrefix = right.endsWith('/');
  if (left === right) return true;
  if (leftIsPrefix && (right === left.slice(0, -1) || right.startsWith(left))) return true;
  if (rightIsPrefix && (left === right.slice(0, -1) || left.startsWith(right))) return true;
  return false;
}

function manualProvenance(request) {
  return {
    source: 'manual_state_effect',
    evidence_ref: `run-request:${request.request_id}`,
    evidence_digest: request.request_digest,
    status: 'asserted',
  };
}

function candidateProvenance(request) {
  return {
    source: 'manual_candidate_spec',
    evidence_ref: `run-request:${request.request_id}`,
    evidence_digest: request.request_digest,
    status: 'asserted',
  };
}

/**
 * `collectSensorEvidence`のraw収集結果を、query set順へexact整合した
 * front-end evidence契約（`{outcomes: [{query_id, operation, status, raw}]}`）へ写す。
 * 件数・id・operationの不一致はfail closed。
 */
export function evidenceFromCollectedOutcomes(options = {}) {
  if (!exactRecord(options, ['querySet', 'collected'])) {
    fail('evidenceFromCollectedOutcomes optionsがexact shapeでない');
  }
  const { querySet, collected } = options;
  const queryById = normalizeQuerySet(querySet);
  if (!plainRecord(collected) || !Array.isArray(collected.outcomes)) {
    fail('collected evidence shapeが不正');
  }
  if (collected.outcomes.length !== queryById.size) {
    fail(`collected outcomes件数(${collected.outcomes.length})がquery set件数(${queryById.size})と一致しない`);
  }
  const queries = [...queryById.values()];
  return {
    outcomes: collected.outcomes.map((outcome, index) => {
      const query = queries[index];
      if (!plainRecord(outcome)
        || (Object.hasOwn(outcome, 'id') && outcome.id !== query.id)
        || (Object.hasOwn(outcome, 'operation') && outcome.operation !== query.operation)
        || typeof outcome.outcome !== 'string'
        || outcome.outcome.length === 0) {
        fail(`collected outcomeがquery setと整合しない: ${query.id}`);
      }
      return {
        query_id: query.id,
        operation: query.operation,
        status: outcome.outcome,
        raw: outcome,
      };
    }),
  };
}

/**
 * run_requestとsensor evidenceからobservation set・graph・planを一括compileする。
 * 成功時はdispatchable outcome、契約内の識別可能な不成立はtyped non-dispatchable、
 * 入力shape違反はTypeErrorでfail closed。
 */
export function compileRuntimePlanV1(options = {}) {
  if (!exactRecord(options, ['request', 'sensorEvidence', 'planRef', 'planEpoch', 'predecessorRefs'])) {
    fail('compileRuntimePlanV1 optionsがexact shapeでない');
  }
  const { request, sensorEvidence, planRef, planEpoch, predecessorRefs } = options;
  if (!validateRunRequest(request)) fail('run_request.v1がcontractを満たさない');
  if (!identifier(planRef)) fail('planRefがidentifierではない');
  if (!Number.isSafeInteger(planEpoch) || planEpoch < 0) fail('planEpochが不正');
  if (!Array.isArray(predecessorRefs) || !predecessorRefs.every((ref) => typeof ref === 'string')) {
    fail('predecessorRefsがstring arrayではない');
  }

  const queryById = normalizeQuerySet(request.sensor_query_set);
  const outcomeByQueryId = normalizeEvidence(sensorEvidence, queryById);

  const todoIds = request.todos.map((todo) => todo.todo_id);
  const predictionsOnly = [RUN_REQUEST_SCHEMA, RUN_REQUEST_PREDICTION_SCHEMA]
    .includes(request.schema);

  // witnessの束縛を解決する。query set外の参照と、expect↔query targetの
  // 不一致（別targetのreceiptへの再ラベル）はQUERY_DRIFT。
  const bindingsByTodo = new Map();
  const driftDetails = [];
  for (const todoId of todoIds) {
    const witness = request.manual_witness[todoId];
    // 創作宣言はowns側にある。裏付けを決めるのはbindingなので、覆っているbindingへ写す。
    const creating = new Set(witness.owns
      .filter((own) => own.creates === true).map((own) => own.target));
    const bindings = normalizeProvenanceQueries(witness, todoId)
      .map((binding) => (!predictionsOnly && creating.size > 0
        && [...creating].some((target) => bindingCoversOwn(binding, { kind: 'path', target }))
        ? { ...binding, creates: true } : binding));
    for (const binding of bindings) {
      const query = queryById.get(binding.query_id);
      if (query === undefined) {
        driftDetails.push({ todo_id: todoId, query_id: binding.query_id, reason: 'query set外の参照' });
      } else if (!bindingMatchesQuery(binding, query)) {
        driftDetails.push({
          todo_id: todoId,
          query_id: binding.query_id,
          reason: 'expectとquery operation/targetが一致しない',
        });
      }
    }
    bindingsByTodo.set(todoId, bindings);
  }
  if (driftDetails.length > 0) return nonDispatchable('QUERY_DRIFT', { references: driftDetails });

  // status queryは正確に1つ要求し、fresh index規律をここで検査する。
  const statusQueries = [...queryById.values()].filter((query) => query.operation === 'status');
  if (statusQueries.length !== 1) {
    return nonDispatchable('QUERY_DRIFT', {
      references: [{ reason: `status queryが${statusQueries.length}件（正確に1件が必要）` }],
    });
  }
  const statusOutcome = outcomeByQueryId.get(statusQueries[0].id);

  const unknowns = [];
  if (statusOutcome.status !== 'ready') {
    for (const todoId of todoIds) {
      unknowns.push({ todo_id: todoId, kind: `sensor_${statusOutcome.status}`, ref: statusQueries[0].id });
    }
  }

  // 全束縛queryの解決statusを検査する。非readyな構造／affected evidenceは
  // dispatchable planへ丸めず、unknownとしてevidence acquisitionへ送る。
  for (const todoId of todoIds) {
    for (const binding of bindingsByTodo.get(todoId)) {
      const resolved = resolveBindingStatus(binding, outcomeByQueryId.get(binding.query_id));
      if (!predictionsOnly && resolved !== 'ready') {
        unknowns.push({ todo_id: todoId, kind: `sensor_${resolved}`, ref: binding.query_id });
      }
    }
  }

  // affected test drift検査（witness宣言とfresh affected観測のexact比較）。
  //
  // 比較はTODO単位で、そのTODOが持つ**全affected束縛の観測の和**に対して行う。1面しか持たない
  // TODOでは束縛ごとの比較と同じ結果になり、複数面を所有するTODOでも表現できる——束縛ごとに
  // 宣言全体とexact比較すると、affectedの異なる2 pathを所有するTODOは原理的に成立せず、
  // 実行時に所有が広がった宣言を受け取れなくなる。和なので緩みは入らない（余分な宣言も
  // 足りない宣言もdriftのまま）。
  const affectedDrift = [];
  for (const todoId of todoIds) {
    const witness = request.manual_witness[todoId];
    const declared = [...witness.affected_tests].sort(compareText);
    const queryIds = [];
    const observedUnion = new Set();
    let unreadable = false;
    for (const binding of bindingsByTodo.get(todoId)) {
      if (binding.expect.kind !== 'affected') continue;
      const outcome = outcomeByQueryId.get(binding.query_id);
      if (resolveBindingStatus(binding, outcome) !== 'ready') continue;
      queryIds.push(binding.query_id);
      const payload = affectedPayload(outcome.raw, binding.expect.path);
      if (!Array.isArray(payload?.affectedTests)) {
        // 観測が読めないのは「一致しない」とは別の事象である。丸めずそのまま残す。
        affectedDrift.push({ todo_id: todoId, query_id: binding.query_id, declared, observed: null });
        unreadable = true;
        continue;
      }
      for (const test of payload.affectedTests) observedUnion.add(test);
    }
    if (unreadable || queryIds.length === 0) continue;
    const observed = [...observedUnion].sort(compareText);
    if (observed.length !== declared.length
      || observed.some((test, index) => test !== declared[index])) {
      affectedDrift.push({
        todo_id: todoId,
        query_id: queryIds.sort(compareText).join(','),
        declared,
        observed,
      });
    }
  }
  if (!predictionsOnly && affectedDrift.length > 0) {
    return nonDispatchable('AFFECTED_TEST_DRIFT', { mismatches: affectedDrift });
  }

  // owns targetごとの構造的裏付け。covering queryは全witnessを通じて一意でなければならない。
  const ownGroups = new Map();
  const coveringByTarget = new Map();
  const ambiguous = [];
  for (const todoId of todoIds) {
    const witness = request.manual_witness[todoId];
    for (const own of witness.owns) {
      if (own.kind === 'path' && !repoRelativePath(own.target, { allowPrefix: true })) {
        fail(`witness ${todoId}のowns pathがrepo相対規律を満たさない: ${own.target}`);
      }
      const key = `${own.kind} ${own.target}`;
      if (!ownGroups.has(key)) ownGroups.set(key, { own, todoIds: [] });
      ownGroups.get(key).todoIds.push(todoId);
      const covering = bindingsByTodo.get(todoId).filter((binding) => bindingCoversOwn(binding, own));
      for (const binding of covering) {
        const seen = coveringByTarget.get(key);
        if (seen === undefined) {
          coveringByTarget.set(key, binding.query_id);
        } else if (seen !== binding.query_id) {
          ambiguous.push({ target: own.target, query_ids: [seen, binding.query_id].sort(compareText) });
        }
      }
      if (!predictionsOnly && covering.length === 0) {
        unknowns.push({ todo_id: todoId, kind: 'sensor_unbound', ref: `${own.kind}:${own.target}` });
      }
    }
  }
  if (ambiguous.length > 0) return nonDispatchable('QUERY_DRIFT', { ambiguous_targets: ambiguous });

  // observation set resources。
  const resources = [];
  for (const [key, group] of [...ownGroups.entries()].sort((left, right) => compareText(left[0], right[0]))) {
    const coveringQueryId = coveringByTarget.get(key);
    if (coveringQueryId === undefined) continue; // 未束縛ownsは既にunknownへ落ちている
    const outcome = outcomeByQueryId.get(coveringQueryId);
    // covering bindingのexpectを、実際にこのtargetを束縛したwitnessから再取得する。
    let representative;
    for (const todoId of group.todoIds) {
      representative = bindingsByTodo.get(todoId).find((entry) => (
        entry.query_id === coveringQueryId && bindingCoversOwn(entry, group.own)
      ));
      if (representative !== undefined) break;
    }
    if (representative === undefined) fail(`covering binding不整合: ${group.own.target}`);
    if (predictionsOnly && resolveBindingStatus(representative, outcome) !== 'ready') continue;
    const status = statusOutcome.status !== 'ready'
      ? statusOutcome.status
      : resolveBindingStatus(representative, outcome);
    resources.push({
      resource_id: `own-${group.own.kind}-${sha16(group.own.target)}`,
      kind: group.own.kind,
      target: group.own.target,
      todo_ids: [...group.todoIds].sort(compareText),
      provenance: [
        {
          source: 'sensor',
          evidence_ref: coveringQueryId,
          evidence_digest: outcome.portable_digest,
          status,
        },
        candidateProvenance(request),
      ],
    });
  }

  const ownResourceCovers = (target, leftId, rightId) => resources.some((resource) => (
    resource.kind === 'path' && resource.target === target
    && resource.todo_ids.includes(leftId) && resource.todo_ids.includes(rightId)
  ));

  // 最新契約ではwrite scopeは予測である。既知の交差はserial conflictへ使うが、
  // 予測が足りないこと自体はunknownへ落とさない。
  const predictedWriteGroups = [];
  for (let left = 0; left < todoIds.length; left += 1) {
    for (let right = left + 1; right < todoIds.length; right += 1) {
      const leftWitness = request.manual_witness[todoIds[left]];
      const rightWitness = request.manual_witness[todoIds[right]];
      for (const leftPath of leftWitness.writes) {
        for (const rightPath of rightWitness.writes) {
          if (!pathPrefixOverlap(leftPath, rightPath)) continue;
          // 同一targetを両者がownsで所有主張し、そのowns resourceが実際に両者を含む時だけ
          // write conflictはresource経由で扱われる。予測契約では裏付けの無いownsはresourceに
          // ならないので、ここで飛ばすと衝突が消える（a35、主張4）。
          if (leftPath === rightPath && ownResourceCovers(leftPath, todoIds[left], todoIds[right])) continue;
          if (predictionsOnly) {
            predictedWriteGroups.push({
              target: [leftPath, rightPath].sort(compareText).join(' ↔ '),
              todoIds: [todoIds[left], todoIds[right]],
            });
          } else {
            unknowns.push({
              todo_id: todoIds[left], kind: 'undeclared_write_overlap',
              ref: `${leftPath} ${rightPath}`,
            });
            unknowns.push({
              todo_id: todoIds[right], kind: 'undeclared_write_overlap',
              ref: `${leftPath} ${rightPath}`,
            });
          }
        }
      }
    }
  }

  // witness明示unknowns。
  for (const todoId of todoIds) {
    for (const unknown of request.manual_witness[todoId].unknowns) {
      unknowns.push({ todo_id: todoId, kind: unknown.kind, ref: unknown.ref });
    }
  }

  // read/write交差は「片方が書き、他方が読む」state依存としてconflict化する
  // （RC2 boundary compilerのstate overlap規則の継承）。並列化してはならない。
  const readWriteGroups = new Map();
  for (let left = 0; left < todoIds.length; left += 1) {
    for (let right = 0; right < todoIds.length; right += 1) {
      if (left === right) continue;
      const writer = request.manual_witness[todoIds[left]];
      const reader = request.manual_witness[todoIds[right]];
      for (const writePath of writer.writes) {
        for (const readPath of reader.reads) {
          if (!pathPrefixOverlap(writePath, readPath)) continue;
          if (!readWriteGroups.has(writePath)) readWriteGroups.set(writePath, new Set());
          const group = readWriteGroups.get(writePath);
          group.add(todoIds[left]);
          group.add(todoIds[right]);
        }
      }
    }
  }

  // 同じ意味的な線はpathが交差しなくても共有契約である。reads同士だけは並列可とし、
  // 少なくとも片方がwritesのpairを独立したresourceへする。1 lineを全taskの単一resourceへ
  // 丸めるとreads×readsまでconflictになるため、pair単位で実体化する。
  const lineGroups = new Map();
  for (const todoId of todoIds) {
    for (const line of request.manual_witness[todoId].lines ?? []) {
      if (!lineGroups.has(line.line_id)) {
        lineGroups.set(line.line_id, { reads: new Set(), writes: new Set() });
      }
      lineGroups.get(line.line_id)[line.role].add(todoId);
    }
  }
  const lineConflictGroups = [];
  for (const [lineId, roles] of [...lineGroups.entries()]
    .sort((left, right) => compareText(left[0], right[0]))) {
    const participants = [...new Set([...roles.reads, ...roles.writes])].sort(compareText);
    for (let left = 0; left < participants.length; left += 1) {
      for (let right = left + 1; right < participants.length; right += 1) {
        const leftId = participants[left];
        const rightId = participants[right];
        if (!roles.writes.has(leftId) && !roles.writes.has(rightId)) continue;
        lineConflictGroups.push({ lineId, todoIds: [leftId, rightId] });
      }
    }
  }

  // state_effect宣言のないbare shared resourceは、方向不明の共有資源として
  // conflict化する（安全と推測しない）。
  const bareResourceGroups = new Map();
  for (const todoId of todoIds) {
    const witness = request.manual_witness[todoId];
    const declaredStateIds = new Set(witness.state_effects.map((entry) => entry.resource_id));
    for (const resourceId of witness.resources) {
      if (declaredStateIds.has(resourceId)) continue;
      if (!bareResourceGroups.has(resourceId)) bareResourceGroups.set(resourceId, new Set());
      bareResourceGroups.get(resourceId).add(todoId);
    }
  }

  const stateGroups = new Map();
  for (const todoId of todoIds) {
    for (const entry of request.manual_witness[todoId].state_effects) {
      if (!stateGroups.has(entry.resource_id)) {
        stateGroups.set(entry.resource_id, { kind: STATE_KIND_MAP[entry.kind], todoIds: new Set() });
      }
      const group = stateGroups.get(entry.resource_id);
      if (group.kind !== STATE_KIND_MAP[entry.kind]) {
        fail(`resource ${entry.resource_id}のstate/effect kindがwitness間で矛盾している`);
      }
      group.todoIds.add(todoId);
    }
  }
  // bare shared resourceは、同idのstate_effect宣言があればそこへmergeし、
  // なければ方向不明の共有state資源として独立に実体化する。
  for (const [resourceId, todos] of bareResourceGroups) {
    if (stateGroups.has(resourceId)) {
      const group = stateGroups.get(resourceId);
      for (const todoId of todos) group.todoIds.add(todoId);
    } else {
      stateGroups.set(resourceId, { kind: 'state', todoIds: todos });
    }
  }
  for (const [resourceId, group] of [...stateGroups.entries()].sort((left, right) => compareText(left[0], right[0]))) {
    resources.push({
      resource_id: resourceId,
      kind: group.kind,
      target: resourceId,
      todo_ids: [...group.todoIds].sort(compareText),
      provenance: [manualProvenance(request)],
    });
  }
  for (const [writePath, todos] of [...readWriteGroups.entries()].sort((left, right) => compareText(left[0], right[0]))) {
    resources.push({
      resource_id: `rw-${sha16(writePath)}`,
      kind: 'state',
      target: writePath,
      todo_ids: [...todos].sort(compareText),
      provenance: [manualProvenance(request)],
    });
  }
  for (const group of lineConflictGroups) {
    resources.push({
      resource_id: `line-${sha16(group.lineId)}-${sha16(group.todoIds.join('\0'))}`,
      kind: 'line',
      target: group.lineId,
      todo_ids: group.todoIds,
      provenance: [manualProvenance(request)],
    });
  }
  for (const [index, group] of predictedWriteGroups.entries()) {
    resources.push({
      resource_id: `predicted-ww-${sha16(`${group.target}:${index}`)}`,
      kind: 'state',
      target: group.target,
      todo_ids: group.todoIds,
      provenance: [manualProvenance(request)],
    });
  }

  let dynamicIndex = 0;
  for (const unknown of unknowns) {
    resources.push({
      resource_id: `dyn-${String(dynamicIndex += 1).padStart(3, '0')}-${sha16(`${unknown.kind}:${unknown.ref}`)}`,
      kind: 'dynamic',
      target: `${unknown.kind}:${unknown.ref}`.slice(0, 4_096).trim(),
      todo_ids: [unknown.todo_id],
      provenance: [manualProvenance(request)],
    });
  }

  const observationSet = {
    schema_version: 'lattice.boundary_observation_set.v2',
    source: {
      snapshot_digest: digestArtifact({ base_sha: request.repo.base_sha }),
      candidate_witness_digest: digestArtifact(request.manual_witness),
      query_set_digest: digestArtifact(request.sensor_query_set),
      manual_evidence_digest: request.request_digest,
    },
    capacity: request.capacity.executors,
    todos: todoIds,
    resources,
    precedences: [],
  };

  const bundle = compileBoundaryObservationV2(observationSet);
  const compiled = compileSchedulabilityGraphV2(bundle.graph);

  if (compiled.outcome === 'unsupported' && compiled.code === 'NODE_LIMIT_EXCEEDED') {
    return nonDispatchable('NODE_LIMIT_EXCEEDED', { todo_count: todoIds.length });
  }
  if (compiled.outcome === 'unknown') {
    const hasFreshAbsentPath = todoIds.some((todoId) => (
      bindingsByTodo.get(todoId).some((binding) => {
        if (!['path', 'affected'].includes(binding.expect.kind)) return false;
        const query = queryById.get(binding.query_id);
        const outcome = outcomeByQueryId.get(binding.query_id);
        return query.operation === 'affected'
          && outcome.status === 'empty'
          && affectedTarget(outcome.raw, binding.expect.path)?.path_state === 'absent';
      })
    ));
    return nonDispatchable('BOUNDARY_UNKNOWN', {
      unknowns: compiled.unknowns,
      unresolved_witnesses: unknowns,
      guidance: hasFreshAbsentPath
        ? {
          code: 'BOOTSTRAP_OWNERSHIP_SEAM',
          message: '不存在と観測されたpathは、そのTODOが作るならowns entryへcreates: trueを宣言して再compileする。宣言せずに裏付けを得るなら、親が空の専用seamをbase commitへ先行追加し、sensor sync後に同じrequestを再compileする',
        }
        : {
          code: 'ACQUIRE_OWNERSHIP_EVIDENCE',
          message: '既存path・symbol・未束縛ownershipはfresh Sensor queryを追加して同じrequestを再compileする',
        },
    });
  }
  if (compiled.outcome === 'unsupported' && compiled.code === 'SEARCH_BUDGET_EXHAUSTED') {
    return nonDispatchable('SEARCH_BUDGET_EXHAUSTED', {});
  }
  if (compiled.outcome !== 'compiled') fail(`未知のcompiler outcome: ${compiled.outcome}`);

  // producer非依存の独立verifierと必ず一致すること（成功条件5）。
  const verified = verifySchedulabilityPlanV2(bundle.graph, compiled.plan);
  if (verified.outcome !== 'verified'
    || verified.minimum_feasible_waves !== compiled.plan.minimum_feasible_waves) {
    fail(`producerとverifierの結果が一致しない: ${JSON.stringify(verified)}`);
  }

  // boundary_manifest.v2をTODOごとに構成する。
  const manifests = {};
  for (const todoId of todoIds) {
    const witness = request.manual_witness[todoId];
    const witnessProvenance = {};
    for (const resource of resources) {
      if (!resource.todo_ids.includes(todoId)) continue;
      witnessProvenance[resource.resource_id] = resource.kind === 'symbol' || resource.kind === 'path'
        ? 'sensor'
        : 'manual_state_effect';
    }
    const manifest = {
      schema: BOUNDARY_MANIFEST_SCHEMA,
      todo_id: todoId,
      owns: witness.owns,
      reads: witness.reads,
      writes: witness.writes,
      resources: witness.resources,
      state_effects: witness.state_effects,
      unknowns: witness.unknowns,
      affected_tests: witness.affected_tests,
      ...(witness.lines === undefined ? {} : { lines: witness.lines }),
      graph_evidence: bindingsByTodo.get(todoId).map((binding) => {
        const outcome = outcomeByQueryId.get(binding.query_id);
        return {
          query_id: binding.query_id,
          operation: outcome.operation,
          status: resolveBindingStatus(binding, outcome),
          result_digest: outcome.portable_digest,
        };
      }),
      witness_provenance: witnessProvenance,
    };
    manifest.manifest_digest = selfDigest(manifest, 'manifest_digest');
    if (!validateRuntimeBoundaryManifest(manifest)) {
      fail(`生成manifestがboundary_manifest contractを満たさない: ${todoId}`);
    }
    manifests[todoId] = manifest;
  }

  const plan = {
    schema: 'lattice.runtime_plan.v1',
    plan_ref: planRef,
    plan_epoch: planEpoch,
    request_digest: request.request_digest,
    base_sha: request.repo.base_sha,
    nodes: bundle.graph.todos.map((todoId) => ({ todo_id: todoId })),
    precedence: bundle.graph.precedences.map((entry) => ({
      from_todo_id: entry.from_todo_id,
      to_todo_id: entry.to_todo_id,
    })),
    conflicts: bundle.graph.conflicts,
    capacity: { executors: request.capacity.executors },
    manifest_digests: Object.fromEntries(bundle.graph.todos.map((todoId) => (
      [todoId, manifests[todoId].manifest_digest]
    ))),
    claim: { mode: 'exact_minimum' },
    predecessor_refs: [...predecessorRefs],
  };
  plan.plan_digest = selfDigest(plan, 'plan_digest');
  if (!validateRuntimePlan(plan)) fail('生成planがruntime_plan.v1 contractを満たさない');
  if (!verifyRuntimePlanBinding({ plan, request })) fail('生成planがrequestへbindできない');

  return {
    outcome: 'dispatchable',
    plan,
    manifests,
    schedule: compiled.plan,
    pairwise_verdicts: compiled.pairwise_verdicts,
    graph: bundle.graph,
    // graph.conflictsはresource_idしか持たない。resource kindはここでしか引けないため、
    // conflictの切断可能性を判定する消費者へnormalized resourceをそのまま渡す（ADR 0128）。
    resources: bundle.resources,
    graph_digest: bundle.graph_digest,
  };
}
