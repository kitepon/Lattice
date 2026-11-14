// Task trees (a100, docs/architecture/dfd-display-trees.md): connected components of this chart's tasks, so a host
// shows each tree's size without computing the graph itself. Pure; never throws on a malformed member or edge.

import { isFinishedTodoTaskState, projectTodoCrossPlanDependencies } from './todo-store-view.mjs';

const list = (value) => (Array.isArray(value) ? value : []);
const isRef = (ref) => ref !== null && typeof ref === 'object';
const key = (projectId, planKey, taskId) => `${projectId}\0${planKey}\0${taskId}`;
const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Only well-formed ledger events reach the shared projection, so one bad event never drops the others.
function wellFormedLedger(member) {
  const events = list(member?.plan_scoped?.events).filter((event) => isRef(event?.payload) && (
    event.kind === 'cross_plan_dependency' ? isRef(event.payload.from) && isRef(event.payload.to)
      : event.kind === 'cross_plan_dependency_removed'));
  return { plan_scoped: { events } };
}

/** `[{tree_id, tasks:[{plan_key, task_id}], total, finished}]` over every task of `store.members`. */
export function projectTodoTrees(store) {
  const members = list(store?.members).filter((member) => isRef(member?.plan));
  const nodes = new Map();
  const parent = new Map();
  for (const { plan, tasks } of members) {
    const states = new Map(list(tasks).map((state) => [state?.task_id, state]));
    for (const task of list(plan.tasks)) {
      if (typeof task?.task_id !== 'string') continue;
      const id = key(plan.project_id, plan.plan_key, task.task_id);
      nodes.set(id, { plan_key: plan.plan_key, task_id: task.task_id,
        finished: isFinishedTodoTaskState(states.get(task.task_id)) });
      parent.set(id, id);
    }
  }
  const root = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  // An edge with an endpoint that is not a task here (another chart, a removed task, a bad ref) is skipped.
  const join = (from, to) => {
    if (!isRef(from) || !isRef(to)) return;
    const left = key(from.project_id, from.plan_key, from.task_id);
    const right = key(to.project_id, to.plan_key, to.task_id);
    if (nodes.has(left) && nodes.has(right)) parent.set(root(left), root(right));
  };
  for (const { plan } of members) {
    for (const edge of list(plan.hard_dependencies)) join(edge?.from, edge?.to);
    for (const entry of list(plan.joins)) for (const after of list(entry?.after)) join(after, entry.before);
    for (const task of list(plan.tasks)) {
      const parentId = task?.parent_task_id;
      if (typeof parentId === 'string') join({ ...plan, task_id: parentId }, { ...plan, task_id: task.task_id });
    }
  }
  for (const edge of projectTodoCrossPlanDependencies(members.map(wellFormedLedger))) join(edge.from, edge.to);

  const trees = new Map();
  for (const id of nodes.keys()) {
    const tree = root(id);
    if (!trees.has(tree)) trees.set(tree, []);
    trees.get(tree).push(nodes.get(id));
  }
  return [...trees.values()].map((members) => {
    const tasks = members.sort((left, right) => byCodeUnit(left.plan_key, right.plan_key)
      || byCodeUnit(left.task_id, right.task_id));
    return {
      tree_id: tasks.map((task) => `${task.plan_key}/${task.task_id}`).sort(byCodeUnit)[0],
      tasks: tasks.map(({ plan_key, task_id }) => ({ plan_key, task_id })),
      total: tasks.length,
      finished: tasks.filter((task) => task.finished).length,
    };
  }).sort((left, right) => byCodeUnit(left.tree_id, right.tree_id));
}
