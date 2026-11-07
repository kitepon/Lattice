# Data flow: plan authoring and input diagnosis

Canonical w1/w5 contract for initial/additional authoring and validation.
[Function map](function-map.md) owns the composed boundaries.

Implementation status: proposed w1/w5 changes; Store supplies its following API
and recovery changes after PR37. The current main still has the initial-only
create restriction.

## Store implementation boundary

The Store API in this diff supplies the transaction below. Plan's additional
create/status dispatch remains Alice's following integration. No v5 revision
artifact is introduced by this change.

| Store function / state | Reads and transition | Publication / refusal and exit |
|---|---|---|
| `appendAuthoredTodoPlan` | Require exact authored inputs and g5 writer; shared membership transaction acquires the existing identified lock, replays a fresh store, checks project and absent key, builds ordinary genesis and validates the merged graph. | No historical import, migration state, cross-plan event injection or initialization option. Existing key uses `plan_key_already_exists`; project mismatch uses `STORE_WRITE_CONFLICT/project_id_mismatch{expected,actual}`. Correct /project_id or submit a new key. |
| Shared membership publication | Reuse the imported-member transaction's staging, captured manifest digest CAS, member descriptor and final manifest publication. Authored preparation supplies only plan/genesis/snapshot/optional backchain. | Existing members, repositories and manifest schema are preserved. `staging_fsynced` → `manifest_cas_matched` → `pre_activation_renamed` → `manifest_activated`; return a fresh locked Store read. |
| Unpublished membership files (authored and imported) | Enumerate staging and destination directory identities and bytes before reuse for both input kinds. Only the exact expected plan/journal/snapshot/backchain files or their empty parent directories are accepted. | An identical retry can finish pre-manifest publication. A different file, symlink or unknown entry is preserved and refuses with existing `REVISION_CONFLICT/revision_bytes_conflict` and next_action naming the path; restore expected unpublished bytes or use another key/version. No new public code/reason is needed. Published membership always refuses duplicate input. |
| `isUninitializedTodoStore` | Read-only: absent real Store root, or a real root containing only `.write.lock`, `.write.lock.*.tmp`, `.write.lock.recovery/`, `.cross-plan-recovery/`, and optional `notes/` containing only those same reserved entries, means uninitialized. Claim containers must contain only empty claim directories. Any note chain is data. Any manifest, member or other data means false; unsafe parent/root is never followed. | Advisory classification performs no recovery or deletion. A transient-only directory can still contain a live or unidentified owner; the initializer makes the authoritative decision under the lock. |
| Initial transient-root recovery | Capture real root identity; acquire the existing todo lock without creating a parent; collect only identity-proven dead temporaries and empty recovery claims. Recheck the same root and reserved-only layout while locked. Do the same for reserved-only notes residue. Release; recheck identity and emptiness; rmdir only those empty directories. A new lock between release and rmdir yields ENOTEMPTY → store_locked/retry. If a competing initializer removed the root first, re-evaluate the absent-root path; its final publication still wins through directory rename and the loser gets store_bootstrap_raced. | Live/foreign/unidentified owners remain `store_locked` or `lock_owner_unidentified`. Unremoved residue gets a manual next_action naming the root; no recursive residue deletion. Retry after owner exit or confirmed manual clearing. Changed identity refuses `authoring_activation_path_changed`. |
| Initial directory publication | After residue removal acquire identified todo and note locks in the private staged directory and keep it across the existing directory rename and verification/rollback. Both locks move with the directory; the shared primitive resolves its release path from rename state and the original real directory identity. | Other todo/note writers cannot append between publication and a failed initializer's rollback. Release the matching owner at its current path; no replacement owner or replaced directory is followed. Cleanup preserves a competing published store and its parent attributes. Existing `store_bootstrap_raced` covers a competing publication. Ordinary Store mutations require an existing parent and never mkdir a missing Store root; only the legacy g4 initializer explicitly creates it. A missing root gives `STORE_INCONSISTENT/artifact_missing{ref: manifest}`. New stores publish an empty notes/ directory; readers still see no chain. Fresh private stage locks never enter recovery-claim election; their configured claim paths are inside the moved stage. A contender whose temporary/parent disappears during open or link gets store_locked with retry-after-initialization/recovery next_action, including rollback races. |
| Note mutation | Require a real published Store root and manifest before creating the immediate notes directory; acquire its lock with createParent:false. | Existing NOTE_WRITE_CONFLICT/note_store_locked and next_action to initialize/retry; no missing Store ancestor is mkdir'd. |
| Legacy g4 bootstrap import (`bootstrapImportedPlan`) | initializeIfMissing remains a migration provenance path (ADR 0058 decision 7), outside authored initial publication. | Transient-only pre-existing roots are not deleted by this path; keep STORE_INCONSISTENT/artifact_missing with a manual recovery next_action. Fully absent root still uses its existing staged import bootstrap. |
| Legacy g4 initializeTodoStore | Retains its explicit createParent and direct artifact writes; this is not Plan create. | Pre-manifest member data remains data and classification is false. Restore/finish the same legacy initialization from its original inputs; never clear that root as transient residue. No legacy initializer transaction rewrite is included here. |
| `buildTodoPlan` | In the existing failed boolean-validation branch call the common `explainTodoPlan`. | Keep TypeError/message; attach reason→violation_kind, path→pointer and only present expected/actual JSON values. No independent Plan rule implementation. |

## Authoring input and diagnosis (w1/w5)

| Step / owner | Input and reads | Decision / output | Failure / recovery |
|---|---|---|---|
| Plan: create input | Current `lattice.plan_create_input.v4`, author actor/time/digest, full desired task/phase graph | Canonical input and a genesis plan; initial store or an additional plan in the same project | Invalid input returns existing INPUT_INVALID / plan_create_schema_invalid plus the shared validator's pointer and rule. Author corrects that field and resubmits; no store write occurs. |
| Plan: common plan validator | Plan schema, task/phase shapes, parent graph, strict collection ordering, topology/self digest | The same boolean validity for all existing readers; diagnostic entry returns the first failing pointer/rule. Create keeps existing task/phase authoring diagnostics; migrate keeps extraction-specific diagnostics and propagates common plan failures. | Invalid order identifies the failing collection index and ascending-unique key. Derived-plan migration failures remain INVALID_TODO_EXTRACTION / schema_invalid, never TypeError → CONTRACT_VIOLATION. No auto-sort silently changes authored input. |
| Store: initial or additional membership | Valid plan/genesis, g5 writer and optional featureChain; existing manifest and every current member re-read under recoverable lock for addition | Initial creation retains atomic directory publication. `appendAuthoredTodoPlan` returns the fresh read after ordinary genesis/replay and manifest-last publication. Existing members/repositories/manifest version remain intact; result selects the requested plan, not the first member. No historical import or state carry. Store builder forwards common plan diagnostic details without changing its TypeError/message. | Project mismatch or existing plan key refuses publication to protect existing state; a new matching project/key can be submitted. A live pre-manifest owner returns STORE_WRITE_CONFLICT / store_locked; retry after owner exit. No overwrite/revision semantics are added to create. |
| Plan: status / successor | Valid store, current membership and task state | `can_create_plan` is true for an uninitialized or valid store; ordinary next-action priority still reflects active/ready work. Create returns its existing result schema. Migration remains the provenance-bearing import path. | Invalid store still requires the existing repair action before authoring. |

Focused validation: initial/additional authoring including phases and backchain,
unchanged existing membership, duplicate/project mismatch refusal, status/session
consistency, and malformed/unsorted graph pointers on create/migrate. Ship these
tables and implementation together, with Leviathan review and exact-commit
three-OS CI. Historical replay, readiness predicates and storage format stay in
their existing contracts.

## Compatibility and identity

`lattice.project_status.v1` keeps its JSON fields and next_action key sets.
The meaning of can_create_plan expands to true for ready/active_run as well as
uninitialized; invalid remains false. `validateProjectStatus` changes its
ready/active_run requirement from false to true in the same diff. Ready/active_run next_action keeps its
existing work priority and command/reason shape; no authoring schema keys are
added there. Document this capability expansion for hooks/Peertable consumers
in the public contract, ADR 0058 supplement and release notes.

A store is uninitialized when its manifest and plan members are absent; an empty
directory containing only host-local lock/tmp residue is not a published store.
Store owns residue handling and identity/race checks before initial directory
rename activation (ADR 0058 decision 6). Store supplies the read-only
`isUninitializedTodoStore({repoRoot})` layout classification; Plan does not
duplicate its rules. Store checks layout, real identity and owner liveness,
reclaims only proven-dead known transients, then uses rmdir on the same empty
directory before stage rename. It preserves unknown files, members, manifest,
symlinks, live owners and unidentifiable legacy locks. A later initial operation
retries after the live owner exits; ordinary append does not create a missing
store root. Unexpected data or unsafe paths
retain the existing typed invalid state; existing published data is preserved.
Initial × initial creation keeps store_bootstrap_raced. Addition requires a
published manifest and uses the shared lock, so it cannot take the pre-manifest
initial path. CLI discovery is advisory; Store makes the authoritative checks.

Append authoring reuses lock → fresh forWrite read → absent key → staging outside
membership → manifest publication from the membership transaction. It does not
reuse initializeIfMissing, crossPlanDependencies, historical start/done,
narrativeAnchorSources, historical_import genesis or g4 writer.

## Diagnostic pointer spaces

`explainTodoPlan(plan)` is the single rule source; valid input returns null, and
`validateTodoPlan(value)` is exactly `explainTodoPlan(value) === null`. Failures
return reason/path and optional expected/actual; diagnostic objects are allocated
only on failure. Store buildTodoPlan retains TypeError/message and forwards the
diagnostic in error.detail, mapping reason → violation_kind and path → pointer:
`{violation_kind, pointer, expected?, actual?}`. expected/actual are omitted when
absent and are JSON values when present. Create/migrate keep these public keys.
Create input graph paths match plan paths for tasks/hard_dependencies/joins/
phases/phase_accept_dependencies. Computed predecessor/topology/plan digests are
not author fields; failures there are reported as derived-plan diagnostics.
Migrate retains explainTodoExtraction for input/provenance/ordering errors. A
subsequent derived-plan failure reports pointer_space=todo_plan plus task_id when
the path refers to a task; it never claims a filtered plan index is an extraction
index.
ADR 0181 canonicalization covers formatting/BOM/CRLF/digest/path normalization;
it does not sort arrays. Ordering failures require explicit author correction.
