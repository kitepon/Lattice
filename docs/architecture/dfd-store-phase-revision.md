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
