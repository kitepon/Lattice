# SEC-002 complete sensor suite parser diagnosis

Temporary branch `snowwhite/sec002-windows-sensor-diagnostic`, testing original product
source `3300d770b31e06a1b701e547c10d4899429e4024` in a separate checkout. Do not merge
this dispatch-only CI workflow. The preceding six-case diagnosis remains on its original
branch and its successful result is not full acceptance.

The existing Windows selector/queue is used, with unchanged permissions and identity checks.
Only actual runner id13 / factory-windows-fox-u / dedicated non-administrator is accepted.
Node must remain 24.20.0 / x64 / win32, as observed in the six-case diagnosis.
After ordinary review reports zero required changes, dispatch this branch once.
No runner restart, marker operation, host configuration, or active-job cancellation occurs.

One COMPLETE sensor suite is run per arm, standard parser pool then
LATTICE_SENSOR_PARSE_WORKERS=1. Vitest keeps original maxWorkers=4/minWorkers=1;
there is no test filename filter, retry option, timeout override or new skip.
The preceding six-case harness's 180-second wrapper timeout is not used, as explicitly
confirmed by Dorothy. Product test/parser timeouts and original full-CI 30-minute timeout
are unmodified; this diagnostic job retains its existing 25-minute total budget.
No repeated identical run is launched if any timeout occurs.

Both arms receive the identical existing preload observer. Before EACH arm, the same
npm --prefix sensor run build cleans dist and removes its globalSetup stamp. The unchanged
globalSetup therefore performs its additional build in BOTH arms. There is no first-arm-only
build. File/compile caches can still differ; timings alone do not establish causation.

JSON reports, raw logs and safe fixed-field runtime/kernel records are retained for seven days.
An incremental summary records the current arm/stage before each build and suite. A workflow
hard timeout remains an actual timed_out result in Actions; artifact upload uses always(),
but completion of artifact upload cannot be guaranteed after the whole-job hard deadline.
No environment dump or arbitrary argv/addon path is recorded. Raw test logs may contain
ordinary workspace/temp paths, as with the previous reviewed diagnosis.

Reports must contain the pinned Windows inventory (320 files, 5142 tests); actual complete
assertion inventories must also match between arms. Existing skip/todo counts are recorded
and must match between arms. Missing observations/report, JSONL parse error, test failure,
spawn failure or inventory difference makes this diagnosis fail, never acceptance pass.
The summary always has diagnosticOnly=true and acceptanceFull=false. Reproduction or no
reproduction does not by itself resolve the original full failure or prove source causation.

The old six-case driver is retained as historical diagnostic code but not invoked here.
