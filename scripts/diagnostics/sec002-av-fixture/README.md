# SEC002 fixed-binary fixture controller preparation

No Windows execution or dispatch is authorized in this preparation. Product code,
hooks/full CI, host settings/permissions/authentication and SDKs are unchanged.

The only allowed download is repo kitepon/Lattice run38801258793 artifact12004154981,
526617-byte ZIP SHA256 f9f73e84517e980a1a7cc436592f857bb765cb3b4344578bcba07875eccff205.
All16 files/1489200 bytes must match artifact-files.json before either EXE is enabled.
Flat allowlisted ZIP paths, count/size/compression bounds, duplicate/path/symlink
rejection, individual hashes and PE32+/AMD64/console/KERNEL32-only are checked.
No latest download, arbitrary URL, fallback or policy bypass. Expired/unavailable
artifact or unsigned policy refusal is unavailable, never an admission pass.

First and only normal call is admission. Status0, exact fixed stdout/stderr bytes,
canonical metadata schema, coverage/loader acceptance, no fault, EOF, zero owned
active processes, unchanged source and sentinel alive are required. On failure
stop; do not consume another mode. Then exit1, exit-av, read, write, execute,
handled, thread, breakpoint, child, child-delay each once, 15-second soft budget between APIs per
mode plus3-second cleanup budget. A blocked synchronous API is not guaranteed to
return within15seconds; the finite25-minute job bounds the whole controller. No retries. These are fixture budgets, not
product timeout changes. Each mode has a new cwd/raw filename. All process handles
come from our own suspended CreateProcess call; atomically assign own non-inherited KILL_ON_JOB_CLOSE job using
PROC_THREAD_ATTRIBUTE_JOB_LIST at CreateProcess, check membership, then ResumeThread.
Unavailable atomic assignment fails closed; no non-atomic fallback. This also
covers controller death between creation and an explicit assign call. Breakaway flags/resource limits are not
added. Only three stdio handles are inherited. Native GetExitCodeProcess preserves
DWORD values. Pipe reads poll PeekNamedPipe, avoiding blocking EOF reads/extra
reader threads. Timeout/collector death affects our owned fixture tree only.
Job accounting/EOF/cleanup unknown is failure/partial. The sentinel is a separately
owned Node stdin-wait process with its own job; it must remain alive through all
mode checks and is then closed/reaped through its original handles. No PID search,
OpenProcess/OpenThread/attach/host enumeration or other-job kill.

Raw capture/native stdout/stderr stay in quarantine. Only canonical allowlisted
observations plus hashes/counts/verdicts are uploaded; actual stdout/stderr bytes
are uploaded only when equal to the fixed known fixture strings/empty bytes.
Invalid/missing observations stay partial; raw unknown text is not uploaded.
Quarantine is job-local, retained through finalization and removed only by the
runner's ordinary temporary-directory lifecycle. No host archive cleanup.

The fixed binary labels its application image 'node'/targetNode even when the
application is our fixture. The controller marks this as fixture image labeling;
it proves nothing about Node/V8/WASM or the original AV. Stack remains unavailable
and frames empty. execute AV can have complete exception fields but no mapped
module; the existing helper's metadataComplete=false is expected for this case.
child requires fault PID different from root, exit-av requires no exception.

Actual receipt of arbitrary argv/cwd/env is not observable in the successful
fixed11-mode binary. The controller passes a fixed mode/cwd and inherits its own
environment unchanged; the helper's only deliberate environment mutation is the
fixed heap-disable request. This is source/launch-plan preservation, not empirical
child-env identity. receivedArgvCwdEnvVerified stays false. Extra fixture9b763 was
not compiled in the allowed artifact and is never counted as passed. Adversarial
controller-death/nested-job/handle/large-pipe/Unicode/env-reexec tests also need
separate fixture/controller scope. Core11 pass is not complete Win32 or product
acceptance. SafeHandle/Win32 layout, nested jobs, unsigned policy, loader matching,
pipe EOF and cleanup are still Windows-unverified in this preparation.
