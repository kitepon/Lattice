# ADR 0206: A cross-plan edge pins its source task, not the source plan's whole topology

- Status: accepted for implementation (2026-11-26, Snow White decided option (b); s7 of plan lattice-seat-cost-20261126)
- Owners: Ludmila (Store), Snow White (contract), Alice (Plan: task_migration and the carry proof)
- Amends: ADR 0053 Decision 4 ("cross-plan dependency binding carries `expected_topology_digest`")
- Diagram: [dfd-store-phase-revision](../architecture/dfd-store-phase-revision.md) (u03 section); roles in [function-map](../architecture/function-map.md)

## Context

ADR 0053 Decision 4 binds every cross-plan edge to the topology digest of the plan it points into, so that the merged graph never
changes meaning implicitly: a successor version of that plan makes the edge `binding_stale`. The u03 repair
(`repairCrossPlanBindings`, run after every successor write) then re-pins each live edge by writing a tombstone plus a new edge
into the owner's plan-scoped chain.

The topology digest covers every task of the source plan, so any revision of it (every `todo add`) stales every inbound edge, even
when the edge's source task is untouched. On the bellteam Store (2026-11-26): `bellteam-dev-added` (2.9k tasks) is revised many
times a day; its 12 inbound edges (7 into `bellteam-dev`, 5 into `bellteam-dev-3`) were re-pinned 24 events per revision.
`bellteam-dev` / `-3` hold 20,324 / 10,914 plan-scoped events for 7 / 5 live edges, 25 of the 39 MB display checkpoint, and every
verified read re-parses them. The endpoints never changed; only the pin did.

## Decision

1. **A cross-plan edge's `from` ref in the same project is pinned to its task**, with the existing field and no schema change:
   `expected_topology_digest` holds `todoTaskPin(ref)` = the digest of the canonical `{schema: 'lattice.todo_task_pin.v1',
   project_id, plan_key, task_id}`. It is stable while the task keeps its identity.
2. **Meaning is kept.** The edge depends on its task, not on unrelated tasks of the plan (ADR 0053's intent). A task pin stays valid
   while the task is in the source plan, including when the revision resets it (Alice's ruling: the task is the same task, pending
   again, so the wait stays right; a new meaning needs a new id, and Plan gives no migration row for a new id). When the task is gone
   (renamed, merged or removed) the finding is `endpoint_missing`, as for any endpoint. Plan owns `task_migration`; it is the identity
   proof. A revision that neither renames nor removes the source task writes nothing.
3. **Repair as today, from one hop.** `repairCrossPlanBindings` maps a task-pinned edge through the current genesis's
   `task_migration`: carried to another id -> tombstone + replacement pinned to the new task; `removed` -> tombstone; no row -> the
   finding stays. The repair runs in the revision's own locked write. A legacy topology-pinned edge is repaired by the old lineage walk, and its replacement is task-pinned
   (a one-time conversion of 2 events per edge).
4. **Compatibility.** Existing topology-pinned edges stay readable and valid while their pin equals the source topology; sealed events
   are never rewritten; no event kind, field or schema is added, so an older CLI reads the chain. An older CLI sees a task pin as a
   stale topology (a `binding_stale` finding, which never stops dispatch) and cannot map it; upgrade the seats.
5. **Unchanged:** the `to` ref and phase refs keep topology pins (the owner re-pins its own carried chain at its own revision);
   edges from another chart keep the other chart's topology (Plan's node); connect-time validation still requires a current pin
   (`dependency_topology_stale`), accepting the task pin for a task that exists.

## Consequences

- A revision of a big source plan no longer grows the owners' chains: 24 events per `todo add` -> 0 after the one-time conversion.
- Known limits (`shortcut`, upgrade when such a store exists): (a) a permutation of ids that all stay in the plan (T1->T2 and T2->T1)
  is not seen, because the pin names the id; (b) if the repair of a removed task is dropped (duplicate or cycle) and a later revision
  adds the same id again, the edge attaches to the new task; the finding stays until the tombstone is written.
- Rejected: leaving stale pins (every revision would raise `binding_stale`, which misleads); a lineage proof at read time (reads
  every retained version again, the m1 harm).
