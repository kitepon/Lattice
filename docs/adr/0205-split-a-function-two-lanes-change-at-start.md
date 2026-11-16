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

`todo start --plan P --task T`, in a witness or enforced plan (conversation plans have no judgment; unchanged), after today's
readiness check and before the enforced gates:

1. Read T's open relations (`readTodoTaskRelations({taskId: T})`, ADR 0204 §5; nothing else is opened).
2. Keep the overlaps where T writes and the other task U writes (`access` of both sides is `write`), U is `in-progress`,
   and `lane(U) != lane(T)`. None → today's start, unchanged (read x write included, D2).
3. For each kept function `F = {path, symbol}` of U's side (U's anchor; a whole-file claim is skipped: no function to cut):
   - an unfinished task S in P with `function_split` on the same path and an overlapping range → **join**: S becomes a
     predecessor of T; T is appended to `S.function_split.members`; a note on S names T.
   - otherwise **add**: a task S `split-<12 hex of digest(P, path, symbol)>`, lane `lane(U)`, phase `phase(U)`, title
     `Split <path>#<symbol>`, design memo naming U, T and the function, marked `function_split {path, symbol, members:
     [U, T]}`, predecessor of U and of T. U stays in progress (a revision carries it; `todo done U` is refused until S is
     done, which keeps U from closing before the split it must rebase on).
   The adds and joins of one start are one plan revision.
4. T is not started. With `--override-reason` on an enforced plan, step 3 is skipped and T starts as today (recorded).

Result (exit 0): `lattice.todo_start_split_result.v1`
`{project_id, plan_key, plan_version, task_id: T, status: "pending", splits: [{task_id: S, path, symbol, joined, members}],
next_action: "wait: S is in <lane>; the chart offers T again when every split it waits on is done or withdrawn"}`.
A caller never retries the start; the chart's startable notice brings T back.

### 2. The split task (Store record, Ludmila)

- `function_split` is an optional field on a plan task: `{path, symbol, start_line, end_line, members: [task_id...]}`
  (members ≤ 64). Written only by the revision of §1; carried across revisions like other task fields. A plan carrying it
  is a newer plan value for older readers (rollout: seats upgrade first, as with ADR 0204).
- The map and the verify outcome live outside the plan, in `.lattice/todo/splits/<plan_key>/<S>.json` (bounded, own lock
  like relations): `{map: [{task_id, path, symbol}], commit, outcome: "accepted" | "rejected", conditions, recorded_at, actor}`.
  Only `function-split verify`, `todo done S` and `todo show S` read it.

### 3. The worker's decision (Plan/lifecycle CLI; D5)

S is startable in U's lane, so the startable notice tells U's worker. `todo start S` / `todo show S` carry
`function_split {path, symbol, members, cut_cost}` where `cut_cost` is the existing seam-cost profile of that file
(`computeSeamCostProfile`), so the worker sees the size before deciding.

- **Split**: the worker writes the cut on a branch from main (a code change by the worker: Lattice has no data-flow
  analysis to extract part of a function), then
  `lattice todo function-split verify --plan P --task S --commit <sha> --map <task>=<path#fn>[,<task>=<path#fn>...]`.
  Every member may be mapped; one entry per member at most; an unmapped member keeps its declaration (§5).
- **Not split**: `lattice todo function-split decline --plan P --task S --reason <text>`.

### 4. Verify: the five conditions (claim 6)

Code graph (Neve) answers for the commit, in a disposable worktree (isolation runner), against `base = merge-base(commit,
HEAD)`:

| Condition | Owner | Check |
|---|---|---|
| behaviour | Neve | export surface of the changed files kept (`compareExportSurface`) and no severed reference in a fresh index of the commit (`detectSeveredReferences`) |
| tests | Neve | the tests that reach F in the graph pass at the commit (`node --test`, as seam apply) |
| fresh | Neve | every mapped `path#fn` resolves in the fresh index of the commit (Resolve at a commit) |
| overlap | Alice | with the mapped ranges, no two mapped members of different lanes still write overlapping ranges (ADR 0204 judgment) |
| parallel | Alice | `measureWaveCount` over the mapped members is lower than before (all on F = one per lane) |

Interface: `verifyFunctionSplit({repoRoot, commit, target: {path, symbol}, map: [{task_id, path, symbol}]})` →
`{base, commit, behaviour: {passed, detail}, tests: {passed, ran: [...], detail}, fresh: {passed, unresolved: [...]},
ranges: [{task_id, path, symbol, start_line, end_line}]}` (Neve); Alice adds overlap and parallel and records the outcome.
All five pass → `accepted`. Any fails → `rejected`, and Lattice reorganizes as not split (§6, D7), reason = the failed
conditions. The verify takes as long as the tests; it runs only when the worker asks.

### 5. `todo done S` (D8)

Refused unless the split record is `accepted`. Lattice resolves the map at the chart's current HEAD (the new functions must
exist on main: the protection is adopting a cut that never landed; self-exit: merge the PR, sync, done again). It rewrites
each mapped member's witness row (the anchor on F replaced by its mapped function) through the ADR 0204 declaration path, so
relations are judged again and close where the overlap is gone. An unmapped member keeps its row; if F no longer resolves,
its next start or declare answers the nearest names (ADR 0204). Then S is done as usual; its successors become startable.

### 6. Not split (D6, D7)

`function-split decline` or a rejected verify: in one revision, S is retired, and the member that started first (earliest
`start` event; U) becomes the predecessor of every other member. Each member gets a note with the reason. No 接続 is used:
the members are always in one plan (relations are judged within a plan).

### 7. Labels (D9; Plan/lifecycle projection and the gantt)

Derived from the plan already read; no file opened for them:
- a task in `members` of an unfinished S: label `分割待ち` (wire: `split_wait: {task_id: S}`), whatever its status;
- S itself: label `関数分割` (wire: `function_split: {path, symbol}`).
Shown in `todo show`, the text of `todo status`, `session-context`, and the gantt (a chip next to the status). `todo status
--json` keeps its exact wire shape (ADR 0204: a field there is a version change for a separate decision).

## Load budget (acceptance, on a BellTeam copy)

- `todo start` without a qualifying relation: unchanged. With one: today's start + one revision (≤ 2 s).
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
