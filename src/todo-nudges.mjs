// Nudges (sweep-list, docs/architecture/dfd-nudge.md): the ready set grouped by lane, each task with the prompt to
// fire it and, if it cannot move once fired, to set a stop. Read-only; no other condition (the Owner's spec).

import { startPath } from './todo-notices.mjs';
import { projectTodoStatus, TODO_STATUS_DISPATCH_ONLY } from './todo-status.mjs';

const laneOrder = (lane) => (lane === null ? '\u{10FFFF}' : lane);

/** `declared(planKey, taskId)` says whether an enforced plan's witness set records the task's row. */
export function projectTodoNudges(store, { declared = () => true } = {}) {
  const members = new Map(store.members.map((member) => [member.plan.plan_key, member]));
  const lanes = new Map();
  for (const ready of projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY).next_ready) {
    const member = members.get(ready.plan_key);
    const task = member?.plan.tasks.find(({ task_id: id }) => id === ready.task_id);
    if (task === undefined) continue;
    const planKey = member.plan.plan_key;
    const fire = startPath(planKey, task.task_id, member.coordination?.mode ?? null, declared(planKey, task.task_id));
    const stop = `lattice todo block --plan ${planKey} --task ${task.task_id} --reason <why it cannot move>`;
    const lane = task.lane ?? null;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push({
      plan_key: planKey,
      plan_version: member.plan.plan_version,
      task_id: task.task_id,
      title: task.title,
      done_condition: task.done_condition ?? null,
      fire_actions: fire,
      stop_action: stop,
      prompt: `${planKey}/${task.task_id} 「${task.title}」: its predecessors are finished and it is not started.`
        + ` Fire it: ${fire.map((command) => `\`${command}\``).join(' then ')}.`
        + ` If it cannot move once fired, set a stop: \`${stop}\`.`,
    });
  }
  return [...lanes].sort(([left], [right]) => (laneOrder(left) < laneOrder(right) ? -1 : 1))
    .map(([lane, tasks]) => ({ lane, tasks }));
}
