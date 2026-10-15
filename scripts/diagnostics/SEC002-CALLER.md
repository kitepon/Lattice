# SEC002 root timeline caller candidate

Preparation only: DO NOT DISPATCH. This manual-only feature-branch caller uses the
registered upstream-check.yml entry. The default/weekly workflow is unchanged. Do not
run ci.yml or any old pool driver. Product ci.yml is byte-identical to original 3300d770.

Product source is pinned to 478947af3470982bfc8c810e99b2f8d35a5c81f9, with fetch-depth:0,
persist-credentials:false, exact HEAD, complete 20-path allowlist against 3300d770 and
tracked clean checks at entry/run end/finalize. ci.yml is excluded from that allowlist.
The only source change from 83bc4124 is test/runtime-error-reporting.test.mjs. Product
src and existing sensor observation are unchanged. Identity/actual id13/non-administrator
and Node24.20.0/x64/win32 must pass before installation. Only the API guard step receives
GH_JOB_TOKEN. A caller Node wrapper is an additional ancestor of pwsh/npm/product children.

The original logical CPU calculation, npm ci && npm --prefix sensor ci, and one standard
pool npm --prefix sensor run build && npm run ci command remain, using pwsh and explicit
LASTEXITCODE forwarding. Root/docs run before sensor; the original && stops on root failure.
No reporter/filter/retry/timeout/skip/fork/parser override/preload is added. Sensor remains
four forks, original product timeouts and skips. Job budget is 25 minutes, no rerun.
Observer unit7 and new diagnostic local units remain outside normal test inventory.

LATTICE_SENSOR_STAGE_TRACE_DIR is the only observation environment addition. The target
root case accumulates at most 64 fixed events in memory, uses numeric WeakMap identities
for existing accepted sockets, and writes once after the existing close then rm cleanup.
No additional POST/store read/process/thread/listener/timer/Promise reaction is installed.
When observation is off there is no timeline clock, buffer, WeakMap or sink. Preparation
failure and original cleanup exceptions keep their original behavior; the outer finally
only attempts diagnostic persistence. Clock/allocations/final write still perturb timing.

Root root-report-timeline.jsonl sits directly in the artifact output directory, outside
sensor raw-events/. test.log and both raw event sets are preserved separately from derived
av-events.jsonl, source-events.jsonl and summary.json. rootTimeline summary validates fixed
schema/fields/stages, sequence/PID/monotonic stream, one footer, mandatory boundaries and two
mock body/response points. Missing/malformed/unreadable/partial/overflow/observer-error or
the fixed write-failure marker prevents observationComplete. A sink that writes then throws
also fails via the marker. Partial rows and last stage remain available, never counted as
complete. Product nonzero exit remains failure even if observations are valid. Hard kill
can prevent persistence/upload; absence is missing evidence, not a successful observation.

Intervals include existing fixture/store/report/cleanup boundaries. mock_body follows
requests.push; mock_response_queued follows response.end returning. Queueing is not client
receipt. A report interval includes credential/store preflight, network, receipt and ack,
not network-only or ack-only timing. nothing_pending records interval only, no outcome.
receivedCount is complete bodies recorded by the mock, not bytes arriving/client acceptance.
sameAcceptedSocket compares server-side object identity only for two completed bodies;
a missing second body gives no evidence of the failed client's socket reuse. No errno,
internal ack lock/rename/DACL stage or new post-failure store snapshot is collected. Paths,
URL/port/argv/env/body/key/report ID/signature/error text are absent from root event fields.

This new source/caller is a proposed observation step, not a retry of either prior run.
Output is sec002-lattice-root-timeline-${run_id}; artifact is
sec002-lattice-root-timeline-diagnostic. Preserve old full/6case/sensor/stage/reason originals.
A root failure still means sensor unobserved; event0 is not AV non-recurrence. Healthy stages
are a baseline only; a healthy root does not explain the old unconfirmed report. Standard
native build absence is distinct from an unobserved original external kernel override.
No result substitutes for original full acceptance, root/source/AV classification or repair.

Execution requires a separate Dorothy decision after exact source/caller SHA, local checks
and both implementation reviews have mandatory fixes zero. The 03:17 design review does
not replace those reviews. Current authorization is implementation/local checks/read-only
review/caller preparation only. No Windows run, new host probe/auth/permission change or
other job interruption occurs here. Reviewer must read saved evidence and code only; the
implementation owner performs necessary Linux checks, which do not prove Windows behavior.
