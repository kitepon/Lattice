// n2: who waits on a task through 接続, across charts and projects (docs/architecture/dfd-connect.md, n1).
// The edges live in the waiting charts' plan-scoped chains; this reads them through the Store's cheap outgoing reader
// (no replay of the other charts) and judges each against the target's state in THIS chart. Read-only, no watcher.

import path from 'node:path';

import { chartIds } from './chart-cli.mjs';
import { TODO_CHARTS_ROOT_ENV } from './todo-external.mjs';
import { judgeTaskConnection } from './todo-store-view.mjs';
import { readTodoOutgoingConnections } from './todo-store.mjs';

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * `{waiters: Map<'plan\0task', waiter[]>, unread: [{project_id, reason}]}` for every task of `store` that another chart
 * waits on. A waiter: `{project_id, plan_key, task_id, kind: 'task', state, state_reason?, reason, since, event_digest}`
 * (project/plan/task name the WAITING task; `state` is the 接続's judgment against the target now). An unreadable chart
 * is named in `unread`, never read as "no waiters".
 */
export async function listTodoConnectionWaiters(store, env) {
  const root = env?.[TODO_CHARTS_ROOT_ENV];
  const waiters = new Map();
  // No charts root = a single chart: there is no other chart to wait from (not an unread chart).
  if (typeof root !== 'string' || root === '') return { waiters, unread: [] };
  const unread = [];
  const states = new Map(store.members.flatMap((member) => member.tasks.map((task) => [
    `${member.plan.plan_key}\0${task.task_id}`, task])));
  for (const id of await chartIds(path.resolve(root))) {
    if (id === store.project_id) continue;
    let outgoing;
    try { outgoing = await readTodoOutgoingConnections({ repoRoot: path.join(path.resolve(root), id) }); } catch (error) {
      unread.push({ project_id: id, reason: error?.detail?.reason ?? error?.code ?? 'chart_unreadable' });
      continue;
    }
    for (const edge of outgoing.edges) {
      if (edge.from.project_id !== store.project_id) continue;
      const target = states.get(`${edge.from.plan_key}\0${edge.from.task_id}`);
      const key = `${edge.from.plan_key}\0${edge.from.task_id}`;
      const { state, state_reason: stateReason } = judgeTaskConnection(
        target === undefined ? { status: null, missing: true } : { status: target.status });
      waiters.set(key, [...(waiters.get(key) ?? []), {
        project_id: edge.to.project_id, plan_key: edge.to.plan_key, task_id: edge.to.task_id, kind: 'task', state,
        ...(stateReason === undefined ? {} : { state_reason: stateReason }),
        reason: edge.reason, since: edge.connected_at, event_digest: edge.event_digest }]);
    }
  }
  for (const [key, list] of waiters) {
    waiters.set(key, list.sort((left, right) => byText(`${left.project_id}\0${left.plan_key}\0${left.task_id}`,
      `${right.project_id}\0${right.plan_key}\0${right.task_id}`)));
  }
  return { waiters, unread };
}

/** `[{plan_key, task_id, waiters}]` sorted, for every task that has any (`open` keeps only the ones still waiting). */
export function waitersByTask(waiters, { open = false, planKey = null, taskId = null } = {}) {
  return [...waiters].map(([key, list]) => {
    const [plan, task] = key.split('\0');
    return { plan_key: plan, task_id: task, waiters: open ? list.filter(({ state }) => state === 'open') : list };
  }).filter((entry) => entry.waiters.length > 0 && (planKey === null || entry.plan_key === planKey)
    && (taskId === null || entry.task_id === taskId))
    .sort((left, right) => byText(`${left.plan_key}\0${left.task_id}`, `${right.plan_key}\0${right.task_id}`));
}
