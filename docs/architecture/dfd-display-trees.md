# Display read: task trees (a100, 2026-11-14)

Status: IMPLEMENTED (plan lattice-trees-20261114, task trees-impl). Owner: Plan/lifecycle (state projection).
Consumer: BellTeam display (Flora) builds the chart fractions and the hide rule on this answer and never computes
trees itself. Contract agreed with Flora and accepted by Snow White on 2026-11-14. Connected to the
[Store display read](dfd-store-display-read.md) envelope and the
[cross-chart dependency](dfd-plan-revise.md#cross-chart-dependency-xchart-2026-11-13) `external_tasks` beside it.

## Data flow

| Step | Input | Output | Failure |
|---|---|---|---|
| Store `readTodoStoreForDisplay({repoRoot})` | the chart's Store | envelope `{state, store, ...}` (unchanged) | an inconsistency is a state; `unavailable` has `store: null` |
| Plan `projectTodoTrees(store)` (`src/todo-trees.mjs`, pure) | `store.members` of the envelope (verified, unverified raw, or last_verified checkpoint: the members that were read) | `[{tree_id, tasks:[{plan_key, task_id}], total, finished}]` | never throws: a missing list reads as empty; an edge whose endpoint is not a task of this chart, or a malformed edge/event, is skipped and the rest is still drawn |
| Plan `displayRead` (todo-cli) | envelope + `projectTodoTrees` | `lattice.todo_display_read_result.v1` gains top-level `trees` beside `external_tasks` (additive); no `store` = `trees: []` | — |

## Tree rule

- Nodes: every task of every member (active plan) of this chart, retired tasks included.
- Edges, taken in either direction: plan `hard_dependencies`; `joins` (each `after` to `before`); cross-plan
  ledger edges between plans of this chart through `projectTodoCrossPlanDependencies` (tombstones applied, the
  merged view readiness uses); `parent_task_id` (parent to child, same plan).
- A predecessor on another chart (`from.project_id` ≠ the task's chart) is not a node: it joins no tree and is
  not counted.
- Tree = connected component. A task with no edge is a tree of one. Every task is in exactly one tree.
- `total` = number of tasks in the tree; `finished` = tasks whose status is `done` or `retired`
  (`isFinishedTodoTaskState`, the readiness rule).
- `tree_id` = the smallest `plan_key/task_id` string (code-unit order) among its members; stable while
  membership is unchanged. `tasks` sorted by (`plan_key`, `task_id`), `trees` by `tree_id`.
