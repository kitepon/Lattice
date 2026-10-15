# SEC-002 Windows parser pool diagnosis

Temporary branch `snowwhite/sec002-windows-parser-diagnostic`, based on product source
`3300d770b31e06a1b701e547c10d4899429e4024`. Do not merge its dispatch-only CI workflow.
The workflow uses the existing Windows selector and refuses any assignment except
runner id13 / factory-windows-fox-u under its non-administrator dedicated account.
It checks out the pinned product and this diagnostic harness into separate directories.
No product source or tests are changed. Standard dependency/build commands are retained.

After ordinary review reports zero required changes, dispatch this branch once with
`environment=windows-native`. No manual host operation or runner restart is needed.
The job shares the existing SEC002 Windows comparison concurrency group and never
cancels an active job.

The original six-case index-command test file is run three times per arm, alternating
standard parser pool and LATTICE_SENSOR_PARSE_WORKERS=1. Vitest retains its original
maxWorkers=4/minWorkers=1 configuration; only one test file is selected. Both arms have
the identical observer loaded using NODE_OPTIONS. Ambient parser overrides cause refusal.
Each repetition gets a JSON test report, raw test log and per-process/thread JSONL records.
A missing/incomplete report, skipped case, spawn failure or test failure makes the job fail.
Each repetition must also record runtime, main-thread sensor CLI and TS kernel-selection
events; their counts are included in summary.json. Missing observations are incomplete.

The observer records Node version/arch/platform, PID/thread/parent PID and fixed entry kind;
only two allowlisted execArgv values and a count of other arguments; boolean presence of
relaunch guards and explicit kernel path; parser arm and the actual TS kernel-support choice.
It never records arbitrary argv, environment values, executable paths, addon paths or tokens.
It observes the existing loader call without proactively loading any native addon.
This observer can perturb timing, so this is a diagnosis, not an uninstrumented acceptance run.

The artifact summary always says diagnosticOnly=true and acceptanceFull=false.
No recurrence in the short test does not establish equivalence or a full pass.
If necessary, a separate proposal will preserve all sensor suites at four forks and vary
only parser pool size. That proposal is not executed by this workflow.
