# Data flow: host connection — chart list, change tokens, chart identity, addressing, code charts (a101, 2026-11-14)

Status: contract. Rows K1-K8 are BellTeam's requirements (Flora, 2026-11-14, BellTeam
`docs/architecture/modules/lattice/README.md`, "BellTeam <-> Lattice connection (target, task a102)"), accepted or
reshaped here by Snow White (coordinator). Code starts after Flora agrees to this file.
Tasks: BellTeam chart `bellteam-dev-added/a101` (this contract, release), `a100` (trees, 0.100.0), `a102` (Flora switches
BellTeam over and removes the direct references).
Owner's words (Quo 2026-11-14): "プロダクト間の繋ぎはしっかりと図で定義しよう。全部そうだね。直接参照は便利だけど、
片方のプロダクトが修正された時にサイレントに破壊されるから危険。プロダクト間で契約されてる口でやり取りしてるなら心配はない。"
"機能図、データフロー図だ。"
Canonical ownership in [function-map](function-map.md#host-connection-a101).

## Problem this removes

BellTeam's module reaches into Lattice where no Lattice contract covers it, so a Lattice change can break BellTeam
silently:

| Direct reference today | Replaced by |
|---|---|
| Lists charts by `readdir(<root>)` + `<id>/.lattice` checks | K1 `lattice charts list` |
| Per-chart `todo display source` (one process per chart); an import of Lattice's `src/todo-store.mjs` reported by Trony | K1/K2, one process for all charts |
| Chart name and creator in `.bellteam-chart.json` inside the chart dir | K4, identity owned by Lattice |
| `mkdir <root>/<id>`, `git init`, prune of a failed new dir | K5, Lattice creates the chart |
| Building `<root>/<id>` and running Lattice with that cwd | K8, addressing by project id |
| `git fetch/merge` and `sensor` inside the code chart dir (`code-chart.mjs`) | K7, `lattice chart repo` |
| Owner-lane filing record `.bellteam-owner-decisions.json` in the charts root | Not Lattice: BellTeam moves it to its own state dir (a102) |

## Boundary

- Lattice owns everything under `LATTICE_CHARTS_ROOT`: chart directories, their git repositories, Stores and chart
  identity. BellTeam keeps nothing there.
- BellTeam (caller) passes `LATTICE_CHARTS_ROOT` and `LATTICE_PROJECT_ID` (K8) and reads only the JSON below.
  Notification is pull: BellTeam polls tokens (K2); Lattice runs no watcher for the host.
- A chart is `<LATTICE_CHARTS_ROOT>/<project_id>` holding a Store manifest. A directory without one is not a chart.
- Everything is additive. The seat surface (`plan`, `todo`, `status`, `session-context`, `help`, `--version`) and
  `todo blockers`, `todo unblock`, `todo notice list|ack` are unchanged (K5, K6).

## Function diagram

| Function | Owner | Input | Output |
|---|---|---|---|
| K8 `resolveChartRoot(env, cwd)` | Plan CLI (Alice) | `LATTICE_CHARTS_ROOT` + `LATTICE_PROJECT_ID` (both set: repoRoot = root/id; otherwise cwd as today) | repoRoot for every command |
| K5 chart creation on the first Store-creating command | Plan CLI (Alice) + Store (Ludmila) | K8 repoRoot that does not exist yet | `mkdir` + `git init` + Store; if the command fails, the dir it created is removed |
| K4 creator on Store creation | Store (Ludmila) | `initializeAuthoredTodoStore({..., chartCreator})`; the CLI passes `LATTICE_SEAT_ID` (Store reads no env) | `.lattice/chart.json` `created_by` (only while null), `created_at` (only when the file is first created) |
| K4 `readTodoChartMeta({repoRoot})` / `writeTodoChartMeta({repoRoot, patch})` | Store (Ludmila) | `.lattice/chart.json` `lattice.chart_meta.v1` | `{name, created_by, created_at, repo}` (null when unknown); write → `{meta, unchanged}` |
| K4 `lattice chart set --name <text> [--created-by <id>] [--json]` | Plan CLI (Alice) | K8 chart, `LATTICE_SEAT_ID` | `lattice.chart_set_result.v1` |
| K1 `lattice charts list [--json]` | Plan CLI (Alice) over Store `readTodoStoreDisplaySource` + `readTodoChartMeta` | `LATTICE_CHARTS_ROOT` | `lattice.charts_list_result.v1` |
| K2 `lattice charts source [--project <id>]... [--json]` | Plan CLI (Alice) over Store `readTodoStoreDisplaySource` | `LATTICE_CHARTS_ROOT`, chosen ids | `lattice.charts_source_result.v1` |
| K3 `projectTodoTrees(store)` in `todo display read` | Plan/lifecycle (Alice) | one Store view | `trees` (a100, 0.100.0) |
| K7 `lattice chart repo bind|sync` | Plan CLI (Alice) over git and the bundled sensor | K8 chart | `lattice.chart_repo_result.v1` |
| Caller: list, header ring, cards, change detection, naming, code chart refresh | BellTeam module (Flora) | the JSON above | its screen and MCP results |

## Data flow

| Row / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| K1 `lattice charts list --json` (one process, any cwd) | every direct child of the root that holds a Store manifest: display source + chart identity | `{schema: lattice.charts_list_result.v1, charts_root, charts: [{project_id, name, created_by, created_at, source}], findings}`; `charts` sorted by project_id; `source` = the chart's `todo display source` result digest (string), changes when its display source or identity changes | Never refuses for one chart: an unreadable chart is listed with `source: null` and a finding `{project_id, reason}`. Root unset: exit 0, `charts: []`, finding `charts_root_unset`; missing root: `charts: []` |
| K2 `lattice charts source --project <id> [--project <id>]... --json` (one process; no `--project` = all charts) | the chosen charts' display source + identity | `{schema: lattice.charts_source_result.v1, charts: {"<project_id>": "<source>" or null}}` | A chosen id with no chart: `null` (gone) |
| K3 `todo display read --json` with K8 env | as today | as today + `trees` | as today |
| K4 naming: `lattice chart set --name <text>` (K8 env, `LATTICE_SEAT_ID=<bot id>`) | name rule: 1-40 characters, trimmed, no control characters (BellTeam's `validLatticeName`) | atomic write of `.lattice/chart.json`; result `{project_id, name, created_by, created_at, unchanged}` | Invalid name: `CHART_NAME_INVALID` with next_action. No chart yet: K5 creates it (identity may precede the first plan) |
| K4 creator | the run that creates the Store | `created_by` = its `LATTICE_SEAT_ID` (null when unset), `created_at` = now | Never overwritten afterwards |
| K4 Store: `readTodoChartMeta` | `.lattice/chart.json`; no lock, no Store needed, no write | `{name, created_by, created_at, repo}`; missing file = all null | Symlink, non-file, over 64 KiB, bad JSON or shape: `STORE_INCONSISTENT/chart_meta_invalid {ref}`; a higher `lattice.chart_meta.vN`: `UNSUPPORTED_SCHEMA/newer_lattice_value` (registered as `chart_meta` in `NEWEST_KNOWN_TODO_SCHEMA`). The CLI turns either into a per-chart finding |
| K4 Store: `writeTodoChartMeta` | `patch` keys `name`, `created_by`, `repo` (absent = keep; `repo` replaces the object, null unbinds); creates `.lattice/` (0700) when missing | Under `.lattice/.chart.write.lock` (store-lock: identified owner, proven-dead recovery; protects the creator from two writers that both read it unrecorded): reread, `created_by` only while null, `created_at` = now only when the file is new, atomic write; `unchanged: true` and no write when equal | An unknown patch key or invalid value: TypeError. A malformed or newer file: the read refusals above, nothing written. Busy lock past the wait: `STORE_WRITE_CONFLICT/store_locked`. `.lattice` a symlink or non-dir: `STORE_INCONSISTENT/unsafe_lattice_root` |
| K4/K5 Store: creator on creation | `initializeAuthoredTodoStore` succeeded (the Store is published) | `writeTodoChartMeta({created_by: chartCreator ?? null})` after activation, so the initializer's rollback never meets chart.json. A dir already holding `.lattice/chart.json` (a `chart set` before the first plan) or a fresh `git init` dir is still an uninitialized Store | A chart.json fault does not fail the published creation; readers report it. Shortcut: only authored creation stamps (migration/import Stores get the creator from `chart set --created-by`); upgrade if a host creates charts by import |
| K4 migration (a102, once per chart) | old `.bellteam-chart.json` | `chart set --name <old name> --created-by <old createdBy>`: `--created-by` applies only while `created_by` is null; then BellTeam deletes the sidecar | Re-running is harmless (`unchanged: true`) |
| K5 creation | K8 repoRoot missing | the first Store-creating command (`plan create`, `chart set`) makes the dir (mode 0700) and `git init`; read commands on a missing chart do not create it | On failure the command removes only a dir it created in this run; a path that is a symlink or not a dir is refused `CHART_PATH_INVALID` (named protection: writes outside the root) and nothing is written |
| K7 `lattice chart repo bind --url <url> --branch <branch>` | K8 chart | records the binding in `.lattice/chart.json` (`repo: {url, branch, accepted_tip}`) | Invalid url/branch: refused with next_action |
| K7 `lattice chart repo sync --json` | binding, chart work tree | depth-1 fetch; fast-forward only from `accepted_tip`, never reset or force; then `sensor sync` (or `init` the first time); `{schema: lattice.chart_repo_result.v1, project_id, status: current/synced/dirty/diverged/failed, tip, accepted_tip, sensor}` | `dirty` / `diverged`: nothing moved, status says which; `failed`: the step and its message; the next sync retries |

## Shapes

- `trees: [{tree_id, tasks: [{plan_key, task_id}], total, finished}]` (agreed with Flora 2026-11-14): connected
  components, either direction, over all tasks of this chart's active plans via hard_dependencies, joins, same-chart
  cross-plan dependencies (tombstones applied) and `parent_task_id`; a predecessor on another chart never joins; a task
  with no link is a tree of one; retired tasks stay members. `finished` = done or retired. `tree_id` = the smallest
  `plan_key/task_id` in the tree; `trees` sorted by tree_id, `tasks` by (plan_key, task_id).
- `source`: opaque string; compare for equality only.

## Implementation binding: CLI side (host-cli, Alice)

Store exports agreed with Ludmila 2026-11-14 (host-store): `readTodoChartMeta({repoRoot})` →
`{name, created_by, created_at, repo}` (missing file = all null; a newer `schema` = `UNSUPPORTED_SCHEMA`, a bad file =
`STORE_INCONSISTENT/chart_meta_invalid`); `writeTodoChartMeta({repoRoot, patch})` → `{meta, unchanged}` under its own
`.lattice/.chart.write.lock` (`created_by` only while null, `created_at` when chart.json is first made, `repo` replaced
whole); `initializeAuthoredTodoStore({..., chartCreator})` stamps the creator right after the Store is activated (a malformed chart.json does not fail creation; readers report it).

| Name | Where | Contract |
|---|---|---|
| `enterAddressedChart({env, argv, cwd})` | `src/chart-cli.mjs`, called by `bin/lattice.mjs` before dispatch | K8: both env vars set → `process.chdir(<root>/<id>)`; every command except help, `--version`, `charts` and the other cwd-free groups. Relative `--input` / `--plan-input` / `--review` values are resolved against the caller's cwd first. K5: `plan create --input` and `chart set` on a missing dir `mkdir` (0700) + `git init`; the bin removes that dir when the command exits non-zero (shortcut: an escaped exception skips the removal; every branch returns a typed exit). Refusals (exit 1, `cli_error.v2`): `CHART_PATH_INVALID` (id not a plain name, or a link / non-directory: writes outside the root), `CHART_NOT_FOUND {project_id, path, next_action}` for any other command on a missing chart (protection: running on the caller's cwd is the wrong chart; self-exit: `chart set` or `plan create` creates it) |
| `listCharts(env)` / `chartSources(env, ids)` | `src/chart-cli.mjs` | K1/K2 as above; `source` = sha256 of `[display source, chart meta]`; a meta or display-source failure = `source: null` + finding `{project_id, reason}` (K1); K2 has no findings field, so an unreadable chart is `null` there too |
| `runChartCli({argv, cwd, env, stdout, stderr, created})` | `src/chart-cli.mjs`, `bin/lattice.mjs` `charts`/`chart` branch | K4 `chart set`: `created_by` patch = `--created-by`, else `LATTICE_SEAT_ID` only when K5 created the chart in this run (an existing chart with no creator is not claimed by whoever renames it). `project_id` in results = `LATTICE_PROJECT_ID`, else the repo directory name. K7 `chart repo bind` result: `{schema: lattice.chart_repo_result.v1, project_id, status: 'bound', repo, unchanged}`; invalid url/branch = `CHART_REPO_INVALID {field, rule, next_action}`; a new url or branch resets `accepted_tip` to null. K7 `sync`: adds `.lattice/` to `.git/info/exclude`; `dirty` (tracked edits) before any fetch; unsets promisor config; baseline = `accepted_tip`, else (charts moved before 0.101.0) `refs/remotes/origin/<branch>`; `git fetch --depth=1 --no-tags <url> <branch>` (origin is never touched); HEAD unborn or equal to the baseline → `checkout -B <branch> <tip>`, any other HEAD ≠ tip → `diverged`; new tip saved as `accepted_tip`; then `sensor sync` (`init` when it answers `LATTICE_SENSOR_NOT_INITIALIZED`) on every sync. Result adds `failure: {step, message} | null`; no binding = `failed` with step `bind` |
| `runPlanCreate` | `src/project-cli.mjs` | passes `chartCreator: LATTICE_SEAT_ID || null` to `initializeAuthoredTodoStore` (Store does not read env) |

## Speed

K1 and K2 run in one process for all charts (a95: in-process reads of 37 charts took 10-40 ms in production). They read
only the manifest-level display source and `.lattice/chart.json`, never full Stores.

## Release

Trees (K3) in 0.100.0. K1, K2, K4, K5, K7, K8 in 0.101.0.
