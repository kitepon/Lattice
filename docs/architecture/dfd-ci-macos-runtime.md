# macOS CI runtime identity and non-overwriting generations

Current source: PR53 `c13f92d38d4cf5edac00e6c4899b041f8f28cfd8`.
The generation rows below are the proposed delta, not implemented behavior.
Owner: Snow White, product CI runtime and acceptance. CI environment allocation
belongs to Shiratsuru/Dorothy. Snow White, as CI/consumer owner, positively
accounts for consumer exit and removes its own retired trees; Brid/Owner save
rules and remove only the exact retired ESET rule. No exclusive physical-cache allocation or all-consumer
exit handoff exists (Dorothy, 2026-11-08: not established), so this design never
replaces, renames over or deletes a tree another job may be running.

## Current functions and connections

| Owner/function | Input and callers | State/output | Current limit |
|---|---|---|---|
| Product caller, `.github/workflows/ci.yml` | main push, main-targeting PR, explicit workflow dispatch | Calls product-full-ci with `npm ci`, `npm run ci` | No concurrency or automatic superseded-run cancellation is declared. |
| Product matrix, `product-full-ci.yml` | Eligible self-hosted factory/macOS runner | `steps.macos_runtime.outputs.directory` feeds three Node-consuming steps | Labels do not prove a dedicated runner or exclusive physical cache. |
| `ci-macos-node-runtime.sh` (c13) | Absolute version directory `lattice-node/v24.22.0` | Verified Node 24.22.0 at that fixed path | A directory failing verification is `rm -rf`'d and rebuilt at the same path: not old-consumer preserving. Accepted only within c13's original scope. |
| Foreground test orchestrator | `npm run ci`, Node test runner, Sensor tests | Waits for foreground result | Detached bridge/dashboard/fixture children can outlive the foreground parent. |
| Runner finalization | Inherited job process tracking | Best-effort orphan termination | Not evidence of confirmed exit before a later job. |

## Identity and generation layout (proposed)

Requested version `24.22.0`; pinned official darwin-arm64 archive SHA256
`6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5`.

The root is no longer `$RUNNER_TOOL_CACHE`. Brid's normal-UI check (2026-11-08)
found the ESET chooser cannot reach any file under `/Users/factory-runner`
(0700; console UID 501 cannot traverse), so no rule can target that tree. The
root moves to `/Users/Shared`, the standard macOS 1777 sticky directory: UID 600
creates its own subtree without admin or host change, other users cannot rename
or delete its entries, and the console can traverse it to the exact file.
The location itself is pending Owner approval and Brid's read-only host check.

```
/Users/Shared/
  lattice-node/                     root: real dir, owner = installer UID, 0755, no group/other write
    v24.22.0-6a9724d9b50a5f22/      identity = version + first 16 hex of the pinned SHA
      g1/  bin/node ... .lattice-complete   complete generation (marker present)
      g2/  bin/node ...                     reserved, unpublished (no marker): never selected
  lattice-node.2/                   next sibling root, used only if every earlier root name is unsafe
$RUNNER_TOOL_CACHE/lattice-node/v24.22.0/   legacy c13 tree: never selected, never touched by the installer
```

All installer-created directories are `mkdir -m 755` (mode set at creation,
not after), files carry no group/other write, owner UID 600.

Predicted first new executable on the current runner:
`/Users/Shared/lattice-node/v24.22.0-6a9724d9b50a5f22/g1/bin/node`.
The marker `.lattice-complete` holds one line: `version=<v> sha256=<full 64 hex> uid=<uid>`.
The path prefix is a namespace; the marker binds the full identity.

## Data flow (proposed)

| Stage | Producer → consumer | Transform/state | Failure behavior |
|---|---|---|---|
| Root | Installer → `/Users/Shared` | Root names in fixed order `lattice-node`, `lattice-node.2`, `lattice-node.3`, …: use the first that is a real directory (not a symlink) owned by the installer's own UID with no group/other write. If every existing name is unsafe, `mkdir -m 755` the next unused name (EEXIST → next name). | An unsafe pre-existing root (other owner, symlink, group/other writable, non-directory) is never used or modified; it is skipped. No wait-for-human guard. |
| Select | Installer → existing trees in the chosen root | Candidates are `g1, g2, …` ascending under `v<ver>-<sha16>`. The legacy private-home tree is not a candidate. A `gN` is a candidate only if its marker exists and matches version+full SHA+UID. First candidate passing the existing `verify` (version, UID, mode) is used. | Failing candidates are skipped and left untouched. Ascending order keeps the earliest verified path, so later jobs reuse it and its ESET rule (no per-run churn). |
| Reserve | Installer → identity dir | `mkdir -p` identity dir, then `mkdir` `g<max+1>`; on EEXIST try the next number. `mkdir` is the exclusive create: two writers can never own the same generation. | Any other `mkdir` error fails the job. |
| Build | Official archive → own reserved `gN` | Existing download, pinned `shasum` check, `tar --no-same-owner`, archive removal, `verify` — all inside `gN`, so no rename of a directory is needed. | In-process failure: EXIT trap removes only this process's own unpublished `gN`, then the job fails. |
| Publish | Own `gN` → marker | Write `.lattice-complete.tmp` then `mv` to `.lattice-complete` inside `gN` (same-directory file rename, atomic). Clear the trap only after this. | Before the rename the generation is unpublished and never selectable. |
| Output | Selected/published tree → job | Existing JSON line plus `identity`, `generation` and `execPath`; `directory=<tree>` to `GITHUB_OUTPUT` | The JSON line is the exact identity receipt Brid needs before saving a renewed ESET rule. |

The caller passes the base `/Users/Shared` instead of a `$RUNNER_TOOL_CACHE`
path; consumers keep using the step output path. The step id, output name and
three consumers stay unchanged. Version and SHA stay in the script.

## Interruption and race states

| Durable state | Entry | Next normal invocation |
|---|---|---|
| Legacy `$RUNNER_TOOL_CACHE/lattice-node/v24.22.0` present | c13 install | Never selected, never touched (c13's `rm -rf` is removed). Snow White retires it after consumer accounting. |
| Root name squatted or unsafe | Another user/process created it first, or a symlink | Skipped and untouched; next sibling root name is used or created. |
| Root created, nothing inside | Interrupted right after root `mkdir` | Mode was set at creation, so the root is already safe; next call reserves `g1` in it. |
| `gN` without marker | SIGKILL/host loss during build, or another writer still building | Not selected, not deleted, not waited on. If no complete generation verifies, a new number is reserved. |
| `gN` with only `.lattice-complete.tmp` | Interrupted between marker write and rename | Same as unpublished. |
| `gN` complete, verification now fails | Damage after publication | Left untouched; skipped; a later number is used or reserved. Later jobs settle on that one. |
| Two complete generations | Two jobs built concurrently | Both kept. Lowest verifying number is selected from then on. |
| Marker published, job killed before output | Interruption after publish | Complete; next job selects it. |

Every invocation ends either using a verified complete tree or building a new
one; a failure fails only that job and the next normal job retries from the
state above. No lock, daemon, allocator, PID sweep or wait-for-human guard.
Unpublished and superseded trees accumulate only on interruption/failure; they
are never removed by the installer. Snow White, as CI/consumer owner, removes its
own retired trees after positively accounting for consumer exit; Brid/Owner remove
only the exact retired ESET rule.

## Integrity claims (unchanged strength)

Selection proves version, UID, mode and marker identity only. It does not
re-hash the published binary and makes no tamper-proof claim, the same strength
as the accepted c13 reuse check. The pinned SHA is checked once, on the archive, at build.

## ESET rule connection (Brid)

After implementation: the first normal automatic PR job stages `g1` (staging,
not acceptance) and prints the exact identity receipt; Brid selects that exact
`g1/bin/node` in the chooser; the Owner decides production scope; the rule is
added; then ONE acceptance job through Snow White. Old/new rules and trees stay
until consumer and rollback retirement is positively accounted (consumer exit
by Snow White, rule removal by Brid/Owner). Code/push waits until Shiratsuru
relays Owner approval of the location.

## Changed-boundary checks (after implementation)

One darwin-arm64-only test (skipped elsewhere), seeded directories, a fake
`bin/node` that execs the real Node, and a failing `curl` stub on PATH:
1. legacy tree present and valid → never selected, untouched; `g1` is built in the safe root;
2. squatted root (symlink, and group/other-writable dir; another-UID owner cannot be
   created without privilege in a test) → skipped, untouched; `lattice-node.2` used;
3. legacy present, `g1` unpublished, `g2` complete → `g2` selected; legacy and `g1` untouched;
4. `g1` complete but failing marker identity → skipped, untouched;
5. nothing complete + failing `curl` → job fails, own new `gN` removed, every pre-existing tree untouched;
6. `g1` reserved by another writer → next reservation is `g2` (EEXIST path).
Existing contract-test assertions stay, except `mkdir -m 700` becomes
`mkdir -m 755` (console traversal) and the caller path assertion follows the new base (shasum, --no-same-owner, no
sudo/brew/npm -g, three consumers) stay. Normal automatic PR CI supplies the
real download and execPath evidence; no manual CI.
