# SEC002 fixed-stage caller candidate

This temporary caller is separate from the observed product source. The registered
upstream-check.yml entry is replaced only on this feature branch by a manual-only Windows
caller; it performs no upstream check or schedule. The default branch is unchanged.
The product ci.yml is kept verbatim at 3300d770. Do not dispatch ci.yml or the old pool driver.

The caller pins product checkout to 32f2113bd874a93338a70aff04931474b4585a30 with a full clone,
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

Known pre-dispatch blocker: exact source32 inherited an old diagnostic ci.yml. Local
npm run check:docs fails two existing documentation-ci-contract assertions (reuse of the
product workflow and the three-environment option contract). The original full command
would stop before sensor. This caller MUST NOT be dispatched while that blocker remains.
No assertion is weakened or skipped. A separate source candidate restoring only ci.yml
verbatim from 3300d770 passes the same docs gate; using it needs an explicit replacement of
the pinned source SHA and path allowlist in a reviewed caller. Source correction is workflow
restoration, not a parser/timeout repair; all observation code remains identical to source32.
