# Data flow: function-level conflict relations (ADR 0204, stage A, 2026-11-16)

Status: contract, not implemented. Implementation tasks: chart lattice / lattice-codegraph-a-20261116 (a2 Observe, a3 Resolve,
a3b declaration CLI, a4 Store relations, a5 judgment, a6 Touched). Roles: [function-map](function-map.md).

## Write paths

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan/lifecycle: `todo add --owns p#s,... --reads p#s,...`, `witness declare` (same flags), `plan create/revise` (`tasks[].touches`) | Flags or plan input; the plan's recorded witness set | The task is added first (never refused for conflicts). Then the row: owns paths + `concern_anchors` (writes) + `read_anchors` (reads) | Malformed `p#s` → that flag refused with the expected form; the add still happens |
| Code graph: Resolve | `{path, symbol}[]`; Observe (maintained index of the store tree at HEAD) | `{path, symbol, kind, start_line, end_line}` per anchor; `related` callers/callees | Unknown name → `unresolved {nearest[]}`: the row is not written, the add result says which names and the nearest ones; the next declare retries. No index → Observe builds one once (first use only) |
| Plan/lifecycle: judgment | The new or changed task's resolved ranges; every unfinished task's ranges in the plan (from the witness set) | Pairs whose ranges overlap with write×write or read×write → relations; read×read never | Unresolved anchor → explicit unknown on that task, never "no conflict" |
| Store: row + Relations append (one call under the relations lock, ADR 0204 §6) | The task row and its relations | Appended to the plan's relation log; plan summary rewritten | Lock/head check as every Store write; a failed append leaves the task and its row, and the next write recomputes that task's pairs |
| Plan/lifecycle: result | — | `todo add` / `witness declare` result adds `conflicts: [{with, path, symbol, access}]` and `unresolved` | — |
| K7 `chart repo sync` → after sensor sync | `accepted_tip..new tip` changed paths (one diff per sync) | Re-resolve anchors in touched files only; update ranges; append new relations, mark gone ones; rewrite the summary | Sync failure: nothing recomputed, the summary keeps its `head_sha` (reads show it as of that head); next sync retries |

## Read paths (Owner: open nothing that is not needed)

| Reader | Reads | Never reads |
|---|---|---|
| `session-context`, `status`, `todo show`, display read, dashboard | per plan: summary `{relation_count, open_relations (bounded), unresolved_count, head_sha}` | sensor index, witness set, full relation log; no recompute; no git per plan |
| `todo start` | the summary of its plan + its own open relations | the same |
| `todo independence` (explicit, diagnostic) | relation log, independence artifact | — |

## State it owns

- Witness set (`.lattice/todo/witness/<plan>.json`, v6): declarations with resolved ranges. Written by Plan/lifecycle.
- Relation log + summary per `plan_key` (`.lattice/todo/relations/<plan_key>/`): Store, machine-written, append-only; revisions copy nothing, Judgment appends `gone` for changed or removed tasks (ADR 0204 §6).
- Sensor index: Code graph, unchanged location (`.lattice/sensor/`).

## Interfaces

Resolve / Observe / Touched (Code graph), Relations (Store), Judgment (Plan/lifecycle): shapes in ADR 0204 §4.
