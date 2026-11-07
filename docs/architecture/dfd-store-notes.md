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
| Store batch read | Supplied active Store view + plan key → read each task/plan chain and migration inventory once for the plan → project all active tasks | Existing contexts, archived and note_head_digest. Corrupt chain/history, inactive plan and invalid options keep existing typed refusals; repair the indicated bytes/target and reread. No extra filesystem reads for the optional output. |
| Store includeHistory=true | Same complete projections already computed → expose each task's history before context budget | Additional histories array; default/false remains byte-shape compatible. Superseded notes remain marked, retired/archived targets stay outside active task histories under existing migration policy. |
| Plan workflow reader | One batch read with includeHistory:true → parse/filter typed workflow records by scope/task and superseded metadata | Latest relevant workflow facts survive later prose even when omitted from bounded context. Plan owns malformed/unknown body handling, result schema and surfaces; no second raw-chain read or duplicate migration implementation. |

Plan notes occur in every projected task history under existing semantics; callers
must distinguish scope. Existing limits on chain files, note bodies and historical
artifacts remain; no new unbounded read or publication path is introduced.

Focused Store checks compare default/false shape and opt-in histories with the
existing single-task projection, verify context overflow does not discard full
history, and retain carry/supersedes/archive behavior. Workflow parser/UI tests
belong to Plan. Ship this DFD and function-map Store rows with the reader change.
