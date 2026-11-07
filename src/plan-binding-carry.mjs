// Plan-owned continuity semantics for incoming cross-plan connections whose source
// plan was revised (Snow White coordination decision 2026-11-07, w1b first use).
// Pure: no I/O, no Store mutation. Store supplies this as the mandatory callback of
// rebindTodoCrossPlanDependencies and only rebinds when it answers ok.
const CARRIED_POLICIES = new Set(['carry', 'carry_reconciled_metadata']);

function findMember(store, ref) {
  return store.members.find(({ plan }) => plan.project_id === ref.project_id
    && plan.plan_key === ref.plan_key) ?? null;
}

export function validateBindingCarry({ store, source, dependencies }) {
  const refuse = (code, detail = {}) => ({ ok: false, code, detail });
  const member = findMember(store, source);
  if (member === null) return refuse('binding_carry_source_missing', { plan_key: source.plan_key });
  const { plan, revision } = member;
  // shortcut: only the immediate predecessor hop is carried; a connection two or more
  // revisions behind needs a chained check, add it when such a store actually exists.
  if (revision?.predecessor?.plan_version !== source.predecessor.plan_version
    || revision?.predecessor?.plan_digest !== source.predecessor.plan_digest) {
    return refuse('binding_carry_hop_unlinked', { predecessor: source.predecessor,
      revision_predecessor: revision?.predecessor ?? null });
  }
  if (revision.desired_plan?.topology_digest !== plan.topology_digest) {
    return refuse('binding_carry_successor_mismatch', { plan_version: plan.plan_version });
  }
  const migration = new Map(revision.task_migration.map((row) => [row.from_task_id, row]));
  const seen = new Set();
  const rebound = [];
  for (const dependency of dependencies) {
    const { from, to } = dependency;
    const edge = { from_task_id: from.task_id, to: { plan_key: to.plan_key, task_id: to.task_id } };
    if (from.project_id !== source.project_id || from.plan_key !== source.plan_key) {
      return refuse('binding_carry_source_mismatch', edge);
    }
    if (from.expected_topology_digest !== source.predecessor.topology_digest) {
      return refuse('binding_carry_predecessor_mismatch', { ...edge,
        expected_topology_digest: from.expected_topology_digest });
    }
    const row = migration.get(from.task_id) ?? null;
    if (row === null || row.to_task_id !== from.task_id || !CARRIED_POLICIES.has(row.state_policy)) {
      return refuse('binding_carry_task_not_carried', { ...edge, migration: row });
    }
    if (!plan.tasks.some(({ task_id: taskId }) => taskId === from.task_id)) {
      return refuse('binding_carry_task_missing', edge);
    }
    const owner = findMember(store, to);
    if (owner === null || !owner.plan.tasks.some(({ task_id: taskId }) => taskId === to.task_id)) {
      return refuse('binding_carry_target_missing', edge);
    }
    if (to.expected_topology_digest !== owner.plan.topology_digest) {
      return refuse('binding_carry_target_changed', { ...edge,
        expected_topology_digest: to.expected_topology_digest,
        actual_topology_digest: owner.plan.topology_digest });
    }
    const key = `${from.task_id}\0${to.project_id}\0${to.plan_key}\0${to.task_id}`;
    if (seen.has(key)) return refuse('binding_carry_duplicate', edge);
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
