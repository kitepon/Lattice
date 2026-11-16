// ADR 0205 §7 (b6): the labels 分割待ち / 関数分割, derived from the plan already read (the `function_split` marks and the task states).
// Display only: a status is never changed, and nothing here opens a file.

export const SPLIT_WAIT_LABEL = '分割待ち';
export const SPLIT_TASK_LABEL = '関数分割';

const FINISHED = new Set(['done', 'retired']);

/**
 * `[{plan_key, task_id, label}]` for one Store member: the split task of an unfinished split, and every unfinished member of it
 * (the one in progress too: its status still reads 作業中, the label sits beside it). A plan without marks gives `[]`.
 */
export function splitLabelsOf(member) {
  const status = new Map((member.tasks ?? []).map(({ task_id: id, status: state }) => [id, state]));
  const labels = [];
  for (const task of member.plan.tasks) {
    if (!task.function_split || FINISHED.has(status.get(task.task_id))) continue;
    const entry = (taskId, label) => labels.push({ plan_key: member.plan.plan_key, task_id: taskId, label });
    entry(task.task_id, SPLIT_TASK_LABEL);
    for (const id of task.function_split.members) if (status.has(id) && !FINISHED.has(status.get(id))) entry(id, SPLIT_WAIT_LABEL);
  }
  return labels;
}

/** One list for the whole Store (`session-context`, the display read). */
export const splitLabels = (store) => store.members.flatMap(splitLabelsOf);
