# Data flow: 接続 (他条件に接続) — Store and readiness

Plan lattice-connect-block-20261115, task b1-store-readiness (Ludmila). Spec: Owner via Trony
(`bot-7b140b27/docs/lattice-connect-spec-20261115.md`); contract: `bot-fc291ae4/docs/lattice-connect-block-20261115.md`.
Words: 前工程 = a task on the same chart (unchanged). 接続 = a condition outside the task's own chart: a task on another
chart, or a BellTeam schedule. ブロック replaces 止め. A 接続 is never called a 前工程.
Alice (CLI, b2) calls the Store functions named here; BellTeam reaches Lattice only through that CLI.

## Records (plan-scoped chain, `plan-scoped.jsonl`, same chain and sealing as `cross_plan_dependency`)

| Event (`todo-contracts.mjs`) | Payload | Rule at append (`appendTodoEvent`, `validateConnectionTransition`) |
|---|---|---|
| `connection_added` | `{task_id, to: {kind: 'schedule', id}, reason}` | `id` is opaque: printable ASCII, no space, 1-128. `task_id` must be a task of the plan (`TASK_NOT_FOUND/task_not_found`; case folded to the canonical id). When the same task + id is already open, nothing is appended and `appendTodoEvent` returns `{unchanged: true, target_event_digest}`. A done or retired task is not refused (nothing to protect). |
| `connection_removed` | `{target_event_digest, reason}` | Target must be a `connection_added` of this chain (`DEPENDENCY_NOT_FOUND/connection_not_found`). When it is not open (already removed or resolved) nothing is appended: `{unchanged: true}`. |
| `connection_resolved` | `{target_event_digest, evidence}` | Same target rule. When it is already settled nothing is appended and the first evidence wins: `{unchanged: true}`. Resolving a removed entry is `DEPENDENCY_INVALID/connection_already_removed`. |

Every write is idempotent, so a retry after an unknown outcome replays to the same state (the CLI reports `unchanged: true`, exit 0).
No lane rule: any actor may write; the actor is recorded in each event. A settled entry may be added again (a new open one).
`listTodoConnections(store, planKey, taskId, {includeRemoved: true})` also lists removed entries (`state: 'removed'`) so a retried remove can answer `unchanged`.

`reason` and `evidence` are non-empty text of at most 16384 bytes. A task target is not a new event: it is today's
`cross_plan_dependency` whose `from.project_id` differs from the chart's (`dependency connect --from-project`).
A reader older than this release meets the unknown kind and answers `UNSUPPORTED_SCHEMA/newer_lattice_value` (upgrade).

## Projection

`projectTodoScheduleConnections(events)` (todo-store-view, pure): one entry per `connection_added` with its end.
`projectTodoConnections(members, externalTasks)` (pure): per task `{kind: 'task'|'schedule', ref, state: 'open'|'settled', reason, since, event_digest, settled_at?, evidence?, state_reason?}`.
`ref` is `<project>/<plan>/<task>` for a task and the schedule id for a schedule. A removed connection is not listed.
A schedule connection is settled by `connection_resolved`; a task connection is settled when that task is done or
retired. If its chart cannot be read it stays open and `state_reason` names why (`chart_not_read`, `endpoint_missing`).
`listTodoConnections(store, planKey, taskId)` (todo-readiness) returns one task's entries; call `withTodoExternalTasks` first.

## Readiness (`todo-readiness.mjs`)

| Question | Answer |
|---|---|
| Is the task startable (`next_ready`, `isReady`)? | Pending, own phase ready, `startReady`: 前工程 and phase accepts done, and no open schedule 接続. An open task 接続 is already an unfinished external predecessor. |
| `todo start` | Refused `TODO_TRANSITION_REFUSED/invalid_start_transition` with `cause`: `acceptance_edge`; else `predecessor_unfinished` when a same-chart 前工程 is unfinished (`blocking_tasks`, same chart only, plus `blocking_connections` when any is open); else `connection_open` with `blocking_connections: [{kind, ref, reason, since, state_reason?}]`. `--override-reason` still bypasses, as for 前工程. Rebind and historical import are not gated. |
| `todo done` | A schedule 接続 never gates done. A task 接続 (cross-chart edge) gates done as it does today. |
| A 接続 added to an in-progress task | Nothing changes for that task; readiness gates only `start`. |
| `todo show` | `prerequisites.connections` lists open and settled entries; `blocking_tasks` is same-chart only. |
| `todo status`, `session-context` (`lattice.todo_status_result.v10`) | `active_set[].connections` and `connection_pending: [{plan_key, task_id, label, connections}]` (pending tasks that carry any entry) hold the one list: open 他条件に接続 entries `{kind, ref, state: 'open', reason, since, state_reason?}` and 優先接続 entries. Settled entries are history that `todo show` and `todo display read` list. |
| `todo display read` | Adds `connections: [{plan_key, task_id, connections}]` for each task that has any (open and settled 他条件に接続, and 優先接続). An unreadable store shows `[]`; the display never stops. |

## One place: 優先接続 and no edge (Owner via Trony, 2026-11-15)

Each task has ONE list, `connections`, in `todo show` (`prerequisites.connections`), status, session-context and
`todo display read`. It holds the 他条件に接続 entries above and the 優先接続 entries
`{kind: 'priority', agent, since, reason}`, taken from the host-local `todo wait` marks still in effect
(`withTodoPriorityWaits` in `todo-notices.mjs`, same data as the notice `waiting` field, which stays as an alias).
Only 他条件に接続 gates start; a 優先接続 gates nothing. A 接続 is not a tree edge: the Gantt layout draws no edge
for a cross-chart dependency (and no skipped-edge notice), the task trees and status graph already skipped it, and
`blocking_tasks` stays same-chart only. The raw ledger events stay in the display envelope's `store` as records, and
`external_tasks` stays as the states of those other-chart tasks that readiness reads; neither is a relation list.

## Carry across a plan revision

`carriedPlanScopedChain` (`todo-store.mjs`) copies a predecessor's live ledger edges (edge-carry) and now also its
open schedule connections, mapping `task_id` through the genesis `task_migration`; a settled, removed or
removed-task connection is not copied (it equals no connection for readiness).

## Data flow

BellTeam `set_schedule(connect)` → CLI `todo connect --to schedule:<id>` (Alice) → `appendTodoEvent(connection_added)` →
plan-scoped chain → readiness: task not startable → status/show/start refusal show it.
Schedule exits 0 → CLI `todo connect resolve` → `connection_resolved` → readiness: startable → startable notice (existing).
`todo connect --to task:...` → today's `cross_plan_dependency`; readiness reads the other chart (`external_tasks`).
No product reads another product's store: BellTeam's schedule store is never read by Lattice.
