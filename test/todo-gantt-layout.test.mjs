import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { projectTodoChainV1 } from '../src/todo-chain.mjs';

const ref = (task_id, plan_key = 'plan', project_id = 'project') => ({ project_id, plan_key, task_id });
const dependency = (from, to) => ({ from, to });

function fixture(plans, hardEdges = [], joins = []) {
  const members = plans.map(({ plan_key, tasks }) => ({
    plan: {
      project_id: 'project', plan_key,
      tasks: tasks.map(({ id, lane, title = id }) => ({ task_id: id, lane, title })),
      hard_dependencies: hardEdges.filter(({ from }) => from.plan_key === plan_key),
      joins: joins.filter(({ owner }) => owner === plan_key).map(({ owner: _owner, ...join }) => join),
    },
    tasks: tasks.map(({ id, status = 'pending' }) => ({ task_id: id, status })),
  }));
  const nodes = plans.flatMap(({ plan_key, tasks }) => tasks.map(({ id }) => ref(id, plan_key)));
  return {
    read: { schema: 'lattice.todo_store_read.v1', project_id: 'project', members },
    topology: { nodes, hard_edges: hardEdges, joins: joins.map(({ owner: _owner, ...join }) => join) },
  };
}

function layoutOf(input, options) {
  return layoutTodoGantt(input.read, options);
}

test('退役した最長経路を除き、実行する工程から経路と着手可能状態を求める', () => {
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: 'work' }, { id: 'B', lane: 'work' },
    { id: 'R1', lane: 'old', status: 'retired' },
    { id: 'R2', lane: 'old', status: 'retired' },
    { id: 'R3', lane: 'old', status: 'retired' },
  ] }], [dependency(ref('A'), ref('B')), dependency(ref('R1'), ref('R2')), dependency(ref('R2'), ref('R3'))]);
  const member = input.read.members[0];
  member.plan.schema = 'lattice.todo_plan.v7';
  member.plan.phase_accept_dependencies = [{ from: { project_id: 'project', plan_key: 'plan', phase_id: 'before' }, to: ref('R1') }];
  for (const scope of ['all', 'live']) {
    const layout = layoutOf(input, { scope });
    assert.deepEqual(layout.nodes.map(node => node.ref.task_id).sort(), ['A', 'B']);
    assert.deepEqual(layout.nodes.filter(node => node.visibility.longest_dependency_chain).map(node => node.ref.task_id).sort(), ['A', 'B']);
  }
});

function assertNoCollinearOverlap(edges) {
  const segments = edges.flatMap((edge) => edge.route.slice(0, -1).map((start, index) => ({
    edge: edge.id, index, start, end: edge.route[index + 1],
  })));
  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const left = segments[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
      const right = segments[rightIndex];
      const leftVector = [left.end[0] - left.start[0], left.end[1] - left.start[1]];
      const rightVector = [right.end[0] - right.start[0], right.end[1] - right.start[1]];
      if ((leftVector[0] === 0 && leftVector[1] === 0)
        || (rightVector[0] === 0 && rightVector[1] === 0)) continue;
      const parallel = leftVector[0] * rightVector[1] - leftVector[1] * rightVector[0] === 0;
      const offset = [right.start[0] - left.start[0], right.start[1] - left.start[1]];
      const collinear = parallel && leftVector[0] * offset[1] - leftVector[1] * offset[0] === 0;
      if (!collinear) continue;
      const axis = Math.abs(leftVector[0]) >= Math.abs(leftVector[1]) ? 0 : 1;
      const leftRange = [left.start[axis], left.end[axis]];
      const rightRange = [right.start[axis], right.end[axis]];
      const overlap = Math.min(Math.max(...leftRange), Math.max(...rightRange))
        - Math.max(Math.min(...leftRange), Math.min(...rightRange));
      assert.ok(overlap <= 0, `${left.edge}[${left.index}] and ${right.edge}[${right.index}] overlap`);
    }
  }
}

function enclosingBoxes(result) {
  return result.nodes.filter(({ visible }) => visible).map(({ ref: nodeRef, geometry }) => ({
    id: `${nodeRef.plan_key}/${nodeRef.task_id}`, ...geometry,
  }));
}

// 線がカードの内側を通ると、そのカードに隠れて経路を追えなくなる。端点の
// カードとは辺で接するので、判定は厳密不等号で「内部」だけを見る。
//
function assertNoRouteEntersBox(result) {
  const boxes = enclosingBoxes(result);
  for (const model of [...result.edges, ...result.connectors]) {
    const lastSegment = model.route.length - 2;
    for (let index = 0; index <= lastSegment; index += 1) {
      const [start, end] = [model.route[index], model.route[index + 1]];
      const horizontal = start[1] === end[1];
      for (const box of boxes) {
        const spansX = Math.max(start[0], end[0]) > box.x && Math.min(start[0], end[0]) < box.x + box.width;
        const spansY = Math.max(start[1], end[1]) > box.y && Math.min(start[1], end[1]) < box.y + box.height;
        const inside = horizontal
          ? start[1] > box.y && start[1] < box.y + box.height && spansX
          : start[0] > box.x && start[0] < box.x + box.width && spansY;
        assert.equal(inside, false, `${model.id}[${index}] enters ${box.id}`);
      }
    }
  }
}

test('small branch/join/multi-lane DAG has a deterministic coordinate snapshot', () => {
  const A = ref('A', 'alpha');
  const B = ref('B', 'alpha');
  const C = ref('C', 'alpha');
  const D = ref('D', 'beta');
  const input = fixture([
    { plan_key: 'alpha', tasks: [{ id: 'A', lane: 'core', status: 'done' }, { id: 'B', lane: 'ui' }, { id: 'C', lane: 'core', status: 'in-progress' }] },
    { plan_key: 'beta', tasks: [{ id: 'D', lane: 'release' }] },
  ], [dependency(A, B), dependency(A, C)], [{ owner: 'beta', id: 'join-1', after: [B, C], before: D }]);

  const result = layoutOf(input);
  assert.deepEqual(result.nodes.map(({ ref: nodeRef, wave, row, visible, geometry }) => ({
    id: `${nodeRef.plan_key}/${nodeRef.task_id}`, wave, row, visible, geometry,
  })), [
    // 段間隔は段ごとに、その帯を通るedge数で決まる。第0段の下は2本、第1段の下は3本。
    { id: 'alpha/A', wave: 0, row: 0, visible: true, geometry: { x: 16, y: 16, width: 272, height: 68 } },
    { id: 'alpha/B', wave: 1, row: 1, visible: true, geometry: { x: 312, y: 120, width: 272, height: 68 } },
    { id: 'alpha/C', wave: 1, row: 0, visible: true, geometry: { x: 16, y: 120, width: 272, height: 68 } },
    { id: 'beta/D', wave: 2, row: 0, visible: true, geometry: { x: 16, y: 236, width: 272, height: 68 } },
  ]);
  assert.deepEqual(result.edges.map(({ kinds, join_ids, visible, route }) => ({ kinds, join_ids, visible, route })), [
    { kinds: ['hard'], join_ids: [], visible: true, route: [[36, 84], [36, 96], [332, 96], [332, 120]] },
    // A→CとC→Dは真下へ繋ぐので、出発と到着が同じ取り付け枠を共有して一直線になる。
    { kinds: ['hard'], join_ids: [], visible: true, route: [[48, 84], [48, 108], [48, 120]] },
    { kinds: ['join'], join_ids: ['join-1'], visible: true, route: [[332, 188], [332, 200], [36, 200], [36, 224], [36, 236]] },
    { kinds: ['join'], join_ids: ['join-1'], visible: true, route: [[48, 188], [48, 212], [48, 224]] },
  ]);
  const logicalJoinEdges = result.edges.filter(({ join_ids }) => join_ids.includes('join-1'));
  assert.equal(logicalJoinEdges.filter(({ junction }) => junction !== null).length, 1);
  assert.ok(logicalJoinEdges.every(({ route }) => result.connectors[0].contacts.some((contact) => route
    .some((point) => point[0] === contact[0] && point[1] === contact[1]))));
  assert.deepEqual(result.sweep, { method: 'stable_median', rounds: 4, tie_break: 'previous_position_then_task_ref' });
  assert.equal(JSON.stringify(result).includes('critical'), false);
});

test('opposite row edges reserve distinct vertical ports across the whole wave gap', () => {
  const Z = ref('Z'); const A = ref('A'); const B = ref('B'); const D = ref('D');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'Z', lane: 'a' }, { id: 'A', lane: 'z' },
    { id: 'B', lane: 'a' }, { id: 'D', lane: 'z' },
  ] }], [dependency(A, B), dependency(Z, D)]);
  const result = layoutOf(input);
  assert.deepEqual(result.nodes.filter(({ wave }) => wave === 0)
    .sort((left, right) => left.row - right.row).map(({ ref: nodeRef }) => nodeRef.task_id), ['Z', 'A']);
  assert.deepEqual(result.nodes.filter(({ wave }) => wave === 1)
    .sort((left, right) => left.row - right.row).map(({ ref: nodeRef }) => nodeRef.task_id), ['B', 'D']);
  const verticals = result.edges.flatMap((edge) => edge.route.slice(0, -1)
    .map((start, index) => ({ edge: edge.id, start, end: edge.route[index + 1] }))
    .filter(({ start, end }) => start[0] === end[0] && start[1] !== end[1]));
  for (let leftIndex = 0; leftIndex < verticals.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < verticals.length; rightIndex += 1) {
      const left = verticals[leftIndex]; const right = verticals[rightIndex];
      if (left.edge === right.edge || left.start[0] !== right.start[0]) continue;
      const overlap = Math.min(Math.max(left.start[1], left.end[1]), Math.max(right.start[1], right.end[1]))
        - Math.max(Math.min(left.start[1], left.end[1]), Math.min(right.start[1], right.end[1]));
      assert.ok(overlap <= 0, `${left.edge} and ${right.edge} reuse x=${left.start[0]}`);
    }
  }
});

test('multiple logical join groups targeting one task receive distinct dots and trunks', () => {
  const A = ref('A'); const B = ref('B'); const C = ref('C'); const D = ref('D');
  const input = fixture([{ plan_key: 'plan', tasks: [A, B, C, D]
    .map(({ task_id }) => ({ id: task_id, lane: 'same' })) }], [], [
    { owner: 'plan', id: 'j1', after: [A, B], before: D },
    { owner: 'plan', id: 'j2', after: [C], before: D },
  ]);
  const result = layoutOf(input);
  const junctionEdges = result.edges.filter(({ junction }) => junction !== null);
  assert.equal(junctionEdges.length, 2);
  assert.equal(new Set(junctionEdges.map(({ junction }) => junction.join(','))).size, 2);
  const trunks = junctionEdges.map((edge) => edge.route.slice(-2));
  assert.equal(new Set(trunks.map(([[x]]) => x)).size, 2);
  for (const [[fromX, fromY], [toX, toY]] of trunks) {
    assert.equal(fromX, toX);
    assert.ok(toY > fromY);
  }
});

test('one semantic dependency gets a distinct display branch into every overlapping join', () => {
  const A = ref('A'); const B = ref('B'); const C = ref('C'); const D = ref('D');
  const input = fixture([{ plan_key: 'plan', tasks: [A, B, C, D]
    .map(({ task_id }) => ({ id: task_id, lane: 'same' })) }], [], [
    { owner: 'plan', id: 'j1', after: [A, B], before: D },
    { owner: 'plan', id: 'j2', after: [A, C], before: D },
  ]);
  const result = layoutOf(input);
  assert.equal(result.metrics.edge_count, 3);
  assert.equal(result.edges.length, 4);
  assert.equal(result.edges.filter(({ from, to }) => from.task_id === 'A' && to.task_id === 'D').length, 2);
  for (const joinId of ['j1', 'j2']) {
    const branches = result.edges.filter(({ join_owners }) => join_owners[0]?.join_id === joinId);
    assert.equal(branches.length, 2);
    const primary = branches.find(({ junction }) => junction !== null);
    const connector = result.connectors.find(({ join_owners }) => join_owners[0].join_id === joinId);
    assert.ok(primary.route.some((point) => point[0] === primary.junction[0]
      && point[1] === primary.junction[1]));
    assert.ok(branches.every(({ route }) => connector.contacts.some((contact) => route
      .some((point) => point[0] === contact[0] && point[1] === contact[1]))));
  }
  const dots = result.edges.filter(({ junction }) => junction !== null).map(({ junction }) => junction.join(','));
  assert.equal(dots.length, 2);
  assert.equal(new Set(dots).size, 2);
  assertNoCollinearOverlap([...result.edges, ...result.connectors]);
});

test('same join id owned by different plans remains two fully-qualified junctions', () => {
  const A = ref('A', 'alpha'); const B = ref('B', 'beta'); const D = ref('D', 'target');
  const input = fixture([
    { plan_key: 'alpha', tasks: [{ id: 'A', lane: 'same' }] },
    { plan_key: 'beta', tasks: [{ id: 'B', lane: 'same' }] },
    { plan_key: 'target', tasks: [{ id: 'D', lane: 'same' }] },
  ], [], [
    { owner: 'alpha', id: 'same', after: [A], before: D },
    { owner: 'beta', id: 'same', after: [B], before: D },
  ]);
  const result = layoutOf(input);
  const junctionEdges = result.edges.filter(({ junction }) => junction !== null);
  assert.equal(junctionEdges.length, 2);
  assert.deepEqual(junctionEdges.map(({ join_owners }) => join_owners[0].plan_key).sort(), ['alpha', 'beta']);
  assert.equal(new Set(junctionEdges.map(({ junction }) => junction.join(','))).size, 2);
  assertNoCollinearOverlap([...result.edges, ...result.connectors]);
});

test('join fan routes stay orthogonal and every nonlogical crossing receives bridge metadata', () => {
  const A = ref('A'); const B = ref('B'); const C = ref('C');
  const D = ref('D'); const E = ref('E'); const F = ref('F');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: '0' }, { id: 'B', lane: '0' }, { id: 'C', lane: '0' },
    { id: 'D', lane: '2' }, { id: 'E', lane: '1' }, { id: 'F', lane: '1' },
  ] }], [dependency(A, F)], [
    { owner: 'plan', id: 'j2-0', after: [B], before: C },
    { owner: 'plan', id: 'j3-1', after: [A, B, C], before: D },
    { owner: 'plan', id: 'j4-2', after: [C], before: E },
  ]);
  const result = layoutOf(input);
  const models = [...result.edges, ...result.connectors];
  for (const model of models) {
    for (let index = 0; index < model.route.length - 1; index += 1) {
      const [start, end] = [model.route[index], model.route[index + 1]];
      assert.ok(start[0] === end[0] || start[1] === end[1], `${model.id} has a diagonal segment`);
    }
  }
  const logicalContacts = new Set(result.connectors.flatMap(({ contacts }) => contacts.map((point) => point.join(','))));
  let nonlogicalCrossings = 0;
  for (let leftIndex = 0; leftIndex < models.length; leftIndex += 1) {
    const left = models[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < models.length; rightIndex += 1) {
      const right = models[rightIndex];
      for (let leftSegment = 0; leftSegment < left.route.length - 1; leftSegment += 1) {
        for (let rightSegment = 0; rightSegment < right.route.length - 1; rightSegment += 1) {
          const leftStart = left.route[leftSegment]; const leftEnd = left.route[leftSegment + 1];
          const rightStart = right.route[rightSegment]; const rightEnd = right.route[rightSegment + 1];
          const leftHorizontal = leftStart[1] === leftEnd[1] && leftStart[0] !== leftEnd[0];
          const rightHorizontal = rightStart[1] === rightEnd[1] && rightStart[0] !== rightEnd[0];
          if (leftHorizontal === rightHorizontal) continue;
          const horizontal = leftHorizontal
            ? { model: left, segment: leftSegment, start: leftStart, end: leftEnd }
            : { model: right, segment: rightSegment, start: rightStart, end: rightEnd };
          const vertical = leftHorizontal ? { start: rightStart, end: rightEnd } : { start: leftStart, end: leftEnd };
          const [x, y] = [vertical.start[0], horizontal.start[1]];
          const strictH = x > Math.min(horizontal.start[0], horizontal.end[0])
            && x < Math.max(horizontal.start[0], horizontal.end[0]);
          const strictV = y > Math.min(vertical.start[1], vertical.end[1])
            && y < Math.max(vertical.start[1], vertical.end[1]);
          if (!strictH || !strictV || logicalContacts.has(`${x},${y}`)) continue;
          nonlogicalCrossings += 1;
          assert.ok(horizontal.model.bridges.some((bridge) => bridge.segment_index === horizontal.segment
            && bridge.x === x && bridge.y === y));
        }
      }
    }
  }
  assert.ok(nonlogicalCrossings > 0);
  assertNoCollinearOverlap(models);
});

test('routes use exclusive channels, avoid unrelated boxes, and mark only geometric crossings as bridges', () => {
  const A = ref('A'); const B = ref('B'); const C = ref('C'); const D = ref('D');
  const input = fixture([{ plan_key: 'plan', tasks: [A, B, C, D]
    .map(({ task_id }, index) => ({ id: task_id, lane: `lane-${index % 2}` })) }], [
    dependency(A, B), dependency(A, C), dependency(B, D), dependency(A, D),
  ]);
  const result = layoutOf(input);
  assertNoCollinearOverlap(result.edges);
  const unrelated = result.nodes.find(({ ref: nodeRef }) => nodeRef.task_id === 'C').geometry;
  const skip = result.edges.find(({ from, to }) => from.task_id === 'A' && to.task_id === 'D');
  for (const [start, end] of skip.route.slice(0, -1).map((point, index) => [point, skip.route[index + 1]])) {
    const horizontal = start[1] === end[1];
    const hitsInterior = horizontal
      ? start[1] > unrelated.y && start[1] < unrelated.y + unrelated.height
        && Math.max(start[0], end[0]) > unrelated.x && Math.min(start[0], end[0]) < unrelated.x + unrelated.width
      : start[0] > unrelated.x && start[0] < unrelated.x + unrelated.width
        && Math.max(start[1], end[1]) > unrelated.y && Math.min(start[1], end[1]) < unrelated.y + unrelated.height;
    assert.equal(hitsInterior, false);
  }
  assert.ok(result.edges.some(({ bridges }) => bridges.length > 0));
  assert.ok(result.edges.every(({ junction, join_ids }) => junction === null && join_ids.length === 0));
  assertNoRouteEntersBox(result);
});

test('段をまたぐ線は端点カードの間の縦チャネルを降り、図の右端へ迂回しない', () => {
  const chained = ['A', 'B', 'C'].flatMap((chain) => [0, 1, 2, 3].map((stage) => `${chain}${stage}`));
  const loose = ['L0', 'L1', 'L2'];
  const step = (chain) => [0, 1, 2].map((stage) => dependency(ref(`${chain}${stage}`), ref(`${chain}${stage + 1}`)));
  const input = fixture([{ plan_key: 'plan', tasks: [...chained, ...loose]
    .map((id, index) => ({ id, lane: `lane-${index % 3}` })) }], [
    ...step('A'), ...step('B'), ...step('C'),
    // 右向き・左向き・同一列の段跳びを1枚に同居させる。
    dependency(ref('A0'), ref('C3')), dependency(ref('C0'), ref('A3')), dependency(ref('B0'), ref('B3')),
  ]);
  const result = layoutOf(input);
  assertNoCollinearOverlap([...result.edges, ...result.connectors]);
  assertNoRouteEntersBox(result);

  const geometryOf = (taskId) => result.nodes
    .find(({ ref: nodeRef }) => nodeRef.task_id === taskId).geometry;
  const rightmost = Math.max(...enclosingBoxes(result).map(({ x, width }) => x + width));
  let acrossColumns = 0;
  for (const [fromId, toId] of [['A0', 'C3'], ['C0', 'A3'], ['B0', 'B3']]) {
    const skip = result.edges.find(({ from, to }) => from.task_id === fromId && to.task_id === toId);
    const from = geometryOf(fromId);
    const to = geometryOf(toId);
    // 最初と最後の縦区間はカードに取り付くport stub。段をまたぐ降下はその間の1本。
    const descents = skip.route.slice(0, -1)
      .map((start, index) => ({ start, end: skip.route[index + 1], index }))
      .filter(({ start, end, index }) => start[0] === end[0] && start[1] !== end[1]
        && index !== 0 && index !== skip.route.length - 2);
    assert.equal(descents.length, 1, `${fromId}→${toId} の段またぎ降下は1本`);
    const x = descents[0].start[0];
    if (from.x === to.x) {
      assert.ok(x < from.x || x > from.x + from.width, `${fromId}→${toId} が自列のカードを貫く`);
      continue;
    }
    acrossColumns += 1;
    assert.ok(x > Math.min(from.x, to.x) + from.width && x < Math.max(from.x, to.x),
      `${fromId}→${toId} の縦移動 x=${x} が端点カードの間に無い`);
    assert.ok(x < rightmost, `${fromId}→${toId} が図の右端の外へ迂回している`);
  }
  assert.ok(acrossColumns >= 1);
});

test('依存を持たない工程は同じ段の上へ積まれ、どの線にも貫かれない', () => {
  const wired = ['W0', 'W1', 'W2'];
  const alone = Array.from({ length: 11 }, (_, index) => `A${index}`);
  const input = fixture([{ plan_key: 'plan', tasks: [...wired, ...alone]
    .map((id) => ({ id, lane: 'same' })) }],
  [dependency(ref('W0'), ref('W1')), dependency(ref('W1'), ref('W2'))]);
  const result = layoutOf(input);
  const nodeOf = (taskId) => result.nodes.find(({ ref: nodeRef }) => nodeRef.task_id === taskId);

  assert.deepEqual(alone.map((id) => nodeOf(id).wave), alone.map(() => 0), '前提: 独立工程はwave 0');
  const wiredTop = nodeOf('W0').geometry.y;
  for (const id of alone) {
    assert.ok(nodeOf(id).geometry.y < wiredTop,
      `${id} が依存を持つ工程より下に積まれている`);
  }
  // 折り返しが複数行に及ぶ状況で確かめる（列数分より多い独立工程を置いた）。
  assert.ok(new Set(alone.map((id) => nodeOf(id).geometry.y)).size >= 2, '前提: 独立工程が複数行へ折り返す');
  assertNoRouteEntersBox(result);
  assertNoCollinearOverlap([...result.edges, ...result.connectors]);
});

test('真下の工程へ繋ぐ線は折れずに一直線で降りる', () => {
  const chain = ['P1', 'P2', 'P3'];
  const input = fixture([{ plan_key: 'plan', tasks: chain.map((id) => ({ id, lane: 'same' })) }],
    [dependency(ref('P1'), ref('P2')), dependency(ref('P2'), ref('P3'))]);
  const result = layoutOf(input);
  const columnOf = (taskId) => result.nodes
    .find(({ ref: nodeRef }) => nodeRef.task_id === taskId).geometry.x;
  assert.equal(new Set(chain.map(columnOf)).size, 1, '前提: 3工程が同じ列に並ぶ');
  for (const edge of result.edges) {
    const xs = new Set(edge.route.map(([x]) => x));
    assert.equal(xs.size, 1,
      `${edge.from.task_id}→${edge.to.task_id} が横へ折れている: ${JSON.stringify(edge.route)}`);
  }
  // 折れ点が重なって生まれる長さゼロの区間を残さない。
  for (const edge of result.edges) {
    for (let index = 0; index < edge.route.length - 1; index += 1) {
      assert.notDeepEqual(edge.route[index], edge.route[index + 1]);
    }
  }
});

test('同じ列の別々の辺は取り付け枠を共有せず縦線が重ならない', () => {
  const Z = ref('Z'); const A = ref('A'); const B = ref('B');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'Z', lane: 'a' }, { id: 'A', lane: 'a' }, { id: 'B', lane: 'a' },
  ] }], [dependency(Z, B), dependency(A, B)]);
  const result = layoutOf(input);
  assertNoCollinearOverlap(result.edges);
  const arrivals = result.edges.map(({ route }) => route.at(-1)[0]);
  assert.equal(new Set(arrivals).size, 2, '1枚のカードへ入る2本は別々の取り付け位置を取る');
});

test('stable median sweep reduces crossings versus task-ref naive order', () => {
  const sourceIds = ['A', 'B', 'C'];
  const targetIds = ['X', 'Y', 'Z'];
  const edges = [
    dependency(ref('A'), ref('Z')),
    dependency(ref('B'), ref('Y')),
    dependency(ref('C'), ref('X')),
  ];
  const input = fixture([{ plan_key: 'plan', tasks: [...sourceIds, ...targetIds].map((id) => ({ id, lane: 'same' })) }], edges);
  const result = layoutOf(input);
  const naiveCrossings = 3;
  assert.equal(result.metrics.crossing_count, 0);
  assert.ok(result.metrics.crossing_count < naiveCrossings);
  assert.deepEqual(result.nodes.filter(({ wave }) => wave === 1).sort((a, b) => a.row - b.row).map(({ ref: nodeRef }) => nodeRef.task_id), ['Z', 'Y', 'X']);
});

test('scope all exposes every task and dependency with no folding projection', () => {
  const A = ref('A');
  const B = ref('B');
  const C = ref('C');
  const D = ref('D');
  const E = ref('E');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: 'one', status: 'done' },
    { id: 'B', lane: 'one', status: 'pending' },
    { id: 'C', lane: 'two', status: 'pending' },
    { id: 'D', lane: 'two', status: 'in-progress' },
    { id: 'E', lane: 'two', status: 'blocked' },
  ] }], [dependency(A, B), dependency(A, C), dependency(B, E), dependency(D, E)]);

  const folded = layoutOf(input, { scope: 'all' });
  const visibility = Object.fromEntries(folded.nodes.map((node) => [node.ref.task_id, node.visible]));
  assert.deepEqual(visibility, { A: true, B: true, C: true, D: true, E: true });
  // An isolated task is still drawn: `all` keeps the complete structural projection.
  input.read.members[0].plan.tasks.push({ task_id: 'F', lane: 'two', title: 'F' });
  input.read.members[0].tasks.push({ task_id: 'F', status: 'blocked' });
  input.topology.nodes.push(ref('F'));
  const withHidden = layoutOf(input, { scope: 'all' });
  assert.equal(withHidden.nodes.find((node) => node.ref.task_id === 'F').visible, true);
  assert.equal(withHidden.metrics.visible_node_count, withHidden.metrics.task_count);
  assert.equal(withHidden.metrics.visible_edge_count, withHidden.metrics.edge_count);
  assert.deepEqual(withHidden.groups.plans, [{ plan_key: 'plan', task_count: 6 }]);
  assert.deepEqual(withHidden.groups.lanes, [
    { plan_key: 'plan', lane: 'one', task_count: 2 },
    { plan_key: 'plan', lane: 'two', task_count: 4 },
  ]);
  assert.equal(withHidden.scope.folded_task_count, 0);
  assert.deepEqual(withHidden.folded, []);
});

test('scope liveは生きた作業とその直接前提を絶対に畳まない', () => {
  const A = ref('A');
  const B = ref('B');
  const C = ref('C');
  const D = ref('D');
  // A(done) -> B(done) -> C(pending): Bは生きた作業の直接前提、Aはその先の死んだ枝。
  // D(done)は後続を持たない完走した枝。
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: 'one', status: 'done' },
    { id: 'B', lane: 'one', status: 'done' },
    { id: 'C', lane: 'one', status: 'pending' },
    { id: 'D', lane: 'two', status: 'done' },
  ] }], [dependency(A, B), dependency(B, C)]);

  const live = layoutOf(input, { scope: 'live' });
  const drawn = new Set(live.nodes.map((node) => node.ref.task_id));
  assert.equal(drawn.has('C'), true, 'live work is never folded');
  assert.equal(drawn.has('B'), true, 'the direct premise of live work stays visible');
  assert.equal(drawn.has('A'), false, 'a dead branch behind the premise folds');
  assert.equal(drawn.has('D'), false, 'a finished branch with no live descendant folds');

  const foldedTaskIds = live.folded.map(({ task_id }) => task_id).sort();
  assert.deepEqual(foldedTaskIds, ['A', 'D']);
  // 総数はフルグラフ基準のまま正直に出す。
  assert.equal(live.metrics.task_count, 4);
  assert.deepEqual(live.groups.plans, [{ plan_key: 'plan', task_count: 4 }]);
  assert.equal(live.scope.folded_task_count, 2);
});

test('full_edgesは畳み込みで失われた依存も保持する', () => {
  const A = ref('A');
  const B = ref('B');
  const C = ref('C');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: 'one', status: 'done' },
    { id: 'B', lane: 'one', status: 'done' },
    { id: 'C', lane: 'one', status: 'pending' },
  ] }], [dependency(A, B), dependency(B, C)]);

  const pair = ({ from, to }) => `${from.task_id}->${to.task_id}`;
  const all = layoutOf(input, { scope: 'all' });
  const live = layoutOf(input, { scope: 'live' });
  // 図はA->Bを描かない（Aは畳まれ、内部edgeとして消える）が、full_edgesには残る。
  assert.equal(live.edges.some((edge) => pair(edge) === 'A->B'), false);
  assert.deepEqual(live.full_edges.map(pair).sort(), ['A->B', 'B->C']);
  assert.deepEqual(live.full_edges.map(pair).sort(), [...new Set(all.edges.map(pair))].sort(),
    'scope allの依存集合と一致する');
  assert.equal(live.full_edges.length, live.metrics.edge_count);
});

test('最長依存鎖とready frontierはscopeに依存しない', () => {
  const A = ref('A');
  const B = ref('B');
  const C = ref('C');
  const D = ref('D');
  const input = fixture([{ plan_key: 'plan', tasks: [
    { id: 'A', lane: 'one', status: 'done' },
    { id: 'B', lane: 'one', status: 'done' },
    { id: 'C', lane: 'one', status: 'pending' },
    { id: 'D', lane: 'two', status: 'done' },
  ] }], [dependency(A, B), dependency(B, C)]);

  const chainOf = (layout) => layout.nodes
    .filter((node) => node.visibility.longest_dependency_chain)
    .map((node) => node.ref.task_id).sort();
  const readyOf = (layout) => layout.nodes
    .filter((node) => node.visibility.next_ready).map((node) => node.ref.task_id).sort();

  const all = layoutOf(input, { scope: 'all' });
  const live = layoutOf(input, { scope: 'live' });
  assert.deepEqual(readyOf(live), readyOf(all));
  // 図から外した鎖上のToDoは描かれないが、鎖の長さ自体はフルグラフ基準で数える。
  const foldedIds = new Set(live.folded.map(({ task_id }) => task_id));
  assert.deepEqual(chainOf(all).filter((taskId) => !foldedIds.has(taskId)), chainOf(live));
  assert.equal(live.metrics.task_count, all.metrics.task_count);
});

test('input member/task/edge/join permutations produce byte-identical output', () => {
  const A = ref('A', 'a');
  const B = ref('B', 'a');
  const C = ref('C', 'b');
  const edges = [dependency(A, B), dependency(B, C)];
  const joins = [{ owner: 'b', id: 'j', after: [A], before: C }];
  const first = fixture([
    { plan_key: 'a', tasks: [{ id: 'A', lane: 'x', status: 'done' }, { id: 'B', lane: 'y' }] },
    { plan_key: 'b', tasks: [{ id: 'C', lane: 'z' }] },
  ], edges, joins);
  const second = structuredClone(first);
  second.read.members.reverse();
  for (const member of second.read.members) {
    member.plan.tasks.reverse(); member.tasks.reverse(); member.plan.hard_dependencies.reverse();
    for (const join of member.plan.joins) join.after.reverse();
  }
  second.topology.nodes.reverse(); second.topology.hard_edges.reverse(); second.topology.joins.reverse();
  assert.equal(JSON.stringify(layoutOf(first)), JSON.stringify(layoutOf(second)));
});

test('2,000 tasks / 8,000 unique edges layout completes within the suite contention budget', { timeout: 15_000 }, () => {
  const tasks = Array.from({ length: 2_000 }, (_, index) => ({
    id: String(index).padStart(4, '0'), lane: `lane-${index % 8}`, status: index < 4 ? 'done' : 'pending',
  }));
  const edges = [];
  const seen = new Set();
  for (let distance = 1; edges.length < 8_000; distance += 1) {
    for (let from = 0; from + distance < tasks.length && edges.length < 8_000; from += 1) {
      const key = `${from}:${from + distance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(dependency(ref(tasks[from].id), ref(tasks[from + distance].id)));
    }
  }
  const input = fixture([{ plan_key: 'plan', tasks }], edges);
  const started = performance.now();
  const result = layoutOf(input);
  const elapsed = performance.now() - started;
  assert.equal(result.metrics.task_count, 2_000);
  assert.equal(result.metrics.edge_count, 8_000);
  assert.ok(elapsed < 10_000, `layout took ${elapsed.toFixed(1)}ms`);
});

test('task overflow draws the first 2,000 in ref order and says what was left out', () => {
  const tasks = Array.from({ length: 2_001 }, (_, index) => ({ id: `T${String(index).padStart(4, '0')}`, lane: 'lane' }));
  const input = fixture([{ plan_key: 'plan', tasks }], [dependency(ref('T0000'), ref('T2000'))]);
  const result = layoutOf(input, { scope: 'all' });
  assert.equal(result.nodes.length, 2_000);
  assert.equal(result.nodes.some((node) => node.ref.task_id === 'T2000'), false);
  assert.equal(result.edges.length, 0, 'an edge touching a dropped task is dropped with it');
  assert.deepEqual(result.notices.map(({ code, detail }) => [code, detail.task_count, detail.dropped_task_count]),
    [['TODO_SCALE_EXCEEDED', 2_001, 1]]);
});

test('edge overflow draws the first 8,000 in edge-key order and says what was left out', { timeout: 15_000 }, () => {
  const tasks = Array.from({ length: 2_000 }, (_, index) => ({ id: `T${String(index).padStart(4, '0')}`, lane: 'lane' }));
  const edges = [];
  for (let distance = 1; edges.length < 8_001; distance += 1) {
    for (let from = 0; from + distance < 2_000 && edges.length < 8_001; from += 1) {
      edges.push(dependency(ref(tasks[from].id), ref(tasks[from + distance].id)));
    }
  }
  const result = layoutOf(fixture([{ plan_key: 'plan', tasks }], edges), { scope: 'all' });
  assert.equal(result.metrics.edge_count, 8_000);
  assert.deepEqual(result.notices.map(({ code, detail }) => [code, detail.edge_count, detail.dropped_edge_count]),
    [['TODO_SCALE_EXCEEDED', 8_001, 1]]);
});

test('a dependency cycle is drawn without the edges that point back, and named', () => {
  const tasks = ['A', 'B', 'C', 'D'].map((id) => ({ id, lane: 'lane' }));
  const input = fixture([{ plan_key: 'plan', tasks }], [
    dependency(ref('A'), ref('B')), dependency(ref('B'), ref('C')), dependency(ref('C'), ref('B')),
    dependency(ref('C'), ref('D')),
  ]);
  for (const scope of ['all', 'live']) {
    const result = layoutOf(input, { scope });
    assert.deepEqual(result.nodes.map((node) => node.ref.task_id).sort(), ['A', 'B', 'C', 'D']);
    const [notice] = result.notices;
    assert.equal(notice.code, 'TODO_LAYOUT_CYCLE');
    assert.deepEqual(notice.detail.cycle_tasks.map((entry) => entry.task_id), ['B', 'C', 'D']);
    assert.deepEqual(notice.detail.cut_edges.map(({ from, to }) => [from.task_id, to.task_id]), [['C', 'B']]);
    const wave = Object.fromEntries(result.nodes.map((node) => [node.ref.task_id, node.wave]));
    assert.ok(wave.A < wave.B && wave.B < wave.C && wave.C < wave.D);
  }
  const selfContained = layoutOf(fixture([{ plan_key: 'plan', tasks: tasks.slice(0, 2) }],
    [dependency(ref('A'), ref('B')), dependency(ref('B'), ref('A'))]), { scope: 'all' });
  assert.equal(selfContained.nodes.length, 2);
  assert.equal(selfContained.notices[0].code, 'TODO_LAYOUT_CYCLE');
});

test('an edge whose endpoint is not in the read model, a self edge and a bad join are skipped and named', () => {
  const tasks = ['A', 'B'].map((id) => ({ id, lane: 'lane' }));
  const input = fixture([{ plan_key: 'plan', tasks }], [
    dependency(ref('A'), ref('B')), dependency(ref('A'), ref('ghost')), dependency(ref('B'), ref('B')),
  ]);
  input.read.members[0].plan.hard_dependencies.push(dependency(null, ref('B')));
  input.read.members[0].plan.joins = [null];
  const result = layoutOf(input, { scope: 'all' });
  assert.equal(result.edges.length, 1);
  const [notice] = result.notices;
  assert.equal(notice.code, 'TODO_LAYOUT_INVALID_INPUT');
  assert.deepEqual(notice.detail.skipped_edges.map(({ reason }) => reason).sort(),
    ['endpoint_not_in_read_model', 'join_invalid_shape', 'not_a_task_ref', 'self_edge']);
});
