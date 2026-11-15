# ADR 0201: A plan has no task, edge, join or phase count cap

Status: accepted (2026-11-15, k1-drop-count-caps, Ludmila; requested by Trony for the Owner's chart)

## Context

ADR 0053 capped a plan at 512 tasks, 2,048 edges and 128 joins. On the BellTeam chart the plan
`bellteam-dev-added` reached 512 tasks, most of them done or retired, and `todo add` failed with
`INPUT_INVALID plan_create_schema_invalid bounded_collection_violation /tasks`. The Owner wanted follow-ups
under his task a156 in that plan. Finished tasks stay in the plan so no history is lost, so the count only grows.

## Decision

The count caps protect none of the named protections (data loss, wrong target, secret exposure, privilege
escalation, overwriting state) and have no exit of their own (guards.remove-unnamed), so they are removed, not raised.
The size of a plan stays bounded by bytes: every plan, snapshot and manifest is read with
`TODO_LIMITS.snapshotBytes` (8 MiB), an authoring input file by its 8 MiB input cap, a journal event by the 1 MiB
segment, so a plan too large to read or write is still refused (fail closed) by size.

Removed (constants `tasksPerPlan`, `edgesPerPlan`, `joinsPerPlan` are gone):
`todo-contracts` plan/phase/join/accept-edge counts, the genesis `task_migration` count, state and phase migration counts,
snapshot task count; `todo-migration` extraction edge/join/task counts; `todo-store` import input and narrative source
counts; `todo-revision` operation, task/phase migration, runtime task migration, successor and source inventory counts
(the plan-sized lists of a revision).

Kept, because they do not scale with plan size or are already byte-bound with their own number:
the note context entry count (`noteContextEntries`, 512, beside `noteContextBytes`, shared by the validator and the
note walker); the per-entry `evidence_digests` count; the backchain continuity count and revision history length;
status list limits (`TODO_STATUS_LIST_LIMIT`, output is cut and recorded in `truncated`).

## Consequences

- A 600-task plan with 3,000 edges and 150 joins is 0.67 MB of plan.json (test `todo-plan-size`), so 8 MiB is roughly
  ten thousand tasks of that shape. Long design memos change the figure; the byte cap is what counts.
- A reader older than this release still refuses a plan above its own caps. Seats read the same Store only after the
  release.
- Another product that mirrors these caps (a host reading plan.json) keeps its own limits; Lattice does not read them.
