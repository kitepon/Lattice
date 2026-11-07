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
| TODO plan revision and migration | Plan validates desired revision; Store alone publishes it | Runtime supplies `validatePhaseRevision` / `commitPhaseRevision` callbacks with the existing actor record; it does not edit journal/manifest bytes. |
| Run/adapter exclusion locks | Runtime lock wrapper; shared lock/OS observation is infrastructure | No lock grants task readiness or source-write authorization. Store's todo/note locks are outside this scope. |
| CLI JSON and shipped bins | Runtime supplies command results; surface formats them | Keep `lattice`, `lattice-mcp`, `lattice-scripted-adapter`, `lattice-work-order-adapter` and current result schemas. |

## Observed flow and claim-preservation contract

The numbered rows are the runtime data-flow diagram. Claims 7–10 refer to the
owner-supplied excerpt of JP 2026-178950, received 2026-11-07; this is an
engineering trace, with no legal conclusion. Snow White owns the product-wide
claim map. Evidence below names source paths, not newly passed tests.

| ID / owner | Input and read | Decision / output | Persistence and failure / exit |
|---|---|---|---|
| R1 Observe / Runtime | Actual worktree, base SHA, task manifests and current attempt bindings; `captureWorktreeDiff`, `detectCheckpointFindings`, `classifyObservedDiff` | Checkpoint with changed resources, HEAD and digest; compare actual range with predicted own range and other running tasks' ranges **[9]** | Include committed `base..HEAD`, tracked modifications and untracked non-ignored files. A descendant commit is allowed; reset/branch/rebase outside base ancestry is rejected. Worker self-report does not replace observation. |
| R2 Classify / Runtime | R1 checkpoint and current relevant tasks | Own-range excess is recorded as `undeclared_write`; overlap with another task becomes a pair finding. Resource/state/effect/line witnesses can also produce findings. **[9]** | A lone prediction excess remains observed evidence and input to the next compile. Managed `conflict` requires two tasks before freeze; pull intake similarly separates own-scope growth from blocking findings (ADR 0158). Do not turn detection of an excess into an irreversible single-task hold. |
| R3 Bind finding and freeze intake / Runtime | Valid finding bound to current run/epoch | Persist `conflict_found` and `intake_frozen` with frozen prefix. Select affected closure from finding task IDs, plan and manifests. **[7,8,10]** | `run conflict` / daemon control validates finding digest and epoch. New dispatch pauses; unrelated running attempts keep their binding and writes. Stale finding does not authorize a new stop. |
| R4 Quiesce selected attempts / Runtime supervisor + controllers | R3 closure, controller registration, packet/lease and frozen event digest | `holdConflict` → `barrierSelected`; direct process observation plus quiescence acknowledgements; append final checkpoints, `hold_decided` and carry witnesses. **[7,8,10]** | Hold receipt is emitted only after requested quiescence. Closure-external running work continues only with witnessed carry-over; unproved carry goes to hold. Restart/startup/shutdown and unreconstructable process recovery retain their explicit whole-run barrier. |
| R5a Serial treatment / operating AI + Runtime | R4 finding, `intentional_serial` treatment, selected winner/loser and current source | Keep the losing work stopped; authorize the selected other work under serialized conflicts; that worker commits its source change to Git. Observe the committed HEAD/checkpoint and resolve the overlap before resuming the stopped work. **[7]** | `routeConflictTreatment`, runtime serial resource binding and ready-frontier/receipt decisions supply the execution control. Git commit is the worker/host's action. Its SHA/checkpoint is the source evidence; epoch/gate publication is not that evidence. Existing fixtures must be extended if they do not demonstrate this complete ordering. |
| R5b Limited seam treatment / seam service, invoked by Runtime | R4 finding, AI-authored concern symbols/path names, task migration and treatment | Stop the related pair; `resolveRuntimeSeam` → `applySeamConflict` → isolated transformation, behavior verification and `commitSeamTransform`; re-observe the transformed source. Limit transformation to elements needed to remove the conflict. **[8]** | Bound accepted transformation and successor base must contain the real change. `verifySeamSplitSuccessor` checks ownership/edge deltas and transformed source, not declarations alone. Failed verification leaves the affected work held for corrected treatment; it is not reported as resumed. |
| R6 Compile affected successor / Runtime consumes Plan + seam public services | Frozen prefix, hold decision, R5 treatment, successor request/base, accepted checkpoints and task migration | Fresh compile; new plan reference/epoch and packets for affected successor work; invalidate held contexts/partial patches/boundary evidence. Continue-set retains origin context/packet/process. **[8,10]** | `recompileNextEpochPlan` calculates invalidation/diff; daemon validates the fresh compiled successor, treatment and migration before staging. Whole plan envelope/version may be republished; only the affected work is stopped/replanned/redispatched. |
| R7 Stage / Runtime with Plan callback | R6 validated bundle, revision, queue prefix and transaction identity | `stageSuccessorEpoch`; bound pending transaction; publish receipt-bound recompile event batch | Events cannot claim activation yet. Plan callback owns lifecycle validation and Store publication. Replayed event batches must match their saved base prefix and transaction, not create a second branch. |
| R8 Commit epoch / Runtime | All required successor controller prepare/rebind acknowledgements and validated stage | `commitStagedSuccessorEpoch` publishes successor pointer; controllers observe pointer and return ready acknowledgements | Staged lease is write-disabled. Pointer publication alone cannot resume writes. Persist `epoch-activation-transaction.json` at prepared/pointer-committed boundaries. |
| R9 Commit write authorization / Runtime supervisor | R8 pointer, activation digest, registrations, all ready/release acknowledgements | Persist release barrier, arm staged leases, independently verify all release evidence, atomically commit central gate + control events | `commitWriteGate` is the write-authorization point. Before it, no staged worker may write. Bound recovery completes the same transaction rather than accepting partial release. |
| R10 Resume and accept / Runtime | R9 gate evidence, plan diff and attempt-bound receipt | Append run `intake_resumed`; dispatch affected successor packets; accept source results against their authorized attempt. **[7,8,10]** | Unrelated running attempts keep origin binding; their valid origin receipts can be accepted in a later epoch. Invalidated affected attempts cannot submit stale results. `run resume` reads/project status and does not reauthorize managed writes. |

### Claim paths and source-commit obligation

| Excerpt requirement | Named path in the DFD | Required before/after observation for a later code change |
|---|---|---|
| 7: detect pair conflict → stop one → other commits to VCS → resolve → restart one | R1–R4 → R5a → R6–R10 | Losing attempt stays stopped while the winner produces a real Git commit; recorded checkpoint identifies that commit; losing attempt starts only after resolution. The common hold protocol may first quiesce the affected pair, then serialize it. |
| 8: stop both → refactor only necessary source elements → resolve → restart both | R1–R4 → R5b → R6–R10 | Both affected bindings stop, changed elements and behavior comparison belong to the accepted transformation, successor base contains it, both successors resume. |
| 9: actual resource range exceeds own predicted impact OR overlaps another running impact | R1 → R2 | Both forms remain observable. Excess alone is recorded and reconciled, actual overlap follows the hold path. Keep unknown witnesses explicit. |
| 10: identify affected task group → stop only that group → new plan for group | R3 → R4 → R6 → R10 | Unrelated worker process/context/origin packet stays the same, progresses during treatment and can submit its bound receipt. Global plan numbering does not widen the stopped group. |

R5a describes the device-level worker obligation. The baseline does not contain
a Runtime-owned Git-commit command or prove, merely from `receipt_accepted`, that
all source bytes are committed. This diagram must not be used as evidence that
the complete claim-7 ordering was tested. An actual source-commit/held-worker
trace is required with any change to that path; the lock/service refactor must
not silently remove the existing ability to commit and observe `base..HEAD`.

### Run state transitions

| State | Named protection and transition | Self-exit / next action |
|---|---|---|
| Running | Observed pair conflict protects concurrent source/state writes: R1–R3 → frozen intake | Selected hold and R5 treatment; unrelated running work continues. |
| Affected attempts held | Prevent conflicting writes and stale result acceptance: R4 → serial R5a or limited refactor R5b | Corrected treatment + freshly compiled affected successor, R6. No request to remove the conflict check. |
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

## Proposed lock recovery state transitions

This target table is the contract for later implementation, not a completed
repair. Use existing shared identified-lock infrastructure where its public
interface fits; keep Runtime's operation/error mapping in Runtime. Store owns
its helper and todo/note integrations. A helper API change needs Store agreement.
Do not rewrite Store files while implementing Runtime callers.

| State / protected asset | Observation and action | Transition / self-exit |
|---|---|---|
| Free | Observe this process's PID, process-start identity and OS host/PID domain | Prepare a complete private record; no shared lock is owned yet. Identity observation failure publishes nothing; restored observer allows retry. |
| Preparing | Sync complete owner record before exclusive atomic publication; initializing identity also names any temporary/recovery claim | Publish once → owned. A crash leaves only an identified temporary; next acquirer proves that owner dead and removes it. No empty shared-lock window. |
| Owned, live local owner | Same start identity is observed, including the initializer/recovery claimant | Preserve owner and return existing busy code or existing bounded wait. Owner releases → free; owner death → recoverable. Never reclaim by elapsed time. |
| Owner observation unavailable | Observer fails/returns absent while the PID exists, or identity/domain cannot be established | Preserve bytes, return typed busy/invalid reason. A retry observes again; successful owner release exits normally. Observation failure is not proof of death. |
| Recoverable, proven-dead local owner | PID absent or complete process-start identity differs; exclusive identified recovery claim, then reread exact lock identity before any removal | Reclaim only that owner → free → fresh acquisition and state reread. A live replacement stays intact; multiple live recovery claimants preserve each other and exit busy, then a sole retry can recover. |
| Recovery claimant died | Claim name/record identifies its PID/start/domain even before claim body initialization | Next contender proves the claimant dead, removes only its claim and retries. Recovery never creates a second anonymous permanent lock. |
| Releasing own lock | Re-read owner identity/digest; remove only matching ownership | Matching owner → free. A missing lock counts as already released; another owner is preserved and reported through the Runtime wrapper's existing ownership contract. |
| Legacy empty/PID-only/torn owner | Cannot prove a specific dead owner; protect concurrent state from overwrite | Keep bytes; typed reason and exact path/next action. Operator confirms no writer before clearing legacy state. All newly published locks avoid this legacy state; do not turn age into proof. |
| Foreign domain | Local OS cannot identify another host/namespace's owner | Preserve bytes and name recorded domain/path. Release on that domain, or operator confirmation there permits clearing only the abandoned artifact. |
| Atomic publication unavailable | Filesystem cannot publish a complete ownership record atomically | Publish no empty substitute. Existing wrapper error plus path/cause; retry on a supported filesystem exits this state. |

The protected asset is exclusive mutation of a named run/registry/start binding.
Reacquiring a dead lock is not sufficient to resume a worker: reread the run and
complete R7–R10 from authoritative transaction evidence first. Public Runtime
lock result/artifact compatibility must be decided before replacing its v1
envelope with a shared helper's internal owner record; no implicit schema swap.

## Proposed supervisor service boundary

Current cycle: `runtime-cli → runtime-managed-supervisor → (daemon bootstrap
dynamic import) runtime-cli.runManagedSupervisorDaemon`; lifecycle lock's default
observer also imports the supervisor. The daemon bootstrap currently wires Plan
validation and Store commit callbacks.

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
