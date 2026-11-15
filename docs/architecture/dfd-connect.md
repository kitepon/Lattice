# 前工程, 他条件に接続, 優先接続 and ブロック (CLI, wording, screens)

Chart: lattice / lattice-connect-block-20261115. Owner spec: Quo via Trony, 2026-11-15. Contract:
`/srv/bellteam/bots/bot-fc291ae4/docs/lattice-connect-block-20261115.md` (revision 4 and its additions).
The [function map](function-map.md) is the canonical implementation map; this file owns the data flow of the four words.

## Words (one concept, one word)

| Word | Meaning | Where it lives |
|---|---|---|
| 前工程 | a task on this chart that must finish first | plan edge or in-chart ledger edge; `todo predecessor add\|remove` |
| 他条件に接続 (接続) | a condition outside this chart: a task on another chart, or a BellTeam schedule | cross-plan ledger edge (task) or `connection_*` events (schedule); `todo connect condition add\|remove\|resolve` |
| 優先接続 | "tell me the moment this task can start"; gates nothing | host-local mark in the notices store; `todo connect priority` |
| ブロック | last resort for an in-progress task nothing can be connected to | `block` / `unblock` events |

止め and 待ち are retired from CLI help, refusal guidance, todo-cli strings, this directory and the dashboard. 監査待ち
(a Phase waiting for audit) is a different concept and keeps its name. Machine names kept for compatibility: the notice
field `waiting` and `waiting_digest` (persisted ack format), the revision-record grammar `dependency connect|disconnect`
in `todo-revision-note.mjs` (history must still parse).

## Function map (Plan side, Alice)

| Function | Input | Output / state | Failure |
|---|---|---|---|
| `todo predecessor add\|remove` (`predecessorChange`) | plan, task, `--after <plan>/<task>`, reason | today's dependency connect/disconnect (plan revision or ledger edge); same chart only | another chart or `schedule:` -> `CONNECTION_INVALID/predecessor_target_not_same_chart`, next_action `connect condition add`; malformed `--after` -> exit 2 pointer `--after` |
| `todo connect condition add\|remove\|resolve` (`connectCondition`) | plan, task, `--to task:<project>/<plan>/<task>\|schedule:<id>`, reason or message | `task:` -> `dependencyConnectExternal` / `dependencyDisconnectLedger`; `schedule:` -> `connection_added` / `connection_removed` / `connection_resolved` through `appendTodoEvent` (payloads and idempotency are the Store's) | same-chart task -> `condition_target_same_chart`, next_action `predecessor add`; `resolve` on `task:` -> `condition_task_target_settles_itself`; never added -> `connection_not_found`; unknown task -> `TASK_NOT_FOUND`; malformed `--to` -> exit 2 pointer `--to` |
| `todo connect priority` (`noticePriority`; `todo wait` alias) | plan, task, reason / `--cancel` | `lattice.todo_connect_priority_result.v1 {state: prioritized\|startable_now\|not_pending\|cancelled}`; the mark is the host-local wait file | as before |
| `todo block` result | plan, task, reason | `next_action` names `predecessor add` and `connect condition add`; ブロック is the last resort | as before |
| `dependency connect\|disconnect` (alias, one minor version) | the old flags | the same result as before; stderr prints `lattice.todo_command_retired.v1 {use}` naming the replacing command after a success | as before |
| gantt/dashboard 接続 area (`renderConnectionArea`, `renderConnectionChips`) | per-task `connections` from the Store's `listTodoConnections` | one area per task in the detail pane and a chip in the task index; each entry labelled 他条件に接続 or 優先接続; ブロック中 stays where it was | none (empty list draws nothing) |

Store side (Ludmila, b1): `connection_*` events, `connections[]` projection, `listTodoConnections(store, plan, task, {includeRemoved})`
in `todo-readiness.mjs`, `blocking_connections` / cause `connection_open` on `todo start`. Plan reads them; it writes
only through `appendTodoEvent` (and the existing ledger paths).

## Data flow

```
seat --todo predecessor add--> predecessorChange --> plan revision | ledger edge (same chart)        --> readiness: 前工程 unfinished
seat --todo connect condition add task:--> dependencyConnectExternal --> ledger edge (this chart only) --> readiness: connection_open until that task is done/retired
seat --todo connect condition add schedule:--> appendTodoEvent(connection_added) --> plan-scoped chain  --> readiness: connection_open
BellTeam scheduler --connect condition resolve--> appendTodoEvent(connection_resolved)                 --> readiness: startable, notice to the lane
seat --todo connect priority--> notices store (host-local)                                              --> notice `waiting` / `connections[kind=priority]`
store --connections--> dashboard/gantt: 接続 area + chip (never a tree edge)                          ; ブロック中 unchanged
```

BellTeam reaches Lattice only through these commands; Lattice never reads BellTeam's schedule store.

## Idempotency and errors (contract "Caller, retries and errors")

- Any actor may call; the actor is recorded. No lane rule.
- `add` of an open identical 接続, `resolve` of a settled one (first evidence kept) and `remove` with nothing open exit 0 with `unchanged: true`.
- Refusals exit 1 in `lattice.cli_error.v2`; argument errors exit 2.

## Screens

The detail pane and the task index show 他条件に接続 and 優先接続 together, one area per task, from the single
`connections` list. A 接続 to a task on another chart is not drawn as an edge: the gantt layout skips cross-chart
ledger edges (前工程 inside one chart stay tree edges).

## Verification

`test/todo-connect-condition.test.mjs` (each command refuses the other's targets; idempotent writes; alias notices),
`test/todo-wait.test.mjs` (priority), `test/todo-cli.test.mjs` (block result), `test/todo-gantt-connections.test.mjs` (screens).
