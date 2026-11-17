# Data flow: split a function two lanes change (ADR 0205, stage B, 2026-11-16)

Status: contract (b1). Implementation tasks: chart lattice / lattice-codegraph-b-20261116 (b2 Store, b3 verify, b4 start,
b5 verify/decline/done, b6 labels). Roles: [function-map](function-map.md). Builds on [function conflict](dfd-function-conflict.md).

## Write paths

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan/lifecycle: `todo start T` (b4) | plan (already read); T's open relations (`open/<T>.json`) | write x write with an in-progress task U of another lane → add S or join the open S on that function (one revision); T stays pending; `todo_start_split_result.v1` | No qualifying relation, `--override-reason`, a conversation plan, or a plan a light revision cannot take (warning `LATTICE_START_SPLIT_UNSUPPORTED`) → today's start. Revision refused (concurrent write) → the start answers the refusal as today; nothing half-written (one revision) |
| Store: revision with `function_split` (b2) | the revision of b4 | S with the mark, predecessor edges S→U, S→T; members appended on join | As every revision (head check); U carried in progress |
| Plan/lifecycle: `todo start S` | S's mark; Neve's `cutCost` (seam-cost profile, every member owning F) | `function_split {path, symbol, members, cut_cost, guide}` in the start result (the guide: decide, split or decline, `[skip ci]`); S skips gates 1-3 (no row) | Profile unavailable → `cut_cost.profile: null` with `reasons`, the start proceeds |
| Member (U's worker) | the figures, its own work | split: a branch from main with the cut; or decline | — |
| Code graph: `verifyFunctionSplit` (b3) | commit, base, target, map, members' anchors; missing commit/base/history fetched from `origin` (objects only); one disposable worktree + one fresh index of the commit | behaviour, tests, fresh, ranges, target range, `existed_at_base` | Input errors (`source_dirty`, `commit_not_found`, `empty_diff`, `target_untouched`, `map_entry_malformed`) → `{error}` from Neve; `function-split verify` turns it into a refusal `INPUT_INVALID/function_split_<code>`, nothing recorded or reorganized; worktree or index failure → that condition `passed: false` with the cause |
| Plan/lifecycle: `function-split verify` (b5) | Neve's answer; members' rows | overlap, parallel; outcome → splits record (Store) | Rejected → not-split reorganization (below) |
| Plan/lifecycle: `function-split decline` / rejected verify (b5) | S, members, start events; open relations of the earliest-started member | one revision: S retired; earliest-started member → predecessor of each other member it still has an open write x write overlap with on S's path (none left = no predecessor: the member removed the overlap by declaring again); notes | — |
| Plan/lifecycle: `todo done S` (b5) | splits record (accepted); Resolve of the map at HEAD | mapped members' rows rewritten via ADR 0204 declaration → relations judged again; S done | Not accepted → refused with verify/decline as next_action. Map unresolved at HEAD → refused: merge the PR and sync, then done again |

## Read paths

| Reader | Reads | Never reads |
|---|---|---|
| `todo show` (`labels`), `session-context` (`labels`), display read (`labels`); the gantt chip beside the status comes from the same marks | the plan: `function_split` marks → labels `分割待ち` / `関数分割` | splits records, sensor, relations beyond today's; `todo status --json` unchanged |
| `todo show S` | + `splits/<plan>/<S>.json` (`split_record`: the record, null, or `{unreadable}`) | the sensor; `cut_cost` is only in the start result |

## State it owns

- `function_split` on a plan task (Store, b2): nullable key of plan v9 `{path, symbol, start_line, end_line, members}`.
- `.lattice/todo/splits/<plan_key>/<task_id>.json` (Store, b2): `lattice.todo_split_record.v1`, map, commit, base, outcome, conditions, attempt. Own lock for writes; lock-free reads; never listed.

## Interfaces

`verifyFunctionSplit` (Code graph), splits record read/write and the task mark (Store), start/verify/decline/done and labels
(Plan/lifecycle): shapes in ADR 0205.
