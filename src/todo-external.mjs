// Cross-chart predecessors (xchart, docs/architecture/dfd-plan-revise.md#cross-chart-dependency-xchart-2026-11-13):
// a ledger edge whose `from` is a task of another chart (another project's Store under LATTICE_CHARTS_ROOT).
// Plan reads the other chart read-only; an unreadable one only keeps its waiters waiting.

import path from 'node:path';

import { createTodoReadiness } from './todo-readiness.mjs';
import { isFinishedTodoTaskState, projectTodoCrossPlanDependencies } from './todo-store-view.mjs';
import { readTodoStoreReadOnly, TodoStoreError } from './todo-store.mjs';

export const TODO_CHARTS_ROOT_ENV = 'LATTICE_CHARTS_ROOT';

/** Live ledger edges of `store` whose predecessor is on another chart. */
export function externalTodoDependencies(store) {
  return projectTodoCrossPlanDependencies(store.members)
    .filter(({ from }) => from.project_id !== store.project_id);
}

/** The other chart's Store, or a reason it cannot be read: `{store}` | `{reason, path}`. Never throws. */
async function readChart(env, projectId) {
  const root = env?.[TODO_CHARTS_ROOT_ENV];
  if (typeof root !== 'string' || root === '') return { reason: 'charts_root_unset', path: null };
  // project ids are identifiers (no separators), so the join stays inside the root.
  const chartPath = path.join(path.resolve(root), projectId);
  try {
    const store = await readTodoStoreReadOnly({ repoRoot: chartPath });
    // A chart that says it is another project is the wrong target, not this one.
    return store.project_id === projectId ? { store } : { reason: 'chart_unreadable', path: chartPath };
  } catch {
    return { reason: 'chart_unreadable', path: chartPath };
  }
}

/** Connect-time read: the other chart's Store, or a refusal that names the env var or the chart. */
export async function readTodoExternalChart(env, projectId) {
  const chart = await readChart(env, projectId);
  if (chart.store !== undefined) return chart.store;
  if (chart.reason === 'charts_root_unset') {
    throw new TodoStoreError('DEPENDENCY_INVALID', 'charts_root_unset', undefined, {
      project_id: projectId,
      next_action: `Set ${TODO_CHARTS_ROOT_ENV} to the directory whose children are chart directories named by`
        + ` project id (${projectId} is read from <${TODO_CHARTS_ROOT_ENV}>/${projectId}/.lattice), then connect again.`,
    });
  }
  throw new TodoStoreError('DEPENDENCY_INVALID', 'chart_unreadable', undefined, {
    project_id: projectId, path: chart.path,
    next_action: `No readable Lattice chart for project ${projectId} at ${chart.path}; check the project id`
      + ` (\`lattice status --json\` in that chart) and ${TODO_CHARTS_ROOT_ENV}.`,
  });
}

function taskTrigger(member, taskId) {
  const event = member.journal.events.findLast((entry) => entry.task_id === taskId);
  return event === undefined ? null
    : { kind: event.kind, event_digest: event.event_digest, recorded_at: event.recorded_at, actor: event.actor ?? null };
}

/**
 * The states of every external predecessor of `store`, one read per other project:
 * `{external_tasks, findings}`; nothing is read when there is no external edge.
 */
export async function readTodoExternalTasks(store, env) {
  const dependencies = externalTodoDependencies(store);
  const charts = new Map();
  for (const { from } of dependencies) {
    if (!charts.has(from.project_id)) charts.set(from.project_id, await readChart(env, from.project_id));
  }
  const tasks = new Map();
  const findings = [];
  for (const dependency of dependencies) {
    const { from } = dependency;
    const chart = charts.get(from.project_id);
    const member = chart.store?.members.find(({ plan }) => plan.plan_key === from.plan_key);
    const state = member?.tasks.find(({ task_id: id }) => id === from.task_id);
    const reason = chart.store === undefined ? chart.reason : state === undefined ? 'endpoint_missing' : null;
    if (reason !== null) {
      findings.push({ owner_plan_key: dependency.to.plan_key, event_digest: dependency.event_digest,
        side: 'from', ref: structuredClone(from), reason });
    }
    tasks.set(`${from.project_id}\0${from.plan_key}\0${from.task_id}`, {
      project_id: from.project_id, plan_key: from.plan_key, task_id: from.task_id,
      status: state?.status ?? null, finished: isFinishedTodoTaskState(state), reason,
      trigger: state === undefined ? null : taskTrigger(member, from.task_id),
    });
  }
  return { external_tasks: [...tasks.values()], findings };
}

/** `store` plus `external_tasks` and their findings, so every readiness reader sees one predicate. */
export async function withTodoExternalTasks(store, env) {
  if (store.external_tasks !== undefined || externalTodoDependencies(store).length === 0) return store;
  const { external_tasks: externalTasks, findings } = await readTodoExternalTasks(store, env);
  return { ...store, external_tasks: externalTasks,
    cross_plan_findings: [...(store.cross_plan_findings ?? []), ...findings] };
}

/**
 * Connect-time cycle check through readable charts: walk `from`'s predecessors (in-chart and cross-chart) from
 * `fromStore`; reaching `to` closes a cycle. Returns the closed path (from … to) or null. Unreadable charts end
 * their branch (a cycle nobody can see is not refused).
 */
export async function externalCycle({ env, fromStore, from, to, localStore }) {
  const key = (ref) => `${ref.project_id}\0${ref.plan_key}\0${ref.task_id}`;
  const stores = new Map([[localStore.project_id, localStore], [fromStore.project_id, fromStore]]);
  const target = key(to);
  const seen = new Set();
  const walk = async (ref, trail) => {
    if (key(ref) === target) return [...trail, ref];
    if (seen.has(key(ref))) return null;
    seen.add(key(ref));
    if (!stores.has(ref.project_id)) stores.set(ref.project_id, (await readChart(env, ref.project_id)).store ?? null);
    const store = stores.get(ref.project_id);
    if (store === null) return null;
    const readiness = createTodoReadiness(store);
    for (const pred of readiness.prerequisiteRefs(readiness.key(ref)).tasks) {
      const found = await walk({ project_id: pred.project_id ?? store.project_id, plan_key: pred.plan_key,
        task_id: pred.task_id }, [...trail, ref]);
      if (found !== null) return found;
    }
    return null;
  };
  const closed = await walk({ project_id: from.project_id, plan_key: from.plan_key, task_id: from.task_id }, []);
  return closed === null ? null : [to, ...closed.slice(0, -1).reverse(), to]
    .map(({ project_id: projectId, plan_key: planKey, task_id: taskId }) => ({ project_id: projectId, plan_key: planKey, task_id: taskId }));
}
