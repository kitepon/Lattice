# Store: phase revision v5 registration

Owner: Store. [Function map](function-map.md) composes this boundary with Plan's
compiler and Runtime's supplied revision callbacks. This change adds the approved
backchain-free sibling artifact; it does not change lifecycle meaning.

## Artifact and public connection

`lattice.phase_todo_revision.v5` has exactly the existing PHASE_REVISION_KEYS:
schema, project_id, plan_key, predecessor, desired_plan, task_migration,
phase_migration and revision_digest. desired_plan is a valid todo_plan.v7.
Predecessor remains the existing plan/head/version binding. No backchain, source
inventory or runtime migration fields are allowed. Compute the plan version with
the existing phaseTodoRevisionPlanVersion without featureGraphDigest and the
artifact self digest with the existing revision_digest rule. No event schema,
manifest schema or transaction marker format changes.

| Step / owner | Input and decision | Output / failure and exit |
|---|---|---|
| Plan compiler / existing revise-phase | Desired full phase plan, explicit predecessor task continuity and phase migration; existing `todo revise-phase --input` reaches the same registered validator and apply transaction | Supplies canonical v5. Plan owns compiler policy, /continuity diagnostics and whether the existing CLI accepts v5 as a consequence of registration; Alice approved that existing surface with the same locked/CAS/carry checks. `--schema` still supplies the existing v3 JSON. Shared Store is written only after every member CLI on main can read v5. Old CLI readers refuse v5 with UNSUPPORTED_SCHEMA/unsupported_revision_schema{schema, supported_schemas}. |
| Store schema registration | validatePhaseTodoRevision/explainPhaseTodoRevision recognize v5 with base keys and desired v7, using existing migration/identity/graph/version/digest checks | Existing boolean and explanation shapes; invalid fields keep existing typed refusal. Correct the indicated input and retry. v4 still requires its backchain and feature-graph version; all older branches stay unchanged. |
| Store active reader | PHASE_TODO_REVISION_SCHEMAS includes v5; an existing todo_event.v4 genesis binds revision.json and desired_plan exactly as before | Reopen replays the same committed migration/event chain. Unknown future schemas retain UNSUPPORTED_SCHEMA; identity/digest mismatch is never reconstructed as success. |
| Store generic transaction | applyPhaseTodoRevision after identified lock + fresh read validates active predecessor, complete old task/phase migration, carry contracts and merged graph | v5 follows the existing non-v3/non-v4 path: same v4 genesis, journal/snapshot and manifest-last publication, same marker/retry rules. Unpublished version remains outside membership; a matching retry can finish. No v3 source-cutover or v4 backchain is fabricated. |
| Store task carry projection | Public todoTaskCarrySemantics and its pure reference helpers move unchanged into todo-store-view.mjs; todo-store imports the function as taskSemantics for its final validators and re-exports the public name | Read-only projection for Plan's preliminary canonical comparison. Missing task remains null. It grants no write or carry approval; locked final validation stays authoritative. |

## Shared projection contract

`todoTaskCarrySemantics(plan,taskId,idMap,{reconciliationMetadata=false,
includeDesignMemo=false,removedTaskIds=new Set()}={})` returns null or
`{task,hard_dependencies,joins,phase_accept_dependencies}`. idMap is a Map and
removedTaskIds a Set; inputs and the returned references are read-only for the
caller. Plan imports the pure todo-store-view.mjs module directly; todo-store keeps a compatibility re-export. No clone/freeze, filesystem, clock or Plan-policy dependency is added.
Plan's v5 continuity comparison uses reconciliationMetadata:true and
includeDesignMemo:false, mapping the predecessor side and using an empty desired
idMap; retire compiles to the existing removed migration. The existing projection
and its task/edge/join/acceptance dependency semantics are not rewritten here.

## Preserved boundaries and checks

No lifecycle start/done/reopen predicate, phase ordering, evidence verification,
historical replay, identity or digest check is removed. Generic carry mismatch
remains a refusal; metadata projection does not bypass it. Revision-set v1/v2/v3
registration is not extended to v5 by this change. Plan compiler/CLI integration, including verify's explicit schema dispatch,
is supplied and checked by Alice in her lightweight revision diff; Store does not duplicate her confirmed checks.

Focused Store evidence covers new schema acceptance/refusal, generic apply and
reopen, preserved predecessor bytes/state, carry refusal and schema-specific
version/digest boundaries. Existing v4 writer coverage guards the unchanged
backchain branch. Ship this DFD, the Store function-map rows, code and tests in
one diff; record exact-head CI and diagram review under the current acceptance
rules. No actual shared-Store v5 artifact is produced as part of these tests.

## Journal-backed prospective validation and identity-preserving repair

All successor writers (`applyPhaseTodoRevision`, its v3 source path,
`applyTodoRevision`, `applyTodoRevisionSet`, `createSuccessorTodoPlan`) validate
the complete prospective merged graph, including projected live plan-scoped
connections, before publishing a marker, source change, successor artifact or
manifest. Replaced members have the successor's initially empty plan-scoped
chain; their predecessor chains remain immutable history. Untouched members keep
their live connections. Since u03 (A24/A25b/N6) a stale or removed cross-plan
endpoint never refuses a read or a successor writer; see "Cross-plan binding
findings and automatic repair" below. The recovery API below stays for bindings
stale across more than one source revision.

| Step / owner | Input and decision | Publication / failure and exit |
|---|---|---|
| Plan carry decision | Mandatory `validateBindingCarry({store,source,dependencies,predecessor})` callback supplies explicit same-task carry proof from the recorded source topology to the active successor; Store reads and validates the retained predecessor plan.json named by the active source revision under the same lock, checks its project/plan/version/digest binding, and supplies active `source` member plus separate `predecessor:{plan_version,plan_digest,topology_digest}`. Pure, read-only inputs; returns `{ok:true}` or `{ok:false,code,detail:{reason,...}}` | Store owns no continuity policy; correct refused proof/input before retry. This never admits a new dependency into a completed target. |
| Store `rebindTodoCrossPlanDependencies` public recovery | g5 writer; owner `planKey`, `sourcePlanKey`, exact nonempty unique `eventDigests`, `expectedManifestDigest`, `expectedPlanScopedHeadDigest`, actor/time/reason and supplied Plan callback. Under shared lock, privately tolerate only digest-stale bindings while reading; all identity/hash/missing/dangling checks remain. Snapshot freshness and evidence availability do not gate this topology-only repair; no derived publication occurs. Manifest CAS pins the exact source topology. Require both CAS values and authenticate every selected live original connection on the same owner chain, with a stale source binding and unchanged project/plan/task endpoints. | CAS or original identity mismatch returns a typed conflict with no publication. Obtain current authenticated bindings and explicit intent before retry. No ordinary writer gains stale tolerance. |
| Store staged repair | Keep original events; stage a tombstone for each original plus an existing-schema replacement connection. Change only its source expected_topology_digest to the manifest-bound source topology; retain endpoints/direction and original connection reason. Invoke Plan carry callback, then reject duplicate projected (from,to) identities in Store and strictly validate the complete resulting merged graph. | Any missing carry proof, cycle or malformed event refuses before any chain write; an unselected stale binding stays a finding (u03). Correct selected proof/bindings; bytes stay unchanged. |
| Store single-chain publication | Atomically publish all staged pairs to that one owner plan-scoped journal under lock; return original/replacement event identities and the new chain head. | `stale → locked/CAS → validated in memory → atomic published → clean`. A crash before rename leaves original chain; after rename leaves the complete repair, recoverable through existing dead-owner cleanup. No intermediate disconnect-only state, transaction marker, lifecycle/snapshot/manifest/version write, or historical rewrite. The executor records result.source_topology_digest against the authorized digest. Ordinary strict read confirms closure and existing locked reopen then republishes stale derived snapshots. A repeated successful request conflicts with dependency_rebind_binding_changed because the owner head advanced; confirm by strict read, never automatic retry. |

The bounded shared recovery preserves the already committed successor and both
live edges, including a completed consumer. It is distinct from new-connect
validation and ADR0190 disconnect/reconnect. Existing source barriers may resume
only their recorded validated transaction; no repair fabricates a cascade.

Changed-range evidence: incoming projected binding refuses before revision
publication (representative phase writer); successful atomic repair preserves a
done target and strict reopen; manifest/head CAS, original identity and Plan
refusals retain bytes; incomplete selection and duplicate edges refuse; retry
conflicts; stale snapshots coexist with repair and recover on ordinary reopen.
DFD, function-map, source and these checks ship together.

## u12 authored changes: plan v8, light carry, retire at any state (Store, 2026-11-08)

Owner rulings 2026-11-08 (u12/u03): an author may change or delete any task at
any state and Lattice records it; the revised procedure is then enforced as
written. Plan's contract rows live in dfd-plan-create.md "Authored done
condition", dfd-plan-revise.md "Authored change at any state" and
dfd-todo-start.md "Retire at any state"; this section is Store's half.

| Step / owner | Input and decision | Output / failure and exit |
|---|---|---|
| Store plan v8 registration | `lattice.todo_plan.v8` = v7 plan keys; task = v7 task keys + `done_condition` (always present: null or the design-memo text rule). validateTodoPlan/explainTodoPlan, isPhaseTodoPlanSchema/isDecoupledPhaseTodoPlanSchema and every Store v7 list (parent graph, plan-scoped/trusted-plan checks, active reader) include v8. Successor rank 5 (v7 lineage). | Old readers refuse v8 with UNSUPPORTED_SCHEMA. A v8 predecessor with a non-v8 desired plan refuses REVISION_INVALID `done_condition_schema_downgrade` (same place as design_memo_schema_downgrade); the successor-plan writer refuses the same regression with the same typed code (design_memo_schema_downgrade there is typed too). Author resubmits as v8. |
| Store revision desired-plan lists | phase_todo_revision.v3 desired v5/v7/v8, v4 desired v7/v8, v5 desired v7/v8; all other checks unchanged | Every revision route stays open after a plan becomes v8; v7→v8 is allowed, v8→v7 is the downgrade refusal above. |
| Store light task carry | phase_todo_revision.v5 + `carry_reconciled_metadata` only: compare mapped task_id and compile_binding. Title, lane, memo, done_condition, phase, incoming/outgoing edges and joins may change; state and evidence carry. | compile_binding change → existing REVISION_INVALID carry_semantics_changed (claim 1–4 binding must not silently move); author uses reset or the recompile route. `carry` policy, v1–v4 revisions, plain todo_revision and acquire_phase keep their existing comparisons. Merged-graph validation unchanged. |
| Store light phase carry | phase_todo_revision.v5: a `carry` phase migration compares only its id mapping (from → to); definition and task membership may change | Store carries exactly what phase_migration says. Plan (compilePhaseMigration, light route) chooses reset when the definition changed or the phase gains a task whose carried state is not done/retired, else carry (Alice, 2026-11-08). v1–v4 keep phase_carry_semantics_changed. |
| Store retire replay | `retire` payload legacy `{reason}` or new `{reason, prior_status}` with prior_status ∈ pending/blocked/in-progress/done | Legacy: pending/blocked only, as before. New: prior_status must equal the replayed status, else STORE_INCONSISTENT `retire_prior_status_mismatch` (the event would record a false fact). Result state is the retired shape: blocked_reason = reason; evidence, test_result null; started_at kept; done_at and imported kept only when retired from done (else null/false). An in-progress authored start binding is closed; a done task's completion record and pending evidence verification are dropped from state; the done event and its evidence stay in the journal. Already retired → existing invalid_retire_transition. Old readers refuse the new payload shape (event validation). |
| Store/readiness: retired from done | Retired state with done_at !== null or imported === true (only reachable by retiring a done task, including a historical_import done with unknown time) | `isFinishedTodoTaskState(state)` in todo-store-view.mjs is the single predicate; it counts as a finished predecessor in Store replay dependenciesDone and in readiness predecessorsDone (todo-readiness.mjs, Plan/lifecycle-owned; Alice changes it in the u12 PR) (Alice, 2026-11-08). A task retired from pending/blocked/in-progress (done_at null) keeps today's rule: successors wait for a revision that drops or replaces the edge. Phase gate_ready counts every retired task as finished, as today. Snapshot validation allows retired done_at null or a strict timestamp and imported true or false. |


Changed-range checks: v8 accept/refuse + explain pointer; v7→v8 revision and
v8→v7 downgrade refusal; v4/v3 desired v8 accepted; v5 light carry accepting an
edge/title/phase-field change and refusing a compile_binding change; v5 carried
phase with changed membership accepted, v4 still refused; carry policy unchanged; retire new payload from each of the four states, mismatch refusal,
legacy from in-progress still refused, in-progress retire closes the binding; retire from done keeps a pending successor
ready and lets an in-progress successor record done; retire from pending still
blocks its successor.

## Cross-plan binding findings and automatic repair (u03 A24/A25b/N6, Ludmila 2026-11-08)

Protection kept: intra-plan graph shape (dangling, self edges, joins) and the
merged cycle check still refuse; they guard the order the authors wrote.
Removed refusals: `binding_stale` (read and every successor writer) and
`dangling_dependency` for a cross-plan reference whose task is gone.

| Step / owner | Input and decision | Output / exit |
|---|---|---|
| Store `validateMergedGraph` (every read, connect, successor writer) | Each cross-plan reference (authored `hard_dependencies`/`joins`/`phase_accept_dependencies` naming another plan, and live plan-scoped connections) is bound against the active members. Topology digest differs → finding `binding_stale`, edge kept. Task/phase absent → finding `endpoint_missing`, edge left out of the graph. Same-plan references keep the old refusals, and so does a plan being created (authored/initial/imported): its own foreign references must name existing endpoints at their current topology (`dangling_dependency` / `binding_stale`; the author corrects the input). | Returns findings; `readTodoStore` exposes them as top-level `cross_plan_findings` `[{owner_plan_key, event_digest (null for authored), side: 'from'|'to', ref, reason: 'binding_stale'|'endpoint_missing'}]`; `ref` is a copy of the recorded reference: task `{project_id, plan_key, task_id[, expected_topology_digest]}` or phase `{project_id, plan_key, phase_id[, expected_topology_digest]}` (phase refs are always side 'from'). One entry per identity, sorted by code units over (owner_plan_key, event_digest or '', side, ref.plan_key, ref.task_id or ref.phase_id, reason). Store replay checks only same-plan predecessors, which always exist, so it needs no endpoint rule; cross-plan prerequisites are Plan's readiness. No option toggles this (the old `tolerateStaleBindings` is gone). |
| Store `repairCrossPlanBindings`: in `appendTodoEvent` (via `readTodoStoreLocked` with `assertHeld`, before the event's own validation) and at the end of each successor writer (`withLock` `repairAfter`, same lock) | For a live plan-scoped connection whose `from` names another plan P, walk P's `predecessor_plan_digest` chain through retained versions until a version's topology equals the recorded digest, composing each version's genesis `task_migration` (oldest first). The recorded migration is Plan's revision decision, written from Plan's state_migration under the lock; it is the carry proof, so Store holds no continuity policy. Rebinding into a done target is a carry, not a new dependency. | Mapped → stage `cross_plan_dependency_removed` + replacement `cross_plan_dependency` (from task_id = mapped id, digest = P's topology; to/reason unchanged). Any `removed` on the way → tombstone only (reason names the source plan and version). A repair that would duplicate an edge or close a cycle is dropped alone and stays a finding; the others publish once per owner chain after `assertHeld`. Repairs published before a refused event stay on disk (they are valid on their own). Crash before publication leaves the findings; the next appendTodoEvent or successor writer repairs them (self-exit). |
| Visibility of a repair | Owner chain history keeps both events; the tombstone reason names `source <plan_key> <plan_version> removed/carried the task` | appendTodoEvent returns `cross_plan_repairs` `[{owner_plan_key, original_event_digest, replacement_event_digest|null, action:'rebound'|'tombstoned'}]`; successor writers keep their digest-bound results and pass the same list to an optional `onCrossPlanRepairs` callback. The repair events carry the triggering writer's actor (the trigger, not the decider; the decider is the source revision named in the reason). Plan's CLI decides whether to show them in its JSON. |
| Plan (Alice) | `cross_plan_findings`; a predecessor whose endpoint is gone | Readiness (`createTodoReadiness`) skips a predecessor task or acceptance-source phase that has no node; Store replay needs no change (its dependenciesDone is same-plan only). `todo status` v8 adds top-level `cross_plan_findings: {total, entries}`: entries are the Store findings in Store order, cut at `TODO_STATUS_FINDING_LIMIT` (32) so a long list never refuses status; total is exact. Entry keys are validated strictly (task ref with optional expected_topology_digest; phase ref only on side from). `dependency disconnect` reads/appends without the removed tolerateStaleBindings option. appendTodoEvent's `cross_plan_repairs` is not shown in CLI JSON yet (repairs stay visible in owner chain history). |

A binding whose digest matches no retained predecessor version (or whose task has
no migration entry on the way) stays a finding; the explicit
`rebindTodoCrossPlanDependencies` recovery repairs it.
## Effective source inventory across light revisions (u03i, Ludmila 2026-11-08)

A light revision (`phase_todo_revision.v5`, and any revision without
`source_inventory`: todo_revision.v1, phase v1/v2/v4) records no inventory. Its
`task_migration` already records which old task became which new task or was
removed, so Store derives the inventory instead of adding an artifact key. Plan
supplies nothing new (`plan revise` keeps compiling v5; u03n lifts its guard).

| Step / owner | Input and decision | Output / failure and exit |
|---|---|---|
| Store `effectiveSourceInventory(repoRoot, member)` (was `predecessorSourceInventory`) | Walk from the member's own revision back through `predecessor_plan_digest` (retained `plan.json`/`revision.json`, canonical and valid, same plan_key, desired_plan equal to that version's plan, at most 512 steps) to the newest revision that records `source_inventory` (the base). Every revision on the way without an inventory is kept, newest first. No base → empty base, `recorded: false`. | `{inventory: {active, excluded_tombstones}, recorded}`; derivation is pure (no source read). |
| Store derive one revision (oldest first) | Base inventory + `task_migration` + desired plan | Active: for each row `from → to` (any kept policy) whose `from` has a base entry, the entry with `task_id: to`, in desired task order. A `removed` row's entry is dropped: the revision's own `removed` row is its record, and a tombstone would point at a live line the author may then delete. A base entry whose task has no row stays if the desired plan still has that task id, else is dropped. New tasks get no entry (light revisions do not add sources; adding one is a revise-phase cutover). Tombstones are carried unchanged. |
| Store `validSourceInventory` (v3 artifacts) | active vs desired tasks | Was: active 1:1 with every desired task. Now: active task ids are an ordered subsequence of desired task ids, and each desired task without an entry has `narrative_ref` null (a task without a source). Other checks unchanged (unique refs, tombstones sorted and disjoint, requireNarrativeRef for present entries). Relaxation only: every previously valid artifact stays valid. |
| Store revise-phase v3 diff (`validatePhaseV3SourceInventoryDiff`) | effective predecessor inventory | Unchanged rule, now fed the derived inventory, so a source removed by a light revision is not `predecessor_source_silently_dropped`. A null-ref task needs no cutover operation. |
| Store `verifyEffectivePhaseTodoRevisionSources` / `todo verify` | v5 member | Verifies the derived inventory (active + carried tombstones) against the current source lines, as before. |
| Plan `todo split` `existingSourceInventory` (Alice reviews the hunk) | Store's exported `readTodoEffectiveSourceInventory({repoRoot, member})` | Starts from the derived inventory; `inherited` = `recorded`. A task without an entry and with no source `narrative_ref` gets no entry and is not cut over (was `predecessor_source_inventory_unavailable`); the compiled v3 inventory omits it. A task with a source `narrative_ref` and no entry is read from its line, as before. |

Old readers: the relaxed v3 validator is needed only to read a v3 artifact that
omits a null-ref task; an older binary refuses that artifact (same rollout as plan
v8). Derived inventories are never written, so there is no format change.
Patent: source inventory bookkeeping is outside claims 1–12.
