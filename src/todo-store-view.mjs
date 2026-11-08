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
  return ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(schema);
}

/** One finished-predecessor predicate for Store replay and readiness: done, or retired from done (u12). */
export function isFinishedTodoTaskState(state) {
  return state?.status === 'done'
    || (state?.status === 'retired' && (state.done_at !== null || state.imported === true));
}

export function isDecoupledPhaseTodoPlanSchema(schema) {
  return ['lattice.todo_plan.v5', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(schema);
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
