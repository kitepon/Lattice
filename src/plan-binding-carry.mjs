// Plan-owned continuity semantics for incoming cross-plan connections whose source
// plan was revised (Snow White coordination decision 2026-11-07, w1b first use).
// Pure: no I/O, no Store mutation. Store's rebindTodoCrossPlanDependencies calls it
// under lock with the active source member, the live dependencies to carry and the
// retained predecessor plan's identity, and only rebinds when it answers ok.
const CARRIED_POLICIES = new Set(['carry', 'carry_reconciled_metadata']);

export function validateBindingCarry({ store, source, dependencies, predecessor }) {
  // Refusal shape is Store's typed refusal: code = error class, detail.reason = rule.
  const refuse = (code, reason, detail = {}) => ({ ok: false, code, detail: { reason, ...detail } });
  const { plan, revision } = source;
  // shortcut: only the immediate predecessor hop is carried; a connection two or more
  // revisions behind needs a chained check, add it when such a store actually exists.
  if (revision?.predecessor?.plan_version !== predecessor.plan_version
    || revision?.predecessor?.plan_digest !== predecessor.plan_digest) {
    return refuse('DEPENDENCY_STALE', 'binding_carry_hop_unlinked', { predecessor,
      revision_predecessor: revision?.predecessor ?? null });
  }
  if (revision.desired_plan?.topology_digest !== plan.topology_digest) {
    return refuse('DEPENDENCY_STALE', 'binding_carry_successor_mismatch', { plan_version: plan.plan_version });
  }
  const migration = new Map(revision.task_migration.map((row) => [row.from_task_id, row]));
  const seen = new Set();
  const rebound = [];
  for (const dependency of dependencies) {
    const { from, to } = dependency;
    const edge = { from_task_id: from.task_id, to: { plan_key: to.plan_key, task_id: to.task_id } };
    if (from.project_id !== plan.project_id || from.plan_key !== plan.plan_key) {
      return refuse('DEPENDENCY_INVALID', 'binding_carry_source_mismatch', edge);
    }
    if (from.expected_topology_digest !== predecessor.topology_digest) {
      return refuse('DEPENDENCY_STALE', 'binding_carry_predecessor_mismatch', { ...edge,
        expected_topology_digest: from.expected_topology_digest });
    }
    const row = migration.get(from.task_id) ?? null;
    if (row === null || row.to_task_id !== from.task_id || !CARRIED_POLICIES.has(row.state_policy)) {
      return refuse('DEPENDENCY_INVALID', 'binding_carry_task_not_carried', { ...edge, migration: row });
    }
    if (!plan.tasks.some(({ task_id: taskId }) => taskId === from.task_id)) {
      return refuse('DEPENDENCY_INVALID', 'binding_carry_task_missing', edge);
    }
    const owner = store.members.find((member) => member.plan.project_id === to.project_id
      && member.plan.plan_key === to.plan_key) ?? null;
    if (owner === null || !owner.plan.tasks.some(({ task_id: taskId }) => taskId === to.task_id)) {
      return refuse('DEPENDENCY_INVALID', 'binding_carry_target_missing', edge);
    }
    if (to.expected_topology_digest !== owner.plan.topology_digest) {
      return refuse('DEPENDENCY_STALE', 'binding_carry_target_changed', { ...edge,
        expected_topology_digest: to.expected_topology_digest,
        actual_topology_digest: owner.plan.topology_digest });
    }
    const key = `${from.task_id}\0${to.project_id}\0${to.plan_key}\0${to.task_id}`;
    if (seen.has(key)) return refuse('DEPENDENCY_INVALID', 'binding_carry_duplicate', edge);
    seen.add(key);
    rebound.push({ event_digest: dependency.event_digest ?? null, ...edge,
      from_topology_digest: from.expected_topology_digest, to_topology_digest: plan.topology_digest });
  }
  return { ok: true, detail: { plan_version: plan.plan_version,
    successor_topology_digest: plan.topology_digest, rebound } };
}

export function carriedDependencyPayload(dependency, successorTopologyDigest) {
  return { from: { ...dependency.from, expected_topology_digest: successorTopologyDigest },
    to: { ...dependency.to }, reason: dependency.reason };
}
