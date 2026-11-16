# ADR 0204: Function-level conflicts, recorded by Lattice when a task is added

- Status: accepted for implementation (2026-11-16, Snow White; decisions by the Owner, stage A of the code graph work)
- Owners: Snow White (contract), Neve (code graph role), Alice (Plan/lifecycle), Ludmila (Store)
- Extends: ADR 0127, ADR 0128, ADR 0200; reuses the concern anchors of the seam proposal (ADR 0132, 0133)
- Diagram: [dfd-function-conflict](../architecture/dfd-function-conflict.md); roles in [function-map](../architecture/function-map.md)
- Inventory behind it: Snow White's `docs/lattice-codegraph-a-20261116/inventory.md` (claim element → module, 0.106.0)

## Context

The Owner wants the code graph used for two things: members understanding the code, and the conflict judgment of the patent
(claims 1-4). Measured on 0.106.0 with a BellTeam copy (2,747 files):

- The conflict unit is the declared file. Two tasks that edit different functions of one file are a conflict, although git
  merges them cleanly; Lattice would stop work that a PR flow does not stop. The Owner ruled: 「単位は『同じファイルの、同じ関数（同じ範囲）』」.
- The judgment is computed when every ready task has declared, over every pair, through a fresh detached worktree and a full
  sensor index (11 of ~12 s), while the code chart already keeps a current index of the same HEAD (sync 0.37-2.1 s).
- The exact wave search stops at 8 tasks (fixed by g5 for the record; the wave plan stays exact-or-absent).
- Reads pay for it too: `lattice status` / `session-context` read every plan's independence artifact and run `git diff` per
  plan on every call.
- Function-level declarations already exist as `concern_anchors` (`{within, symbols}`) but are dropped before the conflict
  judgment (`synthesizeWitnessRunRequest`) and read only by the seam proposal. Symbol owns are keyed by bare name, so
  same-named functions in different files collide; an owns entry without a sensor binding makes no conflict, silently.

Owner decisions (2026-11-16 JST):
1. Index updates stay as they are (code chart sync; members' lattice-mcp watches their clone).
2. The functions a task changes are written once, when the task is added; without AI where possible.
3. 「工程を足すときに、他の未完了の工程と比較し、競合関係を記録する。工程を作るのを邪魔はしない。機械が競合関係を勝手に追記する。」
4. 「負荷が増えすぎて工程表が使いづらくなってはダメだ。」 and 「工程を読むたびに、読まなくていいファイルまで開く仕組みになっていないことに注意して。」

## Decision

### 1. Declaration: functions inside a file, through the existing anchors

A task declares, once, the files it changes and, inside each, the functions it changes or reads:

- CLI: `--owns src/a.mjs#foo,src/a.mjs#Bar.baz` and `--reads src/b.mjs#qux` on `todo add`, `todo independence witness declare`,
  and the same strings in plan input (`tasks[].touches: {owns:[...], reads:[...]}`). `path` alone keeps today's meaning
  (the whole file). Non-code tasks write nothing (g3).
- Stored in the witness set as today's rows: `owns` path entries plus `concern_anchors` `{within: {kind: path, target}, symbols}`
  for writes, and a new `read_anchors` of the same shape for reads (witness set v6). No second declaration format.
- Every `path#symbol` is resolved through the code graph (Resolve, §4) when it is declared. An unknown name is refused with the
  nearest names; nothing else in the add is refused for it (the add happens; the task's row is not written until the names
  resolve). Resolution stores `{path, symbol, kind, start_line, end_line}` per anchor.
- Fallback without seeds: identifiers in the task title and design memo that resolve to graph symbols are proposed in the add
  result, not recorded. The AI that adds the task decides; Lattice never records a guess.
- Related elements (claim 2/3): callers and callees of each declared function are taken from the graph and recorded with the
  row as `related` (information and freshness). They do not create conflicts by themselves (Owner: same function only).

### 2. Conflict unit and predicate

A resource is `(path, line range)` of a resolved anchor. Two tasks conflict when:

- both write ranges in one file that overlap (write × write), or
- one writes a range that overlaps a range the other reads (read × write, claim 4),

where a path declared without anchors covers the whole file. Read × read never conflicts. Keys are `path` + qualified symbol,
never a bare name. An anchor that does not resolve is an explicit unknown on that task, never a silent non-conflict.

### 3. When it is computed, and what is recorded

- On `todo add`, `todo independence witness declare`, `plan create` and `plan revise` (and the revision carry of g4), Lattice
  compares only the new or changed task's ranges with every unfinished task's ranges in the same plan. Overlaps are appended as
  **conflict relations**: `{task_a, task_b, path, a: {symbol, start_line, end_line, access}, b: {...}, head_sha, computed_at}`.
  The command result lists them. The add is never refused for a conflict.
- When the code chart takes in a new main (`chart repo sync` after the sensor sync), Lattice re-resolves only the anchors in
  files the diff touched, updates their ranges, and appends relations that appeared or marks relations that disappeared.
  Nothing else is recomputed.
- Relations are a machine-written, append-only record per plan (Store, §5). They survive revisions for unchanged tasks.
- The existing independence artifact keeps its role for the wave plan and the seam proposal; its conflict list is built from
  the same relations, so there is one judgment, not two.
- `todo start` keeps today's behaviour per mode (enforced refuses a conflict with an in-progress task, with predecessor or
  `--override-reason` exits). What start does with a recorded conflict beyond that is stage B/C.

### 4. Interfaces between roles (no role reads another's internals)

| Interface | Owner | Input → output |
|---|---|---|
| Resolve | Code graph (Neve) | `{path, symbol}[]` → `{path, symbol, kind, start_line, end_line}` or `unresolved {nearest[]}`; deterministic, maintained index |
| Observe | Code graph (Neve) | store tree clean at HEAD → current index (never a fresh full index when a maintained one exists); used by Resolve and by the independence compile |
| Touched | Code graph (Neve) | commit range → `{path, symbol, start_line, end_line}[]` from diff hunks (input for C; recorded per task) |
| Relations | Store (Ludmila) | append `{relation}` / mark gone / read plan summary; carried across revisions |
| Judgment | Plan/lifecycle (Alice) | declaration flags and plan input → Resolve → overlap → Relations; start gates read the summary |

### 5. Reads open one small summary

`session-context`, `status`, `todo show`, the display read and the dashboard read, per plan, one summary
`{relation_count, open_relations (bounded), unresolved_count, head_sha}` written by the write that changed it. Reads never open
the sensor index, the witness set or the full relation log, never recompute, and never run git per plan. The per-call
`git diff base..HEAD` of today's status/session-context moves to the sync step (§3).

## Load budget (acceptance, on a BellTeam copy)

- `todo add` with declarations: at most today's add + 2 s; Resolve + overlap for one task ≤ 1 s.
- Sync step after a new main: ≤ 2 s beyond today's sensor sync.
- `session-context` / `status`: not slower than today with no records, and flat in the number of plans with records.
- No new periodic work; no new step for a member except writing the functions when adding a task.

## Patent claims (implementation trace, not legal scope)

- Claims 1-3: the change-impact range is estimated from the work spec (the AI that writes the task names the functions) and the
  structure graph (resolution, ranges, related elements); Lattice adds no model call.
- Claim 4: read × write and write × write on resources, now at function range. Never weakened to write × write only.
- Claim 1 arrangement: the relations feed the existing wave plan; above the exact-search limit the record says the plan is absent.
- Claims 5-10 are untouched here; B consumes the same anchors, C consumes Touched.

## Not decided here (named)

Start behaviour on a recorded conflict beyond today's gates (B/C); counting callers or tests as conflicts (Owner: no);
non-JS/TS range quality (the graph covers 30+ languages; acceptance runs on BellTeam's JS).
