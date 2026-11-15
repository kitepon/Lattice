/**
 * Todo Gantt scope projection.
 *
 * The store carries every completed ToDo forward across plan revisions on
 * purpose — an accepted artifact is the predecessor of the work that follows
 * it. That makes the dependency diagram grow monotonically: once a campaign
 * finishes, its whole tree stays on screen forever and every later revision
 * stacks on top of it. The journal is the source of truth, so nothing is
 * removed from the store; the diagram is a projection, and this module is
 * where that projection narrows.
 *
 * The rule is "drop the dead branches": a completed ToDo that no longer leads
 * to any live work is history, and history leaves the diagram entirely.
 * Completed ToDos that are still the direct premise of live work stay visible,
 * because they are the context for what is dispatchable right now.
 *
 * Summarising history into placeholder nodes was tried and is worse than
 * drawing nothing: a summary box still occupies a column, so the diagram stays
 * as wide as the finished plans ever made it while saying nothing a reader
 * acts on. The count belongs in the legend and the ToDos themselves belong in
 * the task index; neither needs floor space in the graph.
 *
 * This module is pure graph math over the layout's internal node/edge shape.
 * It must run AFTER dependency waves, the longest dependency chain and the
 * ready frontier have been computed on the FULL graph — those numbers describe
 * the real plan, and measuring them on a narrowed graph would make them lie.
 */

import { isAuditPendingPhaseStatus } from './todo-audit-pending.mjs';

export const TODO_GANTT_SCOPES = Object.freeze(['live', 'all']);

/**
 * Hops of completed predecessors kept in front of live work. 1 = keep the
 * direct premises of live ToDos, drop everything upstream of them.
 */
export const DEFAULT_FOLD_DISTANCE = 1;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * ADR 0147: phase無しplan(v1/v2/v3)は終端の暗黙Phase(terminal-audit)がacceptedになるまで
 * 「閉じた」ことにならない。全taskがdoneでも監査未了なら、そのplanのToDoは生きた作業と同じ
 * 扱い(distance 0)にして畳ませない——畳んでしまうと監査前であることが図から消え、
 * ADR 0147が塞ごうとした「一度も重監査を通らず完走した」事故と外形が同じになる。
 *
 * v4/v5(phaseを宣言したplan)はこの判定の対象外にする——既存のPhase gateが重監査を担って
 * おり、ここで同じ規律を足すとPhase単位の既存fold挙動を変えてしまう(非目標)。
 * `phase_status`はレイアウト層(todo-gantt-layout.mjs)がplanの世代を問わず埋める。
 * phase無しplanのtaskにはphase_idフィールド自体が無いため、そこでは暗黙Phaseの状態を
 * 埋める。フィールドが無い/nullの入力(既存test・素のnode)は従来どおり対象外(false)になる。
 *
 * 監査前の状態集合そのものは`todo-audit-pending.mjs`が持つ(gate_ready・reviewing・rejected)。
 * `active`(一部taskがまだpending)が入っていないことにここも依存している——ここまで
 * 広げると、完走していない枝の通常foldまで止めてしまい既存挙動を変える。
 *
 * 下のv4/v5除外は共有moduleへ移さない。あれは「監査前とは何か」の定義ではなく、
 * ganttがどこまでfoldを止めるかという本moduleの方針である。移すと、宣言Phase planの
 * fold挙動を他の消費者の都合で変えてしまう。
 */
function auditPending(node) {
  if (!isAuditPendingPhaseStatus(node.phase_status)) return false;
  const schema = node.plan_schema ?? null;
  return !['lattice.todo_plan.v4', 'lattice.todo_plan.v5'].includes(schema);
}

/**
 * Forward distance from each node to the nearest live (non-done) node, over the
 * dependency DAG. A live node is at distance 0; a node with no live descendant
 * is at Infinity. A done node whose plan's terminal audit (ADR 0147) has not
 * been accepted is also pinned at distance 0 — it must not fold away silently.
 *
 * Edges always increase the wave (`assignWaves` is a longest-path layering), so
 * visiting nodes in descending wave order guarantees every successor is settled
 * before the node that depends on it.
 */
function distanceToLive(nodes, edges, wave) {
  const outgoing = new Map(nodes.map(({ key }) => [key, []]));
  for (const edge of edges) outgoing.get(edge.from).push(edge.to);
  const distance = new Map();
  const ordered = [...nodes].sort((left, right) => wave.get(right.key) - wave.get(left.key)
    || compareText(right.key, left.key));
  for (const node of ordered) {
    if (node.status !== 'done' || auditPending(node)) {
      distance.set(node.key, 0);
      continue;
    }
    let best = Infinity;
    for (const successor of outgoing.get(node.key)) {
      const settled = distance.get(successor);
      if (settled !== undefined && settled + 1 < best) best = settled + 1;
    }
    distance.set(node.key, best);
  }
  return distance;
}

/**
 * Project the full dependency graph onto the `live` scope.
 *
 * Removing nodes from a DAG cannot create a cycle, so the narrowed graph needs
 * no verification: what is left is a subgraph of what was already acyclic.
 *
 * @returns {{nodes: Array, edges: Array, foldedKeys: Set<string>}}
 */
export function projectTodoGanttScope({
  nodes, edges, wave, foldDistance = DEFAULT_FOLD_DISTANCE,
}) {
  const distance = distanceToLive(nodes, edges, wave);
  const foldedKeys = new Set(nodes
    .filter((node) => node.status === 'done' && distance.get(node.key) > foldDistance)
    .map(({ key }) => key));
  if (foldedKeys.size === 0) return { nodes, edges, foldedKeys };
  return {
    nodes: nodes.filter((node) => !foldedKeys.has(node.key)),
    // An edge with a dropped endpoint goes with it. The kept node keeps its
    // real premises in the right pane, which reads the full graph.
    edges: edges.filter((edge) => !foldedKeys.has(edge.from) && !foldedKeys.has(edge.to)),
    foldedKeys,
  };
}
