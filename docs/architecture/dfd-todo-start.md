# Data flow: todo start

Canonical lifecycle field trace at 0.79.5 (`047139e5`). The current-path tables
below reuse the completed read-only Sonnet trace without repeating its verification.
[Function map](function-map.md) owns module/state boundaries.
The target tables describe proposed S3 behavior, not implemented behavior.

Corrections to assumptions: dependency-not-done surfaces as STORE_INCONSISTENT/invalid_start_transition (no "plan order" code); manifest CAS (todo-store.mjs:2822/4418) belongs to activation/revision, not start; dashboard ensure runs BEFORE the mutation.

## Table 1 — steps (cli = src/todo-cli.mjs, store = src/todo-store.mjs, ind = src/todo-independence.mjs, guid = src/todo-independence-guidance.mjs)
| # | where | input | reads | decision | on failure/unknown | output |
|---|---|---|---|---|---|---|
| 1 | bin/lattice.mjs:158-166 | argv, cwd, env | — | — | — | exit code |
| 2 | cli runTodoCli 3781; --commit-store stripped 3798 | argv | — | trailing --commit-store allowed (278) | refuse STORE_COMMIT_UNSUPPORTED exit 2 | argv, atomicCommit |
| 3 | matchFlagCommand (todo-authoring-input.mjs:201/170), start spec cli 4130-4152 | plan, task, override-reason, parallel-frontier, serial-confirmed, rebind, reason | — | ids must be identifiers; override-reason non-empty | refuse INVALID_ARGUMENTS exit 2; `--json` not in known → rejected; --serial-confirmed accepted, never read | startTask closure |
| 4 | cli resolveRepoRoot ~296 | cwd | git rev-parse | — | refuse REPO_UNRESOLVED | repoRoot |
| 5 | cli 4266-4268 ensureActiveProjectDashboard (3614), non-strict | env | store (stable read), project identity, dashboard registry | LATTICE_DASHBOARD_AUTOSTART=0 skips | DEGRADE: all errors → null; last block writes dashboard_delivery.v1 failed to stderr (3637-3643) | activity (discarded) |
| 6 | cli startTask 847 → readTodoStore (store 1508) unlocked, not forWrite | repoRoot | manifest, plans, journals, snapshots | store integrity | refuse SOURCE_CUTOVER_RECOVERY_REQUIRED / STORE_INCONSISTENT (e.g. manifest_journal_head_mismatch); snapshot staleness only flagged (1628) | store |
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
| 15 | store appendTodoEvent 2039 → withLock (~1829) | writer g5-authoring, event{kind:start,task_id,actor,payload{override_reason}} | .lattice/todo/.write.lock (O_EXCL) | lock acquired? | refuse STORE_WRITE_CONFLICT/store_locked; no wait/retry; dead-lock recovery off | lock |
| 16 | store 2043-2047 readTodoStore({forWrite:true}) under lock | — | store | snapshot must equal journal-derived (1628) | refuse STORE_WRITE_REFUSED/snapshot_stale; steps 7-13 reads not re-validated | fresh store |
| 17 | store 2048-2049, 2075-2080 resolveCanonicalTaskId (1959) | id | plan | resolves | TASK_NOT_FOUND / TASK_ID_AMBIGUOUS | task_id |
| 18 | store enforceTodoStructureLifecycleGate 1975 (start not exempt; only done is) | member | binding + source | binding exists → source digest must match | refuse STRUCTURE_LIFECYCLE_GATE_FAILED/enabled_structure_source_unreadable (finalization/HEAD checks apply only to phase_accept/close) | — |
| 19 | store nextEvent (~1893) | input | — | — | — | event |
| 20 | store validateMergedTransition 1133; replay 683-717 | merged task/phase states | memory | task pending; phase active (v4); phase-accept edges accepted (mergedPhaseAcceptReady 1082); predecessors done & phases ready (1071); override_reason waives ONLY predecessor condition | refuse STORE_INCONSISTENT/invalid_start_transition (717, 1145) — one code, four causes | — |
| 21 | store 2086-2095 prospective replay + evidence verification | journal+new event | git blobs | history replays cleanly | refuse with replay's typed error | — |
| 22 | store 2118-2135 journal append via atomicWrite (1697) | event bytes | journal active segment (seal on overflow) | — | I/O error propagates; no rollback across 22-24 | journal seq+1 |
| 23 | store 2141 snapshotFor (867) + atomicWrite | plan, events, tasks | — | — | — | snapshot{through_sequence, journal_head_digest, tasks, snapshot_digest} |
| 24 | store ~2146 manifest rewrite | manifest | .lattice/todo/manifest.json | no digest compare (lock + step16 re-read protect) | crash between 22 and 24 → next read manifest_journal_head_mismatch | member.journal_head_digest, manifest_digest |
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

Current behavior and planned self-exit are distinct. These proposals do not claim
that recovery is already implemented.

| Protected state / current owner | Current failure | Proposed states and self-exit | Protection retained |
|---|---|---|---|
| Todo store write lock / withLock | Normal start uses recovery off; crash can leave EEXIST forever | free → owned → free; proven-dead owner → claim recovery → reopen/replay → owned → free | Live writer exclusion; inspect existing recovery claims/PID protocol before reuse. Never unlink another live owner's lock. |
| Note lock / note-store | Dead lock can remain | free → owned → free; dead owner → claim/replay note chain → owned | Append-only note integrity and sole writer. |
| Run lifecycle lock / runtime-lifecycle-lock | Torn owner record can stay busy | free → initializing → owned → free; abandoned initialization → identity-aware reclamation → owned | Do not reclaim a concurrent live initializer by age alone. |
| Adapter registry / runtime-adapter-registry | No PID recovery | free → owned → free; proven-dead owner → reclaim + reread registry → owned | Do not overwrite a live registry writer. |
| Setup lock / setup | Crash leaves setup locked | free → owned → free; proven-dead owner → reclaim + reread host entries → owned | Preserve unrelated host entries and exclude concurrent configuration writes. |
| Source-cutover/cross-plan recovery marker / Store | Marker currently rejects open in some paths | clean → prepared → applying → committed → clean; reopen completes a validated transaction or rolls back its recorded before-state → clean | Never discard marker or bytes without resolving the recorded operation. |
| Journal ahead of manifest/cache / appendTodoEvent | Crash at steps 22–24 yields manifest_journal_head_mismatch | clean → appended → projected → manifest-published → clean; reopen validates the append and finishes publication → clean | A digest mismatch of unknown origin is not permission to accept arbitrary data. Implement under recorded transaction ownership; no on-disk format change without separate design. |
| Runtime conflict hold / supervisor and pull-intake | Intentional scoped pause | running → conflict-held → conflict resolved → recompile/rebind when needed → running | Keep real overlap detection, process identity, scoped barriers and evidence checks. |

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
