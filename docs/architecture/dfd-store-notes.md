# Store note projection boundary

Store owns note chains, migration projection and this read API. Plan owns the
meaning of typed workflow JSON inside note bodies and its status/Gantt projection.
Existing note bodies stay opaque bounded text; no event/lifecycle format changes.

## Batch projected histories (t19 connection)

`readTodoNoteContextsForPlan({repoRoot,store,planKey,includeHistory?})` uses the
existing active member, task and plan note chains, historical plan/revision
inventory and `projectTodoNoteContext`. includeHistory is boolean when supplied.
Unset or false returns exactly the existing result shape. True adds
`histories: [{task_id,history}]` in active plan task order. Each history is the
same full `history` returned by the existing projector/single-task reader, before
context byte budgeting. It contains plan then task notes in existing order and
retains superseded metadata, original identities and carry projection.

| Owner/function | Input/state → decision | Output / failure and exit |
|---|---|---|
| Plan writer | Typed workflow object serialized into existing task note body | Existing appendTodoNote validates/persists opaque text and existing supersedes/carry semantics. Plan validates body meaning; workflow facts grant no lifecycle approval. |
| Store batch read | Supplied active Store view + plan key → read each task/plan chain and migration inventory once for the plan (perf-store: each retained version's plan/revision validation and migration memoized per process by file identity, `todo-version-memo`; the readdir stays, so new versions appear) → project all active tasks | Existing contexts, archived and note_head_digest. Corrupt chain/history, inactive plan and invalid options keep existing typed refusals; repair the indicated bytes/target and reread. No extra filesystem reads for the optional output. |
| Store includeHistory=true | Same complete projections already computed → expose each task's history before context budget | Additional histories array; default/false remains byte-shape compatible. Superseded notes remain marked, retired/archived targets stay outside active task histories under existing migration policy. |
| Plan workflow reader | One batch read with includeHistory:true → parse/filter typed workflow records by scope/task and superseded metadata | Latest relevant workflow facts survive later prose even when omitted from bounded context. Plan owns malformed/unknown body handling, result schema and surfaces; no second raw-chain read or duplicate migration implementation. |

Revision records (n3, 2026-11-15): a plan-scope note whose whole body is one of
Lattice's own revision records (`todo add`, same-plan `dependency connect|disconnect` (record grammar kept so old records still parse; the commands are now `todo predecessor add|remove`),
`plan revise` retire; grammar in Plan's `todo-revision-note.mjs`, which has no
imports) enters a task's bounded context only when it names that task. Other
revision records stay in `history`, `includeHistory` and `note list`, and do not
count into `overflow_count` (they are not cut by the cap, they are not this task's).
Why: on bellteam-dev-added 546 such records filled the 512 cap and no human
handoff note reached any start/show. Human plan notes and task notes are unchanged. `plan_note_head_digest` still names
the plan chain head, so with `overflow_count` 0 it may stand while no plan note is
shown (`validateTodoNoteContext` checks only that a shown plan note has a head).

Context budget: the bounded context keeps entries in the order above (plan notes
newest first, then task notes newest first) while they fit both the byte budget
(`noteContextBytes`, an entry that does not fit is skipped) and the count cap
(`noteContextEntries`, the same cap `validateTodoNoteContext` checks; the walk stops once
it is reached). Every entry left out counts into `overflow_count`; the full history
and `full_history_command` still reach it. No refusal is added: a plan with more
plan notes than the cap still projects a valid context for every task.

Plan notes occur in every projected task history under existing semantics; callers
must distinguish scope. Existing limits on chain files, note bodies and historical
artifacts remain; no new unbounded read or publication path is introduced.

Focused Store checks compare default/false shape and opt-in histories with the
existing single-task projection, verify context overflow does not discard full
history, and retain carry/supersedes/archive behavior. Workflow parser/UI tests
belong to Plan. Ship this DFD and function-map Store rows with the reader change.

## Note target lineage (w2-impl, 2026-11-28)

Why: on bellteam-dev-added (4,204 retained versions, 3,321 tasks) `todo show`, `todo start` and `todo note list` cost 18-21 s and 1.6 GB, `todo note` 31 s. Every call read and kept the full `task_migration` of every version (7.2 M entries), built a Map per version, and walked each note through every later version (notes × versions, about quadratic in chart age). `appendNote` read and projected twice.

`readTodoNoteContext`, `readTodoNoteSource` and `readTodoNoteContextsForPlan` resolve a note's origin `(plan_version, task_id)` to a current task through one **lineage** (`readNoteLineage`, `todo-note-store`).

| Owner/function | Input/state → decision | Output / failure and exit |
|---|---|---|
| `readVersionMigration(base, version)` | one retained version's `compact.json.gz` or `plan.json` + `revision.json` (same shape checks as before, memoized per process by file identity) → its predecessor's version name (null for the first version) and the `task_migration` entries that change a task (`[from, to \| null]`; an entry that keeps the id is left out) | `{predecessor, moves}`, or null when the version does not exist. Invalid record: `NOTE_PROJECTION_INVALID` (`note_historical_plan_invalid`, `note_historical_revision_invalid`, `note_task_migration_invalid`). The memo holds the moves only, not the 3,321-entry array |
| `readNoteLineage(repoRoot, planKey, headVersion, eventVersions)` | head version, derived cache `.lattice/generated/store-note-lineage/<plan_key>.json` → cached head equal to the head: no version read. A head some revisions later: read only the versions after the cached head, append them, republish. Otherwise: read the chain from the head back to the first version, publish | `NoteLineage` `{versions oldest→head, moves [index, from, to\|null]}`; `resolve(version, task)` follows only that task's own moves (cost independent of the version count). A version off the head's chain (unpublished residue) resolves to archived and is not read; a note naming a version that does not exist: `NOTE_PROJECTION_INVALID note_origin_plan_version_unknown`, as before. A version cycle: `note_migration_cycle` |
| derived cache `lattice.todo_note_lineage_cache.v1` | `{schema, plan_key, versions, moves, cache_digest}`, written atomically (`publishDerivedPlanCache`, shared with the n3 task-added cache), only for a chain that reaches the first version or extends a cached head, and only for a chain of at least 32 versions (a shorter chain reads in well under 0.1 s, so an ordinary `todo start` or `todo note` on a small plan writes no file and cannot dirty a user's git tree) | never truth: absent, unreadable, wrong schema or plan, bad digest, bad shape, or a head that is not on the chain is a miss that reads the chain; a failed write never fails the read. A chain with an unreadable or missing version is never published, so a short lineage cannot outlive the missing directory |
| `projectTodoNoteContext` | events + `migrations` (a lineage, or the old array of `{from_plan_version, to_plan_version, task_migration}`, turned into one by `lineageFromMigrations`: a fork, a duplicate or a cycle is `note_migration_history_invalid` / `note_migration_cycle`) → `lineage.resolve` per event, then the existing ordering, budget and digests | the context bytes are unchanged (same notes, same digests, same overflow) |
| `appendNote` (`todo-cli`) | `readTodoNoteSource` once (chains + lineage, before anything is written, so a broken history still refuses first); the history before the append only when `supersedes` is set; `source.project([event])` once after the append | `note_context` equals a fresh read. A note another writer appends between the read and the append is not in this answer (the append itself re-reads the chain under the lock) |

Assumption (checked on bellteam-dev-added: 5,537 distinct note origins, old walk and lineage identical): a revision's `task_migration` lists every task of its predecessor (the writer refuses `predecessor_task_migration_incomplete`), so a missing entry cannot occur and an entry that keeps the id carries nothing. A hand-made array that omits tasks (the pure projector's tests) keeps its tasks by identity instead of archiving them.

Cost: first read after install pays one chain read per plan (bellteam-dev-added: 7-12 s); the next, and every read after, costs no version read; one revision later costs one version. `todo show` 17 s → 1.1 s and 1.6 GB → 0.3 GB. Out of scope: `readTodoNoteContextsForPlan` (gantt) still projects once per task; it gets the cheap resolution, not a restructure.
