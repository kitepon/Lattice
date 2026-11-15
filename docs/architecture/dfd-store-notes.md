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
(`tasksPerPlan`, the same cap `validateTodoNoteContext` checks; the walk stops once
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
