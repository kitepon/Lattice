/* Pure projections shared by Store and Plan; no I/O or lifecycle mutation. */
import { canonicalizeTodoArtifact } from './todo-contracts.mjs';

/**
 * u03 A6: undo a Git autocrlf checkout of canonical LF bytes in memory. Only a pure
 * conversion (every CR directly precedes LF) is undone; callers still check canonical
 * bytes and digests on the result, so any other CR keeps failing as non-canonical.
 */
export function normalizeCheckoutEol(bytes) {
  if (!bytes.includes(0x0d)) return bytes;
  for (let index = bytes.indexOf(0x0d); index !== -1; index = bytes.indexOf(0x0d, index + 1)) {
    if (bytes[index + 1] !== 0x0a) return bytes;
  }
  return Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
}

export function isPhaseTodoPlanSchema(schema) {
  return ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8',
    'lattice.todo_plan.v9'].includes(schema);
}

/** One finished-predecessor predicate for Store replay and readiness: done or retired (a13: retire deletes the task, so its edges count as gone). */
export function isFinishedTodoTaskState(state) {
  return state?.status === 'done' || state?.status === 'retired';
}

/**
 * retract-anyone (B2): one rule, used by Store replay and Plan readiness, for tasks reopened to unstarted and not
 * started or retired since. Shortcut: the set lives in one plan version's journal; upgrade when a v4 revision must keep it.
 */
export function stepTodoReopenedPending(ids, event) {
  if (event.kind === 'reopen' && event.payload?.to_status === 'pending') ids.add(event.task_id);
  else if (event.kind === 'start' || event.kind === 'retire') ids.delete(event.task_id);
  return ids;
}

export function isDecoupledPhaseTodoPlanSchema(schema) {
  return ['lattice.todo_plan.v5', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8', 'lattice.todo_plan.v9'].includes(schema);
}

// CLI側(migrate/plan create/最後のdone)が「終端重監査が要る」ことを通知するために
// 同じ判定を再利用する。判定基準を二重管理しないよう、ここから公開する。
export function isPhaselessTodoPlanSchema(schema) {
  return !isPhaseTodoPlanSchema(schema);
}

/**
 * active plan群へ接続済みのplan跨ぎ依存線を投影する。
 *
 * eventはconsumer（to）planのplan-scoped chainへ積まれる。自動発見も暗黙補完もせず、
 * 記録された線だけを返す。順序はtask identityで固定し、status/Ganttが同じ入力を見る。
 */
export function projectTodoCrossPlanDependencies(members) {
  // 除去tombstoneを先に集め、指された接続を線として数えない（歴史は両eventとも残る）
  const removed = new Set();
  for (const member of members) for (const event of member.plan_scoped?.events ?? []) {
    if (event.kind === 'cross_plan_dependency_removed') removed.add(event.payload.target_event_digest);
  }
  const dependencies = [];
  for (const member of members) for (const event of member.plan_scoped?.events ?? []) {
    if (event.kind !== 'cross_plan_dependency') continue;
    if (removed.has(event.event_digest)) continue;
    dependencies.push({
      from: event.payload.from,
      to: event.payload.to,
      reason: event.payload.reason,
      connected_by: event.actor,
      connected_at: event.recorded_at,
      event_digest: event.event_digest,
    });
  }
  return dependencies.sort((left, right) => {
    const key = (entry) => `${entry.from.project_id}\0${entry.from.plan_key}\0${entry.from.task_id}`
      + `\0${entry.to.project_id}\0${entry.to.plan_key}\0${entry.to.task_id}\0${entry.event_digest}`;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });
}

/**
 * A member's journal as the host reads it: `{first: {at, agent}|null, last_at, tasks: [{task_id, changed_at, started: {at, agent}|null, added: {at, agent}|null}]}`
 * (`started` = the last `start`; a task with an event or an add record; `added` = who added it and when, from `added`). One loop for the compact read and the closed history.
 */
function journalActivity(events, added = new Map()) {
  const tasks = new Map();
  let first = null;
  let last = null;
  for (const event of events) {
    if (first === null || event.recorded_at < first.recorded_at) first = event;
    if (last === null || event.recorded_at > last) last = event.recorded_at;
    if (event.task_id === undefined || event.task_id === null) continue;
    const entry = tasks.get(event.task_id) ?? { task_id: event.task_id, changed_at: event.recorded_at, started: null,
      added: added.get(event.task_id) ?? null };
    if (event.recorded_at > entry.changed_at) entry.changed_at = event.recorded_at;
    if (event.kind === 'start') entry.started = { at: event.recorded_at, agent: event.actor?.agent ?? null };
    tasks.set(event.task_id, entry);
  }
  // n3: an add is a plan revision, not a journal event, so a task with an add record and no event still gets an entry.
  for (const [taskId, record] of added) {
    if (!tasks.has(taskId)) tasks.set(taskId, { task_id: taskId, changed_at: record.at, started: null, added: record });
  }
  return { first: first === null ? null : { at: first.recorded_at, agent: first.actor?.agent ?? null },
    last_at: last, tasks: [...tasks.values()] };
}

/**
 * Compact display read (host surface, `todo display read --compact`): each member's `journal` and `plan_scoped` are replaced by
 * what a chart host uses, so the size grows with tasks and live edges, never with notes, evidence or repeated events.
 * `activity` = `journalActivity`; `cross_plan_dependencies` = the live
 * `[{event_digest, from, to}]` of the member's plan-scoped chain (a removal in any member's chain drops it).
 * A member with neither (the unverified raw read) is returned as it is.
 */
export function compactDisplayStore(store, { addedByPlan = new Map() } = {}) {
  const removed = new Set(store.members.flatMap((member) => (member.plan_scoped?.events ?? [])
    .filter((event) => event.kind === 'cross_plan_dependency_removed').map((event) => event.payload.target_event_digest)));
  return { ...store, members: store.members.map(({ journal, plan_scoped: planScoped, ...member }) => {
    if (journal === undefined && planScoped === undefined) return member;
    return { ...member,
      activity: journalActivity(journal?.events ?? [], addedByPlan.get(member.plan?.plan_key) ?? new Map()),
      cross_plan_dependencies: (planScoped?.events ?? [])
        .filter((event) => event.kind === 'cross_plan_dependency' && !removed.has(event.event_digest))
        .map((event) => ({ event_digest: event.event_digest, from: event.payload.from, to: event.payload.to })) };
  }) };
}

const isObject = (value) => value !== null && typeof value === 'object';
const taskKeyOf = (planKey, taskId) => `${planKey}\0${taskId}`;
const isOpenTree = ({ finished, total }) => finished < total;

/**
 * Open display read (`todo display read --open`, v2): the compact result with every per-task list limited to the tasks of open
 * trees (`finished < total` in the result's own `trees`, the one source) and `closed: {trees, tasks}` over the chart.
 * v2 drops what no host reads: each member's `revision` (the whole desired plan, closed trees included) and, for a
 * verified member (it has `tasks`), its `snapshot` (the same task states); an unverified raw member keeps its filtered
 * `snapshot`. `next_ready` is the caller's (`result.next_ready`, null unless the read is verified). Pure. `plan.phases`, descriptors and `activity.first/last_at` stay whole. A ref of another chart is never a task of
 * this chart here, so a join or dependency naming one keeps it.
 */
export function openDisplayResult(result) {
  const trees = result.trees ?? [];
  const closedTrees = trees.filter((tree) => !isOpenTree(tree));
  const kept = new Set(trees.filter(isOpenTree).flatMap(({ tasks }) => tasks.map((task) => taskKeyOf(task.plan_key, task.task_id))));
  const closed = { trees: closedTrees.length, tasks: closedTrees.reduce((sum, { total }) => sum + total, 0) };
  const connections = (result.connections ?? []).filter(({ plan_key: planKey, task_id: taskId }) => kept.has(taskKeyOf(planKey, taskId)));
  const referred = new Set(connections.flatMap((entry) => entry.connections.map(({ ref }) => ref)));
  const base = { ...result, schema: 'lattice.todo_display_open_result.v2', next_ready: result.next_ready ?? null,
    trees: trees.filter(isOpenTree), connections, closed,
    external_tasks: (result.external_tasks ?? []).filter(({ project_id: projectId, plan_key: planKey, task_id: taskId }) => referred.has(`${projectId}/${planKey}/${taskId}`)) };
  if (!isObject(result.store)) return base;
  const { store } = result;
  return { ...base, store: { ...store, members: store.members.map((member) => {
    const planKey = member.descriptor?.plan_key ?? member.plan?.plan_key;
    const projectId = member.plan?.project_id ?? store.project_id;
    const keptTask = ({ task_id: taskId }) => kept.has(taskKeyOf(planKey, taskId));
    const local = (ref) => (ref.project_id ?? projectId) === projectId;
    const keepRef = (ref) => isObject(ref) && (!local(ref) || kept.has(taskKeyOf(ref.plan_key, ref.task_id)));
    const { revision: _revision, ...next } = member;
    if (Array.isArray(member.tasks)) {
      next.tasks = member.tasks.filter(keptTask);
      delete next.snapshot;
    } else if (Array.isArray(member.snapshot?.tasks)) next.snapshot = { ...member.snapshot, tasks: member.snapshot.tasks.filter(keptTask) };
    if (isObject(member.plan)) {
      next.plan = { ...member.plan };
      if (Array.isArray(member.plan.tasks)) next.plan.tasks = member.plan.tasks.filter(keptTask);
      if (Array.isArray(member.plan.hard_dependencies)) next.plan.hard_dependencies = member.plan.hard_dependencies.filter((edge) => keepRef(edge?.to));
      if (Array.isArray(member.plan.joins)) {
        next.plan.joins = member.plan.joins.filter((entry) => keepRef(entry?.before))
          .map((entry) => ({ ...entry, after: (entry.after ?? []).filter(keepRef) }));
      }
    }
    if (isObject(member.activity)) next.activity = { ...member.activity, tasks: member.activity.tasks.filter(keptTask) };
    if (Array.isArray(member.cross_plan_dependencies)) {
      next.cross_plan_dependencies = member.cross_plan_dependencies
        .filter(({ from, to }) => [from, to].some((ref) => isObject(ref) && local(ref) && kept.has(taskKeyOf(ref.plan_key, ref.task_id))));
    }
    return next;
  }) } };
}

const compareCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// History order: finished_at newest first (no time last), then plan_key, task_id ascending.
const compareHistory = (left, right) => compareCodeUnit(right.finished_at ?? '', left.finished_at ?? '')
  || compareCodeUnit(left.plan_key, right.plan_key) || compareCodeUnit(left.task_id, right.task_id);
const CURSOR_PREFIX = 'h1.';
const encodeHistoryCursor = ({ finished_at: finishedAt, plan_key: planKey, task_id: taskId }) =>
  CURSOR_PREFIX + Buffer.from(JSON.stringify([finishedAt, planKey, taskId])).toString('base64url');

/** The position a `next_cursor` names as a row-shaped key, or null when it does not parse. */
export function decodeHistoryCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null;
  try {
    const [finishedAt, planKey, taskId] = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'));
    return (finishedAt === null || typeof finishedAt === 'string') && typeof planKey === 'string' && typeof taskId === 'string'
      ? { finished_at: finishedAt, plan_key: planKey, task_id: taskId } : null;
  } catch { return null; }
}

/**
 * Closed history (`todo display history`): the tasks of closed trees (`finished >= total`), newest finish first, one page.
 * `{closed: {trees, tasks}, tasks: [...], next_cursor}`; `before` is a decoded cursor (rows after it), `limit` a clamped count.
 * `finished_at` = `done_at` of a done task, else the task's latest journal event. Pure; reads the full (not compact) store.
 */
export function closedDisplayHistory({ store, trees }, { limit, before = null }) {
  const closedTrees = trees.filter((tree) => !isOpenTree(tree));
  const members = new Map((store?.members ?? []).map((member) => {
    const planKey = member.descriptor?.plan_key ?? member.plan?.plan_key;
    return [planKey, {
      plan: new Map((member.plan?.tasks ?? []).map((task) => [task.task_id, task])),
      state: new Map((member.tasks ?? member.snapshot?.tasks ?? []).map((task) => [task.task_id, task])),
      activity: new Map(journalActivity(member.journal?.events ?? []).tasks.map((entry) => [entry.task_id, entry])),
    }];
  }));
  const rows = closedTrees.flatMap((tree) => tree.tasks.map(({ plan_key: planKey, task_id: taskId }) => {
    const member = members.get(planKey);
    const task = member?.plan.get(taskId);
    const state = member?.state.get(taskId);
    const activity = member?.activity.get(taskId);
    return { tree_id: tree.tree_id, plan_key: planKey, task_id: taskId,
      title: task?.title ?? null, lane: task?.lane ?? null, phase_id: task?.phase_id ?? null,
      parent_task_id: task?.parent_task_id ?? null, design_memo: task?.design_memo ?? null,
      done_condition: task?.done_condition ?? null, status: state?.status ?? null, done_at: state?.done_at ?? null,
      finished_at: state?.status === 'done' && state.done_at ? state.done_at : activity?.changed_at ?? null,
      activity: { changed_at: activity?.changed_at ?? null, started: activity?.started ?? null } };
  })).sort(compareHistory);
  const rest = before === null ? rows : rows.filter((row) => compareHistory(row, before) > 0);
  const page = rest.slice(0, limit);
  return { closed: { trees: closedTrees.length, tasks: rows.length }, tasks: page,
    next_cursor: rest.length > page.length ? encodeHistoryCursor(page.at(-1)) : null };
}

/**
 * 接続 (schedule): one plan chain's connection_added events with how each ended. `ended` is 'removed' or
 * 'resolved' (an add has at most one end, which Store append enforces); a state of 'removed' is not shown.
 */
export function projectTodoScheduleConnections(events) {
  const ends = new Map();
  for (const event of events ?? []) {
    if (event.kind === 'connection_removed') ends.set(event.payload.target_event_digest, { ended: 'removed', event });
    if (event.kind === 'connection_resolved') ends.set(event.payload.target_event_digest, { ended: 'resolved', event });
  }
  return (events ?? []).filter((event) => event.kind === 'connection_added').map((event) => {
    const end = ends.get(event.event_digest);
    return { kind: 'schedule', task_id: event.payload.task_id, ref: event.payload.to.id,
      state: end === undefined ? 'open' : end.ended === 'resolved' ? 'settled' : 'removed',
      reason: event.payload.reason, since: event.recorded_at, event_digest: event.event_digest,
      actor: event.actor, provenance: event.provenance, ended: end?.ended ?? null,
      ...(end?.ended === 'resolved' ? { settled_at: end.event.recorded_at, evidence: end.event.payload.evidence } : {}) };
  });
}

const connectionTaskKey = (projectId, planKey, taskId) => `${projectId}\0${planKey}\0${taskId}`;
export { connectionTaskKey as todoConnectionTaskKey };

/**
 * 接続 per task, keyed `project\0plan\0task`: schedule connections from the plan chain, and task connections from
 * today's cross-chart ledger edges (settled once that task is done or retired, open while its chart is unread).
 * Pure; a removed connection is not listed. Entry: {kind, ref, state, reason, since, event_digest, settled_at?,
 * evidence?, state_reason?}, sorted by since then digest.
 */
export function projectTodoConnections(members, externalTasks = []) {
  const external = new Map(externalTasks.map((entry) => [connectionTaskKey(entry.project_id, entry.plan_key, entry.task_id), entry]));
  const byTask = new Map();
  const push = (key, entry) => byTask.set(key, [...(byTask.get(key) ?? []), entry]);
  for (const member of members) {
    const { plan } = member;
    for (const entry of projectTodoScheduleConnections(member.plan_scoped?.events)) {
      if (entry.state === 'removed') continue;
      const { task_id: taskId, actor: _actor, provenance: _provenance, ended: _ended, ...shown } = entry;
      push(connectionTaskKey(plan.project_id, plan.plan_key, taskId), shown);
    }
  }
  for (const dependency of projectTodoCrossPlanDependencies(members)) {
    if (dependency.from.project_id === dependency.to.project_id) continue;
    const { from, to } = dependency;
    const source = external.get(connectionTaskKey(from.project_id, from.plan_key, from.task_id));
    const settled = source?.finished === true;
    push(connectionTaskKey(to.project_id, to.plan_key, to.task_id), {
      kind: 'task', ref: `${from.project_id}/${from.plan_key}/${from.task_id}`,
      state: settled ? 'settled' : 'open', reason: dependency.reason, since: dependency.connected_at,
      event_digest: dependency.event_digest,
      ...(!settled && (source === undefined || source.status === null || source.status === undefined)
        ? { state_reason: source?.reason ?? 'chart_not_read' } : {}) });
  }
  for (const [key, entries] of byTask) {
    byTask.set(key, entries.sort((left, right) => (left.since + left.event_digest < right.since + right.event_digest ? -1 : 1)));
  }
  return byTask;
}

function mappedNodeRef(ref, plan, idMap) {
  if (ref.project_id !== plan.project_id || ref.plan_key !== plan.plan_key) return ref;
  return { ...ref, task_id: idMap.get(ref.task_id) ?? ref.task_id };
}

export function localTaskRef(ref, plan, taskId) {
  return ref.project_id === plan.project_id && ref.plan_key === plan.plan_key
    && ref.task_id === taskId;
}

export function removedTaskRef(ref, plan, removedTaskIds) {
  return ref.project_id === plan.project_id && ref.plan_key === plan.plan_key
    && removedTaskIds.has(ref.task_id);
}

export function todoTaskCarrySemantics(plan, taskId, idMap, {
  reconciliationMetadata = false, includeDesignMemo = false, removedTaskIds = new Set(),
} = {}) {
  const task = plan.tasks.find(({ task_id }) => task_id === taskId);
  if (!task) return null;
  const mapId = (id) => id === null ? null : idMap.get(id) ?? id;
  const normalizedTask = reconciliationMetadata ? {
    task_id: mapId(task.task_id), title: task.title, lane: task.lane,
    compile_binding: task.compile_binding,
  } : {
    task_id: mapId(task.task_id), title: task.title, lane: task.lane,
    ...(includeDesignMemo ? { design_memo: task.design_memo } : {}),
    narrative_ref: task.narrative_ref, narrative_anchor: task.narrative_anchor ?? null,
    compile_binding: task.compile_binding, parent_task_id: mapId(task.parent_task_id ?? null),
  };
  const edges = plan.hard_dependencies
    .filter(({ from, to }) => !removedTaskRef(from, plan, removedTaskIds)
      && !removedTaskRef(to, plan, removedTaskIds)
      && (localTaskRef(from, plan, taskId) || localTaskRef(to, plan, taskId)))
    .map(({ from, to }) => ({ from: mappedNodeRef(from, plan, idMap), to: mappedNodeRef(to, plan, idMap) }))
    .sort((left, right) => canonicalizeTodoArtifact(left) < canonicalizeTodoArtifact(right) ? -1 : 1);
  const joins = plan.joins
    .flatMap((join) => {
      if (removedTaskRef(join.before, plan, removedTaskIds)) return [];
      const after = join.after.filter((ref) => !removedTaskRef(ref, plan, removedTaskIds));
      if (after.length === 0 || (!localTaskRef(join.before, plan, taskId)
        && !after.some((ref) => localTaskRef(ref, plan, taskId)))) return [];
      return [{ ...join,
        after: after.map((ref) => mappedNodeRef(ref, plan, idMap))
        .sort((left, right) => canonicalizeTodoArtifact(left) < canonicalizeTodoArtifact(right) ? -1 : 1),
        before: mappedNodeRef(join.before, plan, idMap),
      }];
    }).sort((left, right) => left.id < right.id ? -1 : 1);
  const phaseAcceptDependencies = isDecoupledPhaseTodoPlanSchema(plan.schema)
    ? plan.phase_accept_dependencies
      .filter(({ to }) => localTaskRef(to, plan, taskId))
      .map(({ from, to }) => ({ from, to: mappedNodeRef(to, plan, idMap) }))
      .sort((left, right) => canonicalizeTodoArtifact(left) < canonicalizeTodoArtifact(right) ? -1 : 1)
    : [];
  return { task: normalizedTask, hard_dependencies: edges, joins, phase_accept_dependencies: phaseAcceptDependencies };
}
