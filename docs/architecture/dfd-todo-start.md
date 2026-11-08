# Data flow: todo start

Canonical lifecycle field trace at 0.79.5 (`047139e5`). The current-path tables
below reuse the completed read-only Sonnet trace without repeating its verification.
[Function map](function-map.md) owns module/state boundaries.
The [Runtime DFD](dfd-runtime-hold-resume.md) owns hold/source-commit/recompile/
resume and detailed Runtime lock recovery; manual start does not grant a Runtime
write lease. Its proposed Runtime recovery rows are not implemented by this doc.
Its R2T/R3T/R6T and R5aT target rows also record t12's required singleton
excess-detection/replan and source-commit-before-resume corrections.
Unchanged rows retain the baseline trace. Store recovery rows and the Store reopen
contract below describe this S3 implementation; other target rows remain proposals.

Corrections to assumptions: dependency-not-done surfaces as STORE_INCONSISTENT/invalid_start_transition (no "plan order" code); manifest CAS (todo-store.mjs:2822/4418) belongs to activation/revision, not start; dashboard ensure runs BEFORE the mutation.

## Table 1 — steps (cli = src/todo-cli.mjs, store = src/todo-store.mjs, ind = src/todo-independence.mjs, guid = src/todo-independence-guidance.mjs)
| # | where | input | reads | decision | on failure/unknown | output |
|---|---|---|---|---|---|---|
| 1 | bin/lattice.mjs:158-166 | argv, cwd, env | — | — | — | exit code |
| 2 | cli runTodoCli 3781; --commit-store stripped 3798 | argv | — | trailing --commit-store allowed (278) | refuse STORE_COMMIT_UNSUPPORTED exit 2 | argv, atomicCommit |
| 3 | matchFlagCommand (todo-authoring-input.mjs:201/170), start spec cli 4130-4152 | plan, task, override-reason, parallel-frontier, serial-confirmed, rebind, reason | — | ids must be identifiers; override-reason non-empty | refuse INVALID_ARGUMENTS exit 2; `--json` not in known → rejected; --serial-confirmed accepted, never read | startTask closure |
| 4 | cli resolveRepoRoot ~296 | cwd | git rev-parse | — | refuse REPO_UNRESOLVED | repoRoot |
| 5 | cli 4266-4268 ensureActiveProjectDashboard (3614), non-strict | env | store (stable read), project identity, dashboard registry | LATTICE_DASHBOARD_AUTOSTART=0 skips | DEGRADE: all errors → null; last block writes dashboard_delivery.v1 failed to stderr (3637-3643) | activity (discarded) |
| 6 | cli startTask 847 → readTodoStore (store 1508) unlocked, not forWrite | repoRoot | manifest, plans, journals, snapshots | store integrity + locked recovery when needed | validated journal-ahead/cache/marker state recovers automatically; unknown identity/digest corruption retains typed failure | store |
| 7 | cli 850-858 projectTodoStatus DISPATCH_ONLY (todo-status.mjs:565; isNodeReady 513) | store | memory | is target in next_ready? | u03 B8: --parallel-frontier on a non-ready target is ignored (no refusal); non-ready alone not refused here | next_ready, active_set, targetReady |
| 8 | cli 859-877 lookup | planKey, taskId | members | case-insensitive id match | STORE_INCONSISTENT/plan_not_active, TASK_NOT_FOUND, TASK_ID_AMBIGUOUS | resolvedTaskId |
| 9 | cli 879-897 readTodoNoteContext (todo-note-store.mjs:504) | store, plan, task | note chains (task+plan), migrations | project | DEGRADE only for NOTE_LOG_CORRUPT/NOTE_PROJECTION_INVALID → note_context.unreadable.v1 stub; other errors propagate | noteContext |
| 10 | cli startAdvisory 773 → readTodoIndependenceArtifact (store 5193) | store, plan | plans/<k>/<v>/independence.json, member.coordination.mode | record exists? | u03 B16: corrupt (INDEPENDENCE_ARTIFACT_INVALID) → treated as no record (10a) with self_unknowns ref `independence_record_unreadable` and process warning `LATTICE_START_INDEPENDENCE_UNUSABLE`; legacy schema → legacy marker | artifact or null |
| 10a | no record, cli 780-795 | — | — (no git) | advisory only | coverage missing; self_unknowns witness_missing/no_independence_record; guidance by mode: conversation→coordination_conversation, null→coordination_mode_undeclared, witness→independence_unrecorded. None refused | advisory |
| 10b | record exists, cli 796-798 currentHeadSha (1932), changedPathsSince (1954) | artifact.base_sha | git rev-parse HEAD, cat-file -e, diff --name-only | HEAD required only now | u03 B7: HEAD unreadable (INDEPENDENCE_BASE_UNRESOLVED) → treated as no record (10a) with self_unknowns ref `git_head_unresolved` and the same process warning; unreachable base → changedPaths=null = everything intersects | currentBaseSha, changedPaths |
| 10c | projectIndependenceFrontier (ind 383-520; coverage 488-492) | artifact, ready ids, active ids, plan | memory | coverage: superseded (plan_version/topology differs or legacy), verified (base==HEAD), else stale; record_stale only if declared boundary ∩ diff; witness_missing; plan_verdicts_absent (outcome≠compiled) | unknowns collected per READY task only | coverage, drift_intersecting, conflicts_with_active, scope_expansion_recommendations, uncovered_active_task_ids, self_unknowns |
| 10d | selectIndependenceGuidance (guid 260-300) | coverage, taskDeclared, taskStale, severability, contractSuperseded, verdictsAbsent, mode | — | precedence: conflict_with_active, conflict_between_ready, contract superseded, missing, superseded, undeclared, stale, verdicts absent, verified | — | guidance{code,message,next_action} |
| 11 | (removed u03 B1–B6) no start refusal on guidance | guidance.code | — | — | none: the five codes stay in advisory.guidance (code, message, next_action) and the start is recorded; conflicts are not refused either | — |
| 12 | cli startStructureContext 714 → readTodoStructureState (todo-structure-store.mjs:213) | store, plan | structure source + binding | no source/binding → not_enabled; digest mismatch/missing task → unreadable | projected only here; reader errors (INVALID_TODO_STRUCTURE_*, STRUCTURE_SOURCE_*) propagate | structure_context |
| 13 | cli 913 readTaskBackchainContext (plan-backchain.mjs:282; read 253) | plan, taskId | plans/<k>/<v>/backchain.json | missing file → null → result v5; present → feature_context, v6 | u03 A88: any PLAN_BACKCHAIN_INVALID (binding_unsafe/unreadable/invalid_json/invalid incl. plan_digest mismatch/task_missing/validate failure) → featureContext null (absence-compatible v5 result) and process warning `LATTICE_START_BACKCHAIN_UNUSABLE` naming the reason; an unsafe entry is never followed or read | featureContext |
| 14 | cli mutate 638, mutationActor 575 | LATTICE_TODO_ACTOR_HOST/SESSION/AGENT | env, terminal id, USER/LOGNAME | identifier values are used | u03 A57: a set but non-identifier value is treated exactly like unset → host label/host, session, sanitized USER/agent (no ACTOR_UNRESOLVED) | actor{host,session,agent} |
| 15 | store appendTodoEvent 2039 → withLock (~1829) | writer g5-authoring, event{kind:start,task_id,actor,payload{override_reason}} | .lattice/todo/.write.lock (atomic hard-link publication; in-place `wx` publication where hard links are unsupported) | complete PID/start/host owner, or weak owner when own observation is unavailable. Local identified owner: held until its process exits (PID+start), never age-recovered. Foreign/legacy/weak owner: held until its heartbeat is older than LOCK_STALE_MS | live contender: STORE_WRITE_CONFLICT/store_locked (or lock_owner_unidentified); self-exits on process exit (local) or heartbeat staleness (others). Before the journal publish the holder runs assertHeld; a lost lock refuses STORE_WRITE_CONFLICT/store_locked cause lock_lost, nothing published, retry reacquires | lock |
| 16 | store readTodoStoreLocked({forWrite:true}) under lock | — | store | reread/replay validated history, repair derived snapshot and interrupted publication | unknown authoritative corruption retains typed error; steps 7-13 feature reads not re-validated | fresh store |
| 17 | store 2048-2049, 2075-2080 resolveCanonicalTaskId (1959) | id | plan | resolves | TASK_NOT_FOUND / TASK_ID_AMBIGUOUS | task_id |
| 18 | (removed u03 A29/A30) store holds no structure lifecycle gate | — | — | — | none: an unreadable/changed structure source or a missing/stale finalization never refuses a lifecycle write. It stays visible: start structure_context (step 12) reports unreadable/stale, phase status reports structure_finalization status/stale_reasons (incl. non-consistent verdict, A52 kept) | — |
| 19 | store nextEvent (~1893) | input | — | — | — | event |
| 20 | store validateMergedTransition 1133; replay 683-717 | merged task/phase states | memory | task pending; phase active (v4); phase-accept edges accepted (mergedPhaseAcceptReady 1082); predecessors done & phases ready (1071); override_reason waives ONLY predecessor condition | Plan's prospective validator refuses TODO_TRANSITION_REFUSED/invalid_start_transition with cause and the blocking tasks/phases ([a12](#order-and-state-refusals-a12-a13-ludmila-2026-11-08)); replay's own STORE_INCONSISTENT/invalid_start_transition remains only for recorded history that does not replay | — |
| 21 | store 2086-2095 prospective replay + evidence verification | journal+new event | git blobs | history replays cleanly | refuse with replay's typed error | — |
| 22 | store 2118-2135 journal append via atomicWrite (1697) | event bytes | journal active segment (seal on overflow) | — | I/O error propagates; validated committed append rolls forward on reopen across 22-24 | journal seq+1 |
| 23 | store 2141 snapshotFor (867) + atomicWrite | plan, events, tasks | — | — | — | snapshot{through_sequence, journal_head_digest, tasks, snapshot_digest} |
| 24 | store ~2146 manifest rewrite | manifest | .lattice/todo/manifest.json | no digest compare (lock + step16 re-read protect) | crash between 22 and 24 → next locked reread completes snapshot/manifest publication | member.journal_head_digest, manifest_digest |
| 25 | store ~2150 projectPhaseStates → cli 668-710 | event, snapshot, plan, phases | — | — | — | {event,snapshot,plan,phases} |
| 26 | cli 687-710 result | event, snapshot, advisory, contexts | — | v6 if featureContext else v5; start without noteContext → TypeError (CONTRACT_VIOLATION) | — | result + result_digest |
| 27 | cli 4270-4275 | result | stdout | — | typedFailure (220); TypeError→CONTRACT_VIOLATION; else INTERNAL_FAILURE (245) | JSON line; exit 0 / 1 (typed, internal) / 2 (args) |

Journal event fields (nextEvent ~1893-1910): schema lattice.todo_event.v1 (v3 for phase-capable plans); project_id, plan_key, plan_version, sequence, previous_digest; kind:start, task_id, phase_id (v3, null), actor, recorded_at, provenance:null, payload{override_reason}, event_digest. NOT in event: advisory, note/structure/feature context, guidance.

Five advisory-only guidance reasons (formerly INDEPENDENCE_UNVERIFIED refusals, removed u03 B1–B6): independence_task_undeclared; independence_stale_for_task (HEAD moved and declared boundary ∩ diff; unreachable base counts); independence_superseded (plan_version/topology_digest differ); independence_contract_superseded (legacy schema); independence_verdicts_absent (outcome≠compiled and task covered). No record → none apply. Conflict guidance wins precedence and is advisory only. self_unknowns computed over READY tasks only. None of them refuses a start.

## Table 2 — result data dictionary (lattice.todo_mutation_result.v5 / v6 with feature_context; built cli 687-710)
| field | producer/source | persisted? |
|---|---|---|
| schema | mutate, by featureContext null-ness | projected |
| project_id, plan_key, plan_version, task_id, kind, sequence | from event (nextEvent) | journal |
| event_digest | todoSelfDigest in nextEvent | journal |
| journal_head_digest | = event_digest | snapshot + manifest member |
| snapshot_digest | snapshotFor | snapshot file |
| status | snapshot.tasks[task].status (in-progress) | snapshot |
| advisory | startAdvisory: coverage, drift_intersecting, conflicts_with_active[{active_task_id,type,detail,kind,severability}], scope_expansion_recommendations, uncovered_active_task_ids, self_unknowns, guidance | projected (independence.json + git HEAD/diff, computed before lock) |
| design_memo | designMemoProjection {status, markdown, prompt} | projected (plan file) |
| note_context | readTodoNoteContext or unreadable stub | projected (note chains) |
| structure_context | startStructureContext | projected (structure artifacts) |
| feature_context (v6) | readTaskBackchainContext: goal, requires, provides, downstream_task_ids, unknown_feature_ids, chain_digest | projected (backchain.json) |
| result_digest | todoSelfDigest(result) | projected |
No next_action, no status projection in start result (projectTodoStatus output discarded).
Error lattice.cli_error.v2 (stderr): schema, code, message (typedFailure 220); detail{reason,...} (TodoStoreError 75-82); lookup adds requested_task_id, matching_task_ids; internalFailure adds stack_excerpt, error_name. Pre-append refusals do not write lifecycle state; an I/O failure after journal append may leave partial persistence (steps 22–24). Dashboard setup may already have side effects (step 5). Arg failures: typedArgumentFailure (260) with detail.command, next_action, exit 2.

## Ordering is part of the product contract

Owner correction received 2026-11-07 JST supersedes the proposal to make phase
ordering advisory. These are authored dependencies, not missing observations:

| Predicate | Source and readers | Meaning / transition out of waiting |
|---|---|---|
| Task predecessors completed | localPredecessors/replay; mergedPredecessorKeys + validateMergedTransition; todo-status isNodeReady | Finish upstream tasks; existing start override_reason only waives the allowed task-predecessor check. Authored done still requires predecessors. |
| v4 phase active | derivedPhaseStatus + local start replay; status phase_ready | Upstream phases must be accepted; all phase tasks done/retired makes gate_ready; review then accept unlocks successors. |
| v4 cross-phase predecessor accepted | mergedDependencyPhaseReady; status isNodeReady | Completion and phase acceptance are distinct; downstream work waits for the required acceptance. |
| Explicit phase_accept_dependencies in decoupled plans | mergedPhaseAcceptReady + validateMergedTransition; status phaseAcceptIncoming | An explicitly authored acceptance edge requires upstream accepted status for start/done. It is not waived by override_reason. |
| Predecessor endpoint gone (u03 A24, Store finding `endpoint_missing`) | createTodoReadiness prerequisites (the only cross-plan prerequisite check; Store replay's dependenciesDone is same-plan only) | A predecessor task or acceptance-source phase with no node in the merged view is skipped: it never blocks start/done. The edge stays visible as a `cross_plan_findings` entry. |
| Review/accept evidence binding | replayEvents phase_review/phase_accept; phase decision CLI | All required work completes, review binds a digest, decision binds that review plus evidence slots. Rejection/reopen supports correction and renewed review. |

Blanket conversion would let a downstream implementation run against an unaccepted
upstream design and let completion bypass authored prerequisites. Removing an
unnecessary manual step could reduce effort, but there is no evidence here that
waiving these dependencies preserves the requested order. Keep these checks;
separately evaluate any convenience automation without changing their predicates.
Status/readiness and mutation must continue to agree.

## Target flow for S3 (proposed, revised under boundary review)

| Stage / owner | Input and read | Transform and output | Persistence / failure handling |
|---|---|---|---|
| Surface | argv, cwd, actor environment | Parse identifiers and resolve project/plan/task; preserve target identity | Invalid input/wrong target remains typed error. Any acting seat may retract/accept; target digest and current version still bind the operation. |
| Store open | manifest, immutable plan, journal, snapshot | Replay authoritative events, reconstruct derived snapshot | Rebuild a stale derived cache automatically. Preserve digest/identity failures as errors; crash recovery must not invent an event. |
| Plan readiness | task status, hard dependencies, joins, phase state, explicit acceptance edges | Compute ready frontier with the current dependency/phase predicates | Keep authored order. Unknown independence evidence does not rewrite readiness. |
| Independence | recorded artifact plus HEAD/diff and declared boundaries | Reuse advisory.coverage/guidance/self_unknowns for observations that cannot be used; no new top-level advisories array | Proposed refusal conversion applies to observational missing/stale/unknown results only. Unknown stays visible, never becomes verified or conflict-free. |
| Structure/backchain | version-bound observation artifacts | Return existing context keys with typed unavailable forms where validated; backchain absence-compatible fallback is result v5 | Do not silently waive authored dependency or required acceptance evidence. Wrong target or unsafe path retains validation. |
| Mutation attribution | resolved task + acting host/session/agent + override reason | Build unchanged event schema and attribution | Actor mismatch alone no longer prohibits owner-approved retract/accept; preserve binding to the specific authored start/request/result. |
| Store transaction | expected plan/event state, event | Acquire recoverable lock, reread, run the pure Plan-supplied validator for lifecycle/order, append and project | Preserve single writer and data-loss checks. Define recoverable journal/snapshot/manifest commit ordering before implementation. |
| Response | committed event/snapshot plus precomputed contexts | Same result schema and top-level keys, with existing advisory and typed context variants | No schema bump or new top-level fields in this pass; nested stub validation/consumer compatibility must still be checked together before emission. Observational advisories exit 0; phase/order refusals retain their existing contract. |
| Dashboard delivery | committed mutation after manifest publication (current step 24) | Run best-effort ensure/delivery after the lifecycle decision | Move current step 5 after commit; a refused start must not autostart a dashboard. Reporting failure does not undo a committed event. |
| Status | persisted event chain, phase states and notes | Project active_set, next_ready, audit_pending and context | Journal is source of truth. Status and mutation use the same order; reporting failure must not undo a committed event. |
| Runtime integration | plan bindings, executor receipts, observed changes | Dispatch, observe conflict, hold/recompile/resume | Required in every host environment. Aiterm launch does not replace conflict management, scoped barriers, result binding or plan-version control. |

## Recovery state transitions to establish before changing guards

Store and note rows below describe S3 recovery. Runtime/adapter/setup rows remain
proposals and are not integrated by this Store change.

| Protected state / current owner | Current failure | Proposed states and self-exit | Protection retained |
|---|---|---|---|
| Todo store write lock / withLock | Normal start publishes an empty lock; cross-plan recovery publishes PID only | Implemented: free → complete owner record atomically linked → owned → free; identified dead owner → identity-aware recovery claim → locked reread/replay → owned → free. Recovery is default for all todo writes. | PID + process-start identity + host identify the owner. Never reclaim a live owner. Owners that cannot be proven dead (foreign host, legacy empty/pid-only, weak) are recovered only after their heartbeat is older than LOCK_STALE_MS (u03 N2); before that: STORE_WRITE_CONFLICT, reason lock_owner_unidentified or store_locked. |
| Note lock / note-store | Empty lock cannot identify a dead owner | Implemented: same shared identified lock protocol → reread/replay note chain under lock → append → free | Append-only note integrity and sole writer. Live owners stay protected; unidentified/foreign-host/weak owners are recovered once their heartbeat is older than LOCK_STALE_MS (u03 N2), before that NOTE_WRITE_CONFLICT with lock_owner_unidentified or store_locked detail. |
| Run/CLI/pull/start-binding locks / Runtime | Empty or torn owner publication could remain busy | Lifecycle/pull/start-binding: implemented atomic linked publication and unidentified-byte recovery (u03 L1/L2); `todo retract` releases its bound intake and records it (u03 R1). [Canonical Runtime table](dfd-runtime-hold-resume.md#u03-guard-self-exit-implemented) owns the transitions. CLI/registry locks stay proposals | Do not reclaim a live initializer by age or resume writes merely because a lock was recovered. |
| Adapter registry / Runtime | PID-only publication, no dead-owner recovery | Proposed identified publication/recovery and reread registry; [Runtime state table](dfd-runtime-hold-resume.md) | Do not overwrite a live registry writer; keep current public error mapping. |
| Setup lock / setup | Crash leaves setup locked | free → owned → free; proven-dead owner → reclaim + reread host entries → owned | Preserve unrelated host entries and exclude concurrent configuration writes. |
| Source-cutover/cross-plan recovery marker / Store | Marker currently rejects open in some paths | Implemented: clean → prepared → applying → committed → clean; reopen invokes the existing recorded revision recovery or resolves the cross-plan import transaction → clean | Never discard marker or bytes without resolving the recorded operation. |
| Journal ahead of manifest/cache / appendTodoEvent | Crash at steps 22–24 yields manifest_journal_head_mismatch | Implemented: clean → appended → projected → manifest-published → clean; reopen validates the append and finishes publication → clean | A digest mismatch of unknown origin is not permission to accept arbitrary data. Repair under the shared transaction lock; old manifest head must be a validated journal ancestor. No on-disk format change. |
| Runtime conflict hold / supervisor and pull-intake | Intentional scoped pause | [Runtime DFD R1–R10](dfd-runtime-hold-resume.md): observe → selected hold → source commit or limited refactor → affected recompile → epoch/gate commit → resume | Keep real overlap detection, process identity, scoped barriers and evidence checks; unrelated attempts retain origin bindings. |

Store owner Rudmira's authoring follow-up after PR37 also changes ordinary append
so it does not create a missing store root before taking the lock. The
[authoring flow](dfd-plan-create.md) owns uninitialized-layout classification and
transient cleanup before initial directory-rename activation.

## Runtime activation publication

Runtime owns `activateEpochOneStore` / `commitStagedSuccessorEpoch`. The selected
activation digest binds a durable prefix, not a requirement that unrelated
heartbeat/observation events stop. The protected asset is the committed epoch's
binding to persisted run/control evidence; the error exits by restoring the
recorded valid prefix or resolving a conflicting activation, then retrying the
same transaction. No Store or Plan meaning changes.

| Step | Read / decision | Output and failure |
|---|---|---|
| Prepare | Validate predecessor, successor bundle and transaction as before; caller captures run/control activation digests | Keep the saved digests as the activation anchor. |
| Fresh observation | Read durable run events and durable control events; control callback may append one heartbeat before returning | The actual tails can differ from the anchors without losing durability. |
| Prefix proof | Validate each stream's chain and run identity; require each selected digest in its stream | Missing/broken/foreign prefix retains the existing typed activation failure. |
| Subsequent events | Heartbeat/observation append is allowed; reject a later run close/freeze/premature resume, a future epoch or different plan, and a later control stop/recovery barrier/gate/epoch activation which contradicts the pending epoch | Do not overwrite a superseding activation or accept a merely matching digest in invalid bytes. |
| Publication | Rename staged successor and publish pointer last, or complete initial activation in its existing order | Pointer retains the selected activation digests; no format change. Same-transaction recovery stays idempotent. |
| Evidence | Return internal run/control `expected_tail`, `actual_tail`, `expected_in_chain`, `chain_valid`, conflicting event digest | Failure includes the same diagnostics. Unit callback appends a durable heartbeat; Mac hold-resume fixture records the two stream comparisons after activation. |

This replaces exact-tail checks with durable-chain inclusion at the Runtime
activation boundary. It grants no lease, resumes no worker and changes no
claim-7–10 conflict or task-group decision.

## Changed scope

S1 records the current implementation and proposed boundaries. S2 only retires
unreachable research implementations and their exclusive tests; it changes no
start fields, ordering, actor checks, persistence or runtime behavior. S3 must
update this document, public schemas/contracts and focused tests together with
any implemented behavior changes. A stale historical classification of phase
checks as protection-free is not authority to remove them.

## Reviewed conversion boundary (Leviathan, 2026-11-07 JST)

Manual/AI `todo start` and runtime pull-intake deliberately have different roles:
manual start may report stale/missing observations while allowing work; runtime
entry keeps its hold → recompile → resume loop (C5/C6/C8/C13/C14/C43/C25). A
runtime hold is not an observational refusal to remove. No runtime hold changes
are included without its own DFD.

| Start-path case | Proposed treatment | Condition retained |
|---|---|---|
| Five INDEPENDENCE_UNVERIFIED reasons | Implemented u03 B1–B6: keep coverage/guidance precedence and unknowns in existing advisory; exit 0 | Do not relabel stale, missing or superseded coverage verified. |
| HEAD unavailable | Implemented u03 B7 (steps 10b/10a): no-record advisory with self_unknowns ref `git_head_unresolved` + warning | No fabricated Git state: coverage is never reported verified/stale without HEAD. |
| Backchain unreadable/invalid_json/plan_digest mismatch/task_missing/validation failure/unsafe | Implemented u03 A88 (step 13): absence-compatible v5 result (no feature_context) + warning | A v5 result never acquires v6-only fields. binding_unsafe is no longer a start refusal: start never follows or reads the unsafe entry, so the refusal protected nothing; `todo show` and plan writers keep their own reads. |
| Structure read unavailable; start structure source digest failure | Existing structure_context typed unavailable form plus advisory | Acceptance finalization at phase_accept/close remains required. |
| Invalid actor environment | Implemented u03 A57 (step 14): treat like unset; record resolved actor | Keep event/request/result identity. |
| Stale snapshot | Rebuild under transaction lock from journal | Unknown digest corruption stays an error. |
| Dead write-lock owner | Recover through shared identity-aware protocol | All five writers record PID plus process-start identity; no live owner reclaim. |

Withdrawn from the earlier broad conversion list: A12 A13 A63 (order),
A60 A61 A62 (review/accept evidence), A30 A52 for acceptance/close finalization,
A56 A58 A64 H4 (evidence/migration completeness), C5 C6 C8 C13 C14 C43 C25
(runtime loop). Leave A79/A80/A85 authoring/provenance alone this pass. Keep
same-key overwrite checks A33/A35. Target resolution, all four current transition
predicates, event identity, evidence verification and durable publication remain.

Status and prospective event validation will share pure Plan-owned readiness
predicates; use structured reason detail to identify task state, phase state,
acceptance edge or unfinished predecessor, instead of a single ambiguous cause.
Preserve public top-level error code until its compatibility is intentionally
changed. Journal event schemas stay unchanged; observational uncertainty is a
projection, and any requested human/AI provenance can use the existing note store.

Recovery rolls forward a chain-valid authoritative journal to snapshot/manifest;
never truncate committed events. Replay currently walks committed history as well
as prospective events. Its transition checks must be assessed separately from
append-time readiness before S3: a valid hash chain alone does not prove a valid
lifecycle event. Do not remove historical integrity validation under a blanket
'replay is derived' rule. No replay change is part of S2.


## Plan readiness extraction (S3 stage 1)

The pure `todo-readiness.mjs` service consumes only its caller's store view.
`member.tasks` and journal-derived `member.phases` are canonical for status and
prospective validation. Snapshot phase fields are a cache, absent in v1 snapshots;
the predicates neither read nor repair them. Store guarantees `member.tasks`
and journal-derived `member.phases` for every member (ADR 0147); under the
locked `forWrite` read, snapshot phases equal that projection. This equivalence
makes replacing the merged validator's snapshot-phase reads behavior-preserving.
Snapshot phase reads in revision migration are outside this extraction. No filesystem, Git, clock or writes
are allowed in this service. Existing Store schema/phase and cross-plan-edge
projection helpers move unchanged to `todo-store-view.mjs` and keep Store re-exports.

| Step / function | Input and reader | Output / failure | Persistence owner |
|---|---|---|---|
| `createTodoReadiness(store)` | Active members, task and phase projections; hard, join, plan-scoped cross-plan and explicit phase-accept edges | Per-task state, own-phase-active, predecessor completion/acceptance, explicit acceptance predicates; successor queries | None; caller-owned read-only view |
| `todo-status` graph validation → shared readiness | The same read model used for status labels, head metadata and schema validation | Existing sorted ready frontier and result schema; pending + active own phase + satisfied prerequisites | None |
| `validateProspectiveEvent({store,member,event})` merged checks first | Fresh locked Store view; start/done/reopen/phase_reopen including existing mode/override exceptions | Same accepted/refused outcomes and existing per-kind reason; additive cause identifies the failed predicate. Explicit acceptance edge takes priority over unfinished predecessor. Start override retains the existing combined task-predecessor exception, including v4 predecessor-phase readiness. | None |
| Prospective own-task checks after merged rejection priority | Authored start requires pending and v4 own phase active; authored done requires in-progress | Existing invalid_start_transition / invalid_done_transition plus task_state or phase_state | None |
| Existing replay integrity | Journal history plus prospective event, actor/target bindings and evidence | Existing historical checks retained unchanged; full event validity remains a replay responsibility | None |
| Store publication | Successful callback and replay | Existing journal → snapshot → manifest sequence | Store alone |

`reopen` and `phase_reopen` refusal reasons stay
`reopen_has_started_successor` / `phase_reopen_has_started_successor`; their
additive cause is `task_state`, describing the successor state which prevents
invalidating its prerequisite. Reopen keeps the existing next_action.

The extraction temporarily keeps `validateMergedTransition` as a compatibility
wrapper and a direct import from Plan in Store. Rudmira's subsequent Store change
replaces that wrapper with the supplied callback under lock + fresh reread, then
removes the temporary upward import. This intermediate seam introduces no new
store option or public event schema.

Verification is limited to readiness truth tables and read-only behavior, existing
status/store/cross-plan/start/phase suites, changed syntax/document links, and the
normal three-OS candidate CI. Historical replay cases remain regression checks;
unrelated product and sensor behavior is outside the focused local range.

## Store lock implementation contract (S3, Snow White 2026-11-07)

The shared Store lock module calls the platform process-start observer directly;
it does not import runtime policy. Only todo/note integration is included here.
The transient lock record has exact keys
`{pid, process_start:{platform,identity}, host}`; missing/extra keys are unidentified.
Host is a hash of an OS-observed identity domain: Linux boot UUID + PID namespace,
macOS boot-session UUID, Windows MachineGuid. No terminal configuration is needed,
so ADR 0197's missing-config actor fallback still works. Containers sharing config
cannot conflate local PID namespaces. Unavailable domain observation follows
the weak owner (u03 N1); there is no generic-host fallback, so a weak owner is never
PID-recovered. A boot-domain change is a foreign domain and follows heartbeat-stale
recovery.
Publication writes and
syncs a complete temporary record, hard-links it to `.write.lock` (EEXIST means
busy), then unlinks the temporary. No reader can see a partially filled new lock,
except on a filesystem without hard links, where the record is written in place.

| State | Entry and protected data | Self-exit / next operation |
|---|---|---|
| Preparing ownership | Temporary complete record, no lock ownership yet; temporary name includes host/PID/start digest | Link publishes ownership atomically; failed acquisition removes its own temporary. Next acquisition removes abandoned temporaries only after proving their encoded owner dead. |
| Live identified owner | Complete lock bound to local PID + process start | Keep the lock until that process exits (judged by PID + start only; never age-recovered). Existing conflict code/reason for a live contender. Owner releases after callback; an already-removed lock counts as released, and a different replacement owner is preserved. |
| Identified dead owner | Local PID absent (checked first), or the occupying process's observed start identity differs from recorded identity. Windows reuses PIDs quickly, so PID existence alone never proves the owner alive | Publish unique recovery-claim directory with host/PID/start digest in its name. Clean only proven-dead claims; recover only as sole remaining claimant. Reread lock, then remove only the judged entry (removeJudged: rename to `.write.lock.<random>.stale`; unlink only when dev/ino/size/mtime equal the judged lstat; otherwise link it back, and on EEXIST keep both, conflict cause lock_recovery_raced naming the quarantine path; the next acquisition sweeps a quarantine whose mtime is older than LOCK_STALE_MS, its displaced owner having already failed assertHeld), then link new complete ownership. EEXIST preserves any competing owner. |
| Abandoned recovery claim | Claim creator died before/during initialization or recovery | Next contender proves claim owner's death from the complete identity in its directory name and removes only that unique claim. A claim whose owner cannot be proven dead is removed once its heartbeat mtime is older than LOCK_STALE_MS (u03 N2). |
| Multiple live claimants | Two recovery attempts overlap | Each preserves other live claims and exits with existing conflict; owner/claim release permits subsequent acquisition. Claim remains for the whole recovery operation. |
| Unidentified legacy owner | Empty or pid-only pre-S3 lock, or a weak owner (u03 N1); death cannot be established | Keep bytes while the lock mtime is younger than LOCK_STALE_MS (10 min): conflict lock_owner_unidentified. Once older, the next writer takes the sole recovery claim, rereads, confirms it is still stale, removes it and links its own owner (u03 N2 self-exit). |
| Unavailable observation | Local PID exists but the observer fails transiently (spawn failure) | Keep ownership and return existing busy result; retry can observe the owner again. If the PID is absent when rechecked after the failed observation, it was a short-lived reuser of the dead owner's PID (Windows reuses PIDs immediately, e.g. the observer's own pwsh): the owner is dead and recovery proceeds. Access denial is not this state: Windows falls back to the handle-free process snapshot creation time, the same kernel value as StartTime, so another account's process occupying a reused PID is observable and cannot hold a dead owner's lock for its lifetime. PID absence is usable only for a complete local owner record. |
| Own identity unavailable | No complete process-start or host-domain identity can be observed for this writer | Publish a weak owner `{pid, process_start:{platform, identity:"unobserved"}, host:"unobserved"}` instead of failing every write (u03 N1). Nobody PID-recovers a weak owner; it holds by heartbeat and is recovered like an unidentified owner once stale. A weak writer skips PID-based cleanup of others' temporaries/claims. |
| Publication primitive unavailable | Hard-link support is absent (EPERM/ENOTSUP/EOPNOTSUPP/EXDEV/ENOSYS) | Publish in place: open(.write.lock, `wx`) + write + sync (u03, same as Runtime L1); EEXIST follows the busy/recovery path. A reader can see an empty/torn record during the write; it is unidentified, and if the writer dies it goes stale and self-exits. File sync uses fs-publish.syncPublishedFile, the shared owner of the existing WSL2 /mnt EIO allowance. Link-back in removeJudged on such a filesystem keeps the quarantine and reports lock_recovery_raced. |
| Foreign, unidentified or weak owner/claim | Local observation cannot prove the owner dead; preserve single writer | Every holder touches its lock (and its recovery claim) every LOCK_HEARTBEAT_MS (30 s) while it holds, but only after confirming dev/ino and bytes are still its own; on a mismatch it stops touching and marks the lock lost (assertHeld then refuses lock_lost). A foreign/unidentified/weak lock, claim or temporary whose mtime is older than LOCK_STALE_MS is abandoned: the sole claimant removes it via removeJudged and proceeds (u03 N2). Fresh heartbeat: existing conflict code/reason and next_action to retry. |
| Lost lock (residual, accepted) | A holder judged by heartbeat can lose its lock while alive: suspended longer than LOCK_STALE_MS (process stop, host sleep); event loop blocked by a synchronous callback step (gitSync) so the heartbeat stops; cross-host clock skew (a reader whose clock is ahead by more than LOCK_STALE_MS − LOCK_HEARTBEAT_MS can recover a live foreign lock; a reader behind only delays recovery); S3/pre-u03 binaries never heartbeat, so their transactions longer than LOCK_STALE_MS can be recovered | appendTodoEvent (lifecycle and plan-scoped journal) and note append run assertHeld right before the publish: lstat the release path, dev/ino == own, bytes == own record; otherwise STORE_WRITE_CONFLICT/NOTE_WRITE_CONFLICT cause lock_lost, nothing published, retry reacquires. Remaining gap: a loss between assertHeld and the rename can still overwrite the new owner's append. Other publishers (revision/successor/activation) keep their manifest CAS. |

The singleton claim decision does not wait or spin when two live claimants
overlap: both may return busy, then the next sole attempt recovers. The todo
claim root remains `.lattice/todo/.cross-plan-recovery`; old PID-only claim names
are unidentified/manual. Note claims use `.write.lock.recovery`. The old
recoverDeadLock option is ignored because recovery is unconditional; existing
callers keep working. The cross_plan_lock_recovery_mutex_acquired protocol stage
is preserved through onRecoveryClaim. Old binaries only reclaim exact pid-only
records and new binaries never reclaim them, so mixed-version readers cannot
mistake a new identified owner for a legacy dead owner.

Todo/note `.write.lock`, `.write.lock.*.tmp`, `.write.lock.recovery/**` and todo
`.cross-plan-recovery/**` are host-local exclusion state, never durable artifacts.
Repository ignore rules and store Git transaction path selection exclude them;
an interrupted acquisition must not distribute lock state through a commit.
Store uses platform identity observation and never reads the OS hostname
(ADR 0197). Lock identity never supplies journal actors or public results.

The Plan callback receives `validateProspectiveEvent({store,member,event})` after
lock acquisition and fresh read/recovery, before durable append. The complete
store includes every active member and cross-plan edge. It is read-only for Plan.
Transition reasons stay unchanged; `cause` is additive. Since a12 the code is
`TODO_TRANSITION_REFUSED` (nothing is inconsistent when an order or state rule refuses).

### Store supplied-callback wiring (S3 stage 2)

This completes Table 1 step 20's stage-1 compatibility seam; the current call
is the mandatory supplied function below, with no wrapper/upward import.

The stage-1 extraction above remains the Plan contract. Store now removes its
temporary validateMergedTransition wrapper and upward Plan import. All five
todo-cli append sites pass validateProspectiveEvent explicitly. The append option
is mandatory (a missing/non-function option is a contract TypeError before lock
or writes). After lock + recovery + fresh reread and canonical event construction,
Store calls it exactly once with `{store,member,event}`; the view is read-only for
Plan. `{ok:false,code,detail}` maps to the existing refusal path, preserving reason
and additive cause. Malformed callback results are contract TypeErrors before
append. Historical replay, evidence and event identity checks are unchanged.
Tests use one authoring fixture adapter which supplies the same Plan service;
focused boundary tests call the raw Store entry to cover missing callback,
fresh-state observation under the held lock and refusal without journal mutation.

## Store read tolerances (u03 guard sweep, Ludmila 2026-11-08)

Replay and artifact reads (steps 6 and 16) keep integrity checks that name a
protection (identity, schema, canonical bytes, digest and hash chain) and drop
the ones Lattice invented:

| Former refusal | Now | Why it is safe |
|---|---|---|
| A4 STORE_INCONSISTENT/clock_reversal (event recorded_at earlier than its predecessor) | removed; replay never orders by time | sequence + previous_digest chain carry the order |
| A5 STORE_INCONSISTENT/future_clock_skew (recorded_at > reader clock + 5 min) | removed; recorded_at is shown as recorded | the time is a recorded fact, not an integrity key |
| A6 artifact_eol_converted (CR bytes from a Git autocrlf checkout) | the reader undoes a pure CRLF conversion in memory (`normalizeCheckoutEol`: every CR precedes LF); the canonical-bytes check, event/segment digests and hash chain then run on the LF bytes | normalisation is accepted only when the result is the exact canonical/digest-bound bytes; any other CR still fails as non-canonical. The next append/seal/snapshot writes LF bytes. `lattice todo repair-eol` stays as the explicit worktree repair. |

The structure lifecycle gate (step 18) is removed (A29/A30).

## Store reopen publication (S3 implementation contract)

Normal clean reads without an owner lock remain lock-free. An existing owner
lock also triggers acquisition so a crash after manifest publication releases
its dead ownership; live/unidentified contention preserves the valid read view.
A recoverable observation takes the shared
transaction lock, rereads all artifacts, validates before writing, then returns
the same read schema. Writers use the private locked-read entry directly; the
initial-authoring verification keeps its strict raw read so repair cannot hide
an activation mismatch. A live writer's publication window keeps its previous
typed read failure for stable-read retry; no recovery touches its bytes.

| Recovery input | Locked validation and operation | Exit / retained error |
|---|---|---|
| Journal ahead of manifest | Existing manifest head must occur in the validated hash chain. Replay all existing semantic/identity/evidence checks and validate merged topology before any repair. Write derived snapshots first, then publish manifest heads and digest. | clean → appended → projected → manifest-published → clean. No journal truncation or invented event; an absent manifest head remains manifest_journal_head_mismatch. |
| Stale/missing derived snapshot | Recompute from the authoritative validated journal, under lock. Validate every member before rewriting any cache. | Return snapshot_stale=false after canonical replacement. Existing unsafe path, EOL and authoritative digest failures remain typed errors. |
| Segment sealed before active replacement | Verify sealed name/range/digest and exact byte equality of the redundant active segment with the final sealed segment. Treat that exact duplicate as one logical segment. | Next append replaces active with the new event; preserve every committed event. Differing or partial overlaps remain hash-chain errors. Same rule applies to the independent note chain. |
| Cross-plan import transaction marker | Reuse recorded validated transaction: if manifest already published its descriptor, finish its staged bound artifacts; otherwise roll back only its unpublished directory. Destination bytes must equal the staged final bytes or their exact pre-append prefix (derived from the marker's bound event); never overwrite unknown destination bytes. | Remove resolved marker; no caller must replay the original migrate input; import writers also resolve foreign recorded transactions before preparing a new import. Unknown digest/destination or conflicting manifest remains typed error with bytes/marker preserved; restoring the recorded preimage permits recovery. |
| Source-cutover barrier | Find the canonical marker matching the barrier digest in fixed transaction roots. Reconstruct only the recorded validated revision or revision-set input, actor/time/provenance from its genesis; invoke the existing recovery implementation under the already-held lock. | Finish its recorded source/artifact/manifest publication and cleanup. Private lock capability prevents nested acquisition; only recovery dispatch can supply it. Invalid/missing/conflicting marker/stage stays the existing typed recovery error. |

Fault-injection stages after journal publication, snapshot publication and manifest
publication expose the three durable boundaries to focused recovery tests. They
do not alter event bytes or result schemas. Completed recovery is idempotent.

## Retire at any state (u12, agreed 2026-11-08)

Owner 「削除や変更は許す」: deleting a task is never refused by its state.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `todo retire --plan <key> --task <id> --reason <text>` | Fresh task state | Appends `retire` with `{reason, prior_status}` from pending, blocked, in-progress or done; `invalid_retire_transition` for done and (u03 A14r) in-progress is removed. In-progress: see the u03s section below (Runtime release first). | Already retired → success with `unchanged: true` and no new event (a retry after a lost response is not an error). State changed between read and append → Store replay refuses under the lock before publication (`retire_prior_status_mismatch` / `invalid_retire_transition`) and `todo retire` reports it as `STORE_WRITE_CONFLICT/retire_state_changed` {expected} (`retireStateConflict`, todo-readiness); rerun the same retire. Direct Store appends keep Store's reasons. |
| Store replay (Ludmila) | Legacy `{reason}` or new `{reason, prior_status}` | Legacy keeps pending/blocked. New accepts all four prior statuses (pending, blocked, in-progress, done) when prior_status equals the replayed status; in-progress retire deletes the authored start binding; done evidence stays in the journal. Replay records what was appended and is not the gate; u03 A14r needed no Store change. | Old readers reject the new payload; same rollout as plan v8. |
| Plan: readiness after retire | Retired predecessor | A predecessor is finished exactly when Store's shared `isFinishedTodoTaskState(state)` (todo-store-view) holds: status done or retired (a13; u12 counted only a retire from done); replay dependenciesDone and readiness predecessorsDone both call it (the work was done; a retire from done keeps done_at and imported). Since a13 every retired task is finished (retire is the user deleting the task, so its edges count as gone); see the a12/a13 section. Phase gate counts retired as finished, as today. | None added. |
| Runtime (Tov) | Run/hold/claim of a retired in-progress task | No shipped Runtime path releases it today (Tov 2026-11-08: existing-intake refresh ignores task.status and can SIGCONT a held worker; detach→release and whole-run abandon are not task retirement). Required new Runtime behavior, carried by Tov in the u03 guard PR (C11 retract auto-release / C18 close auto-abandon): retirement reconciliation keyed by plan/task/authored start digest records terminal intake abandonment/release, blocks later resume/receipt acceptance for that binding, and cancels an attached worker through authenticated cancellation; its states live in dfd-runtime-hold-resume. Plan never touches Runtime state. Merge split: u12 shipped retire from pending/blocked/done (+ idempotent retired). Tov's C11 release step is in main (R1); u03 A14r reuses it for in-progress retire (u03s section). | Shipped. |

A retired task stays in the plan, so cross-plan connections to it keep a valid
endpoint; removal by revision is covered by the named limit in dfd-plan-revise.md.

Patent: lifecycle transitions are outside claims 1–12.

## u03s start/done/status refusals removed (Ludmila, 2026-11-08)

Rows from guard-sweep-u03 (A14r, A15, A57, A58, A77, A88, B1–B8, B16).
Start-path rows (A57, A88, B1–B8, B16) are steps 7, 10, 10b, 11, 13 and 14 of
Table 1. Authored order, joins, phases and the patent claim mechanisms keep
their refusals (steps 20–21 unchanged).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `todo retire` of an in-progress task (A14r) | Fresh state in-progress; the task's latest `start` event (any actor; a reopen keeps the start it reopened, because Runtime intake binds to the latest literal start and ignores later done/reopen); none, or a historical_import start, for imported/carried work | When a start event exists: Runtime's public `withStartRetractionGuard({..., activationEventDigest, releaseReason: 'task_retired'})` takes the start-binding lock, releases every unaccepted pull intake bound to that start through the R1 release step (recorded `intake_released {reason: task_retired}`), then the action appends `retire {reason, prior_status: 'in-progress'}`. No start event: append directly. Store replay already accepts it and closes the start binding. | Release before the Plan append: a failed append leaves an in-progress task with no intake, which the holder can intake again. A retired task cannot be intaken (intake needs in-progress) or accepted (accept needs done). Managed-runtime runs are not reconciled here (Runtime). |
| Store replay: `reopen` in an accepted / closed_unaudited phase (A15) | reopen event; derived phase status | `task_reopen_requires_phase_reopen` is removed: the task returns to in-progress and the phase state is left as recorded (accepted / closed_unaudited, snapshot format unchanged). `reopen_has_started_successor` (author's order, override exists) is kept. | Old readers (pre-u03s binaries) replay such a recorded reopen as `STORE_INCONSISTENT/task_reopen_requires_phase_reopen` and refuse the journal; same rollout as plan v8: seats update before writing one. |
| Plan: stale phase acceptance (A15) | journal events, phase decision digest | A phase is `acceptance_stale` when its status is accepted or closed_unaudited and a `reopen` of one of its tasks (phaseless plans: any task) comes after its decision event, or one of its tasks is currently not done/retired (a revision carried the acceptance onto work it never saw; u03p, agreed with Ludmila). Derived, never persisted. Shown as `advisory {phase_acceptance_stale: true, phase_id, status, guidance}` on that reopen result and as `acceptance_stale` (boolean) plus guidance on each `todo phase status` entry. | Self-exit: `todo phase reopen` → review → accept (or close-unaudited) records a fresh decision; the flag then clears. |
| Plan: `todo done` evidence input (A58) | `--evidence <path>`, `--message <text>`, both or neither | One: unchanged. Both: the file is resolved as before (blob written, descriptor validated), then the evidence is the message evidence whose text is the message followed by `evidence: <repo_id>:<path> (git blob <oid>, sha256 <digest>)`. Neither: message evidence with the fixed text `証拠の指定なしで完了した。` (done without evidence, recorded as such). Event schema, evidence descriptor and store verification unchanged. | Invalid path token or unreadable file keeps the existing refusals (the file named does not exist). |
| Plan: `todo status` / `project status` output (A77) | Store read model | Output callers get `lattice.todo_status_result.v9`: every list is cut at `TODO_STATUS_LIST_LIMIT` (and each `active_set.unmet_dependencies`), then, while the result exceeds `TODO_STATUS_CAPTURE_LIMIT`, the longest list is halved. `truncated: [{list, total, shown}]` records every cut (empty when none). `dispatch_frontier` is computed from the shown `next_ready`. `TODO_STATUS_DISPATCH_ONLY` callers (start readiness, independence, dashboard liveness) are never cut and have no byte limit; their list limit stays as before. | No TODO_SCALE_EXCEEDED from status output. `todo bindings` keeps its own limit. |

Patent: lifecycle transitions and status projection are outside claims 1–12;
independence/seam estimation (claims 1 A, 5–6) still reads full dispatch-only
projections.

## Order and state refusals (a12, a13; Ludmila 2026-11-08)

Plan bellteam-adoption-20261108, tasks a12-transition-refusals and
a13-retired-predecessor. Table 1 steps 20–21 keep their order of checks.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `validateProspectiveEvent` refusal (a12) | fresh locked store, prospective event | Every order/state refusal uses code `TODO_TRANSITION_REFUSED` (was STORE_INCONSISTENT). Reasons are unchanged (`invalid_start_transition`, `invalid_done_transition`, `reopen_has_started_successor`, `phase_reopen_has_started_successor`) plus `invalid_block_transition` (block needs in-progress) and `invalid_unblock_transition` (unblock needs blocked), now refused here before replay; a v4 `phase_reopen` of an accepted phase whose successor phase is unlocked or has a started task is refused here with replay's rule. Detail by cause: `predecessor_unfinished` → `blocking_tasks: [{plan_key, task_id, status}]` (unfinished predecessors, sorted); `acceptance_edge` → `blocking_phases: [{plan_key, phase_id, status}]` (unaccepted phases); `task_state` → `status`; `phase_state` → `phase_status`. | Store replay keeps STORE_INCONSISTENT for history that does not replay. Self-exit: finish/accept the named blocker, or `--override-reason` on start. |
| Plan: refusal guidance (a12, PR84 table) | detail above | `next_action` for `predecessor_unfinished` names the first blocking task: `Record done on <plan>/<task> first (lattice todo show --plan <plan> --task <task> --json)`; block/unblock get their own repair. Keys stay reason+cause. | — |
| Plan: repeated transition (a12) | unlocked fresh read: task state, journal | No event, success `lattice.todo_mutation_result.v2` with `unchanged: true` and the recorded event (retire's precedent): `start` of an in-progress task whose latest `start` has the current `actor.agent`; `done` of a done task; `block` of a blocked task; `unblock` of a task that is not blocked. A start of another seat's in-progress task is still refused (`task_state`). | State changes between read and append: the append path refuses as usual; rerun. |
| Plan: `todo verify` evidence (a12) | read model `evidence_unverified`, Store `isTodoEvidenceUncommitted({repoRoot, store, evidence})` | A task whose evidence blob exists with its recorded digest but is unreachable from refs (message evidence or a file not yet committed) is an item in `uncommitted_evidence: [{plan_key, task_id, repo_id, path, next_action}]`; verify succeeds (`lattice.todo_verify_result.v4` = v3 + that list). | A missing blob, digest mismatch or unverified import source still refuses STORE_INCONSISTENT/evidence_unverified (data loss). A fresh clone (CI) lacks the uncommitted blob, so CI still refuses it. |
| Plan: `todo done` help (a12) | — | `done --plan <key> --task <id> [--evidence <file>] [--message <text>]`: both, one or neither (A58). | — |
| Store + Plan: retired predecessor (a13) | task state | `isFinishedTodoTaskState(state)` = status done or retired. Store replay dependenciesDone, readiness predecessorsDone and status `unmet_dependencies` share it, so a retired predecessor no longer holds its successors. The order gate for unfinished (non-retired) predecessors and phase acceptance gates stay. | Old readers replay a start/done recorded after a retired-unfinished predecessor as STORE_INCONSISTENT/invalid_start_transition; same rollout as plan v8 (seats update before writing one). |

Patent: lifecycle transitions are outside claims 1–12.
