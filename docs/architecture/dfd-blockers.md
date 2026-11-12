# Data flow: blockers (blockers-list, 2026-11-12)

Status: task `lattice-blockers-20261112/blockers-list`. The Owner's words are the whole spec (Quo 2026-11-12):
"ブロッカー（止め）一覧は作ってくれ。それを見て俺が解除する。AIも解除できる。"
Owner: Plan/lifecycle (projection, CLI). Nothing is written. The screen and the Owner's unblock path are
BellTeam's (Flora, task blockers-screen), which reads only the CLI JSON below.
Canonical ownership in [function-map](function-map.md). It extends the `blocked` list of `todo status`
(plan_key, task_id, truncated reason) with the full reason, who stopped it and when.

Boundary: Lattice reads and shows. `todo unblock` stays open to any seat (no actor check), as before.

## Flow

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `projectTodoBlockers(store)` (pure, todo-blockers.mjs) | Store view: per member the task states (`status: blocked`, `blocked_reason`) and the journal; the last `block` event of each blocked task | `blockers: [{plan_key, task_id, title, lane, reason, blocked_at, blocked_by, unblock_action}]` sorted by plan_key, task_id. `reason` = the full `blocked_reason`; `blocked_at` = the block event's `recorded_at`; `blocked_by` = its `actor` `{host, session, agent}`; `unblock_action` = `lattice todo unblock --plan <key> --task <id>` | Pure; never refuses. No block event found (not expected: replay sets blocked only from one) gives `blocked_at`/`blocked_by` null |
| Plan: `todo blockers [--json]` (todo-cli `blockerList`) | One Store read | `lattice.todo_blockers_result.v1 {project_id, blockers, result_digest}`, exit 0 | No Store yet (`STORE_UNINITIALIZED`): exit 0 with `project_id: null`, `blockers: []`. Other Store refusals as every read |
