# ADR 0205: Split a function two lanes both change, when the second one starts

- Status: accepted for implementation (2026-11-16, Snow White; decisions by the Owner, stage B of the code graph work)
- Owners: Snow White (contract), Alice (Plan/lifecycle), Ludmila (Store), Neve (code graph role)
- Extends: ADR 0204 (function-level conflict relations), ADR 0200 (start gates); reuses the seam verification of ADR 0137/0138
- Diagram: [dfd-function-split](../architecture/dfd-function-split.md); roles in [function-map](../architecture/function-map.md)
- Decision record: Snow White's `docs/lattice-codegraph-b-20261116/plan.md` (the Owner's words per decision)

## Context

ADR 0204 made the conflict unit a function: two tasks on different functions of one file no longer conflict. The existing
refactoring (`todo seam-proposal`, ADR 0132-0138) moves declared symbols of one file into other files; it resolves "same file,
different symbols", which is no longer a conflict. What remains is two tasks writing the same function. Its first real run
(2026-07-26) also showed it cannot attribute parts of a file to tasks without per-task anchors.

Owner decisions (2026-11-16 JST), D-numbers as in the decision record:

- D1 Target: write x write on one function. D2 Read x write is never split; today's start behaviour stays.
- D3 Trigger: the two tasks have different lanes, one is in progress, the other is being started. Not at add time:
  「実際に並列に着手しないかもしれない」.
- D4 Lattice adds the split task itself, in the in-progress task's lane, as predecessor of both.
- D5 The in-progress worker decides whether to split and how.
- D6/D7 Not splitting (too heavy, cannot be cut, or the five conditions fail): the split task is withdrawn and the later
  task becomes a successor of the task started first.
- D8 After the split is on main, Lattice rewrites both declarations and judges again.
- D9 Labels 「分割待ち」 (tasks under an open split) and 「関数分割」 (the split task); status unchanged.
- D10 Three or more tasks: sides are lanes; one open split per function; late starters join it; landing with fewer sides
  re-judges and the same rule applies again; two lanes already in progress on one function is stage C.
- D11 No new load on reads; no new periodic work.

## Decision

### 1. Detection at `todo start` (Plan/lifecycle)

`todo start --plan P --task T`, in every plan that has not chosen conversation (witness, enforced, or no mode declared yet; conversation plans have no judgment; unchanged), after today's
readiness check and before the enforced gates:

1. Read T's open relations (`readTodoTaskRelations({taskId: T})`, ADR 0204 §5; nothing else is opened).
2. Keep the overlaps where T writes and the other task U writes (`access` of both sides is `write`), U is `in-progress`,
   and `lane(U) != lane(T)`. None → today's start, unchanged (read x write included, D2).
3. For each kept function `F = {path, symbol}` of U's side (U's anchor; a whole-file claim is skipped: no function to cut):
   - an unfinished task S in P with `function_split` on the same path and an overlapping range → **join**: S becomes a
     predecessor of T; T is appended to `S.function_split.members`; a note on S names T.
   - otherwise **add**: a task S `split-<12 hex of digest(P, path, symbol)>`, lane `lane(U)`, phase `phase(U)`, title
     `Split <path>#<symbol>`, design memo naming U, T and the function, marked `function_split {path, symbol, members}`
     (members = U and T, sorted), predecessor of U and of T. The id takes `-2`, `-3`... when the base id exists (an earlier
     S for the same function was retired). Join matches an unfinished S by `(path, symbol)` first, range only as a
     fallback (the mark's range and the relation's range come from different heads). U stays in progress (a revision carries it; `todo done U` is refused until S is
     done, which keeps U from closing before the split it must rebase on).
   The adds and joins of one start are one plan revision.
4. T is not started. With `--override-reason` (witness or enforced), step 3 is skipped and T starts as today (recorded).
5. Detection is skipped, and T starts as today, when the plan cannot take a light revision (`lightRevisionExpresses`
   false, or a feature-chain-bound plan): the start emits the warning `LATTICE_START_SPLIT_UNSUPPORTED` naming
   `split_unsupported` (an unknown state is not a danger; nothing is refused). A lane is always set (plan v7+ requires it), so there is
   no unset-lane case. Two lanes already in progress on one function is skipped per function (stage C).

Detection sits in `startTask` after `taskRelations` and before `enforcedStartGate`, so the gates never see a held T.

Result (exit 0): `lattice.todo_start_split_result.v1`
`{project_id, plan_key, plan_version, task_id: T, status: "pending", splits: [{task_id: S, path, symbol, joined, members}],
next_action: "wait: S is in <lane>; the chart offers T again when every split it waits on is done or withdrawn"}`.
A caller never retries the start; the chart's startable notice brings T back.

### 2. The split task (Store record, Ludmila)

- `function_split` is a nullable key of plan schema v9 (`lattice.todo_plan.v9`, task = v8 task + `function_split`):
  `{path, symbol, start_line, end_line, members}` or null. A plan stays v8 until the revision that writes its first split;
  that revision promotes every task (null = none); downgrade is refused (`function_split_schema_downgrade`). Members are
  sorted unique task ids of the plan, 2..64, S not among them; start order is never stored (who started first comes from
  the start events). The range is a snapshot taken at the start; the Store never refreshes it. One open split per function
  is Plan/lifecycle's check; the Store checks the shape.
- Carried across revisions by task_id, including authored `plan revise` input that does not mention it; an author can
  neither set nor clear it (plan create/revise input refuses the field).
- An older seat reading a v9 plan gets `UNSUPPORTED_SCHEMA/newer_lattice_value` with the upgrade next_action. Whether it
  can still read the Store's other plans is measured in b2 and reported before release. Rollout: seats upgrade first.
- The map and the verify outcome live outside the plan, one file per S: `.lattice/todo/splits/<plan_key>/<S>.json`,
  `lattice.todo_split_record.v1`, one canonical JSON line ≤ 64 KiB: `{schema, plan_key, task_id, attempt, map (≤ 64, one
  per member, sorted), commit (40 hex), base, outcome: accepted | rejected, conditions {behaviour, tests, fresh, overlap,
  parallel: each {passed, detail ≤ 2 KiB}}, recorded_at, actor}`; lists inside details are capped at 64 by the caller, an
  over-bound record is refused as a writer bug, never truncated.
- API: `recordTodoSplit({repoRoot, planKey, taskId, writer, record})` (lock `.lattice/todo/splits/<plan_key>/.write.lock`,
  held only for the write: checks S unfinished with a mark and map ids within members, replaces with attempt + 1; refused
  after S is done or retired) and `readTodoSplit(...)` → record or null (lock-free). No listing: no read scans the
  directory. A damaged file is `STORE_INCONSISTENT/split_record_invalid {ref}`: done S refuses, show S says unreadable.
- Only `function-split verify`, `todo done S` and `todo show S` read it.

### 3. The worker's decision (Plan/lifecycle CLI; D5)

S is startable in U's lane, so the startable notice tells U's worker. S has no witness row and skips the enforced gates
1-3 like a no-code task (it overlaps its own members by construction); its relations come only from the members' rows
after done S. `todo start S` computes `cut_cost` once (Neve's `cutCost({repoRoot, target, memberTaskIds})`, the seam-cost
profile with every member owning F; best effort, null with the reason) and shows it in the start result (`function_split {path, symbol, members, cut_cost, guide}`; no note is written: nothing
reads one), so the worker sees the size and the steps before deciding. `todo show S` shows the mark, members and the verify record; it
never runs the sensor.

- The split task's design memo and the `todo start S` result also tell the worker: once verify accepts, open the PR with
  `[skip ci]` in the commit message and merge it; verify already ran the checks for the cut (Owner, 2026-11-16: 「分割工程に
  対してはCIを省略しろと、分割作業者に言えばいいだけ」). Only the split PR skips CI; the members' own work after the split
  runs CI as usual (Owner: 「その後の予定通りの作業に対しては省略しない」). A repository whose branch protection requires checks needs an
  exception for these PRs from its CI owner.
- **Split**: the worker writes the cut on a branch from main (a code change by the worker: Lattice has no data-flow
  analysis to extract part of a function), then
  `lattice todo function-split verify --plan P --task S --commit <sha> [--base <sha>] --map <task>=<path#fn>[,...]`.
  `--base` defaults to `merge-base(commit, HEAD)`; a worker who merged before verifying passes the main sha before the
  merge (otherwise the diff is empty and verify could never pass).
  Every member may be mapped; one entry per member at most; an unmapped member keeps its declaration (§5).
- **Not split**: `lattice todo function-split decline --plan P --task S --reason <text>`.

### 4. Verify: the five conditions (claim 6)

Code graph (Neve) answers for the commit in one disposable worktree of the commit with one fresh index (runIsolatedTransform
with a no-op transform; about 11 s on Lattice's repo), reused for the tests, file nodes and Resolve, against `base`:

| Condition | Owner | Check |
|---|---|---|
| behaviour | Neve | per changed JS/TS file, export surface kept (`compareExportSurface`, base text vs commit text; a deleted file loses every name); a changed file of another language that has graph nodes fails with `export_surface_unobserved:<path>` (never a vacuous pass); files without nodes are ignored; no severed reference (`detectSeveredReferences`, residual = target path, over the other changed non-test files) |
| tests | Neve | the file-level `affected` tests of (changed files ∪ target path ∪ mapped paths) on the commit's index, run one by one with `node --test`, stopping at the first failure (`ran`, `not_run`, `skipped`). Static imports only; only node-runnable files. No runnable test = failed `no_test_reaches_function`; self-exit: the cut commit adds a test that imports the new function |
| fresh | Neve | every mapped `path#fn` resolves at the commit (`unresolved: [{task_id, path, symbol, reason: not_found or ambiguous, nearest or candidates}]`) |
| overlap | Alice | with every declared anchor of the mapped members re-resolved at the commit (the cut shifts the other functions of the file), no two mapped members of different lanes still write overlapping ranges (ADR 0204 judgment) |
| parallel | Alice | `measureWaveCount` over the mapped members is lower than before (all on F = one per lane) |

Overlap and parallel cover the mapped members: the sides the worker cut. An unmapped member is judged again after done S
(§5, D10).

Interface: `verifyFunctionSplit({repoRoot, commit, base?, target: {path, symbol}, map: [{task_id, path, symbol}],
anchors: [{task_id, path, symbol}]})` → `{base, commit, target: {resolved, start_line, end_line}, behaviour, tests: {passed,
ran, not_run, skipped, detail}, fresh: {passed, unresolved}, ranges: [{task_id, path, symbol, start_line, end_line}],
map: [{task_id, path, symbol, existed_at_base}]}` (Neve; `anchors` = every declared anchor of the members in the changed
files; `existed_at_base` = resolved at base with the same range, recorded and shown, not a condition). Alice adds overlap
and parallel and records the outcome. All five pass → `accepted`. Any fails → `rejected`, and Lattice reorganizes as not
split (§6, D7), reason = the failed conditions. The verify takes as long as the tests; it runs only when the worker asks.

A host's chart repository usually takes in main only (BellTeam's chart sync), so the worker's cut is not there. Verify
therefore fetches what it needs from the repository's `origin` before it observes: the commit itself (`git fetch origin
<sha>`, objects only, no ref is moved), the base when given, and, in a shallow clone, enough history for the merge-base
(`git fetch --deepen`, then `--unshallow` if still missing). The worker only pushes the branch, which the PR needs anyway
(Behemoth's finding, 2026-11-16, while writing BellTeam's rule).

Input errors are not a rejection and reorganize nothing: verify answers `{error: {code, next_action}}` for `source_dirty`
(the repoRoot has uncommitted changes; names them), `commit_not_found` (the commit is in neither the repository nor its
`origin`: the worker pushes the branch), `empty_diff` (base == commit: pass `--base`), `target_untouched` (the target path is not in the diff),
`map_entry_malformed`. repoRoot is the repository Resolve uses at todo add (a store-only chart has none: B does not arise
there, since it has no relations).

### 5. `todo done S` (D8)

Refused unless the split record is `accepted`. Lattice resolves the map at the HEAD of the repository Resolve uses at todo
add (the new functions must exist on main: the protection is adopting a cut that never landed; self-exit: merge the PR,
sync, done again). It rewrites each mapped member's witness row (the anchor on F replaced by its mapped function) through
the ADR 0204 declaration path, so relations are judged again and close where the overlap is gone. The rewrite is idempotent
per member (a row that already has the mapped function is skipped), so a half-run completes on the next `todo done S`.
Members already done or retired are skipped. An unmapped member keeps its row; if F no longer resolves,
its next start or declare answers the nearest names (ADR 0204). Then S is done as usual; its successors become startable.

### 6. Not split (D6, D7)

`function-split decline` or a rejected verify: in one revision, S is retired, and the member in progress that started
first (earliest `start` event; U) becomes the predecessor of every other unfinished member. If no member is in progress (U
was retracted), S is retired and no predecessor is added; the next start detects again. Each member gets a note with the
reason. A rejected verify writes the record first, then the revision; a crash between them is completed by the next verify
or decline (the retire is re-runnable from a rejected record). No 接続 is used:
the members are always in one plan (relations are judged within a plan).

### 7. Labels (D9; Plan/lifecycle projection and the gantt)

Derived from the plan already read; no file opened for them:
- every task in `members` of an unfinished S: label `分割待ち`, whatever its status (Owner's decision: the in-progress
  member cannot close before the split either; its status still reads 作業中, the label is shown beside it);
- S itself: label `関数分割`.
Wire: a new additive top-level `labels: [{plan_key, task_id, label}]` in `session-context` and in the display read result
(the gantt reads it), and the label in `todo show` and the text of `todo status`. Never on the status projection entries:
`todo status --json` keeps its exact wire shape, and session-context embeds the same projection.

### 8. Rulings from the role review (2026-11-16, Alice, Ludmila, Neve)

Folded into §1-§7 above: override on witness plans too; unset lanes and plans without a light revision start as today
(`split_unsupported`); S skips gates 1-3 and has no row; id suffixes and join by `(path, symbol)`; plan v9 with lazy
promotion; members sorted, start order from events; the splits record schema, lock and API; cut cost once at `todo start
S`; verify's single worktree, test selection, behaviour per file, error shapes and `--base`; overlap over every anchor of
the mapped members; idempotent done; not-split with no member in progress; labels as an additive top-level list.

Not adopted:
- Alice: no 分割待ち on the in-progress member. The Owner decided both members show it (§7).
- Alice: an unmapped member whose function vanished fails `fresh`. The Owner decided that a split landing with fewer sides
  is judged again afterwards (D10); `fresh` covers the mapped entries, and the unmapped member's next start answers the
  nearest names (ADR 0204).

Also: b3 exports `detectSeveredReferences`, `observeFreshSensor` and `buildOutputMounts` from `seam-apply.mjs` (private
today); `todo seam-proposal` behaviour unchanged. b9 accepts on a repository with the product code (the lattice chart is
store-only).

## Load budget (acceptance, on a BellTeam copy)

- `todo start` without a qualifying relation: unchanged. With one: today's start + one revision (≤ 2 s), measured with
  several tasks in progress (each revision adds a rebind start per in-progress task).
- Reads: no new file; labels from the plan.
- Verify: test time; never on a read or a schedule.

## Patent claims (implementation trace, not legal scope)

- Claim 5: on a write x write conflict between works actually running in parallel, the source is refactored (the split) so
  the works no longer write the same function.
- Claim 6: external behaviour compared (export surface, references, tests), ranges re-estimated on the refactored source
  (Resolve at the commit, then the judgment again), the plan arranges the works in parallel only when behaviour holds and
  the overlap is gone; otherwise they are arranged in series. A plan is produced in both branches (claim 1).
- Claim 4 is kept: read x write stays a conflict (arranged in series).

## Not decided here (named)

Two lanes already in progress on one function, writes outside a declared range (stage C); conflicts across plans (ADR 0204
compares within a plan); `todo seam-proposal` stays as it is and is not called by B.
