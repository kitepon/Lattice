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
| 7 | cli 850-858 projectTodoStatus DISPATCH_ONLY (todo-status.mjs:565; isNodeReady 513) | store | memory | is target in next_ready? | --parallel-frontier + non-ready → PARALLEL_DISPATCH_INVALID; non-ready alone not refused here | next_ready, active_set, targetReady |
| 8 | cli 859-877 lookup | planKey, taskId | members | case-insensitive id match | STORE_INCONSISTENT/plan_not_active, TASK_NOT_FOUND, TASK_ID_AMBIGUOUS | resolvedTaskId |
| 9 | cli 879-897 readTodoNoteContext (todo-note-store.mjs:504) | store, plan, task | note chains (task+plan), migrations | project | DEGRADE only for NOTE_LOG_CORRUPT/NOTE_PROJECTION_INVALID → note_context.unreadable.v1 stub; other errors propagate | noteContext |
| 10 | cli startAdvisory 773 → readTodoIndependenceArtifact (store 5193) | store, plan | plans/<k>/<v>/independence.json, member.coordination.mode | record exists? | corrupt → refuse INDEPENDENCE_ARTIFACT_INVALID; legacy schema → legacy marker | artifact or null |
| 10a | no record, cli 780-795 | — | — (no git) | advisory only | coverage missing; self_unknowns witness_missing/no_independence_record; guidance by mode: conversation→coordination_conversation, null→coordination_mode_undeclared, witness→independence_unrecorded. None refused | advisory |
| 10b | record exists, cli 796-798 currentHeadSha (1932), changedPathsSince (1954) | artifact.base_sha | git rev-parse HEAD, cat-file -e, diff --name-only | HEAD required only now | HEAD unreadable → refuse INDEPENDENCE_BASE_UNRESOLVED; unreachable base → changedPaths=null = everything intersects | currentBaseSha, changedPaths |
| 10c | projectIndependenceFrontier (ind 383-520; coverage 488-492) | artifact, ready ids, active ids, plan | memory | coverage: superseded (plan_version/topology differs or legacy), verified (base==HEAD), else stale; record_stale only if declared boundary ∩ diff; witness_missing; plan_verdicts_absent (outcome≠compiled) | unknowns collected per READY task only | coverage, drift_intersecting, conflicts_with_active, scope_expansion_recommendations, uncovered_active_task_ids, self_unknowns |
| 10d | selectIndependenceGuidance (guid 260-300) | coverage, taskDeclared, taskStale, severability, contractSuperseded, verdictsAbsent, mode | — | precedence: conflict_with_active, conflict_between_ready, contract superseded, missing, superseded, undeclared, stale, verdicts absent, verified | — | guidance{code,message,next_action} |
| 11 | cli 903-910 independenceStartRefusal (guid 183-189; codes 172-178) | guidance.code | — | one of five codes? | refuse INDEPENDENCE_UNVERIFIED, detail.reason=code, plan_key, task_id, next_action. Conflicts are NOT refused | — |
| 12 | cli startStructureContext 714 → readTodoStructureState (todo-structure-store.mjs:213) | store, plan | structure source + binding | no source/binding → not_enabled; digest mismatch/missing task → unreadable | projected only here; reader errors (INVALID_TODO_STRUCTURE_*, STRUCTURE_SOURCE_*) propagate | structure_context |
| 13 | cli 913 readTaskBackchainContext (plan-backchain.mjs:282; read 253) | plan, taskId | plans/<k>/<v>/backchain.json | missing file → null → result v5; present → feature_context, v6 | refuse PLAN_BACKCHAIN_INVALID (binding_unsafe/unreadable/invalid_json/invalid incl. plan_digest mismatch/task_missing/validate failure) | featureContext |
| 14 | cli mutate 638, mutationActor 575 | LATTICE_TODO_ACTOR_HOST/SESSION/AGENT | env, terminal id, USER/LOGNAME | env values must be identifiers | refuse ACTOR_UNRESOLVED/actor_environment_invalid; unset → host label/host, session, sanitized USER/agent | actor{host,session,agent} |
| 15 | store appendTodoEvent 2039 → withLock (~1829) | writer g5-authoring, event{kind:start,task_id,actor,payload{override_reason}} | .lattice/todo/.write.lock (atomic hard-link publication) | complete PID/start/host owner; proven-dead recovery by default | live contender: STORE_WRITE_CONFLICT/store_locked; legacy: lock_owner_unidentified with manual next_action; no age-only reclaim | lock |
| 16 | store readTodoStoreLocked({forWrite:true}) under lock | — | store | reread/replay validated history, repair derived snapshot and interrupted publication | unknown authoritative corruption retains typed error; steps 7-13 feature reads not re-validated | fresh store |
| 17 | store 2048-2049, 2075-2080 resolveCanonicalTaskId (1959) | id | plan | resolves | TASK_NOT_FOUND / TASK_ID_AMBIGUOUS | task_id |
| 18 | store enforceTodoStructureLifecycleGate 1975 (start not exempt; only done is) | member | binding + source | binding exists → source digest must match | refuse STRUCTURE_LIFECYCLE_GATE_FAILED/enabled_structure_source_unreadable (finalization/HEAD checks apply only to phase_accept/close) | — |
| 19 | store nextEvent (~1893) | input | — | — | — | event |
| 20 | store validateMergedTransition 1133; replay 683-717 | merged task/phase states | memory | task pending; phase active (v4); phase-accept edges accepted (mergedPhaseAcceptReady 1082); predecessors done & phases ready (1071); override_reason waives ONLY predecessor condition | refuse STORE_INCONSISTENT/invalid_start_transition (717, 1145) — one code, four causes | — |
| 21 | store 2086-2095 prospective replay + evidence verification | journal+new event | git blobs | history replays cleanly | refuse with replay's typed error | — |
| 22 | store 2118-2135 journal append via atomicWrite (1697) | event bytes | journal active segment (seal on overflow) | — | I/O error propagates; validated committed append rolls forward on reopen across 22-24 | journal seq+1 |
| 23 | store 2141 snapshotFor (867) + atomicWrite | plan, events, tasks | — | — | — | snapshot{through_sequence, journal_head_digest, tasks, snapshot_digest} |
| 24 | store ~2146 manifest rewrite | manifest | .lattice/todo/manifest.json | no digest compare (lock + step16 re-read protect) | crash between 22 and 24 → next locked reread completes snapshot/manifest publication | member.journal_head_digest, manifest_digest |
| 25 | store ~2150 projectPhaseStates → cli 668-710 | event, snapshot, plan, phases | — | — | — | {event,snapshot,plan,phases} |
| 26 | cli 687-710 result | event, snapshot, advisory, contexts | — | v6 if featureContext else v5; start without noteContext → TypeError (CONTRACT_VIOLATION) | — | result + result_digest |
| 27 | cli 4270-4275 | result | stdout | — | typedFailure (220); TypeError→CONTRACT_VIOLATION; else INTERNAL_FAILURE (245) | JSON line; exit 0 / 1 (typed, internal) / 2 (args) |

Journal event fields (nextEvent ~1893-1910): schema lattice.todo_event.v1 (v3 for phase-capable plans); project_id, plan_key, plan_version, sequence, previous_digest; kind:start, task_id, phase_id (v3, null), actor, recorded_at, provenance:null, payload{override_reason}, event_digest. NOT in event: advisory, note/structure/feature context, guidance.

Five INDEPENDENCE_UNVERIFIED reasons: independence_task_undeclared; independence_stale_for_task (HEAD moved and declared boundary ∩ diff; unreachable base counts); independence_superseded (plan_version/topology_digest differ); independence_contract_superseded (legacy schema); independence_verdicts_absent (outcome≠compiled and task covered). No record → none apply. Conflict guidance wins precedence and is advisory only. self_unknowns computed over READY tasks only: a non-ready target (via --override-reason) is refused only on superseded/legacy.

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
Error lattice.cli_error.v2 (stderr): schema, code, message (typedFailure 220); detail{reason,...} (TodoStoreError 75-82); INDEPENDENCE_UNVERIFIED adds plan_key, task_id, next_action; lookup adds requested_task_id, matching_task_ids; internalFailure adds stack_excerpt, error_name. Pre-append refusals do not write lifecycle state; an I/O failure after journal append may leave partial persistence (steps 22–24). Dashboard setup may already have side effects (step 5). Arg failures: typedArgumentFailure (260) with detail.command, next_action, exit 2.

## Ordering is part of the product contract

Owner correction received 2026-11-07 JST supersedes the proposal to make phase
ordering advisory. These are authored dependencies, not missing observations:

| Predicate | Source and readers | Meaning / transition out of waiting |
|---|---|---|
| Task predecessors completed | localPredecessors/replay; mergedPredecessorKeys + validateMergedTransition; todo-status isNodeReady | Finish upstream tasks; existing start override_reason only waives the allowed task-predecessor check. Authored done still requires predecessors. |
| v4 phase active | derivedPhaseStatus + local start replay; status phase_ready | Upstream phases must be accepted; all phase tasks done/retired makes gate_ready; review then accept unlocks successors. |
| v4 cross-phase predecessor accepted | mergedDependencyPhaseReady; status isNodeReady | Completion and phase acceptance are distinct; downstream work waits for the required acceptance. |
| Explicit phase_accept_dependencies in decoupled plans | mergedPhaseAcceptReady + validateMergedTransition; status phaseAcceptIncoming | An explicitly authored acceptance edge requires upstream accepted status for start/done. It is not waived by override_reason. |
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
| Todo store write lock / withLock | Normal start publishes an empty lock; cross-plan recovery publishes PID only | Implemented: free → complete owner record atomically linked → owned → free; identified dead owner → identity-aware recovery claim → locked reread/replay → owned → free. Recovery is default for all todo writes. | PID + process-start identity + host identify the owner. Never reclaim a live owner or by age. Legacy empty/pid-only locks stay untouched: STORE_WRITE_CONFLICT, reason lock_owner_unidentified, next_action naming the lock and operator confirmation before clearing. |
| Note lock / note-store | Empty lock cannot identify a dead owner | Implemented: same shared identified lock protocol → reread/replay note chain under lock → append → free | Append-only note integrity and sole writer. Live/unidentified/foreign-host owners stay protected; legacy failure retains NOTE_WRITE_CONFLICT with lock_owner_unidentified detail and manual next_action. |
| Run/CLI/pull/start-binding locks / Runtime | Empty or torn owner publication can remain busy | Proposed identified publication/recovery; [canonical Runtime state table](dfd-runtime-hold-resume.md) owns current/target transitions | Do not reclaim a live initializer by age or resume writes merely because a lock was recovered. |
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
| Five INDEPENDENCE_UNVERIFIED reasons | Keep coverage/guidance precedence and unknowns in existing advisory; exit 0 | Do not relabel stale, missing or superseded coverage verified. |
| HEAD unavailable | Existing advisory describes unknown coverage and base-unresolved guidance | No fabricated Git state. |
| Backchain unreadable/invalid_json/plan_digest mismatch/task_missing/validation failure | Unavailable context; use the absence-compatible v5 result if feature_context cannot be supplied | binding_unsafe (outside repo/symlink) remains refusal. Before S3 choose compatible context representation by inspecting existing validators/consumers; a v5 result cannot silently acquire v6-only fields. |
| Structure read unavailable; start structure source digest failure | Existing structure_context typed unavailable form plus advisory | Acceptance finalization at phase_accept/close remains required. |
| Invalid actor environment | Sanitize like unset; record resolved actor | Keep event/request/result identity. |
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
lock_identity_unavailable; there is no generic-host fallback. A boot-domain change
is a foreign domain and follows the documented manual confirmation path.
Publication writes and
syncs a complete temporary record, hard-links it to `.write.lock` (EEXIST means
busy), then unlinks the temporary. No reader can see a partially filled new lock.

| State | Entry and protected data | Self-exit / next operation |
|---|---|---|
| Preparing ownership | Temporary complete record, no lock ownership yet; temporary name includes host/PID/start digest | Link publishes ownership atomically; failed acquisition removes its own temporary. Next acquisition removes abandoned temporaries only after proving their encoded owner dead. |
| Live identified owner | Complete lock bound to local PID + process start, or foreign host | Keep the lock; existing conflict code/reason for a live contender. Owner releases after callback; an already-removed lock counts as released, and a different replacement owner is preserved. |
| Identified dead owner | Local PID absent (checked first), or the occupying process's observed start identity differs from recorded identity. Windows reuses PIDs quickly, so PID existence alone never proves the owner alive | Publish unique recovery-claim directory with host/PID/start digest in its name. Clean only proven-dead claims; recover only as sole remaining claimant. Reread lock before removing it, then link new complete ownership. EEXIST preserves any competing owner. |
| Abandoned recovery claim | Claim creator died before/during initialization or recovery | Next contender proves claim owner's death from the complete identity in its directory name and removes only that unique claim. No age-only reclaim. |
| Multiple live claimants | Two recovery attempts overlap | Each preserves other live claims and exits with existing conflict; owner/claim release permits subsequent acquisition. Claim remains for the whole recovery operation. |
| Unidentified legacy owner | Empty or pid-only pre-S3 lock; death cannot be established | Keep bytes and conflict code; reason lock_owner_unidentified and next_action identify manual clearing after the operator confirms no writer. This is the explicit legacy compatibility boundary. |
| Unavailable observation | Local PID exists but the observer fails transiently (spawn failure, or the PID was freed between checks) | Keep ownership and return existing busy result; retry can observe the owner again. Access denial is not this state: Windows falls back to the handle-free process snapshot creation time, the same kernel value as StartTime, so another account's process occupying a reused PID is observable and cannot hold a dead owner's lock for its lifetime. PID absence is usable only for a complete local owner record. |
| Own identity unavailable | No complete process-start identity can be observed for this writer; protect identifiable ownership | Publish no lock. Existing conflict code/reason with cause lock_identity_unavailable and next_action to restore the platform observer and retry. |
| Publication primitive unavailable | Hard-link support is absent; protect atomic ownership publication | Existing conflict code/reason with cause lock_publication_unavailable and next_action naming the lock and a filesystem with atomic hard-link support. No empty-then-fill fallback. File sync uses fs-publish.syncPublishedFile, the shared owner of the existing WSL2 /mnt EIO allowance. |
| Foreign or unidentified owner/claim | Local observation cannot prove a different host's process dead; preserve single writer | Existing conflict code, named lock/claim paths and next_action: retry after owner exit, or confirm no writer on the recorded host before manually removing only the abandoned lock/claim. Hostname changes receive this same explicit manual recovery. |

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
Existing transition code/reason stay unchanged; `cause` is additive.

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

## Retire at any state (u12, Snow White 2026-11-08)

Owner 「削除や変更は許す」: deleting a task is never refused by its state.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `todo retire --plan <key> --task <id> --reason <text>` | Fresh task state | Appends `retire` with payload `{reason, prior_status}` from pending, blocked, in-progress or done. An in-progress authored start binding is closed by the retire; done evidence stays in the journal. `invalid_retire_transition` (Lattice-invented, block→retire already reached the same end) is removed. | Already retired → existing typed refusal (nothing to delete). Stale state between read and append → existing CAS conflict; reread and retry. |
| Store replay (contract registered with Ludmila) | `retire` payload: legacy `{reason}` or `{reason, prior_status}` | Legacy payload keeps the old pending/blocked rule. New payload requires `prior_status` to equal the replayed status (recorded fact, not a gate the author can hit through normal CLI use). Readiness of successors treats a retired predecessor exactly as today. | Old readers reject the new payload shape; same shared-store rollout as plan v8. |

Patent: authoring, revision and lifecycle transitions are outside claims 1–12;
claimed mechanisms (impact estimation, overlap resolution, hold/commit/resume,
runtime conflict detection and targeted replanning) are untouched.
