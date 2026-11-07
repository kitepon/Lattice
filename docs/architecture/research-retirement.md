# Research retirement manifest

Baseline: commit `047139e5da6f27d7105d9d24bcdedcd394cf8f0b` (0.79.5). The source inventory below is the exact `RESEARCH_ARTIFACTS` declaration at that revision.

## Retired source modules

- `src/bounded-seam.mjs`
- `src/seam-transform.mjs`
- `src/treatment-compiler.mjs`
- `src/treatment-runner.mjs`
- `src/rc1-black-box-oracle.mjs`
- `src/rc1-comparison.mjs`
- `src/rc1-evidence-bundle.mjs`
- `src/rc1-v4-campaign.mjs`
- `src/rc1-v4-transform.mjs`
- `src/rc1-v5-artifact-set.mjs`
- `src/rc1-v5-behavior-evidence.mjs`
- `src/rc1-v5-campaign.mjs`
- `src/rc1-v5-transform.mjs`
- `src/rc1-v6-artifact-set.mjs`
- `src/rc1-v6-behavior-evidence.mjs`
- `src/rc1-v6-campaign.mjs`
- `src/rc1-v6-causal-binding.mjs`
- `src/rc1-v6-measurement.mjs`
- `src/rc2-artifact-set.mjs`
- `src/rc2-campaign.mjs`
- `src/rc2-delivery-policy-front-end.mjs`
- `src/rc2-delivery-policy-oracle.mjs`
- `src/rc2-delivery-policy-transform.mjs`
- `src/rc2-rc1-transfer-front-end.mjs`
- `src/rc3-actual-dogfood.mjs`
- `src/rc3-dogfood-scaffold.mjs`
- `src/rc3-scripted-campaign.mjs`
- `src/rc4-stage1-dogfood.mjs`
- `src/boundary-compiler.mjs`
- `src/control-compiler.mjs`
- `src/artifact-contracts-v2.mjs`
- `src/runtime-scripted-executor.mjs`
- `src/runtime-worktree-executor.mjs`

## Removed historical test suites (41)

- `boundary-compiler.test.mjs`
- `bounded-seam.test.mjs`
- `control-compiler.test.mjs`
- `integration/control-compiler.integration.mjs`
- `integration/control-portability.integration.mjs`
- `integration/rc1-v4-campaign.integration.mjs`
- `integration/rc2-delivery-policy-transform-sensor.integration.mjs`
- `integration/rc2-sensor-artifact-scope.integration.mjs`
- `integration/rc3-actual-dogfood.integration.mjs`
- `integration/rc3-dogfood-scaffold.integration.mjs`
- `integration/rc3-event-store-scope.integration.mjs`
- `integration/rc3-scripted-campaign.integration.mjs`
- `integration/rc3-worktree-executor.integration.mjs`
- `integration/rc4-stage1-dogfood.integration.mjs`
- `integration/seam-transform.integration.mjs`
- `integration/treatment-recompile.integration.mjs`
- `rc1-black-box-oracle.test.mjs`
- `rc1-comparison.test.mjs`
- `rc1-evidence-bundle.test.mjs`
- `rc1-v4-campaign.test.mjs`
- `rc1-v4-characterization.test.mjs`
- `rc1-v4-transform.test.mjs`
- `rc1-v5-behavior-evidence.test.mjs`
- `rc1-v5-campaign.test.mjs`
- `rc1-v5-transform.test.mjs`
- `rc1-v6-behavior-evidence.test.mjs`
- `rc1-v6-campaign.test.mjs`
- `rc1-v6-causal-binding.test.mjs`
- `rc1-v6-measurement.test.mjs`
- `rc2-artifact-contracts-v2.test.mjs`
- `rc2-artifact-version-witness.test.mjs`
- `rc2-campaign.test.mjs`
- `rc2-delivery-policy-fixture.test.mjs`
- `rc2-delivery-policy-front-end.test.mjs`
- `rc2-delivery-policy-transform.test.mjs`
- `rc2-rc1-transfer-front-end.test.mjs`
- `rc2-v6-compatibility.test.mjs`
- `rc3-compatibility.test.mjs`
- `seam-transform.test.mjs`
- `treatment-compiler.test.mjs`
- `treatment-runner.test.mjs`

The product test runner no longer filters these files through `retiredArtifactReplaySuites`; the deleted suites remain absent from the product gate and recoverable by checking out the baseline or recorded historical commit. The live runtime-engine and hold/recompile suites remain. Their in-process executor fixture now lives at `test/helpers/scripted-executor.mjs`, outside the shipped package source. The live seam-derivation suite retains derivation and all five required verification-policy assertions; only its retired bounded-candidate validator assertions were removed.

## Historical evidence and live product boundary

Historical ADRs, evidence, RAG, and campaign artifacts remain unchanged. In particular, `docs/evidence/2026-08-05-rpf-006-integration-and-claims.md` is a fixed execution record citing commits `61507a7`, `61c2004`, and `b24b4d1`. Its RC3 scripted-campaign citation can be replayed by checking out the recorded historical revision. This retirement does not rewrite that record or imply new verification.

The maintained product loop remains: planned parallel-development benefit; boundary and conflict observation; actual isolated seam transformation with verification; reindex and recompile of affected plans. Runtime continues to observe actual edits and resolve conflicts. Current live replacements are boundary-observation compiler v2, seam proposal/derivation and transform modules, isolation runner, runtime diff observer, managed supervisor, and bundled sensor. The four public bins, runtime and adapters, seam functionality, sensor, and public contracts remain.

Current live equivalents cited by the RPF-006 record include the runtime-conflict CLI, hold/resume and hold/transform/resume integrations, and the prediction-excess daemon integration. The last is macOS-only. No CI or cross-platform coverage claim is made here; the parent task owns full CI.
