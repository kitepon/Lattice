# macOS CI runtime identity and non-overwriting generations

Current source: PR53 `c13f92d38d4cf5edac00e6c4899b041f8f28cfd8`.
The generation rows below are the proposed delta, not implemented behavior.
Owner: Snow White, product CI runtime and acceptance. CI environment allocation
belongs to Shiratsuru/Dorothy; host ESET rules, rule renewal and retirement of
old trees belong to Brid. No exclusive physical-cache allocation or all-consumer
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

```
$RUNNER_TOOL_CACHE/lattice-node/
  v24.22.0/                         legacy c13 tree: read-only candidate, never modified or removed
  v24.22.0-6a9724d9b50a5f22/        identity = version + first 16 hex of the pinned SHA
    g1/  bin/node ... .lattice-complete   complete generation (marker present)
    g2/  bin/node ...                     reserved, unpublished (no marker): never selected
```

Predicted first new executable on the current runner:
`/Users/factory-runner/actions-runner/_work/_tool/lattice-node/v24.22.0-6a9724d9b50a5f22/g1/bin/node`.
The marker `.lattice-complete` holds one line: `version=<v> sha256=<full 64 hex> uid=<uid>`.
The path prefix is a namespace; the marker binds the full identity.

## Data flow (proposed)

| Stage | Producer → consumer | Transform/state | Failure behavior |
|---|---|---|---|
| Select | Installer → existing trees | Candidates in fixed order: legacy `v24.22.0` (accepted c13 evidence), then `g1, g2, …` ascending. A `gN` is a candidate only if its marker exists and matches version+full SHA+UID. First candidate passing the existing `verify` (version, UID, mode) is used. | Failing candidates are skipped and left untouched. Ascending order keeps the earliest verified path, so later jobs reuse it and its ESET rule (no per-run churn). |
| Reserve | Installer → identity dir | `mkdir -p` identity dir, then `mkdir` `g<max+1>`; on EEXIST try the next number. `mkdir` is the exclusive create: two writers can never own the same generation. | Any other `mkdir` error fails the job. |
| Build | Official archive → own reserved `gN` | Existing download, pinned `shasum` check, `tar --no-same-owner`, archive removal, `verify` — all inside `gN`, so no rename of a directory is needed. | In-process failure: EXIT trap removes only this process's own unpublished `gN`, then the job fails. |
| Publish | Own `gN` → marker | Write `.lattice-complete.tmp` then `mv` to `.lattice-complete` inside `gN` (same-directory file rename, atomic). Clear the trap only after this. | Before the rename the generation is unpublished and never selectable. |
| Output | Selected/published tree → job | Existing JSON line plus `identity`, `generation` and `execPath`; `directory=<tree>` to `GITHUB_OUTPUT` | The JSON line is the exact identity receipt Brid needs before saving a renewed ESET rule. |

The caller passes the root `$RUNNER_TOOL_CACHE/lattice-node`; the step id,
output name and three consumers stay unchanged. Version and SHA stay in the script.

## Interruption and race states

| Durable state | Entry | Next normal invocation |
|---|---|---|
| Legacy verifies | c13 install | Used as-is. No new tree, no rule change. |
| Legacy fails verification | Tamper/damage/other version | Left untouched (c13's `rm -rf` is removed). Falls through to generations. |
| `gN` without marker | SIGKILL/host loss during build, or another writer still building | Not selected, not deleted, not waited on. If no complete generation verifies, a new number is reserved. |
| `gN` with only `.lattice-complete.tmp` | Interrupted between marker write and rename | Same as unpublished. |
| `gN` complete, verification now fails | Damage after publication | Left untouched; skipped; a later number is used or reserved. Later jobs settle on that one. |
| Two complete generations | Two jobs built concurrently | Both kept. Lowest verifying number is selected from then on. |
| Marker published, job killed before output | Interruption after publish | Complete; next job selects it. |

Every invocation ends either using a verified complete tree or building a new
one; a failure fails only that job and the next normal job retries from the
state above. No lock, daemon, allocator, PID sweep or wait-for-human guard.
Unpublished and superseded trees accumulate only on interruption/failure; they
are retired only by positive accounting (Brid's renewal flow), never by the installer.

## Integrity claims (unchanged strength)

Selection proves version, UID, mode and marker identity only. It does not
re-hash the published binary and makes no tamper-proof claim, the same strength
as the accepted c13 reuse check. The pinned SHA is checked once, on the archive, at build.

## ESET renewal connection (Brid)

A new generation path is not covered by an existing rule. Brid saves a rule only
after receiving the exact identity receipt from the installer output, then one
subsequent job accepts it. Old/new rules and trees stay until consumer and
rollback retirement is positively accounted. While the legacy tree verifies,
no renewal is triggered. Code/push waits on Brid's normal-UI exact UID600 target
selection check using the observed v24 identity.

## Changed-boundary checks (after implementation)

One darwin-arm64-only test (skipped elsewhere), seeded directories, a fake
`bin/node` that execs the real Node, and a failing `curl` stub on PATH:
1. legacy verifies → selected, nothing created;
2. legacy fails, `g1` unpublished, `g2` complete → `g2` selected; legacy and `g1` untouched;
3. `g1` complete but failing marker identity → skipped, untouched;
4. nothing complete + failing `curl` → job fails, own new `gN` removed, every pre-existing tree untouched;
5. `g1` reserved by another writer → next reservation is `g2` (EEXIST path).
Existing contract-test assertions (mkdir -m 700, shasum, --no-same-owner, no
sudo/brew/npm -g, three consumers) stay. Normal automatic PR CI supplies the
real download and execPath evidence; no manual CI.
