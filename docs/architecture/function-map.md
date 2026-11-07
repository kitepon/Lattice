# Function and ownership map

Baseline: 0.79.5, commit `047139e5`. This is the canonical implementation map;
[product contract](../00_product-contract.md) owns public behavior. The
[start data flow](dfd-todo-start.md) composes the lifecycle connections below.
The [receipt flow](dfd-mcp-startup-receipt.md) owns private MCP startup observation
and atomic publication through the existing storage helper.
The [authoring flow](dfd-plan-create.md) owns initial/additional plan creation,
status compatibility and input diagnostic pointer spaces.
The [runtime flow](dfd-runtime-hold-resume.md) owns hold/source-commit/limited
refactor/affected recompile/resume, claim-7–10 traces, Runtime lock recovery
transitions and the proposed supervisor service boundary. Current behavior and
proposed repair are marked separately there.
Snow White's 2026-11-07 technical ruling requires t12 to repair two current gaps:
claim 9 detects both own-range excess and overlap, and claim 10 stops/replans even
a singleton excess group; claim 7 requires observed source commit and resolution
before loser resume. These target rows are not claims of baseline conformance.
Directory moves are proposed boundaries, not claims that those directories exist.

Runtime activation publication: `runtime-multi-epoch-store` protects durable
membership of the selected run/control activation prefix, not equality with a
moving journal tail. See the [activation flow](dfd-todo-start.md#runtime-activation-publication).
Heartbeats may append after the selected control head; contradictory activation
transitions still reject publication. Runtime alone owns this correction.

## Product boundary

Lattice runs independently of BellTeam. Runtime execution management is required
in every host environment: agent launch alone does not supply actual-change
observation, conflict handling, scoped barriers or plan-version result acceptance.
Its CLI, bundled sensor, adapters,
supervisor, isolation, conflict observation and seam transformation remain product
features. BellTeam is one optional host. Its dispatch choices cannot retire
standalone capabilities. All four package bin names remain unchanged.

### Core product loop retained

The [product philosophy](../../PLAN.md), [public contract](../00_product-contract.md)
and [patent notice](../../README.md#patent) define the context. This map is an
implementation trace, not an interpretation of legal claim scope. Owner explicitly
required preserving the patent-pending product's axis on 2026-11-07 JST.

| Capability retained | Current implementation boundary | Preservation criterion |
|---|---|---|
| Optimize planned multi-agent development for net parallel benefit | Plan/boundary compilation and independence projection | Do not reduce the product to recording tasks or recommending changes. |
| Observe code boundaries, state/effect unknowns and actual overlapping changes | Bundled Sensor, independence, runtime supervisor/pull-intake | Static unknowns remain explicit; actual runtime conflict detection remains available in every environment. |
| Transform a conflicting seam in an isolated worktree and verify it | seam-derivation, seam-rewrite, seam-verification, seam-apply, isolation runner | Keep real transformations, acceptance conditions and behavior preservation. |
| Re-index, recompile affected tasks and invalidate old plans/contexts | Plan revision, runtime epochs/barriers and receipt validation | Preserve the complete transform → observe → new version → resumed execution loop. |
| Preserve provenance and authored execution order | Event journal, task/phase dependencies, versioned artifacts and evidence | Refactoring must not silently remove acceptance prerequisites or historical evidence. |

S2 removes predecessor research implementations only. A file being unreachable
does not by itself prove that every documentary/evidence reference is disposable;
preserve historical records and identify the live product replacement.

## Current modules and proposed boundaries

Authoring inputs, the seat command surface and the error shape follow the
[seat contract](seat-contract.md): the AI states judgements, the machine derives facts.

| Boundary | Current implementation / public interface | Owned state and writer | Callers / connections | Failure and unknown handling |
|---|---|---|---|---|
| Store | `todo-store.mjs`: phase_todo_revision.v5 reader/registration and public todoTaskCarrySemantics (unchanged pure projection in todo-store-view, re-exported by todo-store), see [phase revision flow](dfd-store-phase-revision.md); initial `initializeAuthoredTodoStore`; `appendAuthoredTodoPlan({repoRoot,writer,plan,genesis,featureChain?})` → fresh Store read and `isUninitializedTodoStore({repoRoot})` → read-only reserved-transient layout classification; shared membership staging/manifest-last publication and identity-checked empty-root recovery; authored directory publication classifies EPERM only after a real complete destination is observed (incomplete destinations remain typed conflicts with the original cause); ordinary mutations never create a missing Store root; `buildTodoPlan` forwards `{violation_kind, pointer, expected?, actual?}` mapped from common reason/path; see [authoring flow](dfd-plan-create.md); readTodoStore (public), readTodoStoreLocked (private), appendTodoEvent, marker recovery, activation/revision; `todo-note-store.mjs`, `todo-store-git-transaction.mjs`, `todo-store-cache.mjs`; `store-lock.mjs`: shared identified lock/recovery claims; `readTodoStore` returns canonical `member.tasks` and journal-derived `member.phases` for every member (ADR 0147); the locked `forWrite` view has snapshot phases equal to that projection. | `.lattice/todo/manifest.json`, `plans/<key>/<version>/{plan.json,journal/**,snapshot.json}`, recovery markers: todo-store under write lock; `notes/**`: note-store under note lock; staged store commits: git transaction; todo/note .write.lock, .write.lock.*.tmp, .write.lock.recovery/** and .cross-plan-recovery/** are host-local, never committed | CLI, status, plan/structure/independence, dashboard, runtime pull-intake; currently imports structure adapter and seam contracts upward | Identity/digest/event-chain checks protect recorded bytes; snapshot is derived and rebuilt under lock. Reopen rolls a validated journal ancestor forward to snapshot/manifest and resolves recorded recovery markers. Locks atomically publish complete PID + process-start + host ownership; default proven-dead recovery through identity-aware claims. Preserve live/foreign-host/unidentified owners; legacy empty/pid-only locks require operator confirmation before clearing. See DFD for transitions and error compatibility. Proposed: isolate read/append/CAS/lock without feature imports; caller supplies feature data. Existing event/store formats unchanged; the approved v5 revision sibling is registered. |
| Plan + lifecycle | `project-cli.mjs`, `todo-cli.mjs`, `todo-revision.mjs`, `todo-migration.mjs`, `plan-backchain.mjs`, `plan-scope-review.mjs`, `todo-status.mjs`; public plan/todo commands | Immutable plans and lifecycle events via Store; backchain.json is written only by todo-store activation/revision; plan-backchain validates and supplies its value; author owns input files | Surfaces call lifecycle; lifecycle calls Store; status reads Store; runtime consumes plan bindings | Keep dependency and phase-accept ordering. Unknown observational evidence is a separate concern. Actor binding will permit any actor, retaining event attribution and target digest binding. |
| Independence + seam | `todo-independence*.mjs`, `todo-witness-scaffold.mjs`, `boundary-observation-compiler-v2.mjs`, `schedulability-compiler-v2.mjs`, `schedulability-verifier-v2.mjs`, `seam-*.mjs`; public independence/seam commands | AI authors `witness/<key>.json`; todo-independence validates its contracts; todo-store persists version-bound artifacts. Independence compiler and seam operations write version-bound artifacts via Store; isolation runner owns disposable worktrees | Lifecycle consumes advisory projection; compiler consumes bundled sensor; seam transforms feed plan revision; currently independence also imports runtime-front-end | Missing/stale/unknown observations remain visible. Current start refusals are listed in DFD; proposed advisory conversion must preserve explicit unknowns. Real transformation still verifies behavior and records accepted artifacts. |
| Structure | `todo-structure*.mjs`; structure commands and lifecycle context | AI authors structure inputs; writeTodoStructureSource in todo-store validates and persists canonical source; structure compiler validates/produces values, todo-store alone writes version bindings and realization/finalization artifacts | Lifecycle and phase decisions consume structure; adapter consumes Git and bundled sensor | Source inconsistency currently both projects unreadable context and refuses mutation. Separate observation staleness from required acceptance evidence before any behavior change. |
| Runtime (Tove; claims 7–10) | `runtime-cli.mjs`, `runtime-front-end.mjs`, `runtime-*.mjs`; `run` commands, shipped adapters, managed daemon and versioned request/packet/receipt/results. [Runtime DFD](dfd-runtime-hold-resume.md) is the canonical public connection/lock contract | `.lattice/runs/<id>/**`: Runtime event/epoch/control/gate stores and supervisor/controllers; `.lattice/runtime/adapter-registry`: registry. Runtime owns lifecycle/pull/CLI/registry locks and `.lattice/todo/.start-binding.lock` for attempt binding | Plan supplies revision validation; Store publishes lifecycle revisions through callbacks; seam service supplies verified isolated source transformation. Operating AI/worker performs source Git commits; Runtime observes committed HEAD and actual changes | Keep standalone dispatch, real conflict detection, scoped holds and attempt-bound receipt verification. Source commit, epoch commit and write-gate commit are distinct. Proposed identified lock recovery and service extraction remove permanent initialization stalls and supervisor→CLI cycle; t11 changes no code. |
| Surfaces | `bin/lattice.mjs`, `todo-cli.mjs`, `runtime-cli.mjs`, `project-cli.mjs`; dashboard/gantt, bridge/hub, hooks/setup | CLI stdout/stderr are projections; evidence files via todo CLI; presentation JSON via presentation module | Hosts and external clients call versioned CLI; Peertable additionally imports `src/todo-contracts.mjs` (keep compatibility shim when moved) | Preserve command names and result schemas. Current dashboard bin imports todo-cli for rendering; proposed render-only interface. Exit-code changes require explicit contract/release notes. |
| Seat identity | `seat-identity.mjs`: `resolveSeatIdentity(env)` → `{seat_id, state_dir}`; `seatIdentityFields(env)` → `{seat_id}` or `{}` | No state; derives from `LATTICE_SEAT_ID` / `LATTICE_CONFIG_DIR` | bridge-config root (terminal identity and default actor host become per-seat); `status --json` / `session-context --json` top-level `seat_id` and default actor `agent` (Plan, `mutationActor`); dashboard/receipt state dirs | Invalid or unset id → `seat_id: null`, state at `~/.lattice`; never refuses |
| Dashboard + network | `todo-dashboard-*.mjs`, `todo-gantt*.mjs`, `dashboard-supervisor.mjs`, `bridge-*.mjs`; OS persistence adapters share one contract (`snapshot`/`describe`/`install`/`disable`/`restore`) and are selected by `process.platform` in `bridge-cli.mjs` (`platformLaunchAgent`): macOS `bridge-launch-agent.mjs`, Windows `bridge-startup-folder.mjs`, Linux and any other OS `bridge-detached-supervisor.mjs`; flow in [dfd-bridge-persistence.md](dfd-bridge-persistence.md) | `~/.lattice/dashboard/**`: dashboard registry/daemon; `<seat root>/bridge.json`: bridge config; hub terminal registry: hub server; OS persistence entry, written only by the platform adapter during bridge setup/reconfigure: macOS LaunchAgent plist; Windows Startup launcher + supervisor descriptor; Linux supervisor descriptor + pidfile under `<seat root>/bridge-linux/` | CLI/status autostart; `dashboard ensure` delivery recovery reads the adapter's snapshot/describe before verifying hub delivery; hub viewers and optional bridge | Dashboard delivery failure does not reject lifecycle writes. Registry and authenticated process ownership prevent wrong-process signaling. Persistence probing never runs another OS's tool (no launchctl off macOS); an unreadable entry degrades to `unreadable` in diagnostics, not a stop. Linux has no login/boot entry: the supervisor restarts a crashed bridge, and the seat's setup re-runs `bridge reconfigure` after a container restart. |
| Setup + hooks | `setup-cli.mjs`, `setup-hosts.mjs`, `hooks-cli.mjs`, host helpers | Host MCP/hook entries: setup/hooks; private hook state: hook handler | Standalone hosts, optional Aiterm/BellTeam registration | Preserve unrelated host entries and positions. Agree shared Codex approval ownership with Aiterm; standalone operation remains supported. |
| Sensor | `sensor/` package, `sensor-cli.mjs`, sensor query/runtime bridge, `bin/lattice-mcp.mjs` | `.lattice/sensor/**`: bundled sensor only; MCP startup receipts: receipt module | Independence, structure and isolation validation consume sensor observations | Bundled distribution only; typed missing/index/version errors and explicit unknown provenance. Unchanged in this refactor. |
| Error reporting + infrastructure | `runtime-errors*.mjs`, `cli-stdio.mjs`, terminal/project identity, node/runtime helpers | XDG config/state error files: reporting modules; project identity: project setup; terminal identity: terminal module | All public surfaces | Opt-in reporting; preserve secret redaction and wrong-target/runtime compatibility checks. |
| Retired research | 33 source modules explicitly declared by `scripts/verify-product-reachability.mjs` at baseline; RC1–RC4 compilers/campaigns and experimental executors | No active product state; historical experiments remain in Git history and RAG/ADR records | No import path from product bins; historical tests and witness-generation path strings only | S2 removes these source modules and their exclusive tests, removes stale allowlists and obsolete generation references. Live compilers, seam transforms, adapters, runtime and sensor are retained. |

## Function ownership in shared source files

Ownership is by responsibility/function while files are still mixed. A shared
filename is not permission for two boundaries to own the same function or state.
The later split moves functions to their owner without changing the contract.

| Current functions / service | Single owner | Consumers |
|---|---|---|
| todo-cli: startTask, mutate, startAdvisory, startStructureContext, mutationActor | Plan/lifecycle | CLI dispatch and runtime callers via plan public index |
| project-cli: `runPlanCreate`, `resolveProjectState`, `validateProjectStatus`; plan-backchain: existing additional-plan branch | Plan/lifecycle | Create/backchain call the Store authored API with a g5 writer and select the requested plan_key; status/session use Store's read-only layout classifier. See the [authoring flow](dfd-plan-create.md). |
| project-cli: create-input diagnosis; todo-contracts: `validateTodoPlan`, `explainTodoPlan`, shared strict-order diagnosis | Plan/lifecycle; no direct persistence | Create and migration retain existing error codes, report pointer/rule, and distinguish extraction input from derived-plan pointer space in the [authoring flow](dfd-plan-create.md). |
| todo-cli: runTodoCli, flag matching, typedFailure and result printing; project CLI argument dispatch | Surfaces | bin/lattice and host clients |
| isolation-runner: disposable worktree execution/verification service | Independence + seam | Seam transformation primary consumer; runtime through independence/seam public index |
| todo-cli: resolveDoneEvidence/writeEvidenceBlob, also used by phase decisions | Plan/lifecycle evidence service | done and phase decision commands; sole writer of `.lattice/todo/evidence/<plan>/<task>/<digest>.md` and its Git blob descriptors |
| plan-backchain: validatePlanBackchain and context projection | Plan/lifecycle | Plan activation/revision supply validated values to Store; Store alone persists backchain.json |
| `todo-store-view.mjs`: schema classification, `projectTodoCrossPlanDependencies`, `todoTaskCarrySemantics` and pure reference helpers | Store (pure view; no I/O or feature import) | Readiness, status, Store; CLI and existing clients via Store compatibility re-exports |
| `todo-readiness.mjs`: `createTodoReadiness(store)`, `validateProspectiveEvent({store, member, event})` | Plan/lifecycle; no state writes. Canonical task/phase view is `member.tasks` / journal-derived `member.phases`, including synthetic fixtures; `snapshot.phases` is never read by readiness. | Status and prospective validation use one prerequisite predicate set. Store invokes the supplied validator after lock/re-read. The stage-1 compatibility wrapper and upward import were removed by Store in stage 2. Replay historical integrity remains unchanged. |
| Shared identified lock and recovery claims (store-lock.mjs); todo-store withLock and note-store withNoteLock | Store | All todo/note writers; runtime/adapter/setup integration deferred |
| phase revision v5 artifact recognition and active-reader registration; taskSemantics and pure reference helpers moved to todo-store-view; todoTaskCarrySemantics re-exported by todo-store | Store | Plan compiler/preliminary continuity diagnostics and existing generic phase revision transaction; Plan owns policy, Store retains locked final carry checks. |
| appendTodoEvent supplied-callback invocation | Store | Five todo-cli append sites supply Plan's validateProspectiveEvent; the option is mandatory and runs once after locked reread. No default validator or Store → Plan import remains in S3 stage 2. |
| runtime-os-observation: observeStartIdentityRaw/observeProcessHostIdentityRaw | Platform helper, no runtime policy | Store lock and runtime process/lifecycle observation; Store host domain uses OS identity + Linux PID namespace, independent of actor configuration. Start digests in the two lock protocols are internal and never compared |
| Runtime hold/recompile/control: `decideHoldAndCarryOver`, `recompileNextEpochPlan`, `runManagedSupervisorDaemon`, supervisor `holdConflict` / `commitWriteGate`, pull intake | Runtime | R1–R10 in [runtime flow](dfd-runtime-hold-resume.md). Runtime controls affected attempts; Plan/Store and seam public interfaces retain their own state/meaning. The proposed orchestration service is not yet extracted. |
| fs-publish: syncPublishedFile | Filesystem publication helper | Todo atomicWrite/atomicWriteMode, note atomicWrite and shared Store lock; owns the existing WSL2 /mnt EIO allowance |
| todo-store-git-transaction: detached store commit path selection | Store | Only durable store artifacts enter Git; todo/note .write.lock, .write.lock.*.tmp, .write.lock.recovery/** and .cross-plan-recovery/** are host-local and excluded |

## Dependency direction after the proposed split

`surfaces → plan/lifecycle → store`; independence/seam consumes Store and Sensor
and returns artifacts/advisories to lifecycle. Store imports no features. Runtime
uses both the plan public index and independence/seam public index instead of CLI internals. `src/todo-contracts.mjs`
remains an external compatibility re-export until consumers migrate.

Store → platform OS observer is an infrastructure dependency; the observer's
current runtime-os-observation filename does not make it runtime policy. Store
and runtime lock start digests use different internal encodings and are never
compared. Store → filesystem publication helper shares one file-sync policy.

Stage 1 extraction note (the Store stage-2 supplied-callback row above is current):

The single temporary Store → Plan import is `validateProspectiveEvent` at the
`todo-store.mjs` private `validateMergedTransition` wrapper. Rudmira removes it
in the subsequent store-recovery change when callers supply the validator.

Plan owns pure readiness rules (fresh store view → ready/not-ready + reasons).
Status consumes them; the Store transaction accepts a validator supplied by Plan
and executes it after the locked re-read. Store retains schema/identity/chain,
replay projection, locks and CAS; it imports no feature policy. Structure's
phase_accept/close evidence validator is supplied the same way. For manual start
only, observational structure failure becomes context/advice.

The prospective callback is `validateProspectiveEvent({store, member, event})`.
`store` is the complete fresh locked read, treated read-only by Plan, so cross-plan
edges and states remain available. Plan returns `{ok:true}` or
`{ok:false,code,detail:{reason,cause,...}}`; existing per-kind code/reason are
preserved, with additive task/phase/acceptance/predecessor cause detail. It covers
start, done, reopen and phase_reopen. S3 stage 2 completes the stage-1 seam
described above: callers now supply the mandatory function; the temporary
validateMergedTransition wrapper and upward import are removed. Failure maps
the validator's existing code/reason and additive detail to the same refusal.

Replace independence→runtime-front-end with runtime passing observed-change facts
as data through lifecycle; independence consumes the facts, never runtime state
through an upward import. Runtime still directly consumes the public seam service
for conflict treatment.

Current exceptions to remove later: Store→structure/seam; independence→runtime
front-end; supervisor→runtime-cli cycle; dashboard→whole todo-cli. S2 changes none
of those live connections.

## S2 change boundary and verification

The [retirement manifest](research-retirement.md) lists exact source/test paths,
historical replay refs and the live runtime verification retained in this change.

Delete only the baseline reachability script's 33 declared research modules and
tests whose subject is those modules. Adapt the reachability declarations and
test runner selection in the same diff; inspect other script/fixture references.
Preserve immutable historical evidence and all live product interfaces. The
remaining source graph must have zero undeclared unreachable modules and zero
stale declarations. Validate the product gate through its existing `npm run ci`
entry; CI across supported OSes remains the PR's acceptance evidence.

## Decisions received 2026-11-07 JST

- Any actor may retract/accept; journal records the acting host/session/agent.
  This does not waive identity, target digest, stale version or evidence checks.
- Phase removal or blanket advisory conversion is not approved. Preserve authored
  order while assessing which checks enforce task/acceptance prerequisites and
  which merely demand redundant observation. See the DFD for the shared predicates.
- Runtime remains a standalone product capability. BellTeam integration is optional.

## Patent claim map (特願2026-178950; implementation trace, not legal scope)

Owner rule (2026-11-07 JST): never deviate from the claims; additions are allowed,
the claimed logic is not broken. This table traces each claim's constituent
elements to the modules that implement them today. A module listed here is
"marked": a diff touching it carries a before/after external-behaviour
comparison in its evidence, and its diagram review names the claim. Modules not
listed (authoring inputs, gates, error shape, persistence, state location,
surfaces) may change shape freely within the boundary table above.

| Claim | Constituent elements | Marked modules (current) | Change rule |
|---|---|---|---|
| 1 / 11 / 12 | Analyse source structure + work specifications → estimate change-impact ranges; arrange parallel execution when ranges do not overlap; refactor resolvable overlaps first; always emit a work plan; run the works in parallel on multiple agents | `sensor/` (structure), `boundary-observation-compiler-v2.mjs`, `schedulability-compiler-v2.mjs`, `schedulability-verifier-v2.mjs`, `todo-independence*.mjs`, `seam-*.mjs`, plan compile (`project-cli.mjs` plan compile/verify), `runtime-cli.mjs` run activate | Keep the three parts and their order (estimate → arrange/refactor → execute); a plan is produced in both branches |
| 2 / 3 | Natural-language work specs + structure graph (nodes = elements, edges = relations) given to AI → per-spec impact range including related elements | `sensor/` index and query, `todo-independence-contracts.mjs`, witness set (`todo-witness-scaffold.mjs`) | The AI judges; Lattice supplies the graph and records the judged range. Do not replace with heuristics that drop related elements |
| 4 | Impact range names resources read/written; two works conflict when one writes what the other reads or writes | `todo-independence*.mjs` (independence compile/projection), `schedulability-verifier-v2.mjs` | Conflict predicate stays write-vs-read/write; never relax to write-vs-write only |
| 5 | On conflict, refactor so the two works do not access the same resource directly | `seam-derivation`, `seam-rewrite`, `seam-apply`, isolation worktree runner | Transformation stays real (isolated worktree), not advisory |
| 6 | Compare external behaviour before/after the refactor; re-estimate ranges; plan only when behaviour is within tolerance and overlap is gone | `seam-verification`, `structure compile/realize` (`todo-structure*.mjs`), plan revision (`todo-revision.mjs`) | Verification and re-estimation gate the new plan; do not plan on an unverified seam |
| 7 | During parallel execution, on conflict between two works: hold one, commit the other to version control, resume after resolution | `runtime-cli.mjs` hold/resume, `runtime-work-order-controller.mjs`, `runtime-managed-supervisor.mjs`, scoped barriers | Hold → commit → resume order preserved; barriers scoped to the pair |
| 8 | On a resolvable in-flight conflict: hold both, refactor only the elements needed, resume both | `runtime-cli.mjs` recompile path, `seam-*` invoked from runtime, isolation runner | Refactor scope stays limited to the conflict's elements |
| 9 | Observe each work's actually changed resources; runtime conflict when they exceed the work's range or overlap another running work's range | `runtime-direct-os-observer.mjs`, `runtime-os-observation.mjs`, `runtime-pull-intake.mjs`, receipt validation | Observation is of actual changes (OS/diff), compared against ranges; keep both tests (exceed, overlap) |
| 10 | Identify the target group affected by the runtime conflict; hold only those; have the planner generate a new plan for the group | `runtime-cli.mjs` recompile/reprocess, plan revision/epochs, `runtime-pull-intake.mjs` | Re-planning is targeted (the group), not whole-plan; epochs invalidate old contexts |

Owner of this table: Lattice統括 (Snow White). Runtime rows are refined by the Runtime
owner's hold/recompile/resume DFD when it lands; Independence rows by the seam
weight review. Source of claim text: the owner's filing set (private to the
supervisor's seat); this map quotes constituent elements in paraphrase only.
