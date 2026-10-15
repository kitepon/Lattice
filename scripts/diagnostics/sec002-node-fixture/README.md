# SEC002 pinned Node fixture preparation

Owner: Snow White. Preparation/push only; no Windows execution or dispatch has
been authorized for this head. The fixed capture binary stays unchanged. Existing
11 native fixture modes are not repeated. Native fixture9b763 is not compiled or
used. Product sources/tests/hooks/full CI, SDKs, host settings and privileges are
unchanged. Read-only implementation review must not compile/run/probe anything.

## Three independent cases, once each

1. handoff: one direct Node baseline, then one capture-wrapped Node comparison.
   Both run the same pinned script/argv/cwd under unchanged controller environment.
   The helper's only allowed environment change is `_NO_DEBUG_HEAP=1`. The guard
   requires this variable absent at baseline; no arbitrary difference is accepted.
   Empty/quotes/backslashes/trailing backslashes/spaces/Unicode arguments have
   fixed in-script expectations. Cwd is a private run-local Unicode path. Exact
   argv/cwd/env/execArgv/execPath hashes are compared inside the fixture; hashes and
   context values remain private. The whole environment, including variable names,
   is compared except the single heap variable; only booleans are public. Each
   root/child/grandchild is checked separately. Baseline captures a reference; it
   does not claim to have compared environment. Wrapped receipts declare the actual
   comparison result. `launchContext` declarations are not used as proof.
   All three processes together write exactly 1MiB of byte0x53 to stdout and 1MiB
   of byte0x45 to stderr. Parents leave before the grandchild's250ms timer finishes;
   EOF and job accounting must keep the controller waiting for the descendant.
2. timeout: capture+Node root/child/grandchild hold. Three ready receipts and four
   own active processes are required before the intentional5s timeout terminates
   only the controller's dedicated job. Status125/expectedTimeout/forced/EOF/active0
   and no fallback are expected. This changes no product timeout.
3. collector-kill: same three holding Node processes. At ready3/active4, terminate
   only the original collector process handle (status126). The helper's own
   KILL_ON_JOB_CLOSE job must clear its descendants; the controller's outer job
   must reach active0/EOF within3s without fallback job termination. A fallback
   cleans only our outer job but makes the case fail. This tests collector death,
   not controller death in the middle of CreateProcess (still unproven).

Handoff admission must pass both launches before cases2/3. Each case/phase runs
once; failure stops all later work. 15s soft total wait,3s post-control/cleanup,
25min whole job. A synchronous Win32 call may exceed the soft budget; job timeout
is the overall bound. All trees and a separate own-job stdin-wait sentinel belong
to this controller. No PID/name enumeration/OpenProcess/attach/other-job kill.
Own process handles come only from CREATE_SUSPENDED/JOB_LIST launch. Input is NUL;
only three stdio handles inherit. Original N implementation is reused unchanged.

## Identity, pins and output

Reuse run38801258793/artifact12004154981/ZIP526617/full SHA and all16 manifest,
safeZIP, fixed capture SHA/PE validation. No latest/arbitrary download or fallback.
The guard captures actual process.execPath from Node24.20.0/x64/win32 and its file
SHA256, privately. Every launch locks and rehashes that Node file, the fixed capture
and the hardcoded script SHA. No user-controlled script/target field is accepted.
The exact script is this repository's fixture.mjs; children spawn this same source.
The caller's complete source SHA fixes the C#/JS/script-hash binding.

Existing id13/SID/name/workspace/nonadmin/API guard precedes acquisition; token is
only in that step. Full clone/persistfalse/entry-exit source clean/original13file
snapshot are kept. The Node private identity is checked again before Add-Type.
No probe of installed software, host environment or unrelated processes occurs.

Public fixed schema includes each case's original safe native booleans/counts/
DWORD status/PID/ready count/accounting/EOF/expected-control/forced/fallback and
receipt booleans, plus allowlisted normal collector metadata. It contains no raw
stdio/context/env/argv/cwd/hash-of-env values. stdio is checked chunk-by-chunk;
only lengths/pattern booleans are kept. Context/reference hashes, invalid raw and
capture/native raw stay quarantine; unknown input is never published. Missing or
invalid receipt/collector input is partial/incomplete, not success. Quarantine
persistence after ordinary runner deletion remains unguaranteed. Compile errors
may retain at most16 fixed CSdddd code/line pairs; source/error messages are not
published. A compiler format that does not match yields an empty diagnostics list
and fixed compile_unavailable, never a claim that no compiler error occurred.

## Limits and local evidence

Linux Node26 direct/mock-heap runs only validate this JS comparison/large output
logic; they do not execute capture or validate Windows/Node24 quoting, Add-Type,
new C# code, policy or cleanup. Runtime guards and C# contracts have portable
negative/model checks; actual Win32 failure paths remain unexecuted until separate
permission. The previous core11 run proves only its own fixed implementation.

Timeout/collector-kill do not compare full environment (different case context),
and their public receipt says environmentCompared=false; only handoff's paired
case compares full env. No long command-line boundary, stdin pipe, arbitrary env
encoding/hidden drive entries or worker_threads are claimed. Hash comparison is
bounded to Node's visible process.env (OS hidden entries not exposed there cannot
be compared). Strong termination is collector-only; arbitrary controller death
still needs separate scope. Script reads and compiler parsing are not transparent
observation of a Lattice command. Heap request effectiveness is not independently
observed. This smoke does not establish original AV/Node/V8/Lattice behavior,
stack/CodeView, old root/source timeout causes or full acceptance. Stack remains
unimplemented; no symbols, dump or memory search is added.
