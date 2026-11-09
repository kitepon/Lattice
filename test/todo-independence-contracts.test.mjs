import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TODO_INDEPENDENCE_PROJECTION_SCHEMA,
  TODO_INDEPENDENCE_SCHEMA,
  TODO_WITNESS_SET_SCHEMA,
  explainTodoWitnessSet,
  isTodoIndependenceLegacyArtifactIdentity,
  severabilityOfConflictKind,
  synthesizeWitnessRunRequest,
  validateTodoIndependence,
  validateTodoIndependenceProjection,
  validateTodoWitnessSet,
} from '../src/todo-independence-contracts.mjs';
import { validateRunRequest } from '../src/runtime-contracts.mjs';
import {
  selectIndependenceGuidance,
  todoIndependenceGuidance,
} from '../src/todo-independence-guidance.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';

// ADR 0127。依存線の不在と境界の非干渉は別概念であり、未検査（unknown）と
// 検証済み独立（verified）を同じ「conflictが無い」へ丸めないことを契約で固定する。

const BASE_SHA = 'a'.repeat(40);
const DIGEST = (character) => character.repeat(64);

const witness = (overrides = {}) => ({
  owns: [{ kind: 'path', target: 'src/alpha.mjs' }],
  reads: [],
  writes: ['src/alpha.mjs'],
  resources: [],
  state_effects: [],
  sensor_provenance: {
    queries: [{ query_id: 'q-alpha', expect: { kind: 'path', path: 'src/alpha.mjs' } }],
  },
  affected_tests: [],
  unknowns: [],
  ...overrides,
});

function witnessSet(overrides = {}) {
  const value = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'lattice',
    plan_key: 'plan-a',
    capacity: { executors: 2 },
    sensor_query_set: {
      queries: [
        { id: 'q-status', operation: 'status' },
        { id: 'q-alpha', operation: 'affected', target: 'src/alpha.mjs' },
      ],
    },
    manual_witness: { 'tip-001': witness() },
    witness_set_digest: '',
    ...overrides,
  };
  value.witness_set_digest = todoSelfDigest(value, 'witness_set_digest');
  return value;
}

function independence(overrides = {}) {
  const value = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: 'lattice',
    plan_key: 'plan-a',
    plan_version: 'v1',
    topology_digest: DIGEST('c'),
    base_sha: BASE_SHA,
    witness_set_digest: DIGEST('d'),
    compiled_at: '2026-07-26T00:00:00.000Z',
    task_ids: ['tip-001', 'tip-002'],
    task_boundaries: [
      { task_id: 'tip-001', paths: ['src/alpha.mjs'] },
      { task_id: 'tip-002', paths: ['src/beta.mjs'] },
    ],
    conflict_resources: [],
    conflicts: [],
    precedences: [],
    unknowns: [],
    wave_plan: null,
    outcome: 'unknown',
    result_digest: '',
    ...overrides,
  };
  // v4: scope_expanded は task_ids と1:1でなければ validator が落とす。
  // fixture の既定は「膨張ゼロ・比較相手なし」で、膨張そのものを測る test は overrides で上書きする
  value.scope_expanded = value.scope_expanded ?? (value.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  value.result_digest = todoSelfDigest(value, 'result_digest');
  return value;
}

function projection(overrides = {}) {
  const value = {
    schema: TODO_INDEPENDENCE_PROJECTION_SCHEMA,
    project_id: 'lattice',
    plan_key: 'plan-a',
    coverage: 'verified',
    compiled_base_sha: BASE_SHA,
    current_base_sha: BASE_SHA,
    plan_version: 'v1',
    topology_digest: DIGEST('c'),
    active_task_ids: [],
    uncovered_active_task_ids: [],
    drift: null,
    guidance: todoIndependenceGuidance('independence_verified'),
    frontier: {
      parallel_groups: [], serialize_pairs: [], conflicts_with_active: [], unknown: [],
    },
    result_digest: '',
    ...overrides,
  };
  value.result_digest = todoSelfDigest(value, 'result_digest');
  return value;
}

test('witness setはexact shapeと自己digestを要求する', () => {
  assert.equal(validateTodoWitnessSet(witnessSet()), true);

  const tampered = witnessSet();
  tampered.plan_key = 'plan-b';
  assert.equal(explainTodoWitnessSet(tampered).reason, 'witness_set_digest_mismatch');

  const extra = witnessSet();
  extra.unexpected = 1;
  assert.equal(explainTodoWitnessSet(extra).reason, 'unexpected_or_missing_top_level_keys');

  const empty = witnessSet({ manual_witness: {} });
  assert.equal(explainTodoWitnessSet(empty).reason, 'bounded_collection_violation');
});

test('witness本体の判定はexplainRunRequestへ委譲され、pathがそのまま返る', () => {
  const broken = witnessSet({
    manual_witness: { 'tip-001': witness({ writes: ['/absolute/path.mjs'] }) },
  });
  const explained = explainTodoWitnessSet(broken);
  assert.equal(explained.valid, false);
  assert.equal(explained.reason, 'invalid_repo_relative_paths');
  assert.equal(explained.path, '/manual_witness/tip-001/writes');
});

test('合成したrun requestはrun_request.v1契約を満たす', () => {
  const set = witnessSet({
    manual_witness: { 'tip-002': witness(), 'tip-001': witness() },
  });
  const request = synthesizeWitnessRunRequest(set, {
    baseSha: BASE_SHA, requestId: 'independence-probe',
  });
  assert.equal(validateRunRequest(request), true);
  // todo順序は宣言順でなくtask_id順に正規化される（同じwitness setから同じbytesが出る）。
  assert.deepEqual(request.todos.map(({ todo_id: id }) => id), ['tip-001', 'tip-002']);
  assert.equal(request.repo.base_sha, BASE_SHA);
});

test('concern anchorは合成run requestへ写らない', () => {
  const set = witnessSet({
    manual_witness: {
      'tip-001': witness({
        concern_anchors: [{
          within: { kind: 'path', target: 'src/alpha.mjs' },
          symbols: ['renderLeft', 'renderRight'],
        }],
      }),
    },
  });
  assert.equal(validateTodoWitnessSet(set), true);
  const request = synthesizeWitnessRunRequest(set, {
    baseSha: BASE_SHA, requestId: 'independence-probe',
  });
  // 判定入力から構造的に落ちていること。非影響をtestの主張でなく合成で保証する。
  assert.equal(Object.hasOwn(request.manual_witness['tip-001'], 'concern_anchors'), false);
  assert.equal(validateRunRequest(request), true);
  // 宣言側は書き換えられない。
  assert.equal(set.manual_witness['tip-001'].concern_anchors.length, 1);
});

test('線宣言はv5だけが受理し、run requestへ同じshapeで届く', () => {
  const lines = [{
    line_id: 'room-sse-event',
    role: 'writes',
    anchors: [
      { kind: 'path', path: 'src/alpha.mjs' },
      { kind: 'symbol', name: 'emitRoomEvent', path: 'src/alpha.mjs' },
    ],
  }];
  const set = witnessSet({
    manual_witness: { 'tip-001': witness({ lines }) },
  });
  assert.equal(validateTodoWitnessSet(set), true);
  const request = synthesizeWitnessRunRequest(set, {
    baseSha: BASE_SHA, requestId: 'line-probe',
  });
  assert.equal(request.schema, 'lattice.run_request.v5');
  assert.deepEqual(request.manual_witness['tip-001'].lines, lines);
  assert.equal(validateRunRequest(request), true);

  const legacy = witnessSet({
    schema: 'lattice.todo_witness_set.v4',
    manual_witness: { 'tip-001': witness({ lines }) },
  });
  assert.equal(explainTodoWitnessSet(legacy).reason, 'lines_require_witness_set_v5');

  const duplicate = witnessSet({
    manual_witness: { 'tip-001': witness({ lines: [lines[0], { ...lines[0], role: 'reads' }] }) },
  });
  assert.equal(explainTodoWitnessSet(duplicate).reason, 'invalid_line_entries');

  const missingSymbolPath = witnessSet({
    manual_witness: { 'tip-001': witness({
      lines: [{ line_id: 'room-sse-event', role: 'reads', anchors: [
        { kind: 'symbol', name: 'consumeRoomEvent' },
      ] }],
    }) },
  });
  assert.equal(explainTodoWitnessSet(missingSymbolPath).reason, 'invalid_line_entries');
});

test('創作宣言はv3から使え、判定入力へそのまま届く', () => {
  const creating = witness({
    owns: [{ kind: 'path', target: 'src/alpha.mjs', creates: true }],
  });
  const set = witnessSet({ manual_witness: { 'tip-001': creating } });
  assert.equal(validateTodoWitnessSet(set), true);

  // concern anchorと違い、創作宣言は判定そのものへ効くので合成から落とさない。
  const request = synthesizeWitnessRunRequest(set, {
    baseSha: BASE_SHA, requestId: 'independence-probe',
  });
  assert.equal(validateRunRequest(request), true);
  assert.deepEqual(request.manual_witness['tip-001'].owns,
    [{ kind: 'path', target: 'src/alpha.mjs', creates: true }]);

  // 旧版の宣言には書けない。加算互換が成立しないので版で切る。
  for (const schema of ['lattice.todo_witness_set.v2', 'lattice.todo_witness_set.v1']) {
    const legacy = witnessSet({ schema, manual_witness: { 'tip-001': creating } });
    assert.equal(explainTodoWitnessSet(legacy).reason, 'creates_require_witness_set_v3');
  }
});

test('創作宣言はpathに限り、値はtrueだけを受理する', () => {
  // symbolの存在はfsのlstatで決まらない。創作境界はfile単位に限る。
  const onSymbol = witnessSet({
    manual_witness: {
      'tip-001': witness({ owns: [{ kind: 'symbol', target: 'renderLeft', creates: true }] }),
    },
  });
  assert.equal(validateTodoWitnessSet(onSymbol), false);

  // falseは「存在するpath」と同義。同じ事実へ2つの書き方を与えない。
  const explicitFalse = witnessSet({
    manual_witness: {
      'tip-001': witness({ owns: [{ kind: 'path', target: 'src/alpha.mjs', creates: false }] }),
    },
  });
  assert.equal(validateTodoWitnessSet(explicitFalse), false);
});

test('concern anchorは所有資源・整列・v2 schemaを要求する', () => {
  const anchored = (anchors) => witnessSet({
    manual_witness: { 'tip-001': witness({ concern_anchors: anchors }) },
  });

  assert.equal(explainTodoWitnessSet(anchored([{
    within: { kind: 'path', target: 'src/beta.mjs' },
    symbols: ['renderLeft'],
  }])).reason, 'concern_anchor_resource_not_owned');

  const written = witnessSet({
    manual_witness: {
      'tip-001': witness({
        writes: ['src/alpha.mjs', 'src/beta.mjs'],
        concern_anchors: [{
          within: { kind: 'path', target: 'src/beta.mjs' },
          symbols: ['renderLeft'],
        }],
      }),
    },
  });
  assert.equal(explainTodoWitnessSet(written).valid, true);

  assert.equal(explainTodoWitnessSet(anchored([{
    within: { kind: 'path', target: 'src/alpha.mjs' },
    symbols: ['renderRight', 'renderLeft'],
  }])).reason, 'unsorted_or_duplicate_collection');

  assert.equal(explainTodoWitnessSet(anchored([{
    within: { kind: 'path', target: 'src/alpha.mjs' },
    symbols: [],
  }])).reason, 'bounded_collection_violation');

  assert.equal(explainTodoWitnessSet(anchored([{
    within: { kind: 'module', target: 'src/alpha.mjs' },
    symbols: ['renderLeft'],
  }])).reason, 'invalid_concern_anchor_resource');

  const duplicated = anchored([
    { within: { kind: 'path', target: 'src/alpha.mjs' }, symbols: ['renderLeft'] },
    { within: { kind: 'path', target: 'src/alpha.mjs' }, symbols: ['renderRight'] },
  ]);
  assert.equal(explainTodoWitnessSet(duplicated).reason, 'unsorted_or_duplicate_collection');

  const legacy = witnessSet({
    schema: 'lattice.todo_witness_set.v1',
    manual_witness: {
      'tip-001': witness({
        concern_anchors: [{
          within: { kind: 'path', target: 'src/alpha.mjs' },
          symbols: ['renderLeft'],
        }],
      }),
    },
  });
  assert.equal(explainTodoWitnessSet(legacy).reason, 'concern_anchors_require_witness_set_v2');
});

test('concern anchorを持たない旧v1宣言はそのまま受理される', () => {
  const legacy = witnessSet({ schema: 'lattice.todo_witness_set.v1' });
  assert.equal(validateTodoWitnessSet(legacy), true);
  assert.equal(explainTodoWitnessSet(witnessSet({ schema: 'lattice.todo_witness_set.v0' })).reason,
    'schema_mismatch');
});

test('independence artifactは境界とdigestを検査する', () => {
  assert.equal(validateTodoIndependence(independence()), true);

  const unsortedTasks = independence({ task_ids: ['tip-002', 'tip-001'] });
  assert.equal(validateTodoIndependence(unsortedTasks), false);

  const danglingConflict = independence({
    conflict_resources: [{ resource_id: 'own-path-1', kind: 'path', target: 'src/shared.mjs' }],
    conflicts: [{ task_ids: ['tip-001', 'tip-999'], resource_id: 'own-path-1' }],
  });
  assert.equal(validateTodoIndependence(danglingConflict), false);

  const unorderedPair = independence({
    conflict_resources: [{ resource_id: 'own-path-1', kind: 'path', target: 'src/shared.mjs' }],
    conflicts: [{ task_ids: ['tip-002', 'tip-001'], resource_id: 'own-path-1' }],
  });
  assert.equal(validateTodoIndependence(unorderedPair), false);

  const tampered = independence();
  tampered.base_sha = 'b'.repeat(40);
  assert.equal(validateTodoIndependence(tampered), false);
});

test('旧artifact identityは既知schemaと版共通fieldの型だけを要求する', () => {
  const identity = {
    schema: 'lattice.todo_independence.v2',
    project_id: 'lattice',
    plan_key: 'plan-a',
    plan_version: 'v1',
    topology_digest: DIGEST('c'),
    base_sha: BASE_SHA,
    witness_set_digest: DIGEST('d'),
    result_digest: DIGEST('e'),
    body_is_not_validated: true,
  };
  assert.equal(isTodoIndependenceLegacyArtifactIdentity(identity), true);
  assert.equal(isTodoIndependenceLegacyArtifactIdentity({
    schema: 'lattice.todo_independence.v2',
  }), false);
  assert.equal(isTodoIndependenceLegacyArtifactIdentity({
    ...identity,
    schema: TODO_INDEPENDENCE_SCHEMA,
  }), false);
  assert.equal(isTodoIndependenceLegacyArtifactIdentity({
    ...identity,
    result_digest: 'not-a-digest',
  }), false);
});

test('conflict resource辞書は参照完全性・kind・targetを要求する', () => {
  const withoutResource = independence({
    conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'own-path-1' }],
  });
  assert.equal(validateTodoIndependence(withoutResource), false);

  const unknownKind = independence({
    conflict_resources: [{ resource_id: 'own-path-1', kind: 'dynamic', target: 'src/shared.mjs' }],
    conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'own-path-1' }],
  });
  assert.equal(validateTodoIndependence(unknownKind), false);

  for (const [kind, target] of [
    ['symbol', 'compileTodoIndependence'],
    ['path', 'src/shared.mjs'],
    ['state', 'shared-cache'],
    ['effect', 'deployment-api'],
  ]) {
    const value = independence({
      conflict_resources: [{ resource_id: 'r-1', kind, target }],
      conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'r-1' }],
    });
    assert.equal(validateTodoIndependence(value), true, `kind ${kind} should be accepted`);
  }

  const unused = independence({
    conflict_resources: [{ resource_id: 'r-1', kind: 'state', target: 'shared-cache' }],
  });
  assert.equal(validateTodoIndependence(unused), false);

  const duplicateId = independence({
    conflict_resources: [
      { resource_id: 'r-1', kind: 'path', target: 'src/a.mjs' },
      { resource_id: 'r-1', kind: 'path', target: 'src/b.mjs' },
    ],
    conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'r-1' }],
  });
  assert.equal(validateTodoIndependence(duplicateId), false);

  for (const target of ['/absolute.mjs', 'src/../secret.mjs', 'src\\windows.mjs', 'src/\u0000bad']) {
    const invalidPath = independence({
      conflict_resources: [{ resource_id: 'r-1', kind: 'path', target }],
      conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'r-1' }],
    });
    assert.equal(validateTodoIndependence(invalidPath), false, `path ${JSON.stringify(target)}`);
  }

  const oversizedSymbol = independence({
    conflict_resources: [{ resource_id: 'r-1', kind: 'symbol', target: 'x'.repeat(4_097) }],
    conflicts: [{ task_ids: ['tip-001', 'tip-002'], resource_id: 'r-1' }],
  });
  assert.equal(validateTodoIndependence(oversizedSymbol), false);
});

test('切断可能性はkindだけから決まる', () => {
  assert.equal(severabilityOfConflictKind('symbol'), 'code_seam');
  assert.equal(severabilityOfConflictKind('path'), 'code_seam');
  // 共有state／effectはcode seamでは切断できない（RC1 boundary compilerと同一規則）。
  assert.equal(severabilityOfConflictKind('state'), 'serial');
  assert.equal(severabilityOfConflictKind('effect'), 'serial');
  assert.equal(severabilityOfConflictKind('line'), 'serial');
});

test('旧契約supersededとplan改訂supersededは異なるguidanceを返す', () => {
  const legacyContract = selectIndependenceGuidance({
    coverage: 'superseded',
    contractSuperseded: true,
    taskDeclared: true,
    taskStale: false,
  });
  assert.deepEqual(legacyContract, {
    code: 'independence_contract_superseded',
    message: '記録は旧契約versionで書かれており、現在の並列可否の判定としては読めない。現在の契約での再compileが次の一歩になる。',
    next_action: 'lattice todo independence compile --plan <key> --input <file>',
  });

  const revisedPlan = selectIndependenceGuidance({
    coverage: 'superseded',
    contractSuperseded: false,
    taskDeclared: true,
    taskStale: false,
  });
  assert.equal(revisedPlan.code, 'independence_superseded');
  assert.equal(revisedPlan.next_action, 'lattice todo independence witness migrate --plan <key>');
  assert.notEqual(legacyContract.code, revisedPlan.code);

  const conflictWins = selectIndependenceGuidance({
    coverage: 'superseded',
    contractSuperseded: true,
    taskDeclared: true,
    taskStale: false,
    conflictWithActive: 'serial',
  });
  assert.equal(conflictWins.code, 'independence_conflict_with_active');
});

test('宣言境界はcompile対象taskとちょうど一対一で対応する', () => {
  const missingBoundary = independence({
    task_boundaries: [{ task_id: 'tip-001', paths: ['src/alpha.mjs'] }],
  });
  assert.equal(validateTodoIndependence(missingBoundary), false);

  const strayBoundary = independence({
    task_boundaries: [
      { task_id: 'tip-001', paths: ['src/alpha.mjs'] },
      { task_id: 'tip-999', paths: ['src/other.mjs'] },
    ],
  });
  assert.equal(validateTodoIndependence(strayBoundary), false);

  const unsortedPaths = independence({
    task_boundaries: [
      { task_id: 'tip-001', paths: ['src/b.mjs', 'src/a.mjs'] },
      { task_id: 'tip-002', paths: ['src/beta.mjs'] },
    ],
  });
  assert.equal(validateTodoIndependence(unsortedPaths), false);

  // 宣言が空のtaskも記録できる（境界ゼロは「宣言していない」でなく「触れない」の主張）。
  const emptyPaths = independence({
    task_boundaries: [
      { task_id: 'tip-001', paths: [] },
      { task_id: 'tip-002', paths: ['src/beta.mjs'] },
    ],
  });
  assert.equal(validateTodoIndependence(emptyPaths), true);
});

test('unknownが残る間はwave planもcompiled outcomeも主張できない', () => {
  const claimsPlan = independence({
    outcome: 'unknown',
    unknowns: [{ task_id: 'tip-001', kind: 'sensor_unbound', ref: 'path:src/alpha.mjs' }],
    wave_plan: { waves: [{ task_ids: ['tip-001', 'tip-002'] }], minimum_feasible_waves: 1 },
  });
  assert.equal(validateTodoIndependence(claimsPlan), false);

  const compiledWithUnknown = independence({
    outcome: 'compiled',
    unknowns: [{ task_id: 'tip-001', kind: 'sensor_unbound', ref: 'path:src/alpha.mjs' }],
    wave_plan: null,
  });
  assert.equal(validateTodoIndependence(compiledWithUnknown), false);

  const compiled = independence({
    outcome: 'compiled',
    wave_plan: { waves: [{ task_ids: ['tip-001', 'tip-002'] }], minimum_feasible_waves: 1 },
  });
  assert.equal(validateTodoIndependence(compiled), true);
});

test('wave planは全taskをちょうど一度だけ配置する', () => {
  const missing = independence({
    outcome: 'compiled',
    wave_plan: { waves: [{ task_ids: ['tip-001'] }], minimum_feasible_waves: 1 },
  });
  assert.equal(validateTodoIndependence(missing), false);

  const duplicated = independence({
    outcome: 'compiled',
    wave_plan: {
      waves: [{ task_ids: ['tip-001'] }, { task_ids: ['tip-001'] }],
      minimum_feasible_waves: 2,
    },
  });
  assert.equal(validateTodoIndependence(duplicated), false);

  const miscounted = independence({
    outcome: 'compiled',
    wave_plan: {
      waves: [{ task_ids: ['tip-001'] }, { task_ids: ['tip-002'] }],
      minimum_feasible_waves: 1,
    },
  });
  assert.equal(validateTodoIndependence(miscounted), false);
});

test('projectionはcoverageとidentityの整合を要求する', () => {
  assert.equal(validateTodoIndependenceProjection(projection()), true);

  // 記録が無いのにcompile済みidentityを名乗らない。
  const missingButBound = projection({ coverage: 'missing' });
  assert.equal(validateTodoIndependenceProjection(missingButBound), false);

  const missing = projection({
    coverage: 'missing',
    compiled_base_sha: null,
    plan_version: null,
    topology_digest: null,
  });
  assert.equal(validateTodoIndependenceProjection(missing), true);

  const staleWithoutRecord = projection({ coverage: 'stale', compiled_base_sha: null });
  assert.equal(validateTodoIndependenceProjection(staleWithoutRecord), false);

  const legacySuperseded = projection({
    coverage: 'superseded',
    compiled_base_sha: null,
    plan_version: null,
    topology_digest: null,
  });
  assert.equal(validateTodoIndependenceProjection(legacySuperseded), true);

  const partiallyBoundLegacy = projection({
    coverage: 'superseded',
    compiled_base_sha: null,
    plan_version: 'v1',
  });
  assert.equal(validateTodoIndependenceProjection(partiallyBoundLegacy), false);

  const unknownCoverage = projection({ coverage: 'probably-fine' });
  assert.equal(validateTodoIndependenceProjection(unknownCoverage), false);
});

test('projectionのfrontierは安定順序を要求する', () => {
  const ordered = projection({
    frontier: {
      parallel_groups: [{ task_ids: ['tip-001', 'tip-002'] }, { task_ids: ['tip-003'] }],
      serialize_pairs: [{
        task_ids: ['tip-001', 'tip-004'], type: 'conflict', detail: 'own-path-1',
        kind: 'path', severability: 'code_seam',
      }],
      conflicts_with_active: [],
      unknown: [{ task_id: 'tip-005', unknowns: [{ kind: 'sensor_unbound', ref: 'path:src/e.mjs' }] }],
    },
  });
  assert.equal(validateTodoIndependenceProjection(ordered), true);

  const unsortedGroups = projection({
    frontier: {
      parallel_groups: [{ task_ids: ['tip-003'] }, { task_ids: ['tip-001', 'tip-002'] }],
      serialize_pairs: [],
      conflicts_with_active: [],
      unknown: [],
    },
  });
  assert.equal(validateTodoIndependenceProjection(unsortedGroups), false);

  const unsortedUnknown = projection({
    frontier: {
      parallel_groups: [],
      serialize_pairs: [],
      conflicts_with_active: [],
      unknown: [
        { task_id: 'tip-005', unknowns: [{ kind: 'sensor_unbound', ref: 'a' }] },
        { task_id: 'tip-004', unknowns: [{ kind: 'sensor_unbound', ref: 'b' }] },
      ],
    },
  });
  assert.equal(validateTodoIndependenceProjection(unsortedUnknown), false);
});
