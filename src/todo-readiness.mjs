import {
  isDecoupledPhaseTodoPlanSchema,
  isPhaseTodoPlanSchema,
  projectTodoCrossPlanDependencies,
} from './todo-store-view.mjs';

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
    const states = new Map(member.tasks.map((state) => [state.task_id, state.status]));
    const phaseStates = new Map((member.phases ?? []).map((phase) => [phase.phase_id, phase.status]));
    for (const phase of member.phases ?? []) phases.set(phaseKey({ ...plan, ...phase }), phase.status);
    for (const task of plan.tasks) {
      const key = taskKey({ ...plan, ...task });
      nodes.set(key, {
        status: states.get(task.task_id),
        schema: plan.schema,
        plan_key: plan.plan_key,
        phase_id: isPhaseTodoPlanSchema(plan.schema) ? task.phase_id : null,
        phase_status: phaseStates.get(task.phase_id),
      });
      incoming.set(key, new Set());
      outgoing.set(key, new Set());
      acceptanceIncoming.set(key, new Set());
    }
  }
  const connect = (from, to) => {
    const source = taskKey(from);
    const target = taskKey(to);
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

  function dependencyPhaseReady(predecessor, target) {
    if (predecessor === undefined) return false;
    if (!isPhaseTodoPlanSchema(predecessor.schema)) return true;
    if (isDecoupledPhaseTodoPlanSchema(predecessor.schema)) return true;
    if (target !== undefined && predecessor.plan_key === target.plan_key
      && predecessor.phase_id === target.phase_id) return true;
    return predecessor.phase_status === 'accepted';
  }

  function prerequisites(key) {
    const predecessors = [...(incoming.get(key) ?? [])].map((source) => nodes.get(source));
    const predecessorsDone = predecessors.every((node) => node?.status === 'done');
    const predecessorPhasesReady = predecessors.every((node) => dependencyPhaseReady(node, nodes.get(key)));
    const taskDependenciesDone = predecessorsDone && predecessorPhasesReady;
    const phaseAcceptReady = [...(acceptanceIncoming.get(key) ?? [])]
      .every((source) => phases.get(source) === 'accepted');
    return {
      taskDependenciesDone,
      phaseAcceptReady,
      dependenciesDone: taskDependenciesDone && phaseAcceptReady,
      cause: !phaseAcceptReady ? 'acceptance_edge'
        : !predecessorsDone ? 'predecessor_unfinished'
          : !predecessorPhasesReady ? 'acceptance_edge' : null,
    };
  }

  function ownPhaseReady(key) {
    const node = nodes.get(key);
    return node?.schema !== 'lattice.todo_plan.v4' || node.phase_status === 'active';
  }

  function startedSuccessor(key) {
    return [...(outgoing.get(key) ?? [])].some((successor) => nodes.get(successor)?.status !== 'pending');
  }

  return {
    key: taskKey,
    status: (key) => nodes.get(key)?.status,
    prerequisites,
    ownPhaseReady,
    isReady: (key) => nodes.get(key)?.status === 'pending'
      && ownPhaseReady(key) && prerequisites(key).dependenciesDone,
    startedSuccessor,
    phaseHasStartedSuccessor: (member, phaseId) => member.plan.schema === 'lattice.todo_plan.v4'
      ? member.plan.tasks.filter(({ phase_id }) => phase_id === phaseId)
        .some((task) => startedSuccessor(taskKey({ ...member.plan, ...task })))
      : [...(acceptanceOutgoing.get(phaseKey({ ...member.plan, phase_id: phaseId })) ?? [])]
        .some((key) => nodes.get(key)?.status !== 'pending'),
  };
}

function refused(reason, cause, detail = {}) {
  return { ok: false, code: 'STORE_INCONSISTENT', detail: { reason, cause, ...detail } };
}

/** Prospective policy only; Store retains historical replay, evidence and identity validation. */
export function validateProspectiveEvent({ store, member, event }) {
  const readiness = createTodoReadiness(store);
  const key = readiness.key({ ...member.plan, task_id: event.task_id });
  const prerequisites = readiness.prerequisites(key);
  const authoredStart = event.kind === 'start' && event.payload.start_mode !== 'historical_import'
    && event.payload.start_mode !== 'rebind';
  if (authoredStart && (!prerequisites.phaseAcceptReady
    || (!prerequisites.taskDependenciesDone && event.payload.override_reason === null))) {
    return refused('invalid_start_transition', prerequisites.cause);
  }
  if (event.kind === 'done' && event.payload.done_mode === 'authored' && !prerequisites.dependenciesDone) {
    return refused('invalid_done_transition', prerequisites.cause);
  }
  if (event.kind === 'reopen' && event.payload.override_reason === null && readiness.startedSuccessor(key)) {
    return refused('reopen_has_started_successor', 'task_state', {
      next_action: `lattice todo split --plan ${member.plan.plan_key} --input <file>`,
    });
  }
  if (event.kind === 'phase_reopen' && event.payload.override_reason === null
    && readiness.phaseHasStartedSuccessor(member, event.phase_id)) {
    return refused('phase_reopen_has_started_successor', 'task_state');
  }
  // Keep merged refusal priority; replay still owns missing target/binding checks.
  const status = readiness.status(key);
  if (authoredStart && status !== undefined) {
    if (status !== 'pending') return refused('invalid_start_transition', 'task_state');
    if (!readiness.ownPhaseReady(key)) return refused('invalid_start_transition', 'phase_state');
  }
  if (event.kind === 'done' && event.payload.done_mode === 'authored'
    && status !== undefined && status !== 'in-progress') {
    return refused('invalid_done_transition', 'task_state');
  }
  return { ok: true };
}
