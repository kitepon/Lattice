# SEC002 root reason caller candidate

This temporary caller is separate from the observed product source. The registered
upstream-check.yml entry is replaced only on this feature branch by a manual-only Windows
caller; it performs no upstream check or schedule. The default branch is unchanged.
The product ci.yml is kept verbatim at 3300d770. Do not dispatch ci.yml or the old pool driver.

The caller pins product checkout to 83bc4124e95e8537f0f1f244205c9ae20e364b25 with a full clone,
checks its complete HEAD, tracked clean state and all 20 paths against the original 3300d770,
and checks the same source after execution. Identity/id13 and Node24.20.0/x64/win32 guards
precede npm installs. Only the API identity step receives GH_JOB_TOKEN; both checkouts
use persist-credentials:false. The regular Windows selector and 25-minute budget remain.

Dependencies remain npm ci && npm --prefix sensor ci. Exactly one standard-pool command is
npm --prefix sensor run build && npm run ci. The original logical CPU calculation and
root/docs-before-sensor order are retained. No Vitest reporter/config/test filter/retry,
timeout, skip, worker count, parser override or old preload is added. Observer unit7 stays
outside the product inventory. Trace directory is the only observation env addition.

Raw stdout/stderr is preserved as test.log and raw per-PID/thread JSONL as raw-events/.
Derived av-events.jsonl, source-events.jsonl and summary.json are separate. Summary records
progress and last known command stage before completion, then status/signaled/spawn failure,
missing cases/source edges, malformed rows, write failures and last stage per stream.
An incomplete artifact or hard job timeout is not successful observation and is not rerun.
Always-upload is best effort; Actions raw log remains evidence if the job is forcibly ended.
No AV recurrence yields only a normal timing baseline, not an AV classification or acceptance.

The initial source32 candidate inherited an old diagnostic ci.yml. Its unmodified docs gate
failed two documentation-ci-contract assertions and would stop the full command before
sensor. The pinned source381 restores only ci.yml verbatim from 3300d770 and passes the
same docs gate; all observer code and tests remain identical to source32. No assertion is
weakened or skipped. The 20-path allowlist excludes ci.yml, because it is now identical to
3300d770. Driver command execution uses PowerShell 7 with the original command and explicit
LASTEXITCODE forwarding. The diagnostic Node driver is an additional ancestor process;
product child creation and CLI re-exec logic are unchanged. Summary command stages include
a fixed root/sensor component so their npm test stages remain distinguishable.

Dispatch still requires the requester's acceptance of the exact replacement source SHA
and final caller review with mandatory fixes zero. No run is consumed during preparation.


This is a separate head for root-failure reason observation, not a retry of run38775137903.
The source differs from 38113055 only by one test's assertion message. Its comparison and
expected value are unchanged. If the resolution report fails again, test.log gains only
fixed outcome/reason/httpStatus and mock-intake receivedCount. receivedCount=1 means no
second complete request body was recorded; it does not prove no network bytes arrived.
receivedCount=2 means the mock recorded that complete body, not that the client accepted
the response or persisted acknowledgement. The reason separates transport, receipt and ack
categories; it does not provide errno, socket reuse, exact ack substage or stage durations.
If the case passes, no failure message is emitted and no root failure reason is learned.
If root fails, the original && command still stops before sensor; event0 is unobserved,
not a claim of AV non-recurrence. Nothing bypasses root/docs or turns missing data green.

A later authorized run would use its own sec002-lattice-root-reason-${run_id} directory and
sec002-lattice-root-reason-diagnostic artifact. Old full/6case/sensor/stage raw evidence stays
separate. Current authorization covers preparation/local checks/review only: DO NOT DISPATCH.
Identity/runtime, standard pool, original four sensor forks/timeouts/skips and 25 minutes
are unchanged. No Windows run or host probe is performed during this preparation.
