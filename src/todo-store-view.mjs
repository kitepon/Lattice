/* Pure projections shared by Store and Plan; no I/O or lifecycle mutation. */

export function isPhaseTodoPlanSchema(schema) {
  return ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7'].includes(schema);
}

export function isDecoupledPhaseTodoPlanSchema(schema) {
  return ['lattice.todo_plan.v5', 'lattice.todo_plan.v7'].includes(schema);
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
