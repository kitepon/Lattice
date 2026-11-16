# Data flow: function-level conflict relations (ADR 0204, stage A, 2026-11-16)

Status: a3b, a3c and a5 implemented (declaration, plan input, add-time judgment); a6/Touched and the sync step are not. Implementation tasks: chart lattice / lattice-codegraph-a-20261116 (a2 Observe, a3 Resolve,
a3b declaration CLI, a4 Store relations, a5 judgment, a6 Touched). Roles: [function-map](function-map.md).

## Write paths

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan/lifecycle: `todo add --owns p#s,... --reads p#s,...`, `witness declare` (same flags), `plan create/revise` (`tasks[].touches`) | Flags or plan input; the plan's recorded witness set | The task is added first (never refused for conflicts). Then the row: owns paths + `concern_anchors` (writes) + `read_anchors` (reads) | Malformed `p#s` → that flag refused with the expected form; the add still happens |
| Code graph: Resolve | `{path, symbol}[]`; Observe (maintained index of the store tree at HEAD) | `{path, symbol, kind, start_line, end_line}` per anchor; `related` callers/callees | Unknown name → `unresolved {nearest[]}`: the row is not written, the add result says which names and the nearest ones; the next declare retries. No index → Observe builds one once (first use only) |
| Plan/lifecycle: judgment (a5: `declareTaskRow` → `judgeTask`, `src/todo-judgment.mjs`) | The new or changed task's row; every unfinished task's row in the plan (from the witness set, read under the lock). Ranges come from one batched Resolve before the lock: the task's own anchors plus the other tasks' anchors on the paths it names (a row or path another declaration added meanwhile → the call writes nothing and the attempt runs again, three at most) | Pairs whose ranges overlap with write×write or read×write → relations; read×read never | A name that no longer resolves is read as a whole-file claim of that path (never "no conflict") and counted in `unresolved_count` |
| Store: row + Relations append (one call under the relations lock, ADR 0204 §6) | The task row and its relations | Appended to the plan's relation log; plan summary rewritten | Lock/head check as every Store write; a failed append leaves the task and its row, and the next write recomputes that task's pairs |
| Plan/lifecycle: result | — | `declaration.conflicts: [{with, path, overlaps: [{self, other}]}]` (each side `{symbol, start_line, end_line, access}`, a whole-file claim all null); `[]` when none. `declaration.written: false` keeps `unresolved`/`malformed` | — |
| K7 `chart repo sync` → after sensor sync | `accepted_tip..new tip` changed paths (one diff per sync) | Re-resolve anchors in touched files only; update ranges; append new relations, mark gone ones; rewrite the summary | Sync failure: nothing recomputed, the summary keeps its `head_sha` (reads show it as of that head); next sync retries |

## Read paths (Owner: open nothing that is not needed)

| Reader | Reads | Never reads |
|---|---|---|
| `session-context`, `status`, `todo show`, display read, dashboard | per plan: summary `{relation_count, open_relations (bounded), unresolved_count, head_sha}` | sensor index, witness set, full relation log; no recompute; no git per plan |
| `todo start` (a5c) | the summary of its plan; when it has relations, its own open relations from the log (`readTodoRelations({taskId})`) → `advisory.relations` | the same |
| `todo show` (a5c) | the same → `relations` (`{open: [{with, path, overlaps: [{self, other}]}], plan_relation_count, unresolved_count, head_sha}`; `{unreadable}` when the record cannot be read) | the same |
| `session-context` (a5c) | the summary → `independence[].function_conflicts {relation_count, unresolved_count, head_sha}` for a plan with ready tasks and relations | the same |
| `todo independence` (explicit, diagnostic) | relation log, independence artifact | — |

`todo done` / `todo retire` end with one empty `transactTodoRelations` (only when the plan summary says `relation_count > 0`) so a finished task's open relations close; failure is ignored and the plan's next write closes them.

Independence compile (a5b): `independenceCompile` resolves every declared function of the witness rows in one Resolve call (`resolveDeclaredRanges`; no anchors = no call; a failure = no ranges, so every declared function is read as a whole-file claim, as before) and passes the ranges to `compileTodoIndependence` (`functionRanges`). The runtime front-end then calls `refineResources` (`refineResourcesByFunction`, `src/todo-judgment.mjs`) on the resources it built: a shared path resource (`own-…` owned path, `rw-…` read x write, `predicted-ww-…` write overlap of one path) keeps a task pair only when both claim exactly that path and none of them declared functions in it, or `judgeTask` finds an overlap of the resource's own kind (`ww` both write, `rw` one reads). Other pairs and every other resource kind are untouched. `todo start`'s gates read that artifact, so an enforced plan no longer refuses two tasks on different functions of one file.

`todo status --json` is not changed: its wire shape is an exact record read by other products, so a new field there is a version change for a separate decision.

## State it owns

- Witness set (`.lattice/todo/witness/<plan>.json`, v6): declarations as names (`concern_anchors`, `read_anchors`); ranges are resolved again at judgment time. Written by Plan/lifecycle.
- Relation log + summary per `plan_key` (`.lattice/todo/relations/<plan_key>/`): Store, machine-written, append-only; revisions copy nothing, Judgment appends `gone` for changed or removed tasks (ADR 0204 §6).
- Sensor index: Code graph, unchanged location (`.lattice/sensor/`).

## Interfaces

Resolve / Observe / Touched (Code graph), Relations (Store), Judgment (Plan/lifecycle): shapes in ADR 0204 §4.
