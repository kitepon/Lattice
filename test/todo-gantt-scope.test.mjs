import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { projectTodoGanttScope } from '../src/todo-gantt-scope.mjs';
import { projectTodoChainV1 } from '../src/todo-chain.mjs';

const ref = (task_id, plan_key = 'plan', project_id = 'project') => ({ project_id, plan_key, task_id });
const dependency = (from, to) => ({ from, to });

function fixture(tasks, hardEdges = []) {
  return plansFixture([{ planKey: 'plan', tasks }], hardEdges);
}

function plansFixture(plans, hardEdges = []) {
  const members = plans.map(({ planKey, tasks }) => ({
    plan: {
      project_id: 'project', plan_key: planKey,
      tasks: tasks.map(({ id, lane = 'main', title = id }) => ({ task_id: id, lane, title })),
      hard_dependencies: hardEdges.filter(({ from, to }) => from.plan_key === planKey
        || to.plan_key === planKey),
      joins: [],
    },
    tasks: tasks.map(({ id, status = 'pending' }) => ({ task_id: id, status })),
  }));
  const nodes = plans.flatMap(({ planKey, tasks }) => tasks.map(({ id }) => ref(id, planKey)));
  return {
    read: { schema: 'lattice.todo_store_read.v1', project_id: 'project', members },
    topology: { nodes, hard_edges: hardEdges, joins: [] },
  };
}

const layoutOf = (input, options) => layoutTodoGantt(input.read, options);

/** Kahn peel over the projected layout edges. */
function assertAcyclic(layout) {
  const key = (value) => `${value.project_id}\0${value.plan_key}\0${value.task_id}`;
  const indegree = new Map(layout.nodes.map((node) => [key(node.ref), 0]));
  const outgoing = new Map(layout.nodes.map((node) => [key(node.ref), []]));
  const seen = new Set();
  for (const edge of layout.edges) {
    if (seen.has(edge.semantic_edge_id)) continue;
    seen.add(edge.semantic_edge_id);
    outgoing.get(key(edge.from)).push(key(edge.to));
    indegree.set(key(edge.to), indegree.get(key(edge.to)) + 1);
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([node]) => node);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.pop();
    visited += 1;
    for (const next of outgoing.get(current)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  assert.equal(visited, layout.nodes.length, 'projected layout must stay acyclic');
}

test('全taskがdoneなら図から工程が消える', () => {
  const A = ref('A');
  const B = ref('B');
  const input = fixture([
    { id: 'A', status: 'done' }, { id: 'B', status: 'done' },
  ], [dependency(A, B)]);
  const live = layoutOf(input, { scope: 'live' });
  assert.equal(live.scope.folded_task_count, 2);
  assert.equal(live.nodes.length, 0, 'まとめnodeという代わりの箱も置かない');
  assert.equal(live.edges.length, 0);
  assert.equal(live.metrics.task_count, 2, '総数はフルグラフ基準で保つ');
  assert.deepEqual(live.folded.map(({ task_id }) => task_id), ['A', 'B']);
});

test('完走したplanは図に一切場所を取らない', () => {
  const input = plansFixture([
    { planKey: 'left', tasks: [{ id: 'L1', status: 'done' }, { id: 'L2', status: 'done' }] },
    { planKey: 'right', tasks: [{ id: 'R1', status: 'done' }, { id: 'R2', status: 'pending' }] },
  ], [dependency(ref('L1', 'left'), ref('L2', 'left'))]);
  const live = layoutOf(input, { scope: 'live' });
  // 完走したleft planは、まとめnode1個ぶんの列すら占めない。
  assert.deepEqual(live.nodes.map((node) => node.ref.task_id), ['R2']);
  assert.equal(live.scope.folded_task_count, 3);
  assert.deepEqual(live.folded.map(({ plan_key, task_id }) => `${plan_key}/${task_id}`),
    ['left/L1', 'left/L2', 'right/R1']);
});

test('生きた作業とその直接前提は残り、その先の死んだ枝だけが消える', () => {
  const f1 = ref('f1');
  const f2 = ref('f2');
  const s = ref('s');
  const live = ref('live');
  const input = fixture([
    { id: 'f1', status: 'done' }, { id: 'f2', status: 'done' },
    { id: 's', status: 'done' }, { id: 'live', status: 'pending' },
  ], [dependency(f1, f2), dependency(f1, s), dependency(s, f2), dependency(s, live)]);

  const projected = layoutOf(input, { scope: 'live' });
  assertAcyclic(projected);
  const drawn = projected.nodes.map((node) => node.ref.task_id).sort();
  assert.deepEqual(drawn, ['live', 's'], 'live作業とその直接前提だけが残る');
  assert.deepEqual(projected.folded.map(({ task_id }) => task_id), ['f1', 'f2']);
  // f1 -> s のedgeは、片端が消えたので図からも消える。
  assert.deepEqual(projected.edges.map((edge) => `${edge.from.task_id}->${edge.to.task_id}`),
    ['s->live']);
});

test('projectTodoGanttScopeはfoldableが無ければ入力をそのまま返す', () => {
  const nodes = [
    { key: 'a', ref: ref('A'), title: 'A', lane: 'main', status: 'pending' },
    { key: 'b', ref: ref('B'), title: 'B', lane: 'main', status: 'in-progress' },
  ];
  const edges = [{ key: 'a->b', from: 'a', to: 'b', kinds: new Set(['hard']), joinIdentities: new Map() }];
  const wave = new Map([['a', 0], ['b', 1]]);
  const result = projectTodoGanttScope({ nodes, edges, wave });
  assert.equal(result.nodes, nodes);
  assert.equal(result.edges, edges);
  assert.equal(result.foldedKeys.size, 0);
});

test('ADR 0148: closed_unauditedはAUDIT_PENDING_PHASE_STATUSESに含まれず、gate_ready/reviewing/rejectedと違って通常どおり畳まれる', () => {
  // f1 -> s -> live という鎖。sはliveの直接前提(distance 1)なので残るが、f1はさらに
  // その先(distance 2)なので、foldDistance既定の1を超えて畳まれる対象になる
  // ——ただしf1のphase_statusが監査前3状態のどれかなら、distance計算そのものを
  // 迂回してdistance 0に固定され、畳まれない(ADR 0147の既存規律)。closed_unauditedは
  // この固定に入らない、というのが0.36.1で直した点である。
  const f1 = { project_id: 'project', plan_key: 'plan', task_id: 'f1' };
  const s = { project_id: 'project', plan_key: 'plan', task_id: 's' };
  const live = { project_id: 'project', plan_key: 'plan', task_id: 'live' };
  const edges = [
    { key: 'f1->s', from: 'f1', to: 's', kinds: new Set(['hard']), joinIdentities: new Map() },
    { key: 's->live', from: 's', to: 'live', kinds: new Set(['hard']), joinIdentities: new Map() },
  ];
  const wave = new Map([['f1', 0], ['s', 1], ['live', 2]]);
  const baseNodes = (phaseStatus) => [
    { key: 'f1', ref: f1, title: 'f1', lane: 'main', status: 'done',
      phase_status: phaseStatus, plan_schema: 'lattice.todo_plan.v3' },
    { key: 's', ref: s, title: 's', lane: 'main', status: 'done' },
    { key: 'live', ref: live, title: 'live', lane: 'main', status: 'pending' },
  ];

  for (const phaseStatus of ['gate_ready', 'reviewing', 'rejected']) {
    const result = projectTodoGanttScope({ nodes: baseNodes(phaseStatus), edges, wave });
    assert.equal(result.foldedKeys.has('f1'), false,
      `phase_status=${phaseStatus}は監査前のまま図から消えてはいけない`);
  }

  for (const schema of ['lattice.todo_plan.v6', 'lattice.todo_plan.v7']) {
    const nodes = baseNodes('gate_ready').map((node, index) => (
      index === 0 ? { ...node, plan_schema: schema } : node
    ));
    const result = projectTodoGanttScope({ nodes, edges, wave });
    assert.equal(result.foldedKeys.has('f1'), false,
      `${schema}の暗黙終端監査前も図から消えてはいけない`);
  }

  const closedResult = projectTodoGanttScope({ nodes: baseNodes('closed_unaudited'), edges, wave });
  assert.equal(closedResult.foldedKeys.has('f1'), true,
    'closed_unauditedは監査前ではないので通常どおり畳まれる(ADR 0148裁定4)');

  // phase無しplanと違い、v4/v5(実Phaseを宣言したplan)は元からこの固定の対象外——
  // gate_ready等でもschemaがv4/v5ならdistance計算どおりに畳まれる(既存挙動・非目標)。
  const v5Nodes = [
    { key: 'f1', ref: f1, title: 'f1', lane: 'main', status: 'done',
      phase_status: 'gate_ready', plan_schema: 'lattice.todo_plan.v5' },
    { key: 's', ref: s, title: 's', lane: 'main', status: 'done' },
    { key: 'live', ref: live, title: 'live', lane: 'main', status: 'pending' },
  ];
  const v5Result = projectTodoGanttScope({ nodes: v5Nodes, edges, wave });
  assert.equal(v5Result.foldedKeys.has('f1'), true);
});

test('同じ入力からは同じ図が出る', () => {
  const A = ref('A');
  const B = ref('B');
  const C = ref('C');
  const input = fixture([
    { id: 'A', lane: 'alpha', status: 'done' },
    { id: 'B', lane: 'alpha', status: 'done' },
    { id: 'C', lane: 'beta', status: 'pending' },
  ], [dependency(A, B), dependency(B, C)]);
  const first = layoutOf(input, { scope: 'live' });
  const second = layoutOf(input, { scope: 'live' });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  assert.deepEqual(first.nodes.map((node) => node.ref.task_id), ['B', 'C']);
  assert.deepEqual(first.folded.map(({ task_id }) => task_id), ['A']);
});
