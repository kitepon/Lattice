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
| K4 creator on Store creation | Store (Ludmila) | first Store write, `LATTICE_SEAT_ID` | `.lattice/chart.json` `created_by`, `created_at` (only when absent) |
| K4 `readTodoChartMeta` / `writeTodoChartMeta` | Store (Ludmila) | `.lattice/chart.json` | `{name, created_by, created_at}` (null when unknown) |
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

## Speed

K1 and K2 run in one process for all charts (a95: in-process reads of 37 charts took 10-40 ms in production). They read
only the manifest-level display source and `.lattice/chart.json`, never full Stores.

## Release

Trees (K3) in 0.100.0. K1, K2, K4, K5, K7, K8 in 0.101.0.
