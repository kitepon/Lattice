# Data flow: light authored plan revision (w1b)

Status: implementation contract adopted by Snow White on 2026-11-07; separate
from w1/w5. Canonical ownership is in [function-map](function-map.md).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `plan revise --input <file> [--dry-run] --json` | `lattice.plan_revise_input.v1`: full create-v4 `desired` object plus `continuity` entries `{task_id, policy, reason}` for every old task (carry/reset/retire) | Existing authoring JSON reader repairs the desired input digest; shared `validatePlanCreateInput` checks its existing contract. No semantic patch inference or sorting. | Invalid input returns field/rule before persistence; correct input and rerun dry-run. |
| Plan: compile light revision | Fresh Store member; explicit complete continuity; ordinary v7 desired state | Reuse backchain's plan seed and phase-migration generation. Build complete task migration: carry→carry_reconciled_metadata, reset→reset_pending, retire→removed. carry_reconciled_metadata permits design_memo/narrative_ref/parent_task_id changes; it preserves task_id/title/lane/compile_binding and incident edge/join semantics (ADR 0167 permits jointly retired neighbors); use Store's shared read-only semantics projection to diagnose changed carry at /continuity/<i> with a reset suggestion. Machine-fill predecessor version/plan/head digest, deterministic version and plan/revision digests. Generate `lattice.phase_todo_revision.v5` with PHASE_REVISION_KEYS and no backchain. | Missing/unknown/duplicate policy or retire/desired mismatch refuses; explicitly correct the policy. Markdown-anchored authoring retains the existing heavy source/cutover path. Existing feature-bound plans use backchain, preserving their semantic contract. |
| Store: v5 reader/validator registration (Rudmira, after Store authoring API) | `phase_todo_revision.v5`, ordinary v7 predecessor/desired plan and migration tables | Reuse generic phase transaction: lock/fresh read, predecessor CAS, v1/v2 generic taskSemantics carry checks (not v4 validateBackchainCarry), existing phase carry checks, merged graph validation, immutable successor artifacts and final descriptor publication. v4 and old artifacts stay unchanged. | Existing stale_predecessor/carry/graph failures protect current state; compiler reads current state and resubmits explicit intent. No source inventory/cutover is fabricated. |
| Plan: artifact CLI compatibility | `todo revise-phase --plan <key> --input <revision>` uses the existing authoring JSON reader to repair revision_digest (including v5), then the shared explain/validate path; registered v5 artifacts are accepted alongside older versions. `todo verify` classifies v5 as a phase revision in both source verification and receipt projection. | Reuse Store generic apply and effective-source verification. As for existing non-v3 phase revisions, v5 projects reconciliation_digest from revision_digest; the v3 reconciliation object remains specific to v3. `revise-phase --schema` continues distributing the named v3 schema, not an enumeration of accepted artifact versions; `plan revise --schema` provides the light authoring input. | Plan owns CLI routing/projection; Store owns final locked checks and reader registration. Shared-store compatibility rollout remains required. |
| Plan: completion | Applied revision and fresh task states | Reuse carried-work rebind service to attach in-progress work to the successor; report plan/version/digest, explicit migrations and rebound task IDs. Preserve done evidence and old versions. If desired topology equals current topology and all current tasks explicitly carry, return lattice.plan_revise_unchanged.v1 and only finish rebinds; publish neither a new revision artifact nor a new version. Dry-run has no authoring writes; Store reopen recovery remains its separate contract. | Refusal and rebind-failure detail provide next_action. Every Store error raised after the revision was published carries `revision_applied: true`, `revision_digest` and the successor `plan_version` so the caller knows the publication committed (first-use incident 2026-11-07: a raw `STORE_INCONSISTENT / binding_stale` from the rebind read hid the commit). Rebind failure additionally reports the task and exact repair command; run the exact `lattice todo start --plan <key> --task <id> --rebind --reason <text>` repair command, or the unchanged-intent path when all current policies are present. `binding_stale` after publication arose once (2026-11-07 w1b) because incoming cross-plan connections still bound the predecessor topology; its one-time recovery is the [carried source binding](#carried-source-binding-recovery) flow, never replay, disconnect/reconnect or manual edits. Once Store's prospective validation lands, revising a plan that is the source of another plan's live connection refuses before publication; a meaning-preserving forward path is a separate design Snow White decides (limit documented in the Store DFD). |
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
