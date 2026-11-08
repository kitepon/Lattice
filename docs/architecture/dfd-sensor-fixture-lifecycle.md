# Sensor acceptance fixture process lifecycle

Coach-approved fixture contract, based on accepted main
`6b65edb0f80ae259397bf3d41008c8519993ce9a` (2026-11-07 JST).
This is the canonical function/data-flow contract for the test fixture;
the [function map](function-map.md) composes this boundary. Implementation follows the approved parent-side capture and finalizer contract.
Sensor production behavior remains unchanged.

## Evidence and change scope

The adopted PR53 Windows failure reports candidate PID 39400 still running
while PID 1300 holds the lock. The recorder stores only numeric PIDs, and its
waiter remembers no proven exit. This is a fixture identity defect. The saved
log does not establish whether 39400 was the original survivor or a reused PID.

The complete affected surface is:

- Existing `sensor/__tests__/fixtures/record-detached-spawns.cjs`: retain CJS
  `--require`; record spawn identity, native child exit and asynchronous birth.
- `sensor/__tests__/daemon-candidates.ts`: shared event decoder, monotonic exit,
  cheap-first observations, settlement and bounded diagnostic snapshots.
- `sensor/__tests__/mcp-daemon.test.ts`: replace its direct numeric-log parser
  with the shared reader; replace afterEach's numeric lock-PID kill with the
  existing authenticated stop. Preserve deliberate test-body shutdown signals.
- `sensor/__tests__/mcp-writer-lock.test.ts`: retain authenticated winner stop;
  check original candidates rather than a possibly reused numeric writer PID.
  Direct-mode children retain their original ChildProcess exit waits.
- Product `test/mcp-startup-receipt.test.mjs` (wrapper/proxy fixture) is a third
  reader of the same log through `CG_TEST_SPAWN_LOG`: it collects the `spawn`
  events' PIDs as `tracked` for the managed-daemon teardown. Missing this reader
  left the detached daemon untracked on Windows (PR57 job 128445370145, EBUSY on
  rmdir of the fixture root).
- One small deterministic helper suite for the cases below. Preserve paired
  locks, database integrity, single election/binder and concurrency assertions.

## Parent-side original identity capture

Retain `recordSpawns(fixture)` and the existing CJS preload inherited through
`process.execArgv`. The wrapper does not alter child arguments/environment,
stdio, detached mode, unref behavior or application startup. Candidate tokens
are local to the launcher; no token is passed into the candidate environment.

Immediately after a successful detached spawn, allocate a token, attach the
original ChildProcess's native `exit` listener and synchronously append
`{kind: 'spawn', token, pid: child.pid}` before returning the child. The exit
listener appends `{kind: 'child-exit', token, pid, code, signal}` synchronously.
The token distinguishes different original child objects even after PID reuse.

In that same wrapper invocation, queue one asynchronous capture using the
existing `observeDashboardProcess(child.pid)` from
`src/dashboard-process-control.mjs`. The supported Lattice runtime (Node
>=22.13) can synchronously require this ESM helper because its import graph has
no top-level await. Call the asynchronous observer in the spawn turn, while both
`child.exitCode` and `child.signalCode` are null. Never await its observation
on the candidate's startup path.

When observation resolves, append original `{kind: 'identity', token, pid,
birth}` only after the original child's exitCode and signalCode are both still
null; otherwise discard the late result and retain the native exit fact. A
missing birth or observation error remains explicit capture-unavailable, never
a baseline obtained by later unbound PID lookup. Native exit always wins over
any identity record and is permanent.

### Native lifetime evidence and approved finalizer

Node sets exitCode or signalCode before emitting the child's native exit event.
Its C++ process callback directly invokes that handler. These facts support
checking the original child object rather than reconstructing ownership from a
numeric PID. [Node ChildProcess implementation](https://github.com/nodejs/node/blob/v24.x/lib/internal/child_process.js),
[Node process callback](https://github.com/nodejs/node/blob/v24.x/src/process_wrap.cc).

On Windows, libuv retains its native process handle until exit dispatch, reads
the actual exit code, closes the handle and invokes the exit callback. Microsoft
explains that a PID remains attached to its process object while any process
handle exists. Thus a still-retained original handle protects parent-side PID
observation from rebinding. [libuv Windows process lifetime](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c),
[Microsoft PID reuse semantics](https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803).

On Unix, a terminated child retains its PID/status until reaping; libuv owns
the child wait. However, Node24's bundled libuv reaps a batch of children before
calling their exit callbacks, and Node callback completion can run Promise
microtasks between callbacks. Therefore null JS exit fields alone do not
prove an unreaped Unix child at every possible Promise continuation. This is
an inference from source order, not a reproduced failure.
[Linux wait/reaping contract](https://man7.org/linux/man-pages/man2/wait.2.html),
[Node24 bundled libuv wait loop](https://github.com/nodejs/node/blob/v24.x/deps/uv/src/unix/process.c),
[Node callback microtask handling](https://github.com/nodejs/node/blob/v24.x/src/api/callback.cc).

Approved capture finalization: on observation resolution, queue one
parent-only `setImmediate` finalizer, then recheck both exit fields immediately
before writing identity. This lets the current native exit-dispatch batch finish;
a reaped original child has published its exit before identity is accepted. It
adds no candidate startup wait. The null-fields-only Unix check is insufficient; the finalizer is required.
No native addon, self preload or generic process framework is needed.

The reused observer supplies Linux boot/start ticks, Windows start FILETIME and
macOS `ps lstart`. macOS precision is one second: an equal birth can conservatively
keep a reused PID pending; a different known birth proves original exit. Birth
equality never licenses signaling. Only teardown waits for OS observation; its
Windows command cost consumes the existing teardown budget, with no blocking
PowerShell call or added candidate-start wait. Parent-side asynchronous capture
still uses OS resources and may be lost if its launcher exits first.

## Functions and state ownership

| Function / owner | Public contract and callers | Owned state / output | Failure and unknown handling |
|---|---|---|---|
| `recordSpawns(fixture)` / fixture helper | Existing `{args, env}`; both launcher helpers | Existing CJS preload and sibling log; initialize without truncating previous launcher records | Initialized empty log means zero candidates; unexpected missing/unreadable log remains unknown. |
| Spawn recorder / CJS preload | Launcher's detached spawn and original child's native exit | Small token-keyed spawn, identity/capture-unavailable and child-exit events | No await on startup; native errors preserved. Late identity after exit discarded. |
| `readCandidateSnapshot(fixture)` / fixture helper | Waiter and daemon-test failure-evidence reader | Original token/PID/birth, current observation and terminal reason | Shared decoder/cache; never reinterpret unreadable data as an empty list or replace original birth. |
| `settleLosingCandidates(fixture, holder, timeoutMs = 30_000)` / fixture helper | Existing signature; both teardown paths | All original candidates except current holder prove exit | Holder exclusion is provisional, never an exit fact; never signals losers. |
| `stopDaemonAt(realRoot, {preserveUnverified: true})` / existing registry | Both teardown paths after losers settle, except holder PID equals `process.pid` | Existing authenticated winner stop | Retain identity/lock rechecks; no fixture numeric-PID fallback. Non-worker unverified/still-running fails. |
| Final `settleLosingCandidates(fixture, () => null, remainingBudget)` / fixture helper | Both teardown paths before deletion, including worker-holder case | All original candidates prove exit without holder exemption | Unknown/live original candidate fails within the same initial budget. |
| `removeSpawnLog(fixture)` / fixture helper | After tracked launchers and all original candidates exit | Remove only this test's owned log/fixture bytes | Include bounded failure evidence before removing records; no success-shaped cleanup of unknown candidates. |

The recorder alone writes spawn, identity/capture-unavailable and child-exit.
The shared helper alone records confirmed absence/birth-change as terminal
observation-exit facts, once per token. Merge events by token; exit is permanent
regardless of event ordering. Contradictory records remain diagnostic unknown.
A transient incomplete append may be reread within the same deadline; persistent
invalid records fail. This ephemeral log needs no numeric-format migration.

## Data flow and unchanged deadline

| Stage | Producer → consumer | Data / decision | Persistence / result |
|---|---|---|---|
| Prepare | Test → `recordSpawns` → launcher | Existing CJS preload, sibling log | Empty initialized log preserves a genuine zero-candidate case. |
| Spawn | Launcher CJS wrapper → original ChildProcess | Token + PID, immediate native exit listener; queue asynchronous capture | Spawn recorded before returning; original child remains bound to listener. |
| Capture | Launcher → existing observer → launcher finalizer | Birth accepted only while original child exit/signal fields remain null; late result discarded | Immutable original birth or explicit unavailable; approved finalizer above qualifies Unix acceptance. |
| Stop launchers | Test → tracked ChildProcess objects | Await existing launcher exit protocol | No new candidates; launcher exit is not detached-child exit. |
| Wait losers | Shared waiter → log + cheap liveness + cached birth observations | Re-read holder; evaluate every original candidate except provisional holder | Persist proven exit, retain unknown/live pending. |
| Stop winner | Test → existing authenticated stop, unless holder PID is current worker | Current worker is never signaled; otherwise existing authenticated identity/lock checks | Stop result alone does not prove all candidates exited. |
| Final all-candidate wait | Shared waiter with holder callback returning null | Evaluate every recorded original, including any prior winner | Required for every cleanup branch; unknown/live candidate fails. |
| Remove/report | Test → its own fixture bytes / error evidence | Remove only after lifecycle checks; otherwise report bounded snapshot | At most 16 candidate details plus total counts and existing 8-KiB log/stderr tails; checks evaluate all candidates. |

Each poll first checks native/terminal facts, then `process.kill(pid, 0)`.
ESRCH is proven absence; EPERM and unexpected errors are unknown. For live
pending candidates with an original birth, query the existing birth observer
concurrently, at most approximately once per second per candidate, with one
in-flight observation per candidate. Fast log/kill-zero polling may retain the
existing 25-ms cadence; it must not spawn PowerShell on that cadence. Snapshot
formatting reuses cached observations and does not start duplicate commands.

Use one unchanged 30-second budget beginning at the first loser wait. Winner
stop, concurrent OS observations and final settlement consume its remaining
time; never reset it per candidate, observer, poll or second settlement call.
The outer 45-second afterEach timeout remains. The writer fixture already calls
cleanup both from its body and afterEach: retain a per-test cleanup-complete
flag set only after all exit proofs and fixture removal succeed, so its second
call does not reinterpret its successfully removed log as missing evidence. Windows command costs occur in
asynchronous parent observation and teardown, never a blocking candidate preload.
A late command result cannot turn an expired deadline into successful cleanup.

## Current-worker holder

Some daemon tests deliberately put the Vitest worker's `process.pid` in the
lock and host a mismatched hello on a mini-server. If the current holder PID
equals `process.pid`, withhold daemon stop/signals to that PID. This equality
only prevents signaling the worker; it proves neither candidate exit nor absence
of another daemon. Add no per-test registry, lock-byte record or server argument.
The mini-server's existing test-body `finally` still closes its owned server.

After launchers exit, the same final all-candidate wait runs with no holder
exemption. If all original candidates have proven exit, including a legitimately
empty initialized log, remove only the test-owned fixture/log/database bytes and
preserve the worker. One unknown or live original candidate still fails. A
failed socket hello never changes a candidate into exited; arbitrary unverified
non-worker holders do not gain this cleanup branch.

## Monotonic candidate state

| Previous state | Evidence | Next state |
|---|---|---|
| Spawn recorded | Accepted parent-side birth while original child remains unexited | Identified pending; birth immutable. |
| Pending/unknown | Original ChildProcess native exit event | Proven exited, retaining code/signal/source. |
| Pending/unknown | kill-zero ESRCH, or observer confirms missing/zombie | Proven exited, reason absent. |
| Identified pending | Different current known birth | Proven exited, reason birth-changed; new occupant untouched. |
| Identified pending | Live PID and equal birth | Pending; coarse same-second birth can conservatively delay settlement. |
| Pending/unknown | EPERM, observer error, unavailable original/current birth, invalid log | Unknown; retry within existing budget, then fail with evidence. |
| Proven exited | Later reused/live PID, new identity result or observation error | Remain exited; never overwrite original identity or resurrect token. |

Unknown can exit automatically through native exit, later confirmed absence or,
with an original known birth, a changed birth. Expiry is a bounded test failure;
it authorizes no unsafe signal, silent deletion or increased timeout.

## Minimal deterministic acceptance cases

1. Original birth A and current live A: loser stays pending; no early winner stop.
2. Proven native/absent exit followed by reused live PID/birth B: remain exited
   across reads and do not signal B. Also cover B as the first changed-birth proof.
3. Missing original birth, EPERM or observation failure: unknown fails with
   bounded evidence; later confirmed absence can settle. Failed hello cannot.
4. Current-worker holder with all candidates exited: preserve worker, send no
   signal and allow fixture-byte removal; one unknown candidate prevents removal.
5. Identity observation resolves after original native exit: discard birth,
   preserve terminal exit. Cover concurrent/throttled pending probes without
   real PID reuse or repeated PowerShell commands.

Preserve all existing paired-lock, database, election and concurrency assertions.
Verification is scoped to the cases above and the affected fixture integrations;
no historical full-suite or manual CI rerun belongs to this repair. Historical survivor-versus-reuse remains unconfirmed.
