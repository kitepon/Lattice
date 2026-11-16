# Store relations: function-level conflict record (ADR 0204 a4, 2026-11-16)

Store (Ludmila) holds a machine-written, append-only record of the conflicts Lattice finds when a task is added, plus the plan's witness set
writes that must agree with it. Judgment (Alice) decides what overlaps; the code graph (Neve) resolves ranges; Store knows neither the
sensor nor git. Contract: [ADR 0204](../adr/0204-function-level-conflicts-recorded-when-a-task-is-added.md), roles in
[function-map](function-map.md), judgment flow in [dfd-function-conflict](dfd-function-conflict.md).

## Placement

Per `plan_key`, never per plan version (`todo add` makes a version each time; a per-version log would be copied every add, the bloat
ADR 0202 removed). Precedent: `witness/<plan_key>.json` and `notes/<plan_key>/`.

| File | Writer | Content |
|---|---|---|
| `.lattice/todo/relations/<plan_key>/log.jsonl` | `transactTodoRelations` | `lattice.todo_relation_event.v1` lines, append-only. `kind: relation` `{sequence, relation_id, task_a, task_b, path, overlaps:[{a,b}], head_sha, computed_at}`; `kind: gone` `{sequence, relation_id, task_a, task_b, path, head_sha, computed_at}`. Entry = `{symbol, start_line, end_line, access}` (`read`/`write`; a whole-file claim has symbol and both lines null). `task_a < task_b`. `relation_id` = digest of `{task_a, task_b, path, overlaps}` (head and time excluded). No seat actor and no hash chain: the record is recomputable from the graph, so a chain would guard nothing |
| `.lattice/todo/relations/<plan_key>/summary.json` | same call, after the log | `lattice.todo_relation_summary.v1` `{plan_key, relation_count (open), open_relations (newest 20: relation_id, task_a, task_b, path, overlaps), open_truncated, unresolved_count, head_sha, log_sequence, computed_at}`. The only file status, session-context, show, display and dashboard read |
| `.lattice/todo/relations/<plan_key>/.write.lock` | | the relations lock (store-lock: identified owner, proven-dead recovery); host-local like the note lock |

## Write path

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Store `transactTodoRelations({repoRoot, planKey, writer, update})` (writer caller `todo-relations`) | Takes the relations lock, then reads the Store (unfinished task ids = every task not done/retired), the log (folded to the open relation per `{task_a, task_b, path}`), the summary and the witness set | Calls `update({witnessSet, openRelations, logSequence, unfinishedTaskIds})`; the callback only compares resolved ranges (no Resolve, sensor or git inside) and returns `{witnessSet?, relations?, gone?, headSha?, unresolvedCount?, computedAt?}` | An invalid return is TypeError and nothing is written |
| Store applies the result | Open set + returned relations/gone | First closes every open relation whose task is no longer unfinished; then `gone` keys; then each relation: identical open content = no-op, changed content closes the old one and appends the new, a relation naming a finished task is dropped. `headSha`/`unresolvedCount` default to the previous summary's; `computedAt` to now | |
| Store writes, in this order | witness set (if returned; `writeTodoWitnessSet` validates it), log (read + append + atomic rewrite), summary (when events were appended, head or unresolved count changed, none existed yet but head/unresolved was given, or its `log_sequence` is behind the log) | `{witnessSet, summary, appended, gone}` | A crash between the files leaves the row without its relations, or a summary behind the log. The next call of that task recomputes its pairs (ids are content digests) and rewrites the summary; no reader trusts the summary beyond what it says |
| Lock busy | | `STORE_WRITE_CONFLICT/store_locked` after `LOCK_WAIT_MS` (another process); the same process re-entering is refused at once | The caller retries; a lock whose owner is proven dead is recovered |

Two adds at once cannot both read the old state: the witness set, the open relations and the statuses are read under the relations lock and the
callback compares against exactly those. Lock order: relations lock first, then the Store read (which may take the Todo Store lock); never call
`transactTodoRelations` while holding the Todo Store lock. `todo done` / `todo retire` do not take the relations lock, so a task finishing during a
call leaves at most one extra open relation until the next call; Judgment ends those commands with an empty `update` when the summary says
`relation_count > 0`.

## Read paths

| Reader | Reads | Never |
|---|---|---|
| status, session-context, show, display, dashboard | `readTodoRelationSummary({repoRoot, planKey})` → summary or null (missing file = no records) | the log, the witness set, the sensor index; no verification, no recompute |
| `todo start`, `todo independence` | `readTodoRelations({repoRoot, planKey, taskId?, includeGone?})` → open relations (or the whole log) | |

A damaged or oversize file: `STORE_INCONSISTENT/relation_summary_invalid` or `relation_log_invalid {ref}`; a higher `lattice.todo_relation_*.vN` or
`lattice.todo_witness_set.vN`: `UNSUPPORTED_SCHEMA/newer_lattice_value` (registered in `NEWEST_KNOWN_TODO_SCHEMA`: `todo_relation_event`,
`todo_relation_summary` 1, `todo_witness_set` 6, bumped with the v6 validator in a5). Callers show "relations unreadable" instead of refusing the
command (an unknown state is not dangerous).

## Guards

No guard here protects a named thing except: the relations lock protects two writers from reading the same old state; the plan-key and file checks
(symlink, non-file, oversize) protect the Store tree from a redirected path. Shortcut: every write reads the whole log and rewrites it (fine below
about 1 MiB); upgrade to sealed segments like the note chain when a chart's log passes that.

## Compatibility

Seats older than this version ignore `relations/` (a new directory) but cannot read a witness set v6; Judgment writes v6 only when a task has
`read_anchors`, so charts that do not use reads keep v5 and old seats. Host change in the CHANGELOG.
