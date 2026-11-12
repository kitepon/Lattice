// Startable notices (notice-impl, docs/architecture/dfd-done-notice.md): a read-only projection over the
// Store journals. Lattice records and shows; a notice starts nothing and gates nothing.

import { digestTodoArtifact } from './todo-contracts.mjs';
import { todoNoticeWaitingDigest } from './todo-notice-store.mjs';
import { createTodoReadiness } from './todo-readiness.mjs';
import { projectTodoStatus, TODO_STATUS_DISPATCH_ONLY } from './todo-status.mjs';

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** The journal event that put a task or phase in its current state: its latest event. */
function latestEvent(member, match) {
  const event = member?.journal.events.findLast(match);
  return event === undefined ? null : event;
}

function triggerOf(member, event, ref) {
  return {
    plan_key: member.plan.plan_key, ...ref, kind: event.kind,
    event_digest: event.event_digest, recorded_at: event.recorded_at, actor: event.actor ?? null,
  };
}

/**
 * wait-design: a wait is in effect while its task is pending or blocked and has no own start or retire after `since`.
 * shortcut: a start-then-retract in an earlier plan version followed by a revise can bring a wait back (that version's
 * events are not in this journal); chosen over a revise silently dropping waits (Owner ruling 2). Upgrade when revisions
 * carry the task's event history.
 */
export function waitInEffect(store, wait) {
  const member = store.members.find(({ plan }) => plan.plan_key === wait.plan_key);
  const task = member?.tasks.find(({ task_id: id }) => id === wait.task_id);
  if (task === undefined || !['pending', 'blocked'].includes(task.status)) return false;
  return !member.journal.events.some((event) => event.task_id === wait.task_id
    && ['start', 'retire'].includes(event.kind) && event.recorded_at > wait.since);
}

function noticeSummary(planKey, task, waiting) {
  const head = `${planKey}/${task.task_id} 「${task.title}」 can start now.`;
  return waiting.length === 0
    ? `${head} Information, not a request: whether and when to start is the lane's call.`
    : `${head} ${waiting.map(({ agent, since }) => `${agent} waiting since ${since}`).join(', ')}.`;
}

/**
 * Open notices: ready tasks (`next_ready`, the same rule as `todo status`) that waited on something.
 * `declared(planKey, taskId)` says whether an enforced plan's witness set records the task's row.
 * `waits` are the waits in effect (`waitInEffect`), `[{plan_key, task_id, agent, since, reason}]`.
 */
export function projectTodoNotices(store, { lane = null, declared = () => true, waits = [] } = {}) {
  const readiness = createTodoReadiness(store);
  const members = new Map(store.members.map((member) => [member.plan.plan_key, member]));
  const notices = [];
  for (const ready of projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY).next_ready) {
    const member = members.get(ready.plan_key);
    const task = member?.plan.tasks.find(({ task_id: id }) => id === ready.task_id);
    if (task === undefined || (lane !== null && task.lane !== lane)) continue;
    const refs = readiness.prerequisiteRefs(readiness.key({ ...member.plan, ...task }));
    const triggers = [];
    for (const ref of refs.tasks) {
      const event = latestEvent(members.get(ref.plan_key), (entry) => entry.task_id === ref.task_id);
      if (event !== null) triggers.push(triggerOf(members.get(ref.plan_key), event, { task_id: ref.task_id }));
    }
    const ownPhase = member.plan.phases?.find(({ phase_id: id }) => id === task.phase_id);
    const phaseRefs = [...refs.phases, ...(ownPhase?.predecessor_phase_ids ?? [])
      .map((phaseId) => ({ plan_key: member.plan.plan_key, phase_id: phaseId }))];
    for (const ref of phaseRefs) {
      const event = latestEvent(members.get(ref.plan_key),
        (entry) => entry.phase_id === ref.phase_id && entry.task_id === undefined);
      if (event !== null) triggers.push(triggerOf(members.get(ref.plan_key), event, { phase_id: ref.phase_id }));
    }
    const own = latestEvent(member, (entry) => entry.task_id === task.task_id);
    if (own?.kind === 'unblock') triggers.push(triggerOf(member, own, { task_id: task.task_id }));
    // A task that waited on nothing was never waited on; next_ready already shows it.
    if (triggers.length === 0) continue;
    const unique = [...new Map(triggers.map((entry) => [entry.event_digest, entry])).values()]
      .sort((left, right) => byText(left.event_digest, right.event_digest));
    const planKey = member.plan.plan_key;
    const mode = member.coordination?.mode ?? null;
    const waiting = waits.filter((wait) => wait.plan_key === planKey && wait.task_id === task.task_id)
      .map(({ agent, since, reason }) => ({ agent, since, reason: reason ?? null }))
      .sort((left, right) => byText(left.agent, right.agent));
    notices.push({
      notice_id: digestTodoArtifact([planKey, member.plan.plan_version, task.task_id,
        unique.map(({ event_digest: digest }) => digest)]),
      plan_key: planKey,
      plan_version: member.plan.plan_version,
      task_id: task.task_id,
      title: task.title,
      lane: task.lane ?? null,
      done_condition: task.done_condition ?? null,
      coordination_mode: mode,
      triggers: unique,
      waiting,
      waiting_digest: todoNoticeWaitingDigest(waiting.map(({ agent, since }) => ({ agent, since }))),
      summary: noticeSummary(planKey, task, waiting),
      // The command if the lane starts; information, never an assignment. Same rule as the enforced done hints (#141): offer what the start path accepts.
      next_action: mode === 'enforced' && !declared(planKey, task.task_id)
        ? `lattice todo independence witness declare --plan ${planKey} --task ${task.task_id} --owns <path>[,<path>...]`
        : `lattice todo start --plan ${planKey} --task ${task.task_id}`,
    });
  }
  return notices.sort((left, right) => byText(`${left.plan_key}\0${left.task_id}`, `${right.plan_key}\0${right.task_id}`));
}

/** Notices open after a write and not before it: the `notices` of a mutation result. */
export function newTodoNotices(before, after) {
  const open = new Set(before.map(({ notice_id: id }) => id));
  return after.filter(({ notice_id: id }) => !open.has(id));
}
