import {
  isDecoupledPhaseTodoPlanSchema,
  isFinishedTodoTaskState,
  isPhaseTodoPlanSchema,
  projectTodoConnections,
  projectTodoCrossPlanDependencies,
  projectTodoScheduleConnections,
  stepTodoReopenedPending,
} from './todo-store-view.mjs';
import { TodoStoreError, todoPhaseDefinitions } from './todo-store.mjs';

function taskKey(ref) {
  return `${ref.project_id}\0${ref.plan_key}\0${ref.task_id}`;
}

function phaseKey(ref) {
  return `${ref.project_id}\0${ref.plan_key}\0${ref.phase_id}`;
}

/** Build once per read view; never read derived snapshot caches or mutate the input. */
export function createTodoReadiness(store) {
  const nodes = new Map();
  const phases = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  const acceptanceIncoming = new Map();
  const acceptanceOutgoing = new Map();
  for (const member of store.members) {
    const { plan } = member;
    const states = new Map(member.tasks.map((state) => [state.task_id, state]));
    const phaseStates = new Map((member.phases ?? []).map((phase) => [phase.phase_id, phase.status]));
    // retract-anyone (B2): the same reopened set replay uses; such a start skips only the own-phase check.
    const reopened = (member.journal?.events ?? []).reduce(stepTodoReopenedPending, new Set());
    for (const phase of member.phases ?? []) {
      phases.set(phaseKey({ ...plan, ...phase }), { plan_key: plan.plan_key, phase_id: phase.phase_id, status: phase.status });
    }
    for (const task of plan.tasks) {
      const key = taskKey({ ...plan, ...task });
      nodes.set(key, {
        status: states.get(task.task_id)?.status,
        task_id: task.task_id,
        // retiredは先行として完了扱い（u12/a13）。判定はStore replayと同じ一つの述語。
        finished: isFinishedTodoTaskState(states.get(task.task_id)),
        schema: plan.schema,
        plan_key: plan.plan_key,
        phase_id: isPhaseTodoPlanSchema(plan.schema) ? task.phase_id : null,
        phase_status: phaseStates.get(task.phase_id),
        reopened: reopened.has(task.task_id),
      });
      incoming.set(key, new Set());
      outgoing.set(key, new Set());
      acceptanceIncoming.set(key, new Set());
    }
  }
  // xchart: predecessors on other charts, as their chart reports them (`withTodoExternalTasks`); never phase-gated.
  for (const entry of store.external_tasks ?? []) {
    nodes.set(taskKey(entry), { status: entry.status, task_id: entry.task_id, finished: entry.finished === true,
      schema: null, plan_key: entry.plan_key, project_id: entry.project_id, phase_id: null, reason: entry.reason });
  }
  // An external edge whose state was not loaded waits (fail closed), named `chart_not_read`.
  const external = new Map();
  const predecessorNode = (source) => nodes.get(source) ?? (external.has(source)
    ? { ...external.get(source), status: null, finished: false, schema: null, reason: 'chart_not_read' } : undefined);
  const connect = (from, to) => {
    const source = taskKey(from);
    const target = taskKey(to);
    if (from.project_id !== to.project_id) {
      external.set(source, { project_id: from.project_id, plan_key: from.plan_key, task_id: from.task_id });
    }
    incoming.get(target)?.add(source);
    outgoing.get(source)?.add(target);
  };
  for (const member of store.members) {
    // `?? []`: the display reads unverified members too and must not stop on a missing list (u01).
    for (const edge of member.plan.hard_dependencies ?? []) connect(edge.from, edge.to);
    for (const join of member.plan.joins ?? []) {
      for (const after of join.after) connect(after, join.before);
    }
    if (isDecoupledPhaseTodoPlanSchema(member.plan.schema)) {
      for (const edge of member.plan.phase_accept_dependencies ?? []) {
        const source = phaseKey(edge.from);
        const target = taskKey(edge.to);
        acceptanceIncoming.get(target)?.add(source);
        if (!acceptanceOutgoing.has(source)) acceptanceOutgoing.set(source, new Set());
        acceptanceOutgoing.get(source).add(target);
      }
    }
  }
  for (const edge of projectTodoCrossPlanDependencies(store.members)) connect(edge.from, edge.to);
  // 接続: schedule targets and cross-chart task targets, per task; an open one keeps the task from starting.
  const connectionsByTask = projectTodoConnections(store.members, store.external_tasks ?? []);
  const connections = (key) => connectionsByTask.get(key) ?? [];
  // 優先接続: the host-local `todo wait` mark (store.priority_waits, in-effect only). It gates nothing.
  const priorityByTask = new Map();
  for (const wait of store.priority_waits ?? []) {
    const key = taskKey({ project_id: store.project_id, plan_key: wait.plan_key, task_id: wait.task_id });
    priorityByTask.set(key, [...(priorityByTask.get(key) ?? []),
      { kind: 'priority', agent: wait.agent, since: wait.since, reason: wait.reason ?? null }]);
  }
  /** The one read-contract list: 他条件に接続 entries (gating) then 優先接続 entries (never gating). */
  const allConnections = (key) => [...connections(key),
    ...(priorityByTask.get(key) ?? []).sort((left, right) => (left.agent < right.agent ? -1 : left.agent > right.agent ? 1 : 0))];

  function dependencyPhaseReady(predecessor, target) {
    if (predecessor === undefined) return false;
    if (!isPhaseTodoPlanSchema(predecessor.schema)) return true;
    if (isDecoupledPhaseTodoPlanSchema(predecessor.schema)) return true;
    if (target !== undefined && predecessor.plan_key === target.plan_key
      && predecessor.phase_id === target.phase_id) return true;
    return predecessor.phase_status === 'accepted';
  }

  function prerequisites(key) {
    // u03 A24: 消えた端点（Storeのendpoint_missing finding）は後続を止めない。Store replayも同じ規則。
    const predecessors = [...(incoming.get(key) ?? [])].map(predecessorNode)
      .filter((node) => node !== undefined);
    const unfinished = predecessors.filter((node) => node.finished !== true);
    // 前工程 = same chart; a task on another chart is a 接続 and is named in blocking_connections instead.
    const unfinishedHere = unfinished.filter((node) => node.project_id === undefined);
    const unreadyPhases = predecessors.filter((node) => !dependencyPhaseReady(node, nodes.get(key)));
    const predecessorsDone = unfinished.length === 0;
    const predecessorPhasesReady = unreadyPhases.length === 0;
    const taskDependenciesDone = predecessorsDone && predecessorPhasesReady;
    const unacceptedEdges = [...(acceptanceIncoming.get(key) ?? [])]
      .map((source) => phases.get(source)).filter((phase) => phase !== undefined && phase.status !== 'accepted');
    const phaseAcceptReady = unacceptedEdges.length === 0;
    const openConnections = connections(key).filter(({ state }) => state === 'open');
    // Only a schedule 接続 is an extra gate; a task 接続 is today's cross-chart edge, already in `unfinished`.
    const scheduleOpen = openConnections.some(({ kind }) => kind === 'schedule');
    const connectionsOpen = scheduleOpen || unfinished.some((node) => node.project_id !== undefined);
    const cause = !phaseAcceptReady ? 'acceptance_edge'
      : unfinishedHere.length > 0 ? 'predecessor_unfinished'
        : connectionsOpen ? 'connection_open'
          : !predecessorsDone ? 'predecessor_unfinished'
            : !predecessorPhasesReady ? 'acceptance_edge' : null;
    const blockingPhases = !phaseAcceptReady ? unacceptedEdges
      : unreadyPhases.map((node) => ({ plan_key: node.plan_key, phase_id: node.phase_id, status: node.phase_status }));
    const blockingConnections = openConnections.map(blockingConnection);
    return {
      taskDependenciesDone,
      phaseAcceptReady,
      dependenciesDone: taskDependenciesDone && phaseAcceptReady,
      // start only: a schedule 接続 never gates done, and an in-progress task keeps its state when one is added.
      startReady: taskDependenciesDone && phaseAcceptReady && !scheduleOpen,
      scheduleOpen,
      cause,
      // a12: a refusal names what blocks, not only why.
      blocking: cause === 'predecessor_unfinished'
        ? { blocking_tasks: unfinishedHere.map(blockingTask).sort(byRef),
          ...(blockingConnections.length === 0 ? {} : { blocking_connections: blockingConnections }) }
        : cause === 'connection_open' ? { blocking_connections: blockingConnections }
          : cause === 'acceptance_edge'
            ? { blocking_phases: uniqueRefs(blockingPhases).map((phase) => ({ ...phase })).sort(byRef) } : {},
    };
  }

  function ownPhaseStatus(key) {
    return nodes.get(key)?.phase_status;
  }

  function ownPhaseReady(key) {
    const node = nodes.get(key);
    return node?.schema !== 'lattice.todo_plan.v4' || node.phase_status === 'active' || node.reopened === true;
  }

  /** a28: the successors that already left pending, sorted, so a refusal can name them. */
  function startedSuccessors(key) {
    return [...(outgoing.get(key) ?? [])].map((successor) => nodes.get(successor))
      .filter((node) => node !== undefined && node.status !== 'pending')
      .map(({ plan_key, task_id, status }) => ({ plan_key, task_id, status })).sort(byRef);
  }
  const startedSuccessor = (key) => startedSuccessors(key).length > 0;

  /** notice-impl: what a task waits on — predecessor tasks, phases whose accept it needs, and its own phase. */
  function prerequisiteRefs(key) {
    const node = nodes.get(key);
    const tasks = [...(incoming.get(key) ?? [])].map(predecessorNode)
      .filter((pred) => pred !== undefined).map(({ project_id: projectId, plan_key, task_id }) => (
        external.has(taskKey({ project_id: projectId, plan_key, task_id }))
          ? { project_id: projectId, plan_key, task_id } : { plan_key, task_id }));
    const phaseRefs = [...(acceptanceIncoming.get(key) ?? [])].map((source) => phases.get(source))
      .filter((phase) => phase !== undefined).map(({ plan_key, phase_id }) => ({ plan_key, phase_id }));
    for (const source of incoming.get(key) ?? []) {
      const pred = nodes.get(source);
      if (pred !== undefined && isPhaseTodoPlanSchema(pred.schema) && !isDecoupledPhaseTodoPlanSchema(pred.schema)
        && !(pred.plan_key === node?.plan_key && pred.phase_id === node?.phase_id)) {
        phaseRefs.push({ plan_key: pred.plan_key, phase_id: pred.phase_id });
      }
    }
    return { tasks: uniqueRefs(tasks).sort(byRef), phases: uniqueRefs(phaseRefs).sort(byRef) };
  }

  return {
    key: taskKey,
    status: (key) => nodes.get(key)?.status,
    prerequisites,
    prerequisiteRefs,
    ownPhaseReady,
    ownPhaseStatus,
    connections,
    allConnections,
    isReady: (key) => nodes.get(key)?.status === 'pending'
      && ownPhaseReady(key) && prerequisites(key).startReady,
    startedSuccessor,
    startedSuccessors,
    phaseHasStartedSuccessor: (member, phaseId) => member.plan.schema === 'lattice.todo_plan.v4'
      ? member.plan.tasks.filter(({ phase_id }) => phase_id === phaseId)
        .some((task) => startedSuccessor(taskKey({ ...member.plan, ...task })))
        // a12: same rule as Store replay, so this order refusal is not left to replay's STORE_INCONSISTENT.
        || (phases.get(phaseKey({ ...member.plan, phase_id: phaseId }))?.status === 'accepted'
          && member.plan.phases.some((phase) => phase.predecessor_phase_ids.includes(phaseId)
            && (phases.get(phaseKey({ ...member.plan, phase_id: phase.phase_id }))?.status !== 'locked'
              || member.plan.tasks.some((task) => task.phase_id === phase.phase_id
                && nodes.get(taskKey({ ...member.plan, ...task }))?.status !== 'pending'))))
      : [...(acceptanceOutgoing.get(phaseKey({ ...member.plan, phase_id: phaseId })) ?? [])]
        .some((key) => nodes.get(key)?.status !== 'pending'),
  };
}

const refId = (ref) => `${ref.project_id ?? ''}\0${ref.plan_key}\0${ref.task_id ?? ref.phase_id}`;

/** a12 blocking entry; an external predecessor also names its project and why it waits (null when readable). */
function blockingTask({ project_id: projectId, plan_key, task_id, status, reason }) {
  return projectId === undefined ? { plan_key, task_id, status }
    : { project_id: projectId, plan_key, task_id, status, reason: reason ?? null };
}
/** The refusal entry for an open 接続: what it connects to, why, and since when (+ why a task target is unread). */
function blockingConnection({ kind, ref, reason, since, state_reason: stateReason }) {
  return { kind, ref, reason, since, ...(stateReason === undefined ? {} : { state_reason: stateReason }) };
}
/** The read-contract `connections` of one task (他条件に接続 open and settled, plus 優先接続 when `store.priority_waits` is loaded), for `todo show` and the CLI (call withTodoExternalTasks first). */
export function listTodoConnections(store, planKey, taskId, { includeRemoved = false } = {}) {
  const member = store.members.find(({ plan }) => plan.plan_key === planKey);
  if (member === undefined) return [];
  const listed = createTodoReadiness(store).allConnections(`${member.plan.project_id}\0${planKey}\0${taskId}`);
  if (!includeRemoved) return listed;
  // A removed entry is history; a retry of remove needs it to answer `unchanged` rather than not-found.
  const removed = projectTodoScheduleConnections(member.plan_scoped?.events).filter((entry) => entry.state === 'removed'
    && entry.task_id === taskId).map(({ task_id: _task, actor: _actor, provenance: _provenance, ended: _ended, ...shown }) => shown);
  return [...listed, ...removed];
}
function byRef(left, right) {
  return refId(left) < refId(right) ? -1 : refId(left) > refId(right) ? 1 : 0;
}
function uniqueRefs(refs) {
  return [...new Map(refs.map((ref) => [refId(ref), ref])).values()];
}

// a12: an order or state rule is not an inconsistency; Store replay keeps STORE_INCONSISTENT for history.
function refused(reason, cause, detail = {}) {
  return { ok: false, code: 'TODO_TRANSITION_REFUSED', detail: { reason, cause, ...detail } };
}

/** Prospective policy only; Store retains historical replay, evidence and identity validation. */
export function validateProspectiveEvent({ store, member, event }) {
  const readiness = createTodoReadiness(store);
  const key = readiness.key({ ...member.plan, task_id: event.task_id });
  const prerequisites = readiness.prerequisites(key);
  const authoredStart = event.kind === 'start' && event.payload.start_mode !== 'historical_import'
    && event.payload.start_mode !== 'rebind';
  if (authoredStart && (!prerequisites.phaseAcceptReady
    || ((!prerequisites.taskDependenciesDone || prerequisites.scheduleOpen) && event.payload.override_reason === null))) {
    return refused('invalid_start_transition', prerequisites.cause, prerequisites.blocking);
  }
  if (event.kind === 'done' && event.payload.done_mode === 'authored' && !prerequisites.dependenciesDone) {
    return refused('invalid_done_transition', prerequisites.cause, prerequisites.blocking);
  }
  if (event.kind === 'reopen' && event.payload.override_reason === null && readiness.startedSuccessor(key)) {
    const started = readiness.startedSuccessors(key);
    const on = `--plan ${member.plan.plan_key} --task ${event.task_id}`;
    return refused('reopen_has_started_successor', 'task_state', {
      started_successors: started,
      next_action: `${started.map((task) => `${task.plan_key}/${task.task_id} (${task.status})`).join(', ')}`
        + ` already left pending after ${member.plan.plan_key}/${event.task_id}; to reopen it anyway run`
        + ` \`lattice todo reopen ${on} --reason <text> --override-reason <text>\`.`,
    });
  }
  // a36: review and close-unaudited need gate_ready; any other phase state is ordinary, not damage.
  if (event.kind === 'phase_review' || event.kind === 'phase_close_unaudited') {
    const phase = (member.phases ?? []).find(({ phase_id: id }) => id === event.phase_id);
    if (phase !== undefined && phase.status !== 'gate_ready') {
      const definition = todoPhaseDefinitions(member.plan).find(({ phase_id: id }) => id === event.phase_id);
      return refused('phase_gate_not_ready', 'phase_state', {
        plan_key: member.plan.plan_key, phase_id: event.phase_id, phase_status: phase.status,
        required_evidence_slots: [...(definition?.required_evidence_slots ?? [])],
      });
    }
  }
  if (event.kind === 'phase_reopen' && event.payload.override_reason === null
    && readiness.phaseHasStartedSuccessor(member, event.phase_id)) {
    return refused('phase_reopen_has_started_successor', 'task_state');
  }
  // Keep merged refusal priority; replay still owns missing target/binding checks.
  const status = readiness.status(key);
  if (authoredStart && status !== undefined) {
    if (status !== 'pending') {
      // a36: name who holds an in-progress task, so the refusal can tell an own anonymous start apart.
      const holder = status === 'in-progress' ? member.journal.events
        .findLast((entry) => entry.kind === 'start' && entry.task_id === event.task_id)?.actor?.agent : undefined;
      return refused('invalid_start_transition', 'task_state', { status, ...(holder === undefined ? {} : { started_by: holder }) });
    }
    if (!readiness.ownPhaseReady(key)) {
      return refused('invalid_start_transition', 'phase_state', { phase_status: readiness.ownPhaseStatus(key) });
    }
  }
  if (event.kind === 'done' && event.payload.done_mode === 'authored'
    && status !== undefined && status !== 'in-progress') {
    return refused('invalid_done_transition', 'task_state', { status });
  }
  if (event.kind === 'block' && status !== undefined && status !== 'in-progress') {
    return refused('invalid_block_transition', 'task_state', { status });
  }
  if (event.kind === 'unblock' && status !== undefined && status !== 'blocked') {
    return refused('invalid_unblock_transition', 'task_state', { status });
  }
  return { ok: true };
}

/**
 * `todo retire`はlock外で読んだ状態をprior_statusに入れる。append時にStore replayが
 * prior_status不一致や不正遷移で拒否したなら、読込とappendの間に状態が変わった
 * 再試行できる競合であり、破損ではない（u12）。それ以外のerrorはそのまま返す。
 */
export function retireStateConflict(error, { planKey, taskId, priorStatus }) {
  if (!(error instanceof TodoStoreError)
    || !['retire_prior_status_mismatch', 'invalid_retire_transition'].includes(error.detail?.reason)) return error;
  return new TodoStoreError('STORE_WRITE_CONFLICT', 'retire_state_changed', undefined, {
    task_id: taskId, expected: { status: priorStatus },
    next_action: `lattice todo retire --plan ${planKey} --task ${taskId} --reason <text>`,
  });
}
