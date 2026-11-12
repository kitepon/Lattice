// Blockers (blockers-list, docs/architecture/dfd-blockers.md): every blocked task in the chart with its full reason,
// who stopped it and when, and the command to lift it. Read-only; `todo unblock` stays open to any seat.

/** Blocked tasks of every member, sorted by plan_key then task_id. */
export function projectTodoBlockers(store) {
  const blockers = [];
  for (const member of store.members) {
    const planKey = member.plan.plan_key;
    const lastBlock = new Map();
    for (const event of member.journal.events) if (event.kind === 'block') lastBlock.set(event.task_id, event);
    for (const state of member.tasks) {
      if (state.status !== 'blocked') continue;
      const task = member.plan.tasks.find(({ task_id: id }) => id === state.task_id);
      const event = lastBlock.get(state.task_id);
      blockers.push({
        plan_key: planKey,
        task_id: state.task_id,
        title: task?.title ?? null,
        lane: task?.lane ?? null,
        reason: state.blocked_reason,
        blocked_at: event?.recorded_at ?? null,
        blocked_by: event?.actor ?? null,
        unblock_action: `lattice todo unblock --plan ${planKey} --task ${state.task_id}`,
      });
    }
  }
  const key = ({ plan_key: plan, task_id: task }) => `${plan}\u0000${task}`;
  return blockers.sort((left, right) => (key(left) < key(right) ? -1 : 1));
}
