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
| `.lattice/todo/relations/<plan_key>/open/<task_id>.json` | `transactTodoRelations` | The current record: `lattice.todo_relation_event.v1` `kind: relation` lines, one per open relation of that task (a relation is in both its tasks' files; no file when the task has none). `{sequence, relation_id, task_a, task_b, path, overlaps:[{a,b}], head_sha, computed_at}`; entry = `{symbol, start_line, end_line, access}` (`read`/`write`; a whole-file claim has symbol and both lines null; a function that does not exist yet (ADR 0204 §7) has its symbol and both lines null); `task_a < task_b`; `relation_id` = digest of `{task_a, task_b, path, overlaps}` (head and time excluded). The writer reads every file here (the open set only, never history); a reader of one task opens one |
| `.lattice/todo/relations/<plan_key>/summary.json` | same call, after the task files | `lattice.todo_relation_summary.v1` `{plan_key, relation_count (open), open_relations (newest 20: relation_id, task_a, task_b, path, overlaps), open_truncated, unresolved_count, head_sha, log_sequence, computed_at}`. The only file status, session-context, show, display and dashboard read; `todo show`/`todo start` read it with one task file |
| `.lattice/todo/relations/<plan_key>/log.jsonl`, `log-<sequence>.jsonl` | same call, last | History for audit, append-only (`appendFile`; at 4 MiB the file is renamed `log-<last sequence>.jsonl` and a new one starts). `lattice.todo_relation_event.v1` lines, `kind: relation` as above and `kind: gone` `{sequence, relation_id, task_a, task_b, path, head_sha, computed_at}`. **No code path reads it**: the open set lives in `open/`, so the log can grow without bounding any read or write. No seat actor and no hash chain: the record is recomputable from the graph |
| `.lattice/todo/relations/<plan_key>/.write.lock` | | the relations lock (store-lock: identified owner, proven-dead recovery); host-local like the note lock |

## Write path

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Store `transactTodoRelations({repoRoot, planKey, writer, update})` (writer caller `todo-relations`) | Takes the relations lock, then reads the Store (unfinished task ids = every task not done/retired), every `open/<task_id>.json` (the open relation per `{task_a, task_b, path}`; one present in only one of its two tasks' files is completed from the other, the higher `sequence` wins), the summary and the witness set. Never the log | Calls `update({witnessSet, openRelations, logSequence, unfinishedTaskIds})`; the callback only compares resolved ranges (no Resolve, sensor or git inside) and returns `{witnessSet?, relations?, gone?, headSha?, unresolvedCount?, computedAt?}` | An invalid return is TypeError and nothing is written |
| Store applies the result | Open set + returned relations/gone | First closes every open relation whose task is no longer unfinished; then `gone` keys; then each relation: identical open content = no-op, changed content closes the old one and appends the new, a relation naming a finished task is dropped. `headSha`/`unresolvedCount` default to the previous summary's; `computedAt` to now | |
| Store writes, in this order | witness set (if returned; `writeTodoWitnessSet` validates it), the changed `open/<task_id>.json` files (atomic each; an empty one is removed), summary (when the open set, head, unresolved count or sequence changed, or none existed yet but head/unresolved was given), then the log (`appendFile` only) | `{witnessSet, summary, appended, gone}` | A crash between the files leaves the row without its relations, a task file ahead of the other side's, a summary behind the open set, or events missing from the history. The next call recomputes: the writer rebuilds the open set from the files, completes a half-written relation, recounts the summary from the files, and the task's pairs are recomputed (ids are content digests). The sequence comes from the summary and the open events, so a crash can leave a gap, never a repeat |
| Lock busy | | `STORE_WRITE_CONFLICT/store_locked` after `LOCK_WAIT_MS` (another process); the same process re-entering is refused at once | The caller retries; a lock whose owner is proven dead is recovered |

Two adds at once cannot both read the old state: the witness set, the open relations and the statuses are read under the relations lock and the
callback compares against exactly those. Lock order: relations lock first, then the Store read (which may take the Todo Store lock); never call
`transactTodoRelations` while holding the Todo Store lock. `todo done` / `todo retire` do not take the relations lock, so a task finishing during a
call leaves at most one extra open relation until the next call; Judgment ends those commands with an empty `update` when the summary says
`relation_count > 0`.

## Read paths

| Reader | Reads | Never |
|---|---|---|
| status, session-context, display, dashboard | `readTodoRelationSummary({repoRoot, planKey})` → summary or null (missing file = no records) | the task files, the log, the witness set, the sensor index; no verification, no recompute |
| `todo show`, `todo start` (a5c/a5d) | `readTodoTaskRelations({repoRoot, planKey, taskId})` → `null` (no summary or `relation_count` 0), else `{relation_count, unresolved_count, head_sha, open: [{task_a, task_b, path, overlaps}]}`: the summary and `open/<task_id>.json`, two small bounded files (64 KiB and 4 MiB at most) | every other task's file, the log, the witness set |

A damaged or oversize file: `STORE_INCONSISTENT/relation_summary_invalid` or `relation_log_invalid {ref}` (a task file is read as a log of relation events); a higher `lattice.todo_relation_*.vN` or
`lattice.todo_witness_set.vN`: `UNSUPPORTED_SCHEMA/newer_lattice_value` (registered in `NEWEST_KNOWN_TODO_SCHEMA`: `todo_relation_event`,
`todo_relation_summary` 1, `todo_witness_set` 6, bumped with the v6 validator in a5). Callers show "relations unreadable" instead of refusing the
command (an unknown state is not dangerous).

## Guards

No guard here protects a named thing except: the relations lock protects two writers from reading the same old state; the plan-key and file checks
(symlink, non-file, oversize) protect the Store tree from a redirected path. Shortcut: a task with more open relations than fit 4 MiB (about 10,000) reads as unreadable until some close; upgrade to paged task files if a plan ever gets there. Shortcut: the writer reads every task file with open relations, so a write grows with the open set (not with history); upgrade to reading only the touched tasks' files if a plan's open set passes a few thousand relations.

## Compatibility

Seats older than this version ignore `relations/` (a new directory) but cannot read a witness set v6; Judgment writes v6 only when a task has
`read_anchors`, so charts that do not use reads keep v5 and old seats. Host change in the CHANGELOG.
