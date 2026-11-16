# Data flow: split a function two lanes change (ADR 0205, stage B, 2026-11-16)

Status: contract (b1). Implementation tasks: chart lattice / lattice-codegraph-b-20261116 (b2 Store, b3 verify, b4 start,
b5 verify/decline/done, b6 labels). Roles: [function-map](function-map.md). Builds on [function conflict](dfd-function-conflict.md).

## Write paths

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan/lifecycle: `todo start T` (b4) | plan (already read); T's open relations (`open/<T>.json`) | write x write with an in-progress task U of another lane → add S or join the open S on that function (one revision); T stays pending; `todo_start_split_result.v1` | No qualifying relation → today's start. Revision refused (concurrent write) → the start answers the refusal as today; nothing half-written (one revision) |
| Store: revision with `function_split` (b2) | the revision of b4 | S with the mark, predecessor edges S→U, S→T; members appended on join | As every revision (head check); U carried in progress |
| Plan/lifecycle: `todo start S` / `todo show S` | S's mark; seam-cost profile of the file | `function_split {path, symbol, members, cut_cost}` | Profile unreadable → `cut_cost: null`, the start proceeds |
| Member (U's worker) | the figures, its own work | split: a branch from main with the cut; or decline | — |
| Code graph: `verifyFunctionSplit` (b3) | commit, target, map; disposable worktree of the commit | behaviour, tests, fresh, ranges at the commit | Worktree or index failure → that condition `passed: false` with the cause (a rejected verify, never a hang) |
| Plan/lifecycle: `function-split verify` (b5) | Neve's answer; members' rows | overlap, parallel; outcome → splits record (Store) | Rejected → not-split reorganization (below) |
| Plan/lifecycle: `function-split decline` / rejected verify (b5) | S, members, start events | one revision: S retired; earliest-started member → predecessor of the others; notes | — |
| Plan/lifecycle: `todo done S` (b5) | splits record (accepted); Resolve of the map at HEAD | mapped members' rows rewritten via ADR 0204 declaration → relations judged again; S done | Not accepted → refused with verify/decline as next_action. Map unresolved at HEAD → refused: merge the PR and sync, then done again |

## Read paths

| Reader | Reads | Never reads |
|---|---|---|
| `todo show`, `todo status` (text), `session-context`, gantt, display read | the plan: `function_split` marks → labels `分割待ち` / `関数分割` | splits records, sensor, relations beyond today's |
| `todo show S` | + `splits/<plan>/<S>.json` | — |

## State it owns

- `function_split` on a plan task (Store, b2): `{path, symbol, start_line, end_line, members}`.
- `.lattice/todo/splits/<plan_key>/<task_id>.json` (Store, b2): map, commit, outcome, conditions. Own lock; bounded.

## Interfaces

`verifyFunctionSplit` (Code graph), splits record read/write and the task mark (Store), start/verify/decline/done and labels
(Plan/lifecycle): shapes in ADR 0205.
