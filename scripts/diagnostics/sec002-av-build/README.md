# SEC002 GitHub-hosted build-only candidate

Source of the 13-file snapshot: Snow White's local repository commit
`4ab846c70883170f94b6af05b99cb049e2cff0f4`.
`source-manifest.json` SHA256:
`28b7766841e3c8ddae60008432508a2780aee0e4b22042de9bf062e5b80ef813`.
The snapshot is byte-for-byte unchanged: 13 files, 51764 bytes.
A diagnostic-local .gitattributes marks the snapshot and manifest -text, preserving
bytes across Windows checkout without changing system/global git settings.

This feature branch uses registered `upstream-check.yml` as a manual-only caller.
Main's weekly workflow and all other existing workflows stay unchanged.
Product CI is push-main / PR-main only; this feature push creates no product job.
No PR or merge accompanies this branch.

The workflow checks out a fully pinned source commit. The dispatch input pins the
workflow commit and must equal `github.sha`. Both are saved separately from the
local snapshot commit. Checkout does not persist credentials. Permissions are
contents-read only. GitHub-hosted windows-2025 only, finite 20-minute timeout,
no self-hosted selector, no cancellation, no SDK/tool installation.

The initial build-only run `38799242999` reached a Windows2025 VS2026 image
(`ImageOS=win25-vs2026`, version20261007.264.1), then stopped at the old win25
entry guard before toolchain discovery/compilation. The source exit check passed.
That dispatch is consumed. The change below is a repair candidate; it authorizes
no retry or new dispatch.

[Official label mapping](https://github.com/actions/runner-images/blob/main/README.md)
now maps windows-2025 to VS2026. The actual job's
[versioned image inventory](https://github.com/actions/runner-images/blob/win25-vs2026/20261007.264/images/windows/Windows2025-VS2026-Readme.md)
lists VS18 Enterprise at `C:\Program Files\Microsoft Visual Studio\18\Enterprise`,
the legacy14.44 C++ component and SDK10.0.26100.0. The candidate selects a fixed two-entry map: win25 -> VS2022 Enterprise,
win25-vs2026 -> VS18 Enterprise; other image identities fail. This handles a
mixed old/new image pool without host discovery or arbitrary fallback. It retains the unique14.44/SDK26100 rule,
the unchanged13-file snapshot and the original recipe. No other toolset fallback.
The inventory is a lead, not proof of the next job's files.

The build records actual image version, known toolchain paths, versions, hashes,
and SDK/include/lib/bin-DLL manifests. They are observed build inputs and same-job
consistency checks, not externally pinned vendor provenance. Missing or different
tools fail without installation, fallback, or another run.

The original recipe compiles and links separately with /W4 /WX. It invokes only
compiler/linker/dumpbin, never either generated EXE or any Lattice program/test.
The wrapper independently checks PE32+/AMD64/console/imports and final hashes.
Only kernel32.dll imports qualify in this metadata-only version. Additional CRT
imports are a concrete build result to review, not automatically permitted.

The 7-day artifact includes source manifest, build/toolchain records, required
compiler logs, PE inspections and generated binaries. Objects and arbitrary
workspace/environment contents are excluded. Source checkout and tracked clean
are checked at entry and exit. Failed build records preserve the first compiler
error and any generated partial output; no rerun is implied.

Build success proves compilation/static PE properties only. It proves neither
Win32 debugger lifecycle, nested jobs, fixture behavior nor collection safety.
Stack/unwind remains unimplemented; metadata-only must not be described as a
finished stack collector. Isolation fixture execution, product hook/caller/full
CI, factory id13 operations, authentication/permission/host-setting changes all
require a separate instruction. Existing source478/caller6a80 and main are untouched.
