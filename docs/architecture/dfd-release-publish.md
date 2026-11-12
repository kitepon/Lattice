# Data flow: npm release publication after CI

Owner: product release (`.github/workflows/publish.yml`), no source module. Canonical ownership in
[function-map](function-map.md) (row "Release publication"); the gate it relies on is the
[CI contract](../ci-contract.md). Publication re-runs no suite: the tree published is the tree the `CI`
workflow already tested on the push to `main`.

## Functions and ownership

| Step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Trigger guard (job `if` and concurrency group) | `workflow_run` of `CI`: `conclusion`, `event`, `head_branch`, `head_repository`, `head_sha`; or `workflow_dispatch` on `main` | Runs only for conclusion `success`, event `push`, branch `main`, head repository = this repository. PR-originated, failed, cancelled and other-branch runs never start the privileged job and use their own concurrency group, so they cannot replace a waiting publish run | Nothing runs; the next green `CI` push run triggers again |
| Dispatch CI check (dispatch only) | `GITHUB_SHA` (= main tip at dispatch), Actions API: `CI` runs with `head_sha`, `event=push`, `branch=main`, `status=success` | Continue when at least one exists | Job fails with the reason; dispatch again after `CI` succeeds on that commit |
| Checkout | `workflow_run.head_sha`, else `GITHUB_SHA` | Detached HEAD at the commit `CI` tested; `fetch-depth: 0` gives `origin/main` for `verify:release-commit`; no credentials persisted | Checkout failure fails the job |
| Decide | `package.json` name and version; registry `versions` and `dist-tags.latest` (`npm view`); `HEAD`, `GITHUB_SHA` | `publish=true` only when `HEAD == GITHUB_SHA`, the version is not on the registry and is newer than `latest`. Otherwise `publish=false` and the summary `skipped: <reason>` (job ends green). A non-`x.y.z` version or an unreachable registry fails the job | Registry or format failure: re-run the job (or dispatch) |
| Install, sensor build, packed smoke | `npm ci`, `npm --prefix sensor ci && build`, `npm pack`, install-only `lattice-dashboard --help` | Same steps the old job ran after `npm run ci`; the explicit sensor build replaces the one the test suite used to perform, so `sensor/dist` is in the tarball | Failure ends the job before publish |
| Publish | OIDC `id-token`, `npm publish --access public`; `prepublishOnly` = `verify:release-commit`, `prepack` = sensor build | Version on the registry with provenance | `verify:release-commit` rejects a commit not on `origin/main` or a dirty tree; publish failure: dispatch (same rules) |

## Why `HEAD == GITHUB_SHA`

For a `workflow_run` the runner's `GITHUB_SHA`, which the OIDC token and the provenance statement name, is the
default branch tip at trigger time, not `head_sha`. If `main` moved past the tested commit the provenance would
name a commit the tarball was not built from, so that run skips; the newer commit's own `CI` run (same
`package.json` version, tree also tested) decides. A dispatch always checks out its own `GITHUB_SHA`.

## Cases

| Case | Result |
|---|---|
| Release push, `CI` green, version newer than `latest` | publishes |
| Non-release push (version equals `latest` or already on the registry) | `skipped`, green |
| PR-originated `CI` run, failed or cancelled `CI` run, other branch | job not started |
| Older sha whose `CI` finishes late (version not newer than `latest`) | `skipped`, `latest` is not moved back |
| `main` moved past the tested commit | `skipped`; the newer commit's `CI` run decides |
| Dispatch with a green `CI` push run on the main tip | same decision rules as above |
| Dispatch without one | fails with the reason, nothing published |

`CI` on `main` may end green through the covered-by-PR-run skip (`scripts/ci-main-coverage.mjs`, tested merge tree
equals this tree); that still satisfies tree equality and is not treated as untested.

## State and self-exit (guards rule)

```
no publish needed ----------------------------> skipped (green); next release push triggers again
CI not green ---------------------------------> not started; next green CI push run triggers
dispatch, CI not green on tip --CI succeeds---> dispatch again --> decide
registry unreachable / odd version -----------> failed --re-run or dispatch--> decide
main moved past tested commit ----------------> skipped --newer commit's CI run--> decide
publish rejected (e.g. OIDC refuses a workflow_run job) --> failed --dispatch--> published
```

Guards name what they protect: privileged job on PR code (trigger guard), `latest` moving back and overwriting a
version (decide), provenance naming a different commit (`HEAD == GITHUB_SHA`), a commit that is not on `main` or a
dirty payload (`verify:release-commit`). Every refusal has a transition out above.
