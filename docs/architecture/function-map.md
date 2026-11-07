# Function and ownership map

Baseline: 0.79.5, commit `047139e5`. This is the canonical implementation map;
[product contract](../00_product-contract.md) owns public behavior. The
[start data flow](dfd-todo-start.md) composes the lifecycle connections below.
The [receipt flow](dfd-mcp-startup-receipt.md) owns private MCP startup observation
and atomic publication through the existing storage helper.
Directory moves are proposed boundaries, not claims that those directories exist.

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

| Boundary | Current implementation / public interface | Owned state and writer | Callers / connections | Failure and unknown handling |
|---|---|---|---|---|
| Store | `todo-store.mjs`: readTodoStore, appendTodoEvent, activation/revision; `todo-note-store.mjs`, `todo-store-git-transaction.mjs`, `todo-store-cache.mjs` | `.lattice/todo/manifest.json`, `plans/<key>/<version>/{plan.json,journal/**,snapshot.json}`, recovery markers: todo-store under write lock; `notes/**`: note-store under note lock; staged store commits: git transaction | CLI, status, plan/structure/independence, dashboard, runtime pull-intake; currently imports structure adapter and seam contracts upward | Identity/digest/event-chain checks protect recorded bytes; snapshot is derived. Current stale snapshot and crash windows are recorded in DFD. Proposed: isolate read/append/CAS/lock without feature imports; caller supplies feature data. No on-disk format change. |
| Plan + lifecycle | `project-cli.mjs`, `todo-cli.mjs`, `todo-revision.mjs`, `todo-migration.mjs`, `plan-backchain.mjs`, `plan-scope-review.mjs`, `todo-status.mjs`; public plan/todo commands | Immutable plans and lifecycle events via Store; backchain.json is written only by todo-store activation/revision; plan-backchain validates and supplies its value; author owns input files | Surfaces call lifecycle; lifecycle calls Store; status reads Store; runtime consumes plan bindings | Keep dependency and phase-accept ordering. Unknown observational evidence is a separate concern. Actor binding will permit any actor, retaining event attribution and target digest binding. |
| Independence + seam | `todo-independence*.mjs`, `todo-witness-scaffold.mjs`, `boundary-observation-compiler-v2.mjs`, `schedulability-compiler-v2.mjs`, `schedulability-verifier-v2.mjs`, `seam-*.mjs`; public independence/seam commands | AI authors `witness/<key>.json`; todo-independence validates its contracts; todo-store persists version-bound artifacts. Independence compiler and seam operations write version-bound artifacts via Store; isolation runner owns disposable worktrees | Lifecycle consumes advisory projection; compiler consumes bundled sensor; seam transforms feed plan revision; currently independence also imports runtime-front-end | Missing/stale/unknown observations remain visible. Current start refusals are listed in DFD; proposed advisory conversion must preserve explicit unknowns. Real transformation still verifies behavior and records accepted artifacts. |
| Structure | `todo-structure*.mjs`; structure commands and lifecycle context | AI authors structure inputs; writeTodoStructureSource in todo-store validates and persists canonical source; structure compiler validates/produces values, todo-store alone writes version bindings and realization/finalization artifacts | Lifecycle and phase decisions consume structure; adapter consumes Git and bundled sensor | Source inconsistency currently both projects unreadable context and refuses mutation. Separate observation staleness from required acceptance evidence before any behavior change. |
| Runtime (maintained; no structural rewrite this pass) | `runtime-cli.mjs`, `runtime-front-end.mjs`, `runtime-*.mjs`, runtime calls the isolation worktree service; `run` CLI and versioned request/packet/receipt/results | `.lattice/runs/<id>/**`: runtime event/epoch stores, supervisor/controllers; `.lattice/runtime/adapter-registry`: adapter registry | Shipped scripted/work-order adapters and managed supervisor; plan public binding contract; actual diff observation and seam resolution | Keep standalone dispatch, real conflict holds, scoped barriers and receipt verification. Planned maintenance: lock recovery and supervisor→runtime-cli cycle removal only. A deferred rewrite does not freeze repairs or retire features. |
| Surfaces | `bin/lattice.mjs`, `todo-cli.mjs`, `runtime-cli.mjs`, `project-cli.mjs`; dashboard/gantt, bridge/hub, hooks/setup | CLI stdout/stderr are projections; evidence files via todo CLI; presentation JSON via presentation module | Hosts and external clients call versioned CLI; Peertable additionally imports `src/todo-contracts.mjs` (keep compatibility shim when moved) | Preserve command names and result schemas. Current dashboard bin imports todo-cli for rendering; proposed render-only interface. Exit-code changes require explicit contract/release notes. |
| Dashboard + network | `todo-dashboard-*.mjs`, `todo-gantt*.mjs`, `dashboard-supervisor.mjs`, `bridge-*.mjs` | `~/.lattice/dashboard/**`: dashboard registry/daemon; `~/.lattice/bridge.json`: bridge config; hub terminal registry: hub server; launch/startup entries: bridge setup | CLI/status autostart; hub viewers and optional bridge | Dashboard delivery failure does not reject lifecycle writes. Registry and authenticated process ownership prevent wrong-process signaling. |
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
| project-cli: plan creation/activation orchestration | Plan/lifecycle | Project command dispatch |
| todo-cli: runTodoCli, flag matching, typedFailure and result printing; project CLI argument dispatch | Surfaces | bin/lattice and host clients |
| isolation-runner: disposable worktree execution/verification service | Independence + seam | Seam transformation primary consumer; runtime through independence/seam public index |
| todo-cli: resolveDoneEvidence/writeEvidenceBlob, also used by phase decisions | Plan/lifecycle evidence service | done and phase decision commands; sole writer of `.lattice/todo/evidence/<plan>/<task>/<digest>.md` and its Git blob descriptors |
| plan-backchain: validatePlanBackchain and context projection | Plan/lifecycle | Plan activation/revision supply validated values to Store; Store alone persists backchain.json |
| Pure readiness (proposed extraction of status/store predicates) | Plan/lifecycle | status reads ready/not-ready + reason; Store invokes supplied prospective-event validator after lock/re-read |

## Dependency direction after the proposed split

`surfaces → plan/lifecycle → store`; independence/seam consumes Store and Sensor
and returns artifacts/advisories to lifecycle. Store imports no features. Runtime
uses both the plan public index and independence/seam public index instead of CLI internals. `src/todo-contracts.mjs`
remains an external compatibility re-export until consumers migrate.

Plan owns pure readiness rules (snapshot + plan → ready/not-ready + reasons).
Status consumes them; the Store transaction accepts a validator supplied by Plan
and executes it after the locked re-read. Store retains schema/identity/chain,
replay projection, locks and CAS; it imports no feature policy. Structure's
phase_accept/close evidence validator is supplied the same way. For manual start
only, observational structure failure becomes context/advice.

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
