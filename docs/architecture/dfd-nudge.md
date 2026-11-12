# Data flow: nudges (sweep-list, 2026-11-12)

Status: task `lattice-nudge-20261112/sweep-list`. The Owner's words are the whole spec (Quo 2026-11-12):
"Lattice側が５分に一回くらい工程表を見て、担当者が仕事をしていなかったら発火を促す。発火しても動けないものは
「止め」を設定するように促す。これ以外の条件をつけるな。" "Not working" = not started on the chart although its
predecessors are finished, and the Bot is not running.
Owner: Plan/lifecycle (projection, CLI). Nothing is written. "The Bot is not running", the ~5-minute run and
delivery are BellTeam's (Flora, task sweep-deliver), which reads only the CLI JSON below.
Canonical ownership in [function-map](function-map.md).

Boundary: Lattice reads and shows. A nudge starts, blocks and finishes nothing. No counts, records, thresholds
or exemptions: the list is exactly the ready set. A stopped (blocked) task is not ready, so it leaves the list
by itself; so does a started one.

## Flow

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `projectTodoNudges(store, {declared})` (pure, todo-nudges.mjs) | Store view; the ready set = `projectTodoStatus(…).next_ready` (predecessors finished, not started: the rule `todo status` uses); plan coordination mode; `declared(plan, task)` from the enforced plans' witness sets (the same reader notices use) | `lanes: [{lane, tasks}]`, lanes sorted (null lane last), tasks in `next_ready` order. Each task `{plan_key, plan_version, task_id, title, done_condition, fire_actions, stop_action, prompt}`: `fire_actions` = the start path in order (`startPath`, shared with notices: witness declare first on an `enforced` plan without the task's row, then `todo start`); `stop_action` = `lattice todo block --plan <key> --task <id> --reason <why it cannot move>`, run once fired (block accepts only a started task); `prompt` = the text to hand the lane: fire it, and if it cannot move once fired, set a stop | Pure; never refuses |
| Plan: `todo nudge [--json]` (todo-cli `nudgeList`) | One Store read; witness sets of enforced plans | `lattice.todo_nudge_result.v1 {project_id, lanes, result_digest}`, exit 0 | No Store yet (`STORE_UNINITIALIZED`): exit 0 with `project_id: null`, `lanes: []` (the run walks every chart directory). Other Store refusals as every read. An unreadable witness set reads as "no row" (the declare command is offered; declaring again is harmless) |
