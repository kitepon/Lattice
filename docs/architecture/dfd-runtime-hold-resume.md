# Runtime: hold, commit, recompile and resume

Owner: Lattice Runtime. Read with the [function map](function-map.md) and
[manual start flow](dfd-todo-start.md). Baseline source:
`5bb40eba2988695ea7b7e91bc83632a7803c5801` (0.79.5).
This document records current connections and the proposed recovery/service
boundary for t11. It changes no code. Target rows are not implementation evidence.

## Public contract and state ownership

The device includes the operating AI. Workers/host perform source edits and Git
commits; Runtime observes, binds, stops and authorizes execution. A runtime epoch
pointer commit, a central write-gate commit, a TODO done event and a source Git
commit are four different operations. None substitutes for another.

| State or interface | Sole writer / decision owner | Consumers and exclusion |
|---|---|---|
| Run requests, executor packets, findings, run event chain and epoch bundles under `.lattice/runs/<id>/` | Runtime: front-end/engine, diff observer, multi-epoch store and daemon orchestration | Controllers and CLI consume bound values. TODO Store format and Plan lifecycle meaning stay with their owners. |
| Control events, controller registrations, process/attempt bindings, staged/armed leases and central write gate | Runtime supervisor through control/gate stores | A controller acknowledges its own process state; supervisor independently observes it before granting writes. CLI projections grant no lease. |
| Source commits and accepted transform artifact | Operating AI/worker through Git; seam service performs verified isolated transformation and its commit | Runtime consumes actual tree, checkpoint HEAD and bound transformation result. Runtime does not synthesize source changes or replace a commit with an acknowledgement. |
| TODO plan revision and migration | Plan's `validatePhaseTodoRevision` validates; Store's `applyPhaseTodoRevision` / `createTodoStoreWriter` publish | Daemon bootstrap (composition root) imports those functions and injects `validatePhaseRevision` / `commitPhaseRevision` into `runManagedSupervisorDaemon`. Runtime invokes them with the existing actor record; it does not supply the implementations or edit journal/manifest bytes. |
| Run/adapter exclusion locks | Runtime lock wrapper; shared lock/OS observation is infrastructure | No lock grants task readiness or source-write authorization. Store's todo/note locks are outside this scope. |
| Runtime start-binding exclusion inside Store tree | Runtime owns the meaning of `.lattice/todo/.start-binding.lock` and its transient recovery state | Snow White ruling: retain this exact path in this version, so old/new binaries cannot acquire independent locks. Store owns durable Git path selection and any exclusion correction; retaining the path does not repair the current selection defect below. |
| CLI JSON and shipped bins | Runtime supplies command results; surface formats them | Keep `lattice`, `lattice-mcp`, `lattice-scripted-adapter`, `lattice-work-order-adapter` and current result schemas. |

## Current managed flow and claim-preservation contract

The numbered rows are the runtime data-flow diagram. Claims 7–10 refer to the
owner-supplied excerpt of JP 2026-178950, received 2026-11-07; this is an
engineering trace, with no legal conclusion. Snow White owns the product-wide
claim map. Evidence below names source paths, not newly passed tests.

| ID / owner | Input and read | Decision / output | Persistence and failure / exit |
|---|---|---|---|
| R1 Observe / Runtime | Actual worktree, base SHA, task manifests and current attempt bindings; `captureWorktreeDiff`, `detectCheckpointFindings`, `classifyObservedDiff` | Checkpoint with changed resources, HEAD and digest; compare actual range with predicted own range and other running tasks' ranges **[9]** | Include committed `base..HEAD`, tracked modifications and untracked non-ignored files. A descendant commit is allowed; reset/branch/rebase outside base ancestry is rejected. Worker self-report does not replace observation. |
| R2 Current classification / Runtime | R1 checkpoint and current relevant tasks | Own-range excess is recorded as `undeclared_write` / `prediction_excess`; overlap with another task becomes a pair finding. Resource/state/effect/line witnesses can also produce findings. | Current managed `conflict` rejects fewer than two tasks with `FINDING_NOT_A_CONFLICT`. Single excess is recorded without the singleton hold/replan path. This current behavior does not meet the claim-9/10 target below (Snow White ruling, 2026-11-07). |
| R3 Bind finding and freeze intake / Runtime | Valid finding bound to current run/epoch | Persist `conflict_found` and `intake_frozen` with frozen prefix. Select affected closure from finding task IDs, plan and manifests. **[7,8,10]** | `run conflict` / daemon control validates finding digest and epoch. New dispatch pauses; unrelated running attempts keep their binding and writes. Stale finding does not authorize a new stop. |
| R4 Quiesce selected attempts / Runtime supervisor + controllers | R3 closure, controller registration, packet/lease and frozen event digest | `holdConflict` → `barrierSelected`; direct process observation plus quiescence acknowledgements; append final checkpoints, `hold_decided` and carry witnesses. **[7,8,10]** | Hold receipt is emitted only after requested quiescence. Closure-external running work continues only with witnessed carry-over; unproved carry goes to hold. Restart/startup/shutdown and unreconstructable process recovery retain their explicit whole-run barrier. |
| R5a Current serial treatment / operating AI + Runtime | R4 finding, `intentional_serial` treatment and current source | `routeConflictTreatment`, serial resource/finding binding and frontier decisions select serialized execution. Current resume uses complete prepare/rebind acknowledgements and central gate commit. | Current `finalizeRecompileActivation` / `isActiveSupervisorGateCommitted` do not require observing the winner's source Git commit before resuming the stopped work. Finding/epoch checks are not source-commit evidence. This is an implementation gap against target R5aT **[7]**, not verified claim-7 completion. |
| R5b Limited seam treatment / seam service, invoked by Runtime | R4 finding, AI-authored concern symbols/path names, task migration and treatment | Stop the related pair; `resolveRuntimeSeam` → `applySeamConflict` → isolated transformation, behavior verification and `commitSeamTransform`; re-observe the transformed source. Limit transformation to elements needed to remove the conflict. **[8]** | Bound accepted transformation and successor base must contain the real change. `verifySeamSplitSuccessor` checks ownership/edge deltas and transformed source, not declarations alone. Failed verification leaves the affected work held for corrected treatment; it is not reported as resumed. |
| R6 Compile affected successor / Runtime consumes Plan + seam public services | Frozen prefix, hold decision, R5 treatment, successor request/base, accepted checkpoints and task migration | Fresh compile; new plan reference/epoch and packets for affected successor work; invalidate held contexts/partial patches/boundary evidence. Continue-set retains origin context/packet/process. **[8,10]** | `recompileNextEpochPlan` calculates invalidation/diff; daemon validates the fresh compiled successor, treatment and migration before staging. Whole plan envelope/version may be republished; only the affected work is stopped/replanned/redispatched. |
| R7 Stage / Runtime with injected Plan/Store callbacks | R6 validated bundle, revision, queue prefix and transaction identity | `stageSuccessorEpoch`; bound pending transaction; publish receipt-bound recompile event batch | Events cannot claim activation yet. Injected `validatePhaseRevision` calls Plan's `validatePhaseTodoRevision`; injected `commitPhaseRevision` calls Store's `applyPhaseTodoRevision` with `createTodoStoreWriter`. Bootstrap supplies both; Runtime invokes them. Replayed event batches match their saved base prefix and transaction. |
| R8 Commit epoch / Runtime | All required successor controller prepare/rebind acknowledgements and validated stage | `commitStagedSuccessorEpoch` publishes successor pointer; controllers observe pointer and return ready acknowledgements | Staged lease is write-disabled. Pointer publication alone cannot resume writes. Persist `epoch-activation-transaction.json` at prepared/pointer-committed boundaries. |
| R9 Commit write authorization / Runtime supervisor | R8 pointer, activation digest, registrations, all ready/release acknowledgements | Persist release barrier, arm staged leases, independently verify all release evidence, atomically commit central gate + control events | `commitWriteGate` is the write-authorization point. Before it, no staged worker may write. Bound recovery completes the same transaction rather than accepting partial release. |
| R10 Resume and accept / Runtime | R9 gate evidence, plan diff and attempt-bound receipt | Append run `intake_resumed`; dispatch affected successor packets; accept source results against their authorized attempt. **[7,8,10]** | Unrelated running attempts keep origin binding; their valid origin receipts can be accepted in a later epoch. Invalidated affected attempts cannot submit stale results. `run resume` reads/project status and does not reauthorize managed writes. |

### Required target paths: t12 implementation handoff

Snow White's technical ruling (2026-11-07) requires these changes in
`t12-runtime-recovery`. This is an implementation obligation, not a description
of working baseline behavior or a legal conclusion.

| Target ID | Input / detection | Stop, transformation and replan | Gate / exit and claim element |
|---|---|---|---|
| R2T **[9: detection, both alternatives]** | R1 actual range exceeds the task's impact range **OR** overlaps another running task's impact range | Both are named runtime-conflict detections. Keep actual resource ranges and task/attempt bindings in the finding. A singleton excess is not rejected for lacking a second task. | Route singleton excess to R3T/R6T; route actual pair conflict to R4/R5aT or R5b. Explicitly replaces current R2's record-only/pair-required split. |
| R3T **[10: group of one or more]** | R2T singleton finding for task A, actual resources and current attempt | Target group is `{A}`. Stop only A and observe its final checkpoint. The existing run-level intake freeze temporarily delays new dispatch; it stops no unrelated running attempt, whose origin binding and writes continue. | Enter R6T. Do not use claim-7/8 pair treatments or invent another task. If subsequent observation discovers a real overlap, identify its actual affected group and use the pair path. |
| R6T **[10: new plan for that group]** | R3T singleton checkpoint, revised task scope/work specification and observed excess resources | Generate a fresh plan for A and reconcile its manifest/context against the actual source; invalidate and redispatch only A. Use a dedicated singleton scope-reconciliation treatment contract, not an `intentional_serial`/`seam_split` request which requires two tasks. | Bound successor staging, pointer/gate commit and attempt-bound resume use R7–R10. Update the versioned treatment/request schema with this path in t12; do not silently add a mode to an old exact schema. |
| R5aT **[7: stop → source commit → resolve → resume]** | Pair finding and selected loser A / winner B; source checkpoint and origin attempt bindings | Keep A stopped while B completes and commits its change to Git. Observe B's changed HEAD, its descendant relation and committed checkpoint against B's origin packet/worktree. Re-observe/reconcile the shared resource and generate the resolved affected successor. | The serial treatment must bind the observed committed checkpoint/HEAD, and Runtime must validate that evidence before authorizing A. Prepare/rebind acknowledgement plus gate commit cannot bypass this source-commit-and-resolution gate. Source commit remains the operating AI/worker's action. |
| R5bT **[8: stop both → limited refactor → resume both]** | Pair finding whose conflict can be removed by a bounded seam transformation | R4 stops the related pair; R5b transforms only required source elements, verifies behavior and commits the real transform; R6 regenerates affected tasks. | R7–R10 require the accepted transformation in successor base before both affected successors resume. Preserve the baseline limited-transform path while repairing its connections. |

R5aT's winner must be able to commit while the loser remains stopped. If the
existing common barrier first quiesces both, only the winner may be reauthorized
for that step; a shared gate must not accidentally release the loser. Commit
observation must cover the source change being accepted, not merely an unrelated
HEAD advance. t12 must demonstrate the complete ordering with a real Git commit.

These are public behavior changes in t12: managed `conflict` narrows the existing
`FINDING_NOT_A_CONFLICT` refusal by accepting singleton excess, so its release
notes must name that change. Redirecting pull `acceptFindings` / `ownScopeGrowth`
from record-only acceptance to R3T/R6T changes the relevant part of
[ADR 0158](../adr/0158-planned-boundaries-are-predictions-and-runtime-recovery-is-target-scoped.md).
t12 must ship an ADR 0158 addendum with the new behavior; preserve the historical
decision and identify which rule is superseded.

### Claim paths and source-commit obligation

| Excerpt requirement | Named path in the DFD | Required before/after observation for a later code change |
|---|---|---|
| 7: detect pair conflict → stop one → other commits to VCS → resolve → restart one | Current R5a lacks the source-commit gate; target R1/R2T → R4 → R5aT → R6–R10 | t12 must add commit-observation-and-resolution before loser resume. Complete prepare/rebind + gate evidence alone does not satisfy this target. |
| 8: stop both → refactor only necessary source elements → resolve → restart both | R1–R4 → R5b → R6–R10 | Both affected bindings stop, changed elements and behavior comparison belong to the accepted transformation, successor base contains it, both successors resume. |
| 9: actual range exceeds own impact OR overlaps another running impact; excerpt: 「実行時競合を検出する」 | Current R1/R2 differs; target R1 → R2T | Snow White rules both alternatives are runtime-conflict detection. Record-only singleton excess with a pair-required refusal is not the target. This ruling changes no code in t11. |
| 10: affected group consists of 「一以上の作業」; stop only that group and generate its new plan | Pair: R3/R4/R6/R10; singleton target: R3T/R6T/R7–R10 | Group `{A}` is allowed and required for singleton excess. Unrelated process/context/origin packet stays unchanged and its receipt remains acceptable. Global numbering does not widen the stopped group. |

R5a records the current gap; R5aT is a required implementation change. The
baseline does not contain a Runtime-owned Git-commit command, a source-commit
resume gate or a fixture demonstrating the complete claim-7 ordering. Existing
`receipt_accepted` alone does not prove all source bytes are committed. Preserve
the ability to commit and observe `base..HEAD`, then add the explicit gate and
the real source-commit/held-worker trace in t12.

### Run state transitions

| State | Named protection and transition | Self-exit / next action |
|---|---|---|
| Running | Observed pair conflict protects concurrent source/state writes: R1–R3 → frozen intake | Selected hold and R5 treatment; unrelated running work continues. |
| Affected attempts held | Prevent conflicting writes and stale result acceptance: R4 → serial R5a or limited refactor R5b | Corrected treatment + freshly compiled affected successor, R6. No request to remove the conflict check. |
| Singleton excess held (target) | R2T/R3T detects own-range excess **[9]** and stops only `{A}` **[10]** | R6T generates a new plan for A; R7–R10 resume A after matching source/plan/attempt evidence. Other running tasks continue. |
| Serial loser held (target) | A remains stopped while B commits its source change **[7]** | R5aT verifies B's committed checkpoint and conflict resolution before A's write gate can open. |
| Replanning non-convergent | Current `detectNonConvergentConflicts` / `NON_CONVERGENT_EPOCH_THRESHOLD=3` throws when the same conflict recurs across three epochs | Return the typed failure with the repeated finding/group; operating AI changes the treatment, then reprocesses/recompiles. Do not retry the identical treatment indefinitely or widen the group. |
| Successor staged | Prevent premature source writes and mismatched plan results: R7 → R8 | Complete matching controller prepare/rebind evidence; saved stage resumes after interruption. |
| Pointer committed, gate disabled | Prevent partial-controller activation: R8 → R9 | Gather bound ready/release evidence and commit the same gate; recover from activation transaction and event receipts. |
| Gate committed | R9 → R10 | Publish missing run resume evidence idempotently and redispatch affected successors. |
| Treatment/recovery evidence incomplete | Protect known source/attempt/transaction binding; retain bytes and typed reason | Correct the named treatment/evidence or restore recorded input, then `run reprocess` / bound control replay. No age-based release or fabricated success. |

## Lock inventory: current implementation

| Lock / callers | Current ownership publication | Current recovery / limitation |
|---|---|---|
| `<run>/.lifecycle.lock`: managed daemon operations and activation | `acquireRuntimeLifecycleLock`: exclusive create, then canonical v1 owner record with PID/start identity, nonce digest, operation/request/time and lock digest | Complete dead/reused PID owner is reclaimed after identity observation. Empty/truncated initialization can remain `RUN_BUSY` or `RUN_LOCK_INVALID`; no identifying owner survives that window. |
| `<run>/.pull-intake.lock`, `.lattice/todo/.start-binding.lock`: pull mutations/start binding | Same lifecycle-lock implementation, explicit lock path | Same initialization limitation. Start-binding file protects Runtime's plan-start/attempt binding; it grants no ownership over TODO Store semantics. |
| `<run>/.cli-lifecycle.lock`: unmanaged/launch CLI path | `withLifecycleLock`: empty exclusive-create file | Normal finally unlinks; a killed process leaves no identity for automatic recovery. Existing error is `RUN_BUSY`. |
| `.lattice/runtime/adapter-registry/.registry.lock`: registry writer | Exclusive create, then PID line | Normal release removes; no process-start identity/dead-owner recovery. Existing error is `ADAPTER_REGISTRY_BUSY`. |
| Common Git directory `lattice-todo-store-commit.lock`: `todo-store-git-transaction.mjs:commitTodoStoreMutation` | Store calls Runtime's `acquireRuntimeLifecycleLock` with `lockPath/sessionNonceDigest/operation/requestId/timeoutMs`; it catches `RuntimeLifecycleLockError` and later awaits the returned `release()` | Store agrees in principle to unchanged arguments, awaited helper-finally completion and error code/string-detail compatibility. This explicit Git common-dir path stays fixed across worktrees. Runtime does not edit this Store caller. |

`.lattice/todo/.start-binding.lock` and old lifecycle recovery `.stale` files
currently match neither `.gitignore`'s `.write.lock*`/cross-plan entries nor
`todo-store-git-transaction`'s explicit exclusion pathspecs. That is a source
selection defect: Runtime transient state can enter a durable store commit.
The target must cover the lock, temporary and recovery paths together. This
version retains the old path (Snow White ruling); Store owns the separate Git
selection/ignore correction, coordinated by the supervisor. A future relocation
requires an explicitly approved fixed-order compatibility bridge: acquire old
then new, release new then old, with old-path transients still excluded by Store.
An old-path absence check cannot prevent split exclusion. Existing old-path
ownership exits only by release, identified dead-owner recovery or the legacy
manual-confirmation path; do not delete it as a migration step.

## Proposed lock recovery state transitions

This target table is the contract for later implementation, not a completed
repair. The selected proposal uses `store-lock.mjs:withStoreLock` unchanged:
exclusive atomically linked bytes have exactly `{pid, process_start, host}`.
Runtime adapts the callback lifetime to its existing acquire/`release()` handle
and error/wait contract: the helper callback holds a promise until Runtime's
`release()` resolves it, and `release()` awaits the helper's complete `finally`
cleanup. Process death leaves the identified owner for existing helper recovery.
Operation, request ID, acquired time and nonce stay in
the Runtime handle's v1 metadata, never in shared lock bytes. No new sidecar is
needed. Retain `validateRuntimeLifecycleLockArtifact` for that v1 metadata and
legacy reader compatibility; it no longer validates newly published lock bytes.
Remove Runtime's rename-to-`.stale` recovery implementation. Complete on-disk v1
artifacts, PID-only files and torn files are all unidentified to the new helper;
they follow the explicit legacy/manual-confirmation transition below. No silent
new-envelope validation by an old v1 validator is allowed.

**Agreed boundary (Store principles + Snow White ruling, 2026-11-07):** preserve
the Store caller's acquire arguments, explicit common-dir lock path,
`RuntimeLifecycleLockError` code/string `detail` and awaited `release()` contract, so
`commitTodoStoreMutation` needs no Store-file edit for this integration. The
wrapper retains bounded wait; no `StoreLockError` escapes. Shared helper remains
responsible for atomic ownership and dead-owner recovery, including its raw OS
identity/host/recovery-claim rules. Use the Store inode-release guarantee after
its PR39 integration in the supervisor's order; no Runtime implementation/test
result is implied by Store's agreement.
Runtime owns any wrapper adaptation; Store owns its helper and durable Git
selection. Do not change the helper API or Store caller unilaterally.

`releaseRuntimeLifecycleLock({lockPath, ownerDigest})` remains exported. Runtime
resolves the matching live acquire handle by canonical lock path and the v1
metadata digest, and verifies the captured shared owner bytes plus file identity
before asking the helper to release. A missing lock, missing/mismatched handle or
replaced owner/file yields `RUN_LOCK_OWNER_MISMATCH`, including when the helper
would otherwise silently preserve it. Unwind the callback/helper lifetime even
on that error, await its `finally`, preserve a replacement owner and report the
Runtime error. Successful handle `release()` remains idempotent; the exported
release function retains its missing-owner refusal. The metadata validator does
not parse the new shared lock bytes. t12 must test both entry points and their
error transport; helper cleanup must not turn a refused release into success.

| State / protected asset | Observation and action | Transition / self-exit |
|---|---|---|
| Free | Observe this process's PID, process-start identity and OS host/PID domain | Prepare a complete private record; no shared lock is owned yet. Identity observation failure publishes nothing; restored observer allows retry. |
| Preparing | Sync complete owner record before exclusive atomic publication; initializing identity also names any temporary/recovery claim | Publish once → owned. A crash leaves only an identified temporary; next acquirer proves that owner dead and removes it. No empty shared-lock window. |
| Owned, live local owner | Same start identity is observed, including the initializer/recovery claimant | Preserve owner and return existing busy code or existing bounded wait. Owner releases → free; owner death → recoverable. Never reclaim by elapsed time. |
| Owner observation unavailable | Observer fails/returns absent while the PID exists, or identity/domain cannot be established | Preserve bytes, return typed busy/invalid reason. A retry observes again; successful owner release exits normally. Observation failure is not proof of death. |
| Recoverable, proven-dead local owner | PID absent or complete process-start identity differs; exclusive identified recovery claim, then reread exact lock identity before any removal | Reclaim only that owner → free → fresh acquisition and state reread. A live replacement stays intact; multiple live recovery claimants preserve each other and exit busy, then a sole retry can recover. |
| Recovery claimant died | Claim name/record identifies its PID/start/domain even before claim body initialization | Next contender proves the claimant dead, removes only its claim and retries. Recovery never creates a second anonymous permanent lock. |
| Releasing own lock | Runtime checks live handle metadata digest and captured shared owner/file identity before delegating; helper cleanup is awaited | Matching owner → free. Missing/replaced ownership → `RUN_LOCK_OWNER_MISMATCH`, never silent success; preserve another owner. Only an already successful handle's repeated `release()` is idempotent. |
| Legacy v1/empty/PID-only/torn owner | New helper cannot prove a complete local identified owner; protect concurrent state from overwrite | Keep bytes with the existing typed conflict plus public `detail.reason=lock_owner_unidentified` and manual `next_action`. Preserve Runtime's code/string-detail API and project additive structured CLI detail at its boundary. Operator confirms no writer before clearing. No automatic format conversion or assignment of the current host to legacy bytes. |
| Foreign domain | Local OS cannot identify another host/namespace's owner | Preserve bytes and name recorded domain/path. Release on that domain, or operator confirmation there permits clearing only the abandoned artifact. |
| Atomic publication unavailable | Filesystem cannot publish a complete ownership record atomically | Publish no empty substitute. Existing wrapper error plus path/cause; retry on a supported filesystem exits this state. |

The protected asset is exclusive mutation of a named run/registry/start binding.
Reacquiring a dead lock is not sufficient to resume a worker: reread the run and
complete R7–R10 from authoritative transaction evidence first. Tests which
previously assumed v1 metadata was identical to on-disk lock bytes must instead
check the two explicit contracts and legacy behavior separately in t12.

## Pull execution mode

R1–R10 above describe the managed daemon path. Pull execution is another current
implementation of runtime observation/hold/resume, not an exemption from claims
7–10. Its state is not a managed write gate or an epoch-activation transaction.

| Pull step / current source | Current data and state transition | Target obligation / separate recovery |
|---|---|---|
| P1 `boundaryVerdict` / intake | Current Plan version, independence artifact and start binding → readiness/version-drift hold | A version-drift hold requires a fresh valid Plan/start binding. It is not evidence that a source conflict was resolved. Preserve this distinction. |
| P2 observation and `acceptPullTask` | Actual checkpoints + manifests → findings; blocking findings → `intervention_changed` with hold and attached worker `SIGSTOP` | Apply R2T's two detection alternatives. Singleton own-scope growth currently passes through `acceptFindings`; target singleton stop/replan is R3T/R6T, with group `{A}`. |
| P3 `remainingRuntimeConflictFindings` / acceptance | Accepted source task removes its related findings; empty remaining findings → intervention cleared and attached worker `SIGCONT` | Empty remaining findings alone must not bypass R5aT's committed-source/resolution evidence on a serial pair. Share the target decision contract with managed execution, retaining pull's own event/signal transport. |
| P4 resume observation | PID/start/worker binding and intervention changes are Runtime state | Keep process identity and own-origin receipt binding; t12 compares pull and managed behavior at the shared target contracts without pretending their durable state formats are identical. |

## Proposed supervisor service boundary

Current cycle: `runtime-cli → runtime-managed-supervisor → (daemon bootstrap
dynamic import) runtime-cli.runManagedSupervisorDaemon`; lifecycle lock's default
observer also imports the supervisor. The daemon bootstrap currently wires Plan
validation (`validatePhaseTodoRevision`) and Store commit
(`applyPhaseTodoRevision` / `createTodoStoreWriter`) callbacks.

Current upward connections which the service move must account for:

| Current import | Target direction / owner |
|---|---|
| Plan `todo-cli` → Runtime `runtime-pull-intake.withStartRetractionGuard` | Composition root supplies Runtime's atomic guard callback to the Plan retraction entry. Runtime holds its binding lock across `action`; a stale read-only fact cannot replace this atomic contract. Plan still owns whether its event is semantically valid. |
| `todo-independence` → `runtime-front-end` | Runtime passes observed/compiled facts through the public seam/Plan interface. Independence consumes those values, not Runtime state or a CLI implementation. |
| `todo-independence-contracts` → `runtime-contracts` | Keep the versioned pure value validators as an explicit public contract dependency; do not pull orchestration/daemon I/O through them. A neutral-contract extraction is a separate coordinated change, not an incidental service-move deletion. |
| Store `todo-store-git-transaction` → `runtime-lifecycle-lock` / `runtime-contracts.selfDigest` | Preserve the agreed Runtime lock wrapper, explicit Git common-dir path and pure digest contract for the Store caller. Store owns any later caller move. Runtime cannot change this caller's import by ownership inference. |
| `runtime-lifecycle-lock` → supervisor's `observeManagedProcessStartIdentity` | Target lock wrapper uses shared lock/platform infrastructure, which observes through `runtime-os-observation` only. Lock acquisition must not import the managed supervisor or CLI. |

Target: CLI and daemon bootstrap both call a Runtime orchestration service;
that service calls supervisor/controllers, event/epoch stores and pure runtime
decisions. Supervisor does not import CLI. The existing platform observer is
shared infrastructure. Bootstrap supplies Plan/Store callbacks once at the
composition root. Move the existing daemon behavior, callback signatures,
identity/error handling and recovery ordering together; introduce no host-specific
dependency or second orchestrator. Public bins and standalone execution remain.

## Verification boundary

For this documentation change: source/contract trace, local Markdown checks,
Leviathan's diagram review and exact-candidate CI. Normal Markdown-only CI runs
documentation checks and skips the product matrix. Where three-OS acceptance is
required, use the existing manual full-CI entry at the candidate commit; do not
describe a skipped matrix as three-OS evidence. This draft claims no runtime test
execution.

For the subsequent code change, select only touched rows:

- Lock states: `test/runtime-lifecycle-lock.test.mjs`, adapter registry and pull
  callers; crash during publication/claim/release, dead/reused/live PID, observer
  failure, replacement owner and concurrent recovery. Preserve typed errors.
- R1–R10: existing `test/runtime-hold-public-contract.test.mjs`,
  `test/rc3-hold-recompile.test.mjs`,
  `test/integration/hold-resume.integration.mjs`,
  `test/integration/hold-transform-resume.integration.mjs` and pull observation
  coverage as affected; include the real source-commit ordering for R5a.
- Service move: daemon launch/control, request replay and interrupted activation;
  compare events/results before and after with the same bound inputs. Do not
  replace independent producer/verifier checks with the same implementation.
- Fixture time limits describe the fixture's work and cleanup. A working long-lived
  worker remains observed by the durable supervisor; an arbitrary worker deadline
  must not become a controller fault. Use existing fixture process cleanup and
  prove no fixture-owned processes remain.

The code-change candidate additionally needs focused checks, exact-commit full
three-OS CI, diagrams in the same diff, closed diagram review and behavior
comparison for touched claim-bearing paths. A documentation CI result does not
prove execution or cross-platform daemon behavior.
