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

### 6. Rulings from the role review (2026-11-16, Neve, Alice, Ludmila)

- Syntax: `path#symbol` splits at the first `#` (Ruby `Foo#bar` stays in the symbol); the symbol is a dot-separated container
  chain (`Bar.baz`) matched against the node's qualified name; paths are repo-relative with `/`. Matching is exact; a miss
  answers `unresolved {nearest[]}`.
- A path declared with anchors is a container, not a whole-file claim: no path-level resource is made for it. A path without
  `#` keeps the whole file.
- Results: `todo add` and `witness declare` exit 0 and carry `declaration: {written, unresolved: [{path, symbol, nearest[]}],
  malformed: [...]}` (result schemas v2). A caller never re-adds because a declaration was refused.
- `tasks[].touches` is read at create/revise time and written to the witness set only; it never enters the stored plan
  (input schemas create v6 / revise likewise; plan digests unchanged).
- Witness set v6 (`read_anchors`) is written only when some task has read anchors; otherwise v5 stays, so older readers keep
  reading charts that do not use reads (as with `no_code_lanes`).
- Placement: relations are per `plan_key`, not per plan version: `.lattice/todo/relations/<plan_key>/open/<task_id>.json`
  (the open relations of one task: what a reader opens), `summary.json`, and `log.jsonl` (history, appended, never read; a4c:
  the open set must not live in a file that grows with history), own lock like notes, never the lifecycle journal. Revisions copy nothing; Judgment appends `gone` for tasks
  whose ranges changed or that left the plan. One relation per (task pair, path) carrying the overlapping symbols, so
  whole-file declarations do not grow per symbol pair. Event ids are content digests; re-appending an open id is a no-op.
- Atomicity: the task's witness row and its relations are written in one Store call under the relations lock, with the
  comparison made against rows read under that lock (or a compare on `log_sequence` that refuses a stale write; Judgment
  recomputes and retries). Two adds at once never miss each other.
- Gate 3 (enforced, stale): `todo start` compares the summary's `head_sha` with `git rev-parse HEAD`; equal = fresh; different =
  one `git diff --name-only` limited to that task's paths (start is a write). Self-exit: `chart repo sync` (re-resolves) or
  re-declare.
- Touched answers `{touched: [{path, symbol, start_line, end_line}], unattributed: [{path, reason, old_range, new_range}]}`;
  unattributed hunks (imports, top-level code, deleted or renamed functions, unindexed files) count as file-level, never as
  "touched nothing". A clean HEAD answers from the maintained index; any other range end (an older commit, a dirty tree)
  answers from a disposable worktree of that commit with a fresh index (about 12 s, rare; nothing refused).
- Observe keeps today's protection (the judgment never observes uncommitted state) without a refusal: a clean tree at HEAD is
  answered from its maintained index after an incremental sync; a dirty tree falls back to today's isolated worktree of HEAD
  (slow, nothing refused; guards.stopping-is-not-safety). A store-only chart (no code tree) is never observed; Judgment skips
  Resolve there. Measured (a2, Neve): 1.7 s clean, 12.2 s first use (one index build), 13.9 s dirty fallback.
- Reads, measured today on a BellTeam copy: `session-context` with 6 plans takes 101 ms without records and 116 ms with records
  (about 3 ms per plan). Small now; the rule in §5 keeps it flat as records grow.
- Order: g4 (#210) carries the record after every revision by running the full compile, which today builds a fresh index
  (+~11 s per `todo add` in a witness/enforced plan on a BellTeam-size chart). That breaks decision 4, so 0.108.0 (g4, g5)
  ships only together with a2 (Observe on the maintained index). Neve does a2 first.

### 7. A function that does not exist yet, and the declare texts (Owner 2026-11-17)

Production 2026-11-16/17: in every cross-lane write x write overlap on code one side was a whole file, so the function unit
and stage B had no input. Two members fell back to a file or a parent because a new name refused the whole row (Rapi
`ReplySwipe`; Anis keeps "new names fail, declare files" in her procedure). The text a worker reads when it declares (the
enforced start refusal) showed only `--owns <path>`. Owner approved (1) and (2) below.

1. Texts: every declare command Lattice prints (start refusal `enforced_witness_undeclared`, stale refusal, notices) shows
   the function form first: `--owns <path>#<function>[,...] [--reads <path>#<function>,...]`, a path alone only for a file
   with no functions or a new file.
2. New names: a name that does not resolve no longer stops the row. The row is written with every resolved anchor and the
   unresolved names, which are kept in the anchor as `new_symbols` (subset of `symbols` that did not resolve when declared).
   The result lists them as `declaration.new_names: [{path, symbol, nearest[], elsewhere[]}]` so a typo is seen at once;
   `unresolved` stays for a malformed entry only. Judgment of a name in `new_symbols` with no range: it overlaps a whole-file
   claim on that path and the same name on that path; it does not overlap another function's range or another new name.
   A name not in `new_symbols` that no longer resolves keeps today's reading (whole file, counted in `unresolved_count`), so a
   function renamed on main after the declaration is never read as "no conflict". Once a new name exists on main it resolves
   and is judged by its range. A new name cannot be cut by B (no range): planSplitHold skips such an overlap and the start
   keeps today's behaviour for it. The same applies when the Store root has no code tree or Resolve is unavailable: the row
   is written with the names as new names instead of not being written (that give-up protected nothing).
3. A whole code file declared (Owner: 「合理的だ。その方針で実装しろ」): accepted as today, never refused or asked to confirm
   (a confirmation would be a refusal that protects only parallelism). The result adds `declaration.whole_files:
   [{path, access, functions, candidates[]}]` for each path declared without `#` that holds functions: `functions` = how many
   functions the claim makes conflicting, `candidates` = the title/design-memo proposals (existing `proposeFromText`) that lie
   in that file, and the text line "<path>: whole file, its N functions all conflict; by function: --owns <path>#<candidate>".
   A path with no functions (docs, config, css, a test directory, a new file) gets no entry. The count comes from the same
   Resolve process the declaration already runs (Code graph adds `files: [path]` → `{path, functions}` to Resolve); no extra
   process, nothing read on a read. If Resolve is unavailable the entry is left out; the declaration is unaffected.

4. The result says it to the one member it concerns (Behemoth a344, 2026-11-17: a rule line reaches every seat on every
   turn, this happens to one member at one moment; a rule naming result fields went stale in a day). Each `new_names` entry
   carries `text`, like `whole_files`: "<path>#<name>: not in the code, recorded as a new function; if you meant <nearest>,
   declare again with that name" (the nearest part only when there is one). `todo add` with `declaration.written: false`
   carries the same `next_action` as `witness declare` (correct the entry, declare with `witness declare`, never add again).
   Then the common rules drop the written-false clause.

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
