# Store split: the `function_split` mark and the split record (ADR 0205 b2, 2026-11-16)

Store (Ludmila) holds two things for a split task S: the mark on the plan task (who is waiting on the split, which function) and the
verify outcome (a file). Plan/lifecycle (Alice) decides when a split exists and what verify means; the code graph (Neve) answers the
conditions; Store knows neither the sensor nor git. Contract: [ADR 0205](../adr/0205-split-a-function-two-lanes-change-at-start.md) §2,
flow in [dfd-function-split](dfd-function-split.md), roles in [function-map](function-map.md).

## State it owns

| State | Where | Shape | Writer | Readers |
|---|---|---|---|---|
| The mark | `function_split` on a task of plan `lattice.todo_plan.v9` | `null`, or `{path, symbol, start_line, end_line, members}`: `members` sorted unique task ids of the plan, 2..64, S not among them; the range is a snapshot of the start, never refreshed | any revision that carries a v9 desired plan (`applyPhaseTodoRevision`, `createSuccessorTodoPlan`); the caller decides the value | everything that already reads the plan (labels, show, status): no new file |
| The record | `.lattice/todo/splits/<plan_key>/<task_id>.json` | `lattice.todo_split_record.v1`, one canonical JSON line ≤ 64 KiB: `{schema, plan_key, task_id, attempt, map (≤ 64, sorted by task_id), commit, base, outcome, conditions {behaviour, tests, fresh, overlap, parallel: {passed, detail ≤ 2 KiB}}, recorded_at, actor}`; `accepted` only when all five passed | `recordTodoSplit` (writer caller `todo-splits`) | `readTodoSplit`: `function-split verify`, `todo done S`, `todo show S`; never listed |

## Plan schema

v9 = v8 + `function_split` on every task (`null` = none, as `done_condition` in v8: tasks are exact records). A plan stays v8 until the
revision that writes its first split; that revision rewrites every task. v9 never goes back (`function_split_schema_downgrade`; v8/v9
to older stays `done_condition_schema_downgrade`). Cross-task rule in `explainTodoPlan`: every member is a task of the plan and S is
not its own member (`function_split_members_invalid`). v9 is accepted as a desired plan by `phase_todo_revision.v4` and `.v5`
(`.v3` and older stay as they were). State carries by task id as for any revision: a promotion does not reset a started task.
Registered in `NEWEST_KNOWN_TODO_SCHEMA` (`todo_plan` 9, `todo_split_record` 1).

## Write path: `recordTodoSplit({repoRoot, planKey, taskId, writer, record})`

| Step | Read | Output / decision | Failure / recovery |
|---|---|---|---|
| Takes `splits/<plan_key>/.write.lock` (held only for this write, never across the verify run; taken before the Store read; never call while holding the Todo Store lock) | | | `STORE_WRITE_CONFLICT/store_locked` after `LOCK_WAIT_MS`; the caller retries |
| Checks against the plan | the Store: S is a task of the plan, has a mark, is not done or retired; every `map` entry names a member | refuses otherwise | no mark: `TypeError` (a caller bug); finished: `STORE_WRITE_CONFLICT/split_task_finished` |
| Builds and validates | previous record (`attempt`) | `{...record, schema, plan_key, task_id, attempt: previous + 1}`; invalid or over 64 KiB: `TypeError`, never truncated | |
| Writes | | `atomicWrite` replaces the file whole | a crash leaves the old or the new file, never half |

A rejected outcome is written first and Plan's revision retires S afterwards; a crash between leaves a rejected record and an open S, and
the retire must be re-runnable from it (b5).

## Read path: `readTodoSplit({repoRoot, planKey, taskId})`

No lock (a write replaces the file whole). Missing file: `null`. A symlink, non-file, oversize, unparsable or invalid file, or one whose
`plan_key`/`task_id` disagree with its path: `STORE_INCONSISTENT/split_record_invalid {ref}` (`todo done S` refuses; `todo show S` says
"record unreadable"). A higher `lattice.todo_split_record.vN`: `UNSUPPORTED_SCHEMA/newer_lattice_value`. No function lists the directory.

## Older readers

An older seat reading a v9 plan gets `UNSUPPORTED_SCHEMA/newer_lattice_value` with the upgrade next_action. Measured on 0.109.0 (a Store
with one v8 plan and one v9 plan): **the whole Store read refuses, so every plan of that chart becomes unreadable to the older seat**, not
only the one that carries a split. Rollout: every seat that reads the chart upgrades before the first split is written (b4 writes it only
when a task in a write x write conflict actually starts, so a chart without that stays v8). Older seats ignore `splits/` (a new
directory).

## Guards

The lock protects two verifies from reading the same attempt. The `split_task_finished` refusal protects a closed split from being
rewritten; its exit is none needed (S is closed). The path checks (symlink, non-file, oversize) protect the Store tree from a redirected
path. No timeout is added anywhere.
