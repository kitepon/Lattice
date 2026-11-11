# Data flow: light authored plan revision (w1b)

Status: implementation contract adopted by Snow White on 2026-11-07; separate
from w1/w5. Canonical ownership is in [function-map](function-map.md).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `plan revise --input <file> [--dry-run] --json` | `lattice.plan_revise_input.v1`: create-v4/v5 `desired` object (`project_id`/`plan_version` optional: a17 fills the active plan's values; a different `project_id` refuses `plan_revise_identity_mismatch` at `/desired/project_id`) plus `continuity` entries `{task_id, policy, reason}` for every old task (carry/reset/retire). a31: the wrapper is optional: `applyPlanRevision` reads a bare create-shaped input (`isBareCreateInput`: a record with `tasks`, no `desired`, schema absent or `plan_create_input.v*`) as `{schema: plan_revise_input.v1, desired: <input>}` with computed continuity | Existing authoring JSON reader repairs the desired input digest; shared `validatePlanCreateInput` checks its existing contract. No semantic patch inference or sorting. | Invalid input returns field/rule before persistence; correct input and rerun dry-run. For a bare input the refusal pointers drop `/desired` (`unwrapPointers`). A wrong wrapper (`plan_revise_schema_invalid`) names both accepted shapes. A `desired.plan_key` with no active plan refuses `plan_not_active` before completion (a31), with `plan_key` and next_action `lattice plan create --input <file>`; completion no longer turns it into "add keys [plan_version, project_id]". |
| Plan: compile light revision | Fresh Store member; explicit complete continuity; ordinary v7 desired state | Reuse backchain's plan seed and phase-migration generation. Build complete task migration: carry→carry_reconciled_metadata, reset→reset_pending, retire→removed. carry_reconciled_metadata permits design_memo/narrative_ref/parent_task_id changes; it preserves task_id/title/lane/compile_binding and incident edge/join semantics (ADR 0167 permits jointly retired neighbors); use Store's shared read-only semantics projection to diagnose changed carry at /continuity/<i> with a reset suggestion. Machine-fill predecessor version/plan/head digest, deterministic version and plan/revision digests. Generate `lattice.phase_todo_revision.v5` with PHASE_REVISION_KEYS and no backchain. | Missing/unknown/duplicate policy or retire/desired mismatch refuses; explicitly correct the policy. Markdown-anchored authoring retains the existing heavy source/cutover path. Existing feature-bound plans use backchain, preserving their semantic contract. |
| Store: v5 reader/validator registration (Rudmira, after Store authoring API) | `phase_todo_revision.v5`, ordinary v7 predecessor/desired plan and migration tables | Reuse generic phase transaction: lock/fresh read, predecessor CAS, v1/v2 generic taskSemantics carry checks (not v4 validateBackchainCarry), existing phase carry checks, merged graph validation, immutable successor artifacts and final descriptor publication. v4 and old artifacts stay unchanged. | Existing stale_predecessor/carry/graph failures protect current state; compiler reads current state and resubmits explicit intent. No source inventory/cutover is fabricated. |
| Plan: artifact CLI compatibility | `todo revise-phase --plan <key> --input <revision>` uses the existing authoring JSON reader to repair revision_digest (including v5), then the shared explain/validate path; registered v5 artifacts are accepted alongside older versions. `todo verify` classifies v5 as a phase revision in both source verification and receipt projection. | Reuse Store generic apply and effective-source verification. As for existing non-v3 phase revisions, v5 projects reconciliation_digest from revision_digest; the v3 reconciliation object remains specific to v3. `revise-phase --schema` continues distributing the named v3 schema, not an enumeration of accepted artifact versions; `plan revise --schema` provides the light authoring input. | Plan owns CLI routing/projection; Store owns final locked checks and reader registration. Shared-store compatibility rollout remains required. |
| Plan: completion | Applied revision and fresh task states; the predecessor member read before publication | Reuse carried-work rebind service to attach in-progress work to the successor. Each rebind start keeps the `actor` of the task's latest `start` in the predecessor journal (`carriedStartActors`, a16), so the seat that started the work keeps it in `turn.own` whoever revised; a task with no predecessor start in this read (unchanged-intent retry) falls back to the current actor; report plan/version/digest, explicit migrations and rebound task IDs. Preserve done evidence and old versions. If desired topology equals current topology and all current tasks explicitly carry, return lattice.plan_revise_unchanged.v1 and only finish rebinds; publish neither a new revision artifact nor a new version. Dry-run has no authoring writes; Store reopen recovery remains its separate contract. | Refusal and rebind-failure detail provide next_action. Every Store error raised after the revision was published carries `revision_applied: true`, `revision_digest` and the successor `plan_version` so the caller knows the publication committed (first-use incident 2026-11-07: a raw `STORE_INCONSISTENT / binding_stale` from the rebind read hid the commit). Rebind failure additionally reports the task and exact repair command; run the exact `lattice todo start --plan <key> --task <id> --rebind --reason <text>` repair command, or the unchanged-intent path when all current policies are present. `binding_stale` after publication arose once (2026-11-07 w1b) because incoming cross-plan connections still bound the predecessor topology; its one-time recovery is the [carried source binding](#carried-source-binding-recovery) flow, never replay, disconnect/reconnect or manual edits. Since Store's prospective validation (PR55), revising a plan that is the source of another plan's live connection refuses before publication with `STORE_INCONSISTENT / binding_stale` and no `revision_applied`; a meaning-preserving forward path is a separate design Snow White decides (limit documented in the Store DFD). |
| Supervisor / shared-store rollout | Exact main commit with v5 reader/validator on every member CLI, including supervisor | Only then use the light input to add w1b itself to lattice-refactor-20261107, as the first real acceptance use. w1/w5 do not depend on v5. | Old readers reject UNSUPPORTED_SCHEMA / unsupported_revision_schema with supported_schemas. Until compatibility confirmation, use isolated test stores; no v5 writes to shared store. |

Protected state: published plans, evidence and active work bindings. Every refusal
has an explicit correction/retry or existing heavy-authoring route. No source
rewrite, state inference, feature graph fabrication or new Store writer is added.

Verification scope: explicit policy completeness, add/remove and dangling refs,
deterministic digests/CAS, in-progress/done migration and evidence retention,
dry-run without authoring writes, old backchain behavior, v5 Store registration supplied by
its owner, same-diff diagrams and exact-commit three-OS CI. Leviathan reviews
diagram changes and final implementation conformance.

## Field and routing contracts

The full create-v4 desired object is validated by exported validatePlanCreateInput.
Its plan_version satisfies that input shape but is replaced by the deterministic
successor version; predecessor/CAS/digests come only from the current member and
machine generation. desired has no predecessor_plan_digest field (the create validator rejects one); the compiler inserts the current member plan_digest. desired.actor and desired.recorded_at attribute the ordinary
revision genesis. desired.input_digest is repaired by the existing authoring
normalizer and is not copied into the plan or revision artifact.

Continuity reuses backchain's carry/reset/retire vocabulary and required reason;
retire maps to artifact removed. Unlike backchain's optional inference, light
revision requires every current predecessor task exactly once. New tasks are
pending and have no predecessor policy row. All-carry unchanged detection still
requires complete current coverage; a repeated older input missing newly added
tasks uses the explicit rebind repair command instead of silently inferring carry.

INPUT_INVALID / plan_revise_requires_source_revision routes predecessor narrative
anchors, genesis todo_event.v2 or plan v6 to todo revise-phase. INPUT_INVALID /
plan_revise_requires_backchain routes a non-null readPlanBackchainBinding to plan
backchain. These protect source and feature bindings and have explicit existing
paths to completion. A plain v7 plan with null anchors and no feature binding
uses the light route.

Store registration points: PHASE_TODO_REVISION_SCHEMAS, validatePhaseTodoRevision
(PHASE_REVISION_KEYS; desired v7; version with no featureGraphDigest),
explainPhaseTodoRevision, parsePhaseRevisionMarker through validation, and shared validator registration
used by todo-cli revise-phase; there is no revise-phase allowlist. No revision-set extension and no
public v5 artifact JSON schema are added. plan revise --schema distributes the
light input schema from docs/schemas.

Plan exports the existing backchain planSeed and compilePhaseMigration helpers
without changing their input shapes or inferred phase behavior; it does not reuse
compileTaskMigration's optional semantic inference. rebindCarriedWork is exported
with defaults preserving backchain's reason/failure code, and light revision
supplies its own reason/PLAN_REBIND_PENDING code. Store's existing semantics
projection is shared with the compiler instead of a second carry predicate.

The shared Store projection is imported directly from the pure `todo-store-view.mjs`;
`todo-store.mjs` retains its compatibility re-export. Its semantics are unchanged.

The shared Store projection is
`todoTaskCarrySemantics(plan, taskId, idMap, {reconciliationMetadata,
includeDesignMemo, removedTaskIds})`. Plan uses reconciliationMetadata:true and includeDesignMemo:false,
the old→new Map and retired-task Set on the predecessor side, and an empty Map
on the desired side. It compares canonical values without mutating either;
changed carry returns REVISION_INVALID / carry_semantics_changed at
`/continuity/<i>` with an explicit reset suggestion before apply. Store retains
the authoritative locked check and all phase/backchain checks.

## Carried source binding recovery

Status: coordination decision by Snow White (own plan.md §59, 2026-11-07): both live
connections w1→t03 (done) and w5→t05 (pending) are preserved; retirement, reopening
t03 and disconnect/reconnect workarounds are not authorized. Store's prospective
validation gap is Rudmira's; this section owns only the Plan continuity semantics.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Store: `rebindTodoCrossPlanDependencies` (Rudmira) | Owner plan key, source plan key, expected manifest / plan-scoped head digests, exact live `event_digest`s, actor, reason, Plan callback | Under lock, stale-only repair view; authenticates digests and unchanged endpoints; appends paired tombstone + new connection to the same owner chain; strict full-graph validation; one atomic publication. | Store refusals and CAS as owned by Store. |
| Plan: `validateBindingCarry({store, source, dependencies, predecessor})` in `plan-binding-carry.mjs`, published through `plan-revise.mjs` (named re-export; the recovery composition imports it from there) | Store's locked stale-only repair view; `source` = the active source member (plan + revision); the live projected dependencies to carry (with `event_digest`); `predecessor = {plan_version, plan_digest, topology_digest}` that Store reads under the same lock from the retained predecessor `plan.json` and checks against `source.revision.predecessor` (the locked view holds active versions only, so Store supplies it) | Pure predicate, no I/O or mutation. ok only when: `source.revision.predecessor` names exactly that version/digest and `desired_plan.topology_digest` is the active topology; every `from` names the source plan and binds the predecessor topology; its task has a `task_migration` row `from_task_id === to_task_id` with `carry` or `carry_reconciled_metadata`; the task exists in the successor; every `to` owner is active with unchanged `expected_topology_digest` and existing task (a done target is allowed: the connection meaning is kept, not re-created); no duplicate within the selected set. Returns `{ok:true, detail:{plan_version, successor_topology_digest, rebound:[{…, predecessor_topology_digest, successor_topology_digest}]}}`. Store stages the replacement payload; Plan only judges the carry. | Store's typed refusal `{ok:false, code, detail:{reason, …}}`: `DEPENDENCY_STALE` with reason `binding_carry_hop_unlinked`, `binding_carry_successor_mismatch`, `binding_carry_predecessor_mismatch`, `binding_carry_target_changed`; `DEPENDENCY_INVALID` with `binding_carry_source_mismatch`, `binding_carry_task_not_carried`, `binding_carry_task_missing`, `binding_carry_target_missing`, `binding_carry_duplicate`. A refusal means the carry is not an identity carry; Store must not rebind. More than one revision hop is out of scope (`shortcut`: predecessor must be the immediate one). Store checks the staged projection against live connections. |

Protected state: connection history (both originals and tombstones stay on the owner
chain), endpoints, direction, task lifecycle and evidence. No new connect allowance,
no disconnect-only intermediate state.

## Authored change at any state (u12, agreed 2026-11-08)

Owner rulings 2026-11-08 (u12/u03 notes): an authored task (title, lane, design memo,
done condition, dependencies, joins, phase) may be revised at any state, including
in-progress and done, and may be removed; Lattice records the change with its reason.
The revised procedure is then enforced as written.

Invariant (Plan lifecycle owns it): carried in-progress/done/blocked task state is
never re-validated against the revised readiness; there is no retroactive start
check. A done task that gains an unfinished predecessor stays done. An in-progress
task that gains one stays in-progress, and its `done` refuses `predecessor_unfinished`
until the predecessor finishes or a revision drops the edge. Store merged-graph
validation checks graph shape only and never flags these states.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: continuity | `plan_revise_input.v1`; `desired` is create v4 or v5 | `carry` → carry_reconciled_metadata whatever authored fields/edges changed; the Plan pre-check `carry_semantics_changed` is removed. `retire` → removed at any state (unchanged). | Missing/unknown/duplicate policy and retire/desired mismatch still refuse at `/continuity` (intent cannot be derived). |
| Plan: phase migration (light route only) | Predecessor phases/tasks, desired seed, task migration with carried states | Per phase: `reset` when its definition changed (title, gate_policy, predecessor_phase_ids, required_evidence_slots) or it gains a task whose carried state is not done/retired (it must be re-reviewed under the new procedure); otherwise `carry` (losing tasks, or gaining only done/retired tasks, keeps an accepted phase). Backchain keeps its existing compilePhaseMigration behaviour. | None added. |
| Store: light carry (Ludmila) | phase_todo_revision.v5 | Task carry_reconciled_metadata compares only mapped task_id and `compile_binding`; carried phases compare only id mapping and carry what phase_migration says. Stays: compile_binding → `carry_semantics_changed` (the claim 1–4 impact binding must not carry onto another compiled spec); merged-graph validation; v1–v4 and plain todo_revision checks; predecessor CAS. Relaxed for v5 only: title/lane/memo/done_condition/phase_id/edges/joins on carried tasks, `carry_outgoing_edge_removed`, `phase_carry_semantics_changed`. | compile_binding change: author uses reset or the source/backchain route that recompiles. |
| Plan: history notes | Applied revision, continuity reasons | A task "changed" when any of title, lane, design_memo, done_condition, narrative_ref, parent_task_id, phase_id, incoming/outgoing hard_dependencies, join memberships or phase_accept_dependencies differ. After publication, one task note per changed carried task on the successor version, and one plan note on the successor per removed task naming its task_id, via `appendTodoNote`; body starts `plan revise <from_version>→<to_version> <task_id>:` then the reason. | A note failure after publication returns `revision_applied: true` with `pending_history_notes: [{task_id, body}]` (only the ones not yet appended in this run) and the exact `lattice todo note add` commands; the author runs exactly those. No automatic retry. |

Closed by Store u03 A24/A25b/N6 (2026-11-08): revising a plan that is the `from` of
another plan's live cross-plan connection, or removing such a task, no longer
refuses. The next locked write (and the revision itself at its end) rebinds carried
connections and tombstones those whose task was removed; see the Store phase
revision DFD "Cross-plan binding findings and automatic repair".

Plan migration of `lattice-usability-20261108` (u12 acceptance): after the release,
one light revision to create-v5 moves each task's trailing `終了条件: …` line from
design_memo into done_condition, policy carry for every task.

## Computed continuity and computed migration (u03p, 2026-11-08)

Owner principle (u03): a refusal whose answer the machine can compute is removed;
the machine applies the answer. Supersedes the "explicit complete continuity" and
"required reason" wording above.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: continuity (N5) | `plan_revise_input.v1`; `continuity` optional (absent = `[]`); entry `{task_id, policy, reason?}` | Computed for every predecessor task: present in `desired` → its entry's `carry`/`reset`, else `carry`; absent from `desired` → `retire`. The desired task list wins: an entry `retire` for a task still in `desired` becomes `carry`, an entry `carry`/`reset` for a task absent becomes `retire`. Missing reason → `computed <policy>`. The result's `continuity` is the computed list. | An entry that cannot be read (not a record, unknown policy, task_id not in the predecessor, duplicate task_id) still refuses at `/continuity/<i>`: it is the author's override and guessing it could reset state. A v1–v3 `desired` refuses `plan_revise_desired_schema_unsupported` at `/desired/schema` (they carry no design memo or phases, so no v7/v8 successor can be built; before u03p the same input refused as retired). |
| Plan: migrate (A64) | `todo_extraction` tasks with disposition `unknown_requires_evidence` | Treated as `register_pending` (no state imported), the same default as a carried task without evidence; the result lists them in `defaulted_pending_task_ids`; `--dry-run` reports the same list instead of an `unknown_requires_evidence` violation. | None added. |
| Store: carry rule for every revision schema (A38/A39/A87; Ludmila reviews) | phase_todo_revision v1–v5 and todo_revision | Same rule as v5 light carry for all schemas: carry / carry_reconciled_metadata / acquire_phase keep state whatever authored fields, edges, joins or phase assignment changed. Kept: id mapping, compile_binding identity (`carry_semantics_changed`), target task/phase existence, predecessor CAS, merged-graph and final locked validation. Removed: the other `carry_semantics_changed` comparisons, `carry_outgoing_edge_removed`, `phase_carry_semantics_changed` (except a missing target), `acquire_phase_requires_*`, `backchain_carry_feature_changed`; a backchain continuity decision that disagrees with its migration row no longer refuses (`backchain_continuity_mismatch` removed) — the row's own policy applies. Event and migration schemas unchanged. | compile_binding change: reset or recompile route. An author's explicit `carry` of an accepted/closed_unaudited phase that gains unfinished tasks is applied as written (no refusal); the recorded acceptance then no longer covers those tasks, and Plan shows it as `acceptance_stale` (the A15 derived flag, extended: the phase also counts as stale while it contains a task that is not done/retired). Self-exit as A15: phase reopen → review → accept. |
| Plan: revise-phase artifact completion (A40a/A41) | `todo revise-phase` revision + fresh predecessor member | Before validation: a predecessor task missing from `task_migration` gets `carry` (same id present in desired) or `removed`; a predecessor phase missing from `phase_migration` gets `carry`/`removed` the same way; for v3 source-backed revisions, a predecessor source (active or tombstone) the desired inventory drops is added to `excluded_tombstones`. A missing predecessor phase row uses the light-route rule (compileLightPhaseMigration): `carry` only when the phase definition is unchanged and it gains no unfinished task (new, moved in, or reset); otherwise `reset`, so a recorded acceptance never silently covers work it did not see. A desired phase no row targets gets a `reset` row (from null). v3 task rows are not added: each needs a runtime_task_migration entry with evidence the machine cannot make, so a v3 revision missing a task row still refuses `predecessor_task_migration_incomplete`. Then plan_version, desired plan digests (v4 chain digest, v3 reconciliation digests) and revision_digest are recomputed with the existing functions; an artifact needing nothing is passed through untouched. Store exports `predecessorSourceInventory` (read-only, no logic change) for this. | None added; the completed artifact is what is validated and applied. |
| Plan: backchain-bound plans via `plan revise` (N3) | Plan with a readPlanBackchainBinding | `plan revise` compiles the existing backchain revision (phase_todo_revision.v4, `compileBackchainRevision`) instead of refusing `plan_revise_requires_backchain`. Successor chain = bound chain with `continuity` = the computed continuity, and `tasks` = one entry per desired task in desired order: a kept task keeps its chain entry, a new task gets `{task_id, requires_feature_ids: [], provides_feature_ids: []}`; goal and features are unchanged. | Feature-chain gaps (a new task providing nothing, a feature whose provider task was removed) follow A85. |
| Plan: feature chain findings (A85) | `plan backchain` / backchain revise | Coverage, provider, cycle and orphan checks of the feature chain become `feature_chain_findings` in the result (same entry shape as their old refusal detail: reason, pointer); the plan is registered. Unreadable chain shape still refuses. | None added. |


## In-plan dependency connect/disconnect (a14, 2026-11-08)

Seat walkthrough: `todo dependency disconnect` refused an edge the plan itself
holds (`cross_plan_dependency_not_found`), so one edge needed a full
`plan revise` input. Same-plan edges (`--from-plan` = `--to-plan`) now go
through the light revision route above; cross-plan edges are unchanged.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: desired from the current plan | Fresh Store member (v7/v8 plan) | `desiredFromPlan(plan)` in plan-revise: the plan's own tasks, phases, hard_dependencies, joins, phase_accept_dependencies as a create input (v8 → create v5, v7 → create v4), actor = seat (`resolveTodoActor`), recorded_at = now. No continuity entries (every task carries, computed N5). | Older plan schemas or source-backed plans: the existing `plan revise` refusals (`predecessor_plan_schema_unsupported`, `plan_revise_requires_source_revision`) with their next_action. |
| Plan: same-plan connect | `--from-task`, `--to-task`, `--reason` | Both tasks must exist (existing `dependency_task_not_found`); an edge the plan already holds, or a live ledger edge with the same endpoints (an earlier same-plan connect), is the target state already: exit 0 with `lattice.todo_dependency_unchanged_result.v1` (`unchanged: true`, the edge named, nothing written; a28, was `DEPENDENCY_EXISTS`); a done target keeps `dependency_target_terminal` (same checks as the ledger route). Desired = current + edge `{from, to}`; applied by the shared light-revision apply (`applyPlanRevision`, extracted from `runPlanRevise`, same compile → Store apply → history notes → carried-work rebind). A cycle refuses `DEPENDENCY_CYCLE/dependency_cycle` naming `from`, `to` and the closed `cycle` (a18, [dfd-todo-start](dfd-todo-start.md#refusals-name-the-field-the-cause-and-the-next-command-a18-ludmila-2026-11-10)); nothing is written. | A plan the light route cannot express (`lightRevisionExpresses` false: plan schema not v7/v8, e.g. from create v1–v3; source-backed v6/narrative_anchor/todo_event.v2 genesis; a task with a compile_binding) gets the existing ledger route (`cross_plan_dependency` event, result v1), decided before any write, so connect proceeds on every plan as before a14. Otherwise Store refusals are those of `plan revise`; a live connection from this plan to another plan does not stop the revision (tested). |
| Plan: same-plan disconnect | same flags | Edge in the plan body → desired = current minus that edge, applied as above. Else a live ledger edge with those endpoints (earlier same-plan connect) → existing tombstone (`cross_plan_dependency_removed`, result v1). Neither → `DEPENDENCY_NOT_FOUND/dependency_not_found` (a18; was DEPENDENCY_INVALID/cross_plan_dependency_not_found) with `from`, `to`, the to-task's `predecessors` and next_action `lattice plan show <plan> --json`. | Store refusals are those of `plan revise`. |
| Plan: result and record | Applied revision | `lattice.todo_dependency_revision_result.v1`: `{project_id, plan_key, operation: connect|disconnect, from, to, reason, actor, plan_version, revision_digest, rebound_task_ids, result_digest}`. The reason is a plan history note (`dependency <operation> <from>→<to>: <reason>`) appended with the revision notes. Ledger routes keep their v1 results. | Post-publication Store errors carry `revision_applied` as for `plan revise`. |

Help text: `dependency connect|disconnect` says same-plan edges change the plan
(a light revision, new plan_version) and cross-plan edges use the ledger.
Patent: authoring only; readiness, hold/commit/resume and claimed mechanisms
are untouched.

## One task add, plan show memo, revise --plan (a39, 2026-11-11)

BellTeam production trial (Flora/Trony, 0.85.5): adding t21/t22 needed all 22 tasks
resent to `plan revise --input`, `plan show --json` omitted design_memo so the plan
could not be rebuilt from Lattice's own read, and `plan revise --plan <key>` was an
unknown flag while every todo write requires `--plan`. Removing one task already has
its command: `todo retire --plan --task --reason` (state transition, plan unchanged,
every other task keeps state and journal).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `todo add --plan <key> --task <id> --title <text> [--phase <id>] [--lane <lane>] [--done-condition <text>] [--design-memo <text>] [--after <id>[,<id>…]] [--before <id>[,<id>…]] [--reason <text>]` | Fresh Store member | Same route as same-plan dependency connect: `desiredFromPlan(plan)` + the new task (absent fields filled by `completeCreateInput`) + edges `after → new` and `new → before`, applied by `applyPlanRevision` with no continuity (every existing task carries, computed N5). A plan note `todo add <id>: <reason>` is appended with the revision notes. Result `lattice.todo_task_add_result.v1` `{project_id, plan_key, task_id, after, before, reason, actor, plan_version, revision_digest, rebound_task_ids, result_digest}`. | Plan not active → `plan_not_active`; task id already in the plan → `INPUT_INVALID/todo_add_task_exists` with next_action `plan show`; an `--after`/`--before` id not in the plan → `DEPENDENCY_INVALID/dependency_task_not_found`; all before any write. Field rules (missing phase, memo limit, cycle) are the create validator's and Store's, unchanged. Plans the light route cannot express refuse as `plan revise` does. |
| Plan: `plan show <key> --json` | Store member | Each task also carries `design_memo` (null when the plan schema has none), so `plan show` holds every authored field a `plan revise` input needs. Schema name unchanged (additive). | None added. |
| Plan: `plan revise --plan <key> --input <file>` | Flag and input | `--plan` is optional. Input without a plan_key gets it from `--plan`; an input naming another plan_key refuses `INPUT_INVALID/plan_revise_plan_key_mismatch` (pointer `/plan_key`, or `/desired/plan_key` when wrapped) naming both keys, before any read of the store. | Fix either the flag or the input. |
