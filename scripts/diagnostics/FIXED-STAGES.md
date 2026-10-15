# SEC002 fixed stage observation candidate

This is an observation-only diagnostic patch on product source
3300d770b31e06a1b701e547c10d4899429e4024, kept on a separate temporary branch.
It is not a product repair, release, Windows acceptance, or a worker1 configuration.
No CI dispatch is authorized by preparing this candidate.

Enable only with an existing absolute LATTICE_SENSOR_STAGE_TRACE_DIR. The observer creates
no directories, processes, threads, Promise handlers, retries, timers or exit handlers.
Unknown/unrelated cases are silent. Only the six original index-command cases and the
currency read-error target are recorded; caller case IDs are a fixed enum.
The original suite inventory stays unchanged: observer unit checks and their config are
outside __tests__, and run only with the explicit diagnostics-tests local config.

Every row has fixed stage/edge, case ID, CLI call order, PID/parent PID/thread ID,
per-module sequence, UTC and monotonic time. Runtime rows add Node version/arch/platform,
two allowlisted flags, guard-presence booleans and normalized pool request. Pool markers
record the actual pool size, kernel markers only native/wasm, git markers only a fixed
command category. No arbitrary argv/env, path, source text, error message or dump is written.
The sink is per-process/thread JSONL. priorWriteFailures is a count, never an error message.

CLI helper order starts at 1 for each case. In cli-idempotent, init=1, first index=2,
second index=3. The helper emits cli_spawn enter/leave and preserves the original stdout
return and thrown child error. The actual CLI emits runtime before the existing re-exec,
and its real child and parse/store threads emit their own PID/parent/flags metadata.
No extra CLI or thread is launched by observation. The case/call context remains active
for subsequent in-process graph reads in that case. Child failures add only signaled
(boolean) and an allowlisted spawn error code (unknown codes become other); no signal name
or original error text is emitted.

AV markers: grammar_bytes enter/leave; grammar_load around the existing worker grammar
load/compile await; kernel_load around the first uncached native load/contract attempt; pool_start enter/leave around the existing eager
spawn; pool_ready points for each existing grammar acknowledgement; first_parse enter/leave
for the first parse in each existing worker; store_open enter/leave in the existing writer;
store_drain request/reply keyed by numeric op; pool_shutdown enter/leave around existing join.
A missing leave can be an exception, native crash, forced exit or sink failure. It does not
by itself identify a native fault. Existing return/throw behavior remains authoritative.

Source timeout markers are independent: currency_before_each, currency_body,
currency_after_each, currency_commit, currency_sync_fault, currency_sync_recovery,
currency_get_changed, currency_db_close and currency_fixture_rm boundaries, plus the
injected-read point/count and fixed git category. mutex_wait brackets only existing queued
waits. wal_worker and maintenance_worker bracket existing Worker construction through the
first original completion callback, paired by numeric op (not worker termination). The existing read failure, both syncs,
assertions and cleanup order are unchanged. observeSync returns exactly the delegated value
(including the same Promise), forwards the same exception and adds no Promise reaction.
Async boundaries are statements inside original functions, without wrapping their returns.
The file write sink catches its own failures so it cannot replace a product exception.
Missing trace or any priorWriteFailures makes observation incomplete, never a success claim.

Next dedicated execution proposal (NOT executed in this task):

- One Windows diagnostic run, actual id13/factory-windows-fox-u, same non-admin account
  and Node24.20.0/x64/win32. Keep standard parser pool, original product test/parser
  timeouts, skip policy and four sensor forks. No pool comparison or retry.
- Checkout the exact new diagnostic commit with fetch-depth 0; verify its parent/base and
  the full sorted diff-path allowlist to 3300d770, including inherited diagnostic files;
  verify the literal complete candidate SHA, not just its parent. This intentionally changes source only by
  observational statements; do not assert HEAD==3300d770 for this variant.
- Restore the original npm ci && npm --prefix sensor ci dependency step and the original
  npm --prefix sensor run build && npm run ci command. Thus root/docs run before sensor,
  unlike the previous sensor-only and shallow-clone diagnosis. Trace is silent for unrelated
  cases, so root warm-up does not generate a broad event stream.
- Use the existing Windows selector/regular queue, no cancellations, host settings or marker
  operations. Keep the diagnostic outer budget at 25 minutes (original product full job
  remains 30); no per-case/per-parser timeout change. A whole-job timeout is an actual
  incomplete result, not grounds for repeating the run.
- Preserve AV case streams and source currency target stream separately in the artifact.
  Check CLI call order/actual child flag and pool/kernel records, both normal and missing
  stage pairs, and before/body/after times. Without AV recurrence this yields only a
  normal timing baseline; AV classification does not advance and no automatic retry follows. Preserve child status and each assertion result.
- Remaining differences: observation source patch and synchronous trace I/O, compile/file
  cache and execution timing, dedicated user's environment. Even with full clone/root warm-up
  restored, this is diagnostic evidence, not acceptance or proof of root cause.

The existing ci.yml on this branch still checks out 3300d770 and runs the previous pool
comparison. It MUST NOT be dispatched for this candidate: it would not exercise this patch.
A reviewed dedicated caller must be prepared separately after the next execution is agreed.
