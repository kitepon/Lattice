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

止め and 待ち are retired from CLI help, refusal guidance, todo-cli strings, this directory and the dashboard. The Phase
not yet audited is labelled 監査前; the JSON key `audit_pending` is unchanged. Machine names kept for compatibility: the notice
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


## Re-judge on a target change and waiters (n1, 2026-11-28)

Chart: lattice / lattice-connect-rejudge-20261128, task n1 (Alice, Plan/lifecycle). Ruling: Tronie with the Owner,
2026-11-28 10:1x JST, narrowed 10:2x. Lattice owns exactly two facts; everything else is BellTeam's.

| Fact | Owner | Not Lattice (stated so no one waits for it here) |
|---|---|---|
| (a) A 接続's target is done, retired, missing or reopened (a task) or removed or resolved (a schedule): the 接続 is judged again at that moment; it waits only while the target exists and is not done | Plan/lifecycle (Alice) | Telling the waiting lane's Bot; `次の工程` on BellTeam screens (Flora); deciding when a schedule is deleted (Berota) |
| (b) A task lists who waits on it through 接続, across charts and projects, as 前工程 successors already are listed | Plan/lifecycle (Alice) | The screen that shows it (Flora, Display) |

Lattice sends no Bot message and runs no watcher or periodic check. Content changes of the target need nothing beyond what a
reader already sees in the target's own journal.

### Why "at that moment" needs no event (and where the gap really is)

A 接続 to a task on another chart is today's `cross_plan_dependency` edge in the *waiting* chart. Its state is not stored:
every reader (`withTodoExternalTasks`) reads the target's chart and judges again on that read, so done, retire and reopen of
the target are seen by the next read of the waiter, with no write in the waiting chart. A 接続 to a schedule is stored in the
waiting chart (`connection_added` / `removed` / `resolved`), so a change of the schedule is a write the schedule's owner makes.
The gaps are therefore four, none of them a missing re-check:

1. **Target missing** (the plan or task is gone from a chart that can be read, `endpoint_missing`): the 接続 stays open forever.
   In-chart the same case never blocks (u03 A24). One rule now: a missing target never blocks. An unreadable chart
   (`charts_root_unset`, `chart_unreadable`) is *unknown*, not gone: it stays open with its `state_reason` and settles by itself on the next
   readable read (the guard has a self-exit: the read).
2. **Target retired** is reader-visible as "settled" today, which hides that nothing was finished. It is told apart: `gone`.
3. **A removed schedule 接続 is dropped from every reader.** A reader cannot tell "never connected" from "the schedule is gone".
   It is listed as `gone` (history, like a settled one).
4. **No reverse lookup.** The target's chart does not hold the edge, so `k12-v1-close` could not show its two waiters.

### Command a schedule owner calls when its schedule is deleted (answer for Berota)

Already covered, no new command: `lattice todo connect condition remove --plan <plan> --task <task> --to schedule:<id> --reason <text>`
(run in the waiting chart: BellTeam `lattice` tool with `project` = the schedule's `connect.project`). Plan and task are the schedule's own
`connect` binding. It appends `connection_removed` (the Store's idempotent write), so a retry or a second call exits 0 with
`unchanged: true`; an entry already resolved is unchanged too. `resolve` stays the command for a schedule that settled.
What was missing was the reader-visible result: the entry is now listed with `state: 'gone'` (below), so `a540-release` waiting on a schedule no
seat had is cured by that one call and visible as removed afterwards.

### Function map (Plan side)

| Function | Input | Output / state | Failure |
|---|---|---|---|
| `readTodoExternalTasks` (todo-external) | live cross-chart edges of the store | each external task `{status, finished, reason, trigger}`; **change:** `reason: 'endpoint_missing'` (chart read, task absent) now yields `missing: true` | unreadable chart: `finished: false`, `reason` named (unknown stays open) |
| `projectTodoConnections` (todo-store-view, pure) | members, external tasks | per task entries; **change:** `state` is `open\|settled\|gone`; a retired or missing target and a removed schedule are `gone`; each task entry also carries `changed` (the target's latest journal event) | none |
| `createTodoReadiness` (todo-readiness) | store with external tasks | **change:** a `gone` or `settled` 接続 never blocks `start`/`done`; only `open` does (a missing external endpoint is skipped as an in-chart one is, A24) | as before |
| `listTodoConnectionWaiters({env, target})` (todo-external, new, read-only) | the target `{project_id, plan_key, task_id}`, `LATTICE_CHARTS_ROOT` | `{waiters: [...], unread: [{project_id, reason}]}`: for every other chart (`chartIds(root)`, exported from chart-cli) read through `readTodoStoreReadOnly`, the live cross-project edges whose `from` is the target, with the edge's current `state` | an unreadable chart is named in `unread`, never read as "no waiters" |
| `todo show` (`taskPrerequisites`) | plan, task | **change:** `waiters` and `waiters_unread` beside `prerequisites` | none beyond today's |
| `todo waiters [--plan <key>] [--task <id>] [--open] [--json]` (new) | none = every task of this chart that has a waiter | `lattice.todo_waiters_result.v1` (below) | no `LATTICE_CHARTS_ROOT`: `waiters: []`, `unread: [{project_id: null, reason: 'charts_root_unset'}]` |
| `todo display read [--open]` (`displayRead`) | as today | **change:** top-level `waiters: [{plan_key, task_id, waiters}]` for each task that has any; with `--open` only `state: 'open'` entries; `waiters_unread` | an unreadable chart is named; the display never stops |
| mutation result of `done`, `retire`, `reopen` (`withNotices` path) | the changed task | **change:** `waiters`, `waiters_unread` of that task (all states), so the writer learns which other charts' tasks this change re-judged | scan failure: `waiters: null`, `waiters_unavailable: <reason>`; the write is never undone |
| `charts source` (K2, `chartSources` in chart-cli) | chart ids | **change:** the token of chart *A* also digests the live cross-project edges whose `from` is in *A* (read from the other charts' plan-scoped chains), so it moves when a waiter appears or goes | a chart that cannot be read adds nothing; the token still moves on every other change |
| `connect condition remove\|resolve schedule:` (`connectCondition`) | unchanged | unchanged writes; the next read lists the entry as `gone` / `settled` | as before |

Store (Ludmila): no code in n1/n2. Pieces named: (i) the pure projection `projectTodoConnections` lives in her file and gains the `gone` state and the removed
schedule entries (no on-disk format, no new event kind; Plan edits it in n2 after her review); (ii) a derived per-chart index of outgoing cross-chart connections is
the only Store code that could be needed, and only if n2 measures the read-time scan as too slow. It is not built now (nobody uses it until then); if measured, it becomes a task in her lane.

### State of one 接続 (task kind)

```
(no 接続) --connect condition add task:--> open (since)
open    --target done-------------------------------> settled   state_reason: target_done   (changed: the done event)
open    --target retired----------------------------> gone      state_reason: target_retired
open    --target's plan or task removed, chart read--> gone      state_reason: target_missing
open    --chart cannot be read----------------------> open      state_reason: chart_not_read | charts_root_unset | chart_unreadable
settled|gone --target reopened (a task that still exists)--> open     (changed: the reopen event)
gone    --target_missing: target comes back (plan restored)--> open
open|settled|gone --connect condition remove-----------> (not listed; tombstone, as today)
```

```
(no 接続) --connect condition add schedule:--> open
open --connect condition resolve schedule:--> settled   evidence kept, first one wins
open --connect condition remove schedule:---> gone      state_reason: schedule_removed
gone|settled --connect condition add schedule: again--> a new open entry (as today)
```

Every transition is a read-time judgment or one idempotent write; nothing is polled. Guards: none new. The only wait that can outlast its cause is an unreadable chart,
which leaves by itself on the next readable read; `start --override-reason` bypasses a 接続 as before.
A task already in progress or done keeps its status when its target is reopened: readiness gates `start` only (the 接続 on such a task is history), and the
writer of the reopen is told by `waiters` in the result.

## Data flow (n1)

```
target task, any chart/project:   done | retire | reopen | plan revise removes it
   |  (a write in the TARGET chart only; nothing is written in the waiting chart)
   v
waiting chart reader (status, session-context, start gate, notice list, show, display read):
   withTodoExternalTasks -> readTodoExternalTasks (reads the target chart read-only, per call)
   -> projectTodoConnections: open | settled | gone (+ state_reason, changed)
   -> createTodoReadiness: only open blocks; notices (todo-notices) open for a task that became startable, exactly once per ack
   v
BellTeam (Flora) reads: connections[] of the waiting task, notice list; tells the lane herself

schedule deleted in BellTeam --Berota--> lattice todo connect condition remove --to schedule:<id> --> connection_removed
   -> next read of the waiting chart: entry gone/schedule_removed, task startable if nothing else is open

target chart reader (k12-v1-close and the like):
   listTodoConnectionWaiters: for every other chart read-only: live cross-project edges from the target
   -> todo show .waiters | todo waiters | todo display read .waiters | mutation result .waiters
   -> BellTeam shows it under 次の工程 (Flora)
```

No product reads another product's store: BellTeam's schedule store is never read; other charts are read only through `readTodoStoreReadOnly`.

## JSON contract for BellTeam (n1)

Connection entry (existing list `connections` of `todo show` `prerequisites`, status, session-context, display read), additive fields in bold:
`{kind: 'task'|'schedule'|'priority', ref, state: 'open'|'settled'|'gone', reason, since, event_digest, settled_at?, evidence?, **state_reason?**, **changed?**, **target_content_digest?**}`.
A reader that treats only `state === 'open'` as waiting needs no change. `state_reason`: for `open` `chart_not_read`, `charts_root_unset` or `chart_unreadable`; for `settled` `target_done` or
`schedule_resolved`; for `gone` `target_retired`, `target_missing` or `schedule_removed`. `changed` (task kind): `{kind: 'done'|'retire'|'reopen'|…, event_digest, recorded_at}` = the
target's latest journal event, `null` when unread or missing: a stable key a host can keep its own "already told" record on.
`target_content_digest` (task kind; Tronie with the Owner 11/28, named by Snow White for Flora's c3-content-digest-name): sha256 hex of the canonical JSON
`{title, done_condition, lane, split: {children, function_split}}` of the target task as its chart reads now, where `children` = the sorted ids of the target plan's tasks whose
`parent_task_id` is the target (`todo split` extracts them and rewrites the target's title/lane) and `function_split` = the target's mark or `null`; `null` when the target is unread or missing.
It covers those four fields only: design memo, notes, evidence and status do not move it (status is `state`/`changed`). A host keeps its own `{state, target_content_digest}` per 接続 and
announces when either differs; Lattice sends nothing. The waiting chart's K2 token moves when it changes (n2).
**Wire change:** a retired target used to read `settled` (成立); it reads `gone` with `target_retired`. Readiness is unchanged (it never blocked).

Waiter entry: `{project_id, plan_key, task_id, title, lane, status, kind: 'task', state, state_reason?, reason, since, event_digest}` where `project_id/plan_key/task_id` name the
**waiting** task, `status` is its own task status, and `state` is the judgment of the 接続 (`open` = it still waits; `settled`, `gone` = history, kept so the writer of a done sees whom it released).
Sorted by `project_id, plan_key, task_id`. Schedule 接続 are not waiters of a task (their target is BellTeam's).

`lattice.todo_waiters_result.v1`: `{schema, project_id, tasks: [{plan_key, task_id, waiters: [waiter]}], unread: [{project_id, reason}], result_digest}`. `--open` keeps only `state: 'open'`
waiters (and drops tasks left with none). `todo display read --open` ships the same `waiters: [{plan_key, task_id, waiters}]` and `waiters_unread` (open entries only).
`todo show`: `waiters` (all states) and `waiters_unread`. Mutation result of `done|retire|reopen`: `waiters` (all states) or `null` with `waiters_unavailable`.

Telling the lane (Flora): the waiting task's lane is told by BellTeam from what Lattice reports. A task that became startable already opens a notice (`todo notice list`, exactly once per
`todo notice ack`, [startable notices](dfd-done-notice.md)); the notice trigger for a target done in another chart is the target's `done` event. `reopen`, `retire` and `missing` do not open a notice
(the task is not startable): a host that wants to say them keeps its own record keyed on `changed.event_digest` and `state`. K2: the token of the target's chart moves when a waiter appears or goes (new, above) and, as
always, when its own tasks change.

Verification for n2: tests fail before and pass after for done, retire, reopen, missing target (chart readable), schedule removed (the remove command, then reader state `gone`), the waiters list across two charts
(`todo show`, `todo waiters`, display read `--open`, mutation result) and the K2 token moving on appear/remove; an unreadable chart stays `open` and named in `unread`.
