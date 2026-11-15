/**
 * Lattice's own revision-record note bodies (Plan owns their meaning). Writers build them here and
 * Store's note projection parses them here, so the two cannot drift. No imports: Store reads this
 * module without importing Plan upward (n3, 2026-11-15).
 */

export const todoAddNoteBody = (taskId, reason) => `todo add ${taskId}${reason === null ? '' : `: ${reason}`}`;

export const dependencyNoteBody = (operation, fromTaskId, toTaskId, reason) => (
  `dependency ${operation} ${fromTaskId}→${toTaskId}: ${reason}`);

export const planReviseNoteBody = (fromVersion, toVersion, taskId, reason) => (
  `plan revise ${fromVersion}→${toVersion} ${taskId}: ${reason}`);

const TODO_ADD = /^todo add (\S+?)(?::[ \n][\s\S]*)?$/u;
// Either side may be written however a route spells it (another chart, plan/task); a task is named
// only by an exact side, so a reader matches its own id however the other side is written.
const DEPENDENCY = /^dependency (?:connect|disconnect) (\S+?)→(\S+?): [\s\S]*$/u;
const PLAN_REVISE = /^plan revise \S+?→\S+ (\S+?): [\s\S]*$/u;

/** The task ids a revision-record body names, or null when the body is not a revision record. */
export function revisionRecordTaskIds(body) {
  const add = TODO_ADD.exec(body);
  if (add !== null) return [add[1]];
  const dependency = DEPENDENCY.exec(body);
  if (dependency !== null) return [dependency[1], dependency[2]];
  const revise = PLAN_REVISE.exec(body);
  return revise === null ? null : [revise[1]];
}
