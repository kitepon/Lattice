import { TODO_GANTT_SCOPES, projectTodoGanttScope } from './todo-gantt-scope.mjs';
import { buildTodoGanttHierarchy } from './todo-gantt-nested.mjs';
import { projectTodoCrossPlanDependencies } from './todo-store.mjs';
import { projectTodoChainV1 } from './todo-chain.mjs';
import { createTodoReadiness } from './todo-readiness.mjs';

const TASK_LIMIT = 2_000;
const EDGE_LIMIT = 8_000;
const SWEEP_ROUNDS = 4;
// A notice names at most this many refs; the count always covers all of them.
const NOTICE_SAMPLE = 20;

/** Columns for a stage made only of ToDos with no registered dependency. */
const LOOSE_COLUMNS_MINIMUM = 8;

const GEOMETRY = Object.freeze({
  left: 16,
  top: 16,
  wave_gap: 104,
  lane_gap: 296,
  node_width: 272,
  node_height: 68,
  stage_row_gap: 12,
  route_inset: 8,
  route_spacing: 12,
});

function segmentKind(left, right) {
  if (left[1] === right[1] && left[0] !== right[0]) return 'horizontal';
  if (left[0] === right[0] && left[1] !== right[1]) return 'vertical';
  return 'point';
}

function strictlyBetween(value, left, right) {
  return value > Math.min(left, right) && value < Math.max(left, right);
}

function addCrossingBridges(projectedEdges, logicalContacts = new Set()) {
  const horizontalByY = new Map();
  const verticals = [];
  for (const edge of projectedEdges) {
    for (let segment = 0; segment < edge.route.length - 1; segment += 1) {
      const start = edge.route[segment];
      const end = edge.route[segment + 1];
      const kind = segmentKind(start, end);
      if (kind === 'horizontal') {
        if (!horizontalByY.has(start[1])) horizontalByY.set(start[1], []);
        horizontalByY.get(start[1]).push({ edge, segment, start, end });
      } else if (kind === 'vertical') verticals.push({ edge, start, end });
    }
  }
  const yValues = [...horizontalByY.keys()].sort((left, right) => left - right);
  const firstGreater = (value) => {
    let low = 0; let high = yValues.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (yValues[middle] <= value) low = middle + 1; else high = middle;
    }
    return low;
  };
  const firstAtLeast = (value) => {
    let low = 0; let high = yValues.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (yValues[middle] < value) low = middle + 1; else high = middle;
    }
    return low;
  };
  for (const vertical of verticals) {
    const minimumY = Math.min(vertical.start[1], vertical.end[1]);
    const maximumY = Math.max(vertical.start[1], vertical.end[1]);
    for (let yIndex = firstGreater(minimumY); yIndex < firstAtLeast(maximumY); yIndex += 1) {
      const y = yValues[yIndex];
      for (const horizontal of horizontalByY.get(y)) {
        if (horizontal.edge === vertical.edge
          || !strictlyBetween(vertical.start[0], horizontal.start[0], horizontal.end[0])) continue;
        if (logicalContacts.has(`${vertical.start[0]},${y}`)) continue;
        horizontal.edge.bridges.push({
          segment_index: horizontal.segment, x: vertical.start[0], y,
        });
      }
    }
  }
  for (const edge of projectedEdges) {
    edge.bridges.sort((left, right) => left.segment_index - right.segment_index
      || (edge.route[left.segment_index][0] <= edge.route[left.segment_index + 1][0]
        ? left.x - right.x : right.x - left.x));
  }
}

export class TodoGanttLayoutError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'TodoGanttLayoutError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new TodoGanttLayoutError(code, message, detail);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// null when the value is not a task ref; the caller skips what it cannot draw.
function refOf(value) {
  if (!plain(value) || typeof value.project_id !== 'string'
    || typeof value.plan_key !== 'string' || typeof value.task_id !== 'string') return null;
  return { project_id: value.project_id, plan_key: value.plan_key, task_id: value.task_id };
}

function refKey(ref) {
  return JSON.stringify([ref.project_id, ref.plan_key, ref.task_id]);
}

function compareRefs(left, right) {
  return compareText(left.project_id, right.project_id)
    || compareText(left.plan_key, right.plan_key)
    || compareText(left.task_id, right.task_id);
}

function groupKey(planKey, lane) {
  return JSON.stringify([planKey, lane]);
}

function normalizeInput(readModel) {
  if (!plain(readModel) || readModel.schema !== 'lattice.todo_store_read.v1'
    || !Array.isArray(readModel.members)) {
    fail('TODO_LAYOUT_INVALID_INPUT', 'read model must be lattice.todo_store_read.v1');
  }

  const notices = []; // u03 D-gantt: a read-only drawing draws what it can and says what it left out
  const nodesByKey = new Map();
  const retiredKeys = new Set(); // 撤去済みtask。端点に持つ辺は図から一緒に消す
  const members = [...readModel.members].sort((left, right) => {
    const leftPlan = left?.plan;
    const rightPlan = right?.plan;
    return compareText(leftPlan?.project_id ?? '', rightPlan?.project_id ?? '')
      || compareText(leftPlan?.plan_key ?? '', rightPlan?.plan_key ?? '');
  });
  for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
    const member = members[memberIndex];
    if (!plain(member) || !plain(member.plan) || !Array.isArray(member.plan.tasks)
      || !Array.isArray(member.tasks) || !Array.isArray(member.plan.hard_dependencies)
      || !Array.isArray(member.plan.joins)) {
      fail('TODO_LAYOUT_INVALID_INPUT', `members[${memberIndex}] has an invalid read-model shape`);
    }
    const { plan } = member;
    const statusByTask = new Map(member.tasks.map((task) => [task.task_id, task]));
    // snapshot artifactの形式(v1にはphasesキーが無い)には縛られない導出ビューを読む
    // (readTodoStoreが常にmember.phasesとして埋める。ADR 0147)。
    const statusByPhase = new Map((member.phases ?? [])
      .map((phase) => [phase.phase_id, phase.status]));
    for (const task of plan.tasks) {
      if (!plain(task) || typeof task.task_id !== 'string' || typeof task.lane !== 'string') {
        fail('TODO_LAYOUT_INVALID_INPUT', 'plan task has an invalid shape');
      }
      const state = statusByTask.get(task.task_id);
      if (!plain(state) || !['pending', 'in-progress', 'blocked', 'retired', 'done'].includes(state.status)) {
        fail('TODO_LAYOUT_INVALID_INPUT', `missing task state for ${task.task_id}`);
      }
      // retiredは「実行されないまま恒久に閉じた」工程。工程図は今とこれからの仕事を表す面なので
      // 描画から除く（理由と履歴はsnapshot/journalが持つ。2026-08-29オーナー裁定「消せ」）。
      if (state.status === 'retired') { retiredKeys.add(refKey({ project_id: plan.project_id, plan_key: plan.plan_key, task_id: task.task_id })); continue; }
      const ref = { project_id: plan.project_id, plan_key: plan.plan_key, task_id: task.task_id };
      const key = refKey(ref);
      if (nodesByKey.has(key)) fail('TODO_LAYOUT_INVALID_INPUT', `duplicate task: ${key}`);
      nodesByKey.set(key, {
        key,
        ref,
        title: typeof task.title === 'string' ? task.title : task.task_id,
        lane: task.lane,
        status: state.status,
        plan_schema: plan.schema ?? null,
        phase_id: task.phase_id ?? null,
        // ADR 0147: phase無しplan(task.phase_idが無い世代)も、終端に暗黙のterminal-audit
        // Phaseを1つ持つ(todo-store.mjsのphasesOf/TERMINAL_AUDIT_PHASE_ID)。ここで素通しせず
        // nullのままにすると、gantt scope側(todo-gantt-scope.mjs)が「監査未了のplanを畳まない」
        // 判定に使える材料を一切受け取れない。'terminal-audit'はTERMINAL_AUDIT_PHASE_IDと同じ
        // 予約IDで、phase_readyの判定(v4だけを見る既存分岐)には影響しない。
        phase_status: task.phase_id === undefined
          ? statusByPhase.get('terminal-audit') ?? null
          : statusByPhase.get(task.phase_id) ?? null,
        phase_ready: plan.schema !== 'lattice.todo_plan.v4'
          || statusByPhase.get(task.phase_id) === 'active',
      });
    }
  }
  const droppedKeys = new Set(); // 上限で描かないtask。端点に持つ辺は黙って除く（通知は件数で済む）
  if (nodesByKey.size > TASK_LIMIT) {
    const kept = [...nodesByKey.values()].sort((left, right) => compareRefs(left.ref, right.ref));
    for (const node of kept.slice(TASK_LIMIT)) { nodesByKey.delete(node.key); droppedKeys.add(node.key); }
    notices.push({
      code: 'TODO_SCALE_EXCEEDED',
      message: `工程数が上限を超えたため、並び順の先頭${TASK_LIMIT}件だけを描いています（${droppedKeys.size}件を除外）`,
      detail: { task_count: kept.length, task_limit: TASK_LIMIT, dropped_task_count: droppedKeys.size },
    });
  }

  const edgeMap = new Map();
  const skippedEdges = [];
  const skipEdge = (from, to, reason) => skippedEdges.push({ from, to, reason });
  const addEdge = (fromValue, toValue, kind, joinIdentity = null) => {
    const fromRef = refOf(fromValue);
    const toRef = refOf(toValue);
    if (fromRef === null || toRef === null) return skipEdge(fromRef && refKey(fromRef), toRef && refKey(toRef), 'not_a_task_ref');
    const from = refKey(fromRef);
    const to = refKey(toRef);
    if (retiredKeys.has(from) || retiredKeys.has(to)) return; // 撤去済み端点の辺は描かない
    if (droppedKeys.has(from) || droppedKeys.has(to)) return;
    if (from === to) return skipEdge(from, to, 'self_edge');
    if (!nodesByKey.has(from) || !nodesByKey.has(to)) return skipEdge(from, to, 'endpoint_not_in_read_model');
    const key = JSON.stringify([from, to]);
    let edge = edgeMap.get(key);
    if (edge === undefined) {
      edge = { key, from, to, kinds: new Set(), joinIdentities: new Map() };
      edgeMap.set(key, edge);
    }
    edge.kinds.add(kind);
    if (joinIdentity !== null) {
      const identityKey = JSON.stringify([
        joinIdentity.project_id, joinIdentity.plan_key, joinIdentity.join_id,
      ]);
      edge.joinIdentities.set(identityKey, joinIdentity);
    }
  };
  for (const member of members) {
    for (const edge of member.plan.hard_dependencies) addEdge(edge?.from, edge?.to, 'hard');
    for (const join of member.plan.joins) {
      if (!plain(join) || !Array.isArray(join.after) || typeof join.id !== 'string') {
        skipEdge(null, null, 'join_invalid_shape');
        continue;
      }
      const identity = { project_id: member.plan.project_id, plan_key: member.plan.plan_key,
        join_id: join.id };
      for (const after of join.after) addEdge(after, join.before, 'join', identity);
    }
  }
  for (const dependency of projectTodoCrossPlanDependencies(members)) {
    addEdge(dependency.from, dependency.to, 'cross_plan');
  }
  if (skippedEdges.length > 0) {
    notices.push({
      code: 'TODO_LAYOUT_INVALID_INPUT',
      message: `端点を図に描けない依存${skippedEdges.length}件を除いて描いています`,
      detail: { skipped_edge_count: skippedEdges.length, skipped_edges: skippedEdges.slice(0, NOTICE_SAMPLE) },
    });
  }

  const nodes = [...nodesByKey.values()].sort((left, right) => compareRefs(left.ref, right.ref));
  let edges = [...edgeMap.values()].sort((left, right) => compareText(left.key, right.key));
  if (edges.length > EDGE_LIMIT) {
    notices.push({
      code: 'TODO_SCALE_EXCEEDED',
      message: `依存数が上限を超えたため、並び順の先頭${EDGE_LIMIT}本だけを描いています（${edges.length - EDGE_LIMIT}本を除外）`,
      detail: { edge_count: edges.length, edge_limit: EDGE_LIMIT, dropped_edge_count: edges.length - EDGE_LIMIT },
    });
    edges = edges.slice(0, EDGE_LIMIT);
  }
  edges = breakCycles(nodes, nodesByKey, edges, notices);
  return { nodes, nodesByKey, edges, retiredKeys, notices };
}

/**
 * u03 D-gantt: a cycle is drawn, not refused. Nodes the topological pass cannot reach (the
 * cycle part, with what hangs off it) are taken in ref order, and each edge among them that
 * points back to an earlier one is left out, so the rest is acyclic and every later step
 * terminates. shortcut: an acyclic edge below a cycle that points back in ref order is left
 * out too; the notice names every cut edge, so upgrade only if that proves misleading.
 */
function breakCycles(nodes, nodesByKey, edges, notices) {
  const indegree = new Map(nodes.map(({ key }) => [key, 0]));
  const outgoing = new Map(nodes.map(({ key }) => [key, []]));
  for (const edge of edges) { indegree.set(edge.to, indegree.get(edge.to) + 1); outgoing.get(edge.from).push(edge.to); }
  const queue = nodes.filter(({ key }) => indegree.get(key) === 0).map(({ key }) => key);
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.pop();
    visited.add(current);
    for (const next of outgoing.get(current)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited.size === nodes.length) return edges;
  const rank = new Map(nodes.filter(({ key }) => !visited.has(key)).map(({ key }, index) => [key, index]));
  const cut = [];
  const kept = edges.filter((edge) => {
    if (!rank.has(edge.from) || !rank.has(edge.to) || rank.get(edge.from) < rank.get(edge.to)) return true;
    cut.push(edge);
    return false;
  });
  notices.push({
    code: 'TODO_LAYOUT_CYCLE',
    message: `依存が循環しているため、循環部分の工程${rank.size}件の戻り方向の依存${cut.length}本を除いて描いています`,
    detail: {
      cycle_task_count: rank.size,
      cycle_tasks: [...rank.keys()].slice(0, NOTICE_SAMPLE).map((key) => nodesByKey.get(key).ref),
      cut_edge_count: cut.length,
      cut_edges: cut.slice(0, NOTICE_SAMPLE).map((edge) => ({
        from: nodesByKey.get(edge.from).ref, to: nodesByKey.get(edge.to).ref,
      })),
    },
  });
  return kept;
}

// u03 D-gantt: the drawing never decides readiness itself. Lattice's readiness (the same one
// status and start use) decides, so a successor of a retired-not-done task is not drawn ready.
function readyTaskKeys(readModel, nodes) {
  // Readiness reads the raw edge lists; hand it only the edges normalizeInput can draw, so a
  // malformed one (skipped with a notice) does not stop the page here.
  const drawable = (edge) => refOf(edge?.from) !== null && refOf(edge?.to) !== null;
  const members = readModel.members.map((member) => ({
    ...member,
    plan: {
      ...member.plan,
      hard_dependencies: member.plan.hard_dependencies.filter(drawable),
      joins: member.plan.joins.filter((join) => plain(join) && Array.isArray(join.after)
        && join.after.every((after) => refOf(after) !== null) && refOf(join.before) !== null),
    },
  }));
  const readiness = createTodoReadiness({ ...readModel, members });
  return new Set(nodes.filter((node) => readiness.isReady(readiness.key(node.ref))).map(({ key }) => key));
}

function assignWaves(nodes, nodesByKey, edges) {
  const incoming = new Map(nodes.map(({ key }) => [key, []]));
  const outgoing = new Map(nodes.map(({ key }) => [key, []]));
  const indegree = new Map(nodes.map(({ key }) => [key, 0]));
  for (const edge of edges) {
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  for (const values of incoming.values()) values.sort(compareText);
  for (const values of outgoing.values()) values.sort(compareText);
  let ready = nodes.filter(({ key }) => indegree.get(key) === 0).map(({ key }) => key);
  ready.sort((left, right) => compareRefs(nodesByKey.get(left).ref, nodesByKey.get(right).ref));
  const wave = new Map(nodes.map(({ key }) => [key, 0]));
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift();
    visited += 1;
    for (const next of outgoing.get(current)) {
      wave.set(next, Math.max(wave.get(next), wave.get(current) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort((left, right) => compareRefs(nodesByKey.get(left).ref, nodesByKey.get(right).ref));
      }
    }
  }
  // normalizeInput's breakCycles leaves no cycle; this only guards that invariant.
  if (visited !== nodes.length) fail('TODO_LAYOUT_CYCLE', 'todo layout input contains a cycle');
  return { incoming, outgoing, wave };
}

function median(values) {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function orderLayers(nodes, wave, incoming, outgoing) {
  const maximumWave = nodes.reduce((maximum, node) => Math.max(maximum, wave.get(node.key)), 0);
  const layers = Array.from({ length: maximumWave + 1 }, () => []);
  for (const node of nodes) layers[wave.get(node.key)].push(node.key);
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const baseCompare = (leftKey, rightKey) => {
    const left = nodeByKey.get(leftKey);
    const right = nodeByKey.get(rightKey);
    return compareText(left.lane, right.lane)
      || compareText(left.ref.plan_key, right.ref.plan_key)
      || compareRefs(left.ref, right.ref);
  };
  for (const layer of layers) layer.sort(baseCompare);

  const reorder = (layerIndex, neighborMap) => {
    const layer = layers[layerIndex];
    const previousPosition = new Map(layer.map((key, index) => [key, index]));
    const allPositions = new Map();
    for (const otherLayer of layers) {
      for (let index = 0; index < otherLayer.length; index += 1) allPositions.set(otherLayer[index], index);
    }
    const score = new Map(layer.map((key) => [key, median(
      neighborMap.get(key).filter((neighbor) => allPositions.has(neighbor)).map((neighbor) => allPositions.get(neighbor)),
    )]));
    layer.sort((leftKey, rightKey) => {
      const left = nodeByKey.get(leftKey);
      const right = nodeByKey.get(rightKey);
      const groupOrder = compareText(left.lane, right.lane)
        || compareText(left.ref.plan_key, right.ref.plan_key);
      if (groupOrder !== 0) return groupOrder;
      const leftScore = score.get(leftKey);
      const rightScore = score.get(rightKey);
      if (leftScore !== null && rightScore !== null && leftScore !== rightScore) return leftScore - rightScore;
      if (leftScore === null && rightScore !== null) return 1;
      if (leftScore !== null && rightScore === null) return -1;
      return previousPosition.get(leftKey) - previousPosition.get(rightKey) || baseCompare(leftKey, rightKey);
    });
  };

  for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
    for (let layer = 1; layer < layers.length; layer += 1) reorder(layer, incoming);
    for (let layer = layers.length - 2; layer >= 0; layer -= 1) reorder(layer, outgoing);
  }
  return layers;
}

function crossingCount(edges, wave, transversePosition) {
  const groups = new Map();
  for (const edge of edges) {
    const pair = `${wave.get(edge.from)}\0${wave.get(edge.to)}`;
    if (!groups.has(pair)) groups.set(pair, []);
    groups.get(pair).push([transversePosition.get(edge.from), transversePosition.get(edge.to)]);
  }
  let total = 0;
  for (const group of groups.values()) {
    group.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const targets = [...new Set(group.map((entry) => entry[1]))].sort((left, right) => left - right);
    const rank = new Map(targets.map((value, index) => [value, index + 1]));
    const tree = new Uint32Array(targets.length + 1);
    let seen = 0;
    for (const [, target] of group) {
      let prefix = 0;
      for (let index = rank.get(target); index > 0; index -= index & -index) prefix += tree[index];
      total += seen - prefix;
      for (let index = rank.get(target); index < tree.length; index += index & -index) tree[index] += 1;
      seen += 1;
    }
  }
  return total;
}

/**
 * plan別の独立性投影を、task refで引ける索引と図の外が語る要約へ畳む（ADR 0129 Decision 4）。
 *
 * 読み出しはasync I/Oとgit実行を伴うためCLI層が行い、ここへは値として渡る。
 * layoutは同期pureのままに保つ。
 */
function normalizeIndependence(value, nodesByKey, notices) {
  if (value === null || value === undefined) return { stateByKey: new Map(), summary: null };
  if (!Array.isArray(value)) {
    fail('TODO_LAYOUT_INVALID_INPUT', 'independence must be an array of plan projections');
  }
  const stateByKey = new Map();
  const plans = [];
  const drifted = [];
  for (const projection of value) {
    if (!plain(projection) || typeof projection.plan_key !== 'string'
      || typeof projection.coverage !== 'string' || !plain(projection.frontier)) {
      fail('TODO_LAYOUT_INVALID_INPUT', 'independence entry must carry plan_key, coverage and frontier');
    }
    const { plan_key: planKey, frontier } = projection;
    const mark = (taskId, state) => {
      const key = refKey({
        project_id: projection.project_id, plan_key: planKey, task_id: taskId,
      });
      // 図に無いtaskへ状態を付けない。layoutのready判定と投影のready判定が食い違えば、
      // 印を付けずに通知で露見させる（読むだけの図は拒まない）。
      if (!nodesByKey.has(key)) {
        drifted.push({ plan_key: planKey, task_id: taskId });
        return;
      }
      stateByKey.set(key, state);
    };
    for (const group of frontier.parallel_groups ?? []) {
      for (const taskId of group.task_ids) mark(taskId, 'verified');
    }
    for (const pair of frontier.serialize_pairs ?? []) {
      for (const taskId of pair.task_ids) mark(taskId, 'conflict');
    }
    for (const entry of frontier.conflicts_with_active ?? []) mark(entry.ready_task_id, 'conflict');
    for (const entry of frontier.unknown ?? []) mark(entry.task_id, 'unknown');
    plans.push({
      plan_key: planKey,
      coverage: projection.coverage,
      verified_group_count: (frontier.parallel_groups ?? []).length,
      verified_task_count: (frontier.parallel_groups ?? [])
        .reduce((total, group) => total + group.task_ids.length, 0),
      serialize_pairs: (frontier.serialize_pairs ?? []).map((pair) => ({
        task_ids: [...pair.task_ids], type: pair.type, detail: pair.detail,
        kind: pair.kind ?? null, severability: pair.severability ?? 'serial',
      })),
      conflicts_with_active: (frontier.conflicts_with_active ?? []).map((entry) => ({
        ready_task_id: entry.ready_task_id, active_task_id: entry.active_task_id,
        type: entry.type, detail: entry.detail,
        kind: entry.kind ?? null, severability: entry.severability ?? 'serial',
      })),
      unknown_task_ids: (frontier.unknown ?? []).map(({ task_id: taskId }) => taskId).sort(compareText),
    });
  }
  plans.sort((left, right) => compareText(left.plan_key, right.plan_key));
  if (drifted.length > 0) {
    notices.push({
      code: 'TODO_LAYOUT_INDEPENDENCE_DRIFT',
      message: `独立性の記録が図に無い工程${drifted.length}件を指しているため、その工程には印を付けていません`,
      detail: { drifted_count: drifted.length, drifted_tasks: drifted.slice(0, NOTICE_SAMPLE) },
    });
  }
  return { stateByKey, summary: { plans } };
}

/**
 * seam proposalの公開投影を、描画に必要なhuman-facing fieldだけへ畳む。
 * resource_idは記録のidentityであって表示名ではないため、layoutへ持ち込まない。
 */
function normalizeSeamProposals(value) {
  if (value === null || value === undefined) return { summary: null };
  if (!Array.isArray(value)) {
    fail('TODO_LAYOUT_INVALID_INPUT', 'seamProposals must be an array of plan projections');
  }
  const plans = value.map((projection) => {
    if (!plain(projection) || typeof projection.project_id !== 'string'
      || typeof projection.plan_key !== 'string'
      || !['missing', 'superseded', 'stale', 'verified'].includes(projection.coverage)
      || !plain(projection.guidance)
      || typeof projection.guidance.code !== 'string'
      || typeof projection.guidance.message !== 'string'
      || typeof projection.guidance.next_action !== 'string'
      || !Array.isArray(projection.components)) {
      fail('TODO_LAYOUT_INVALID_INPUT', 'seam proposal entry has an invalid projection shape');
    }
    return {
      project_id: projection.project_id,
      plan_key: projection.plan_key,
      coverage: projection.coverage,
      guidance: { ...projection.guidance },
      component_count: projection.component_count,
      conflict_resource_count: projection.conflict_resource_count,
      components: projection.components.map((component) => {
        if (!plain(component) || typeof component.component_id !== 'string'
          || typeof component.verdict !== 'string'
          || !Array.isArray(component.task_ids)
          || !Array.isArray(component.conflicts)
          || !Array.isArray(component.proposed_surfaces)
          || !Array.isArray(component.affected_tests)
          || !Array.isArray(component.limits)
          || !Array.isArray(component.reasons)
          || !Array.isArray(component.unknowns)) {
          fail('TODO_LAYOUT_INVALID_INPUT', 'seam proposal component has an invalid shape');
        }
        return {
          component_id: component.component_id,
          verdict: component.verdict,
          task_ids: [...component.task_ids],
          conflicts: component.conflicts.map((conflict) => {
            if (!plain(conflict) || typeof conflict.kind !== 'string'
              || typeof conflict.target !== 'string' || !Array.isArray(conflict.task_pairs)) {
              fail('TODO_LAYOUT_INVALID_INPUT', 'seam proposal conflict has an invalid shape');
            }
            return {
              kind: conflict.kind,
              target: conflict.target,
              task_pairs: conflict.task_pairs.map((pair) => [...pair]),
            };
          }),
          proposed_surfaces: component.proposed_surfaces.map((surface) => ({ ...surface,
            owner_task_ids: [...surface.owner_task_ids] })),
          affected_tests: [...component.affected_tests],
          limits: [...component.limits],
          reasons: component.reasons.map((reason) => ({ ...reason })),
          unknowns: component.unknowns.map((unknown) => ({ ...unknown })),
        };
      }),
    };
  });
  plans.sort((left, right) => {
    const leftHasDecisions = left.components.length > 0;
    const rightHasDecisions = right.components.length > 0;
    return leftHasDecisions === rightHasDecisions
      ? compareText(left.plan_key, right.plan_key) : leftHasDecisions ? -1 : 1;
  });
  return { summary: { plans } };
}

function layoutTodoGanttFlat(readModel, options = {}) {
  const scope = options.scope ?? 'live';
  if (!TODO_GANTT_SCOPES.includes(scope)) {
    fail('TODO_LAYOUT_INVALID_INPUT', `scope must be one of ${TODO_GANTT_SCOPES.join(', ')}`);
  }

  // Every structural number below is measured on the FULL graph: the dependency
  // waves, the longest dependency chain and the ready frontier describe the real
  // plan. Folding first and measuring second would make all three lie.
  const full = normalizeInput(readModel);
  const fullWaves = assignWaves(full.nodes, full.nodesByKey, full.edges);
  // 経路と配置は同じ正規化済みgraphから導出し、退役前の別graphを持ち込まない。
  const chain = projectTodoChainV1({
    nodes: full.nodes.map(node => node.ref),
    hard_edges: full.edges.map(edge => ({ from: full.nodesByKey.get(edge.from).ref, to: full.nodesByKey.get(edge.to).ref })),
    joins: [],
  });
  const longestNodeKeys = new Set(chain.longest_chain_node_refs.map(refKey));
  const longestEdgeKeys = new Set(chain.longest_chain_edges.map(edge => JSON.stringify([refKey(edge.from), refKey(edge.to)])));
  const readyKeys = readyTaskKeys(readModel, full.nodes);
  const independence = normalizeIndependence(options.independence ?? null, full.nodesByKey, full.notices);
  const seamProposals = normalizeSeamProposals(options.seamProposals ?? null);

  // Only the geometry stage below sees the narrowed graph.
  const projected = scope === 'all'
    ? { nodes: full.nodes, edges: full.edges, foldedKeys: new Set() }
    : projectTodoGanttScope({ nodes: full.nodes, edges: full.edges, wave: fullWaves.wave });
  const nodes = projected.nodes;
  const edges = projected.edges;
  const nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  const { incoming, outgoing, wave } = assignWaves(nodes, nodesByKey, edges);
  const layers = orderLayers(nodes, wave, incoming, outgoing);
  // A ToDo with no registered dependency has nothing to line up with. Laying
  // every one of them out in a single row makes the canvas as wide as the plan
  // is old — real stores have hundreds — so they wrap into a block of rows.
  //
  // That block goes ABOVE the wired ToDos of its stage. Below them it used to be
  // pierced: a wired card's port descends from its own bottom edge to the routing
  // band under the whole stage, straight through whatever independent card had
  // wrapped into the same column, and the hidden half of that line read as a
  // dependency the plan does not have. Independent ToDos carry no edge, so they
  // have no incoming one either and always land in stage 0, which nothing ever
  // arrives into — putting them on top leaves no line to cross them.
  const wired = new Set();
  for (const edge of edges) { wired.add(edge.from); wired.add(edge.to); }
  const transversePosition = new Map();
  const stageRow = new Map();
  const stageRowCount = [];
  for (const layer of layers) {
    const connected = layer.filter((key) => wired.has(key));
    const loose = layer.filter((key) => !wired.has(key));
    const columns = Math.max(LOOSE_COLUMNS_MINIMUM, connected.length);
    const looseRows = loose.length === 0 ? 0 : Math.ceil(loose.length / columns);
    loose.forEach((key, index) => {
      transversePosition.set(key, index % columns);
      stageRow.set(key, Math.floor(index / columns));
    });
    connected.forEach((key, index) => {
      transversePosition.set(key, index);
      stageRow.set(key, looseRows);
    });
    stageRowCount.push(Math.max(0, ...layer.map((key) => stageRow.get(key))) + 1);
  }
  const maximumLayerWidth = Math.max(1,
    ...[...transversePosition.values()].map((position) => position + 1));
  const visibleKeys = new Set(nodes.map(({ key }) => key));
  const displayBranches = edges.flatMap((edge, semanticIndex) => {
    const identities = [...edge.joinIdentities.entries()]
      .sort(([left], [right]) => compareText(left, right)).map(([, identity]) => identity);
    const variants = identities.length === 0 ? [null] : identities;
    return variants.map((joinIdentity, branchIndex) => ({
      key: JSON.stringify([edge.key, joinIdentity]), edge, semanticIndex, branchIndex, joinIdentity,
    }));
  });

  const gapGroups = new Map();
  const portGroups = new Map();
  const portGroupKey = (gap, row) => `${gap}\0${row}`;
  const portEntryKey = (edgeKey, direction) => `${edgeKey}\0${direction}`;
  const addPort = (gap, row, entry) => {
    const key = portGroupKey(gap, row);
    if (!portGroups.has(key)) portGroups.set(key, []);
    portGroups.get(key).push(entry);
  };
  // 隣の段の真下へ繋ぐ辺は、出発と到着が同じ取り付け位置の集合を奪い合う。別々の
  // 枠を取ると2本の縦線が12pxずれて短い横棒で継がれ、まっすぐ引ける線が段差付きに
  // 見える。両端の縦線は帯の中で1点で接するだけなので、1枠を共有させて直線にする。
  const sharedPort = new Set();
  displayBranches.forEach((branch) => {
    const { edge } = branch;
    for (const gap of new Set([wave.get(edge.from), wave.get(edge.to) - 1])) {
      if (!gapGroups.has(gap)) gapGroups.set(gap, []);
      gapGroups.get(gap).push(branch.key);
    }
    const departureGap = wave.get(edge.from);
    const fromColumn = transversePosition.get(edge.from);
    const toColumn = transversePosition.get(edge.to);
    if (departureGap === wave.get(edge.to) - 1 && fromColumn === toColumn) {
      sharedPort.add(branch.key);
      addPort(departureGap, fromColumn, portEntryKey(branch.key, 'through'));
      return;
    }
    addPort(departureGap, fromColumn, portEntryKey(branch.key, 'departure'));
    addPort(wave.get(edge.to) - 1, toColumn, portEntryKey(branch.key, 'arrival'));
  });
  for (const keys of gapGroups.values()) keys.sort(compareText);
  for (const entries of portGroups.values()) entries.sort(compareText);
  const maximumPortTraffic = Math.max(0, ...[...portGroups.values()].map(({ length }) => length));
  const connectorGroupKeysByGap = new Map();
  for (const branch of displayBranches) {
    if (branch.joinIdentity === null) continue;
    const targetGap = wave.get(branch.edge.to) - 1;
    if (!connectorGroupKeysByGap.has(targetGap)) connectorGroupKeysByGap.set(targetGap, new Set());
    connectorGroupKeysByGap.get(targetGap).add(JSON.stringify([branch.edge.to, branch.joinIdentity]));
  }
  const allGapIndexes = new Set([...gapGroups.keys(), ...connectorGroupKeysByGap.keys()]);
  const maximumGapOccupancy = Math.max(0, ...[...allGapIndexes].map((gap) =>
    (gapGroups.get(gap)?.length ?? 0) + (connectorGroupKeysByGap.get(gap)?.size ?? 0)));
  // An edge that skips a stage has to travel vertically past the stages in
  // between. It used to do that in a corridor beyond the right edge of the
  // whole diagram, so a local hop between two neighbouring cards was drawn as a
  // trip to the far right and back. It now descends through the vertical
  // channel between two columns of cards, chosen from the boundaries that lie
  // between its endpoints. Every card sits on the same column grid, so those
  // gaps are free of cards at every stage: routing inside one is both shorter
  // to follow and structurally unable to cross a card.
  const channelLoad = new Map();
  const channelAssignment = new Map();
  const channelTraffic = (boundary) => channelLoad.get(boundary) ?? 0;
  for (const branch of [...displayBranches].sort((left, right) => compareText(left.key, right.key))) {
    const { edge } = branch;
    if (wave.get(edge.from) === wave.get(edge.to) - 1) continue;
    const fromColumn = transversePosition.get(edge.from);
    const toColumn = transversePosition.get(edge.to);
    const [first, last] = fromColumn === toColumn
      ? [toColumn, toColumn + 1]
      : [Math.min(fromColumn, toColumn) + 1, Math.max(fromColumn, toColumn)];
    let chosen = first;
    for (let boundary = first + 1; boundary <= last; boundary += 1) {
      const closer = Math.abs(boundary - toColumn) < Math.abs(chosen - toColumn);
      if (channelTraffic(boundary) < channelTraffic(chosen)
        || (channelTraffic(boundary) === channelTraffic(chosen) && closer)) chosen = boundary;
    }
    channelAssignment.set(branch.key, { boundary: chosen, lane: channelTraffic(chosen) });
    channelLoad.set(chosen, channelTraffic(chosen) + 1);
  }

  const nodeWidth = Math.max(GEOMETRY.node_width,
    GEOMETRY.route_inset * 2 + (maximumPortTraffic + 1) * GEOMETRY.route_spacing);
  // Only the boundaries that actually carry channels pay for them. Boundary 0
  // is the margin left of the first column and only exists when something
  // routes there, so an untravelled diagram keeps its original left edge.
  const channelWidth = (boundary) => Math.max(24,
    (channelTraffic(boundary) + 1) * GEOMETRY.route_spacing);
  const columnLeft = [GEOMETRY.left + (channelTraffic(0) === 0 ? 0 : channelWidth(0))];
  for (let column = 1; column < maximumLayerWidth; column += 1) {
    columnLeft.push(columnLeft[column - 1] + nodeWidth + channelWidth(column));
  }
  const channelPosition = (edgeKey) => {
    const { boundary, lane } = channelAssignment.get(edgeKey);
    const left = boundary === 0 ? GEOMETRY.left : columnLeft[boundary - 1] + nodeWidth;
    return left + GEOMETRY.route_spacing * (lane + 1);
  };
  // Each routing band is sized for the edges that actually cross it. One
  // crowded band used to set the spacing for every stage in the diagram, so a
  // long plan paid the width of its busiest junction on all of its stages.
  const gapBand = (gap) => Math.max(36, ((gapGroups.get(gap)?.length ?? 0)
    + (connectorGroupKeysByGap.get(gap)?.size ?? 0) + 1) * GEOMETRY.route_spacing);
  const stageHeight = (index) => stageRowCount[index] * GEOMETRY.node_height
    + (stageRowCount[index] - 1) * GEOMETRY.stage_row_gap;
  const stageTop = [GEOMETRY.top];
  for (let index = 0; index + 1 < layers.length; index += 1) {
    stageTop.push(stageTop[index] + stageHeight(index) + gapBand(index));
  }

  const coordinates = new Map();
  const projectedNodes = nodes.map((node) => {
    const visible = visibleKeys.has(node.key);
    const geometry = visible ? {
      x: columnLeft[transversePosition.get(node.key)],
      y: stageTop[wave.get(node.key)]
        + stageRow.get(node.key) * (GEOMETRY.node_height + GEOMETRY.stage_row_gap),
      width: nodeWidth,
      height: GEOMETRY.node_height,
    } : null;
    if (geometry !== null) coordinates.set(node.key, geometry);
    return {
      ref: { ...node.ref }, title: node.title, lane: node.lane, status: node.status,
      wave: wave.get(node.key), row: transversePosition.get(node.key), visible,
      visibility: {
        longest_dependency_chain: longestNodeKeys.has(node.key),
        active: node.status === 'in-progress', next_ready: readyKeys.has(node.key),
        selected: false,
        // 記録が語らないtaskはnull。「独立と分かっている」と「まだ何も言えない」を
        // 図の上でも同じ顔にしない（ADR 0129 Decision 1）。
        independence: independence.stateByKey.get(node.key) ?? null,
      },
      geometry,
    };
  });

  const gapPosition = (edgeKey, waveIndex) => {
    const keys = gapGroups.get(waveIndex);
    const index = keys.indexOf(edgeKey);
    return stageTop[waveIndex] + stageHeight(waveIndex)
      + GEOMETRY.route_spacing * (index + 1);
  };
  const branchCounts = new Map();
  for (const branch of displayBranches) {
    branchCounts.set(branch.semanticIndex, (branchCounts.get(branch.semanticIndex) ?? 0) + 1);
  }
  const portPosition = (edgeKey, direction, gap, row, nodeX) => {
    const entries = portGroups.get(portGroupKey(gap, row));
    const entry = portEntryKey(edgeKey, sharedPort.has(edgeKey) ? 'through' : direction);
    return nodeX + GEOMETRY.route_inset
      + GEOMETRY.route_spacing * (entries.indexOf(entry) + 1);
  };

  const projectedEdges = displayBranches.map((branch) => {
    const { edge } = branch;
    const onLongestChain = longestEdgeKeys.has(edge.key);
    const from = coordinates.get(edge.from);
    const to = coordinates.get(edge.to);
    const departureGap = wave.get(edge.from);
    const arrivalGap = wave.get(edge.to) - 1;
    const startX = portPosition(branch.key, 'departure', departureGap,
      transversePosition.get(edge.from), from.x);
    const startY = from.y + from.height;
    const endX = portPosition(branch.key, 'arrival', arrivalGap,
      transversePosition.get(edge.to), to.x);
    const endY = to.y;
    const departureY = gapPosition(branch.key, departureGap);
    const arrivalY = gapPosition(branch.key, arrivalGap);
    const corners = [[startX, startY], [startX, departureY]];
    if (departureGap === arrivalGap) corners.push([endX, arrivalY]);
    else {
      const channelX = channelPosition(branch.key);
      corners.push([channelX, departureY], [channelX, arrivalY], [endX, arrivalY]);
    }
    corners.push([endX, endY]);
    // 1枠を共有する直線では折れ点が重なる。長さゼロの区間を残すと交差判定にも
    // 描画にも意味のない点が混ざるので畳む。
    const route = corners.filter(([x, y], index) =>
      index === 0 || x !== corners[index - 1][0] || y !== corners[index - 1][1]);
    return {
      id: branchCounts.get(branch.semanticIndex) === 1
        ? `edge-${branch.semanticIndex}` : `edge-${branch.semanticIndex}-join-${branch.branchIndex}`,
      semantic_edge_id: `edge-${branch.semanticIndex}`,
      from: { ...nodesByKey.get(edge.from).ref }, to: { ...nodesByKey.get(edge.to).ref },
      kinds: [...edge.kinds].sort(compareText),
      join_ids: branch.joinIdentity === null ? [] : [branch.joinIdentity.join_id],
      join_owners: branch.joinIdentity === null ? [] : [{ ...branch.joinIdentity }],
      visible: true, visibility: { longest_dependency_chain: onLongestChain, selected_incident: false },
      route, bridges: [], junction: null,
    };
  });
  const joinGroups = new Map();
  for (const edge of projectedEdges) {
    if (edge.join_ids.length === 0) continue;
    const key = JSON.stringify([edge.to, edge.join_owners[0]]);
    if (!joinGroups.has(key)) joinGroups.set(key, []);
    joinGroups.get(key).push(edge);
  }
  const junctionConnectors = [];
  const logicalContacts = new Set();
  const connectorGapRanks = new Map();
  for (const [, group] of [...joinGroups.entries()].sort(([left], [right]) => compareText(left, right))) {
    group.sort((left, right) => compareText(left.id, right.id));
    const target = coordinates.get(refKey(group[0].to));
    const targetGap = wave.get(refKey(group[0].to)) - 1;
    const groupRank = connectorGapRanks.get(targetGap) ?? 0;
    connectorGapRanks.set(targetGap, groupRank + 1);
    const primaryTargetPortX = group[0].route.at(-1)[0];
    const junction = [primaryTargetPortX,
      stageTop[targetGap] + stageHeight(targetGap)
        + GEOMETRY.route_spacing * ((gapGroups.get(targetGap)?.length ?? 0) + groupRank + 1)];
    const contacts = [];
    for (const [index, edge] of group.entries()) {
      edge.route.pop();
      const contact = [edge.route.at(-1)[0], junction[1]];
      if (edge.route.at(-1)[1] !== contact[1]) edge.route.push(contact);
      contacts.push(contact);
      logicalContacts.add(`${contact[0]},${contact[1]}`);
      if (index === 0) {
        edge.route.push([junction[0], target.y]);
        edge.junction = junction;
      }
    }
    const contactXs = contacts.map(([x]) => x);
    if (Math.min(...contactXs) !== Math.max(...contactXs)) {
      junctionConnectors.push({
        id: `join-connector-${junctionConnectors.length}`,
        join_ids: [...group[0].join_ids], join_owners: group[0].join_owners.map((owner) => ({ ...owner })),
        route: [[Math.min(...contactXs), junction[1]], [Math.max(...contactXs), junction[1]]],
        bridges: [], contacts,
      });
    }
  }
  addCrossingBridges([...projectedEdges, ...junctionConnectors], logicalContacts);
  let routeMaximumX = nodes.length === 0 ? 0
    : columnLeft[maximumLayerWidth - 1] + nodeWidth;
  for (const edge of projectedEdges) {
    for (const [x] of edge.route) routeMaximumX = Math.max(routeMaximumX, x);
  }
  for (const connector of junctionConnectors) {
    for (const [x] of connector.route) routeMaximumX = Math.max(routeMaximumX, x);
  }

  // Counts stay honest: the summary chips report every ToDo in the plan, not
  // only the ones the narrowed diagram happens to draw.
  const planMap = new Map();
  const laneMap = new Map();
  for (const node of full.nodes) {
    if (!planMap.has(node.ref.plan_key)) planMap.set(node.ref.plan_key, 0);
    planMap.set(node.ref.plan_key, planMap.get(node.ref.plan_key) + 1);
    const key = groupKey(node.ref.plan_key, node.lane);
    if (!laneMap.has(key)) laneMap.set(key, { plan_key: node.ref.plan_key, lane: node.lane, task_count: 0 });
    laneMap.get(key).task_count += 1;
  }
  return {
    schema: 'lattice.todo_gantt_layout.v2',
    assumptions: { logical_time: 'dependency_wave', duration_estimation: false, lane_is_presentation_only: true },
    sweep: { method: 'stable_median', rounds: SWEEP_ROUNDS, tie_break: 'previous_position_then_task_ref' },
    bounds: {
      width: nodes.length === 0 ? 0 : routeMaximumX + GEOMETRY.left,
      height: nodes.length === 0 ? 0
        : GEOMETRY.top + stageTop.at(-1) + stageHeight(layers.length - 1),
      wave_count: layers.length,
    },
    nodes: projectedNodes,
    // 図の外が語るための投影。カードはバッジで状態だけを示し、相手と理由は右ペインが持つ。
    independence: independence.summary,
    // seam提案は図形を増やさず、右ペインで係争資源・ToDo組・判定・不足証拠をまとめて示す。
    seam_proposals: seamProposals.summary,
    edges: projectedEdges,
    // Every dependency in the plan, before folding contracted any of them away.
    // The diagram draws `edges`; anything that describes a ToDo in words — the
    // premises and successors in the right pane — reads this instead, so a
    // folded ToDo keeps telling the truth about what it depended on.
    full_edges: full.edges.map((edge) => ({
      from: { ...full.nodesByKey.get(edge.from).ref },
      to: { ...full.nodesByKey.get(edge.to).ref },
      kinds: [...edge.kinds].sort(compareText),
      join_ids: [...edge.joinIdentities.values()].map(({ join_id }) => join_id).sort(compareText),
    })),
    connectors: junctionConnectors,
    groups: {
      plans: [...planMap.entries()].map(([plan_key, task_count]) => ({ plan_key, task_count })),
      lanes: [...laneMap.values()],
    },
    scope: {
      requested: scope,
      folded_task_count: projected.foldedKeys.size,
    },
    // The ToDos the diagram no longer draws. They stay in the task index and in
    // every count, so the reader can still reach them by name.
    folded: [...projected.foldedKeys]
      .map((taskKey) => JSON.parse(taskKey))
      .map(([project_id, plan_key, task_id]) => ({ project_id, plan_key, task_id }))
      .sort(compareRefs),
    // u03 D-gantt: what the drawing left out or bent instead of refusing, each as {code, message, detail}.
    // Absent when there is nothing to say, so a clean layout keeps its bytes (and digest).
    ...(full.notices.length > 0 ? { notices: full.notices } : {}),
    metrics: {
      crossing_count: crossingCount(edges, wave, transversePosition),
      visible_node_count: visibleKeys.size,
      visible_edge_count: projectedEdges.filter(({ visible }) => visible).length,
      task_count: full.nodes.length,
      edge_count: full.edges.length,
    },
  };
}

function applyHierarchySemantics(level, semanticByKey) {
  const layout = {
    ...level.layout,
    nodes: level.layout.nodes.map((node) => {
      const semantic = semanticByKey.get(refKey(node.ref));
      return semantic === undefined ? node : { ...node, visibility: { ...semantic.visibility } };
    }),
  };
  return {
    layout,
    children: level.children.map((child) => ({
      ...child,
      level: applyHierarchySemantics(child.level, semanticByKey),
    })),
  };
}

function descendantNodes(level) {
  return level.children.flatMap((child) => [
    ...child.level.layout.nodes,
    ...descendantNodes(child.level),
  ]);
}

export function layoutTodoGantt(readModel, options = {}) {
  const fullLayout = layoutTodoGanttFlat(readModel, options);
  let nested;
  try {
    const visibleTaskKeys = (options.scope ?? 'live') === 'all' ? null
      : new Set(fullLayout.nodes.map((node) => refKey(node.ref)));
    nested = buildTodoGanttHierarchy(
      readModel, options, layoutTodoGanttFlat, visibleTaskKeys,
    );
  } catch (error) {
    if (error?.code !== 'TODO_LAYOUT_INVALID_HIERARCHY') throw error;
    fail(error.code, error.message, error.detail);
  }
  if (nested === null) return fullLayout;

  // 階層ごとの縮約graphは座標だけを決める。ready/最長鎖/独立性まで縮約graphで
  // 再計算すると、未完の子を持つdone親が後続をreadyへ進めるなど、実graphと違う判断を描く。
  const semanticLayout = options.scope === 'all'
    ? fullLayout : layoutTodoGanttFlat(readModel, { ...options, scope: 'all' });
  const semanticByKey = new Map(semanticLayout.nodes.map((node) => [refKey(node.ref), node]));
  const semanticRoot = applyHierarchySemantics(nested.root, semanticByKey);
  // The levels' own notices repeat or partly cover the whole graph's; the whole graph's are the ones to show.
  const { notices: _levelNotices, ...rootLayout } = semanticRoot.layout;
  return {
    ...rootLayout,
    full_edges: fullLayout.full_edges,
    groups: fullLayout.groups,
    ...(fullLayout.notices === undefined ? {} : { notices: fullLayout.notices }),
    scope: fullLayout.scope,
    folded: fullLayout.folded,
    hierarchy_nodes: descendantNodes(semanticRoot),
    metrics: {
      ...rootLayout.metrics,
      visible_node_count: nested.metrics.visibleNodeCount,
      visible_edge_count: nested.metrics.visibleEdgeCount,
      task_count: fullLayout.metrics.task_count,
      edge_count: fullLayout.metrics.edge_count,
    },
    hierarchy: {
      schema: 'lattice.todo_gantt_hierarchy.v1',
      children: semanticRoot.children,
      maximum_depth: nested.metrics.maximumDepth,
      task_count: nested.metrics.taskCount,
    },
  };
}
