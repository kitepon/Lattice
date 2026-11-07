# Runtime activation prefix race

Owner: Runtime (Tove). Source baseline: main `6c55b9cb`.
Trigger reported by Snow White: PR45 Mac CI run `42366910451`, job
`128386819111`, `hold-resume.integration.mjs:58` / recompile assertion.
Snow White and Ludmilla's Astra trace identify a Runtime race, independent of
PR45's v5 Store reader change. Their source-scope verification is trusted here.

The caller captured a control head after prepare; a heartbeat persisted before
`readActivationControlEvents` returned. Exact tail equality rejected the saved
activation digest although it remained in the durable chain.

The new unit fixture appends exactly one real `controller_heartbeat` through
`createRuntimeControlStore` inside that callback. Before the repair, the test
failed with `EPOCH_ACTIVATION_INCOMPLETE: successor activation event headが未耐久化`.
Its diagnostic showed `expected_in_chain=true` and different expected/actual
tails (expected `05e24b8f…`, actual `b83511d2…`). No sleeps are used to create the race.

Repair: initial/successor activation share validation of durable run/control
prefix membership. A later heartbeat/checkpoint is allowed; invalid/missing or
foreign chains and contradictory activation/stop/plan transitions remain refused
before pointer publication. Pointer bindings and on-disk schemas are unchanged.
Internal commit results and failure details contain separate run/control
`expected_tail`, `actual_tail`, `expected_in_chain`, `chain_valid` and conflicting
event digest. The Mac hold-resume fixture records both comparisons after recompile.

Focused verification:

- `node --test test/runtime-multi-epoch-store.test.mjs`: 11 passed, no skips.
- Deterministic heartbeat callback: failed before the fix, passed afterward.
- Both tails may advance; absent digest, corrupt chain, foreign run, later
  stop/gate/epoch/plan/freeze/resume and future epoch are rejected. Restoring the
  recorded input lets the same staged transaction commit.
- Initial activation and interrupted rename/pointer retries retain their focused
  regression cases. Changed source and Mac fixture pass Node syntax checks.

Mac execution and exact-candidate three-OS CI remain to be recorded with the PR.
No t12 lock, actor, singleton replan or source-commit-gate change is included.
