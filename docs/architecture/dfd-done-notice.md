# Data flow: startable notices (notice-design, 2026-11-12)

Status: design for task `lattice-done-notice-20261112/notice-design` (Quo's ruling 2026-11-12:
watchers have a hole; Lattice tells the waiting party when work finishes, without watchers).
Owner: Plan/lifecycle (projection, CLI). Store owns the one new written artifact (the ack set);
its shape below is a proposal to agree with Ludmila. Delivery into BellTeam seats is Flora's
module and reads only the CLI JSON below. Canonical ownership in [function-map](function-map.md).

Boundary: Lattice records and shows. A notice is a fact ("this task became startable because of
these events"), never an assignment; it starts nothing and gates nothing. Readiness, the start/done
gates and hold/commit/resume are unchanged (patent claims untouched: read-only projection plus an
ack record outside the journal).

## What a notice is

A notice exists for a task T while all of these hold (the same predicates `todo status next_ready`
uses, `createTodoReadiness(store).isReady`):

- T is `pending`, its own phase is ready, and every prerequisite is satisfied: hard dependencies,
  joins, cross-plan dependencies, phase-accept edges;
- T has at least one prerequisite or its last own event is `unblock` (a task with nothing to wait
  for was never waited on; it is shown by `next_ready` / session-context as today).

Its **triggers** are the events that satisfied each prerequisite: for each predecessor task the
journal event that put it in its current finished state (`done` or `retire`), for each required
phase its `accept` event, and T's own `unblock` when that is its last event. `notice_id` =
sha256 of the canonical JSON `[plan_key, plan_version, task_id, sorted trigger event_digests]`.
So the id is stable across reads, and a new readiness (a predecessor reopened and done again, a plan
revision) gives a new id. Nothing new is written when a notice opens: the trigger events are already
in the Store journal, so a notice survives sessions and processes as long as the journal does.

A notice **closes** by itself when T leaves the condition (started, retired, blocked, a predecessor
reopened, the plan retired). Closed notices are not listed; there is nothing to clean up.

## Flow

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `projectTodoNotices(store, {lane?})` (new, pure, todo-notices.mjs) | Store view (all active members, as `todo status`); readiness from `createTodoReadiness`; member journals for trigger events; plan coordination mode; witness rows | Open notices sorted by plan_key, task_id: `{notice_id, plan_key, plan_version, task_id, title, lane, done_condition, coordination_mode, triggers: [{plan_key, task_id \| phase_id, kind, event_digest, recorded_at, actor}], next_action}`. `next_action` is what the start path accepts: on an `enforced` plan whose witness has no row for T, the `todo independence witness declare … --task T --owns <path>` command (gate 1 would refuse a bare start; same rule as [enforced plan](dfd-enforced-plan.md) done hints); otherwise `lattice todo start --plan <key> --task <T>` | Unreadable member: skipped and named in `unreadable: [plan_key]` (as `parallel_candidates`); never "no notices" |
| Plan: mutation result `notices` (todo-cli `mutate`, and the phase mutation for `phase accept`) | Open notice ids before the append (from the Store view the write path already validates) and the projection after it | `lattice.todo_mutation_result` gains `notices: [notice]` = notices open after the event and not before (all lanes; usually the successors this done/unblock/retire/accept released, cross-plan included). Empty array when none. `unchanged: true` results carry `notices: []` | Projection failure after a committed append does not undo or fail the mutation: `notices: null` + `notices_unavailable: <reason>`; `notice list` recovers them |
| Plan: `lattice todo notice list --lane <lane> [--include-acked] [--json]` | `projectTodoNotices(store, {lane})`; the lane's ack set | `lattice.todo_notice_list_result.v1 {project_id, lane, notices: [notice + acked:boolean], unreadable, result_digest}`. Default lists unacked only. Lane match is the exact lane string the plan records (bot id or name; the reader passes what it delivers to) | Missing `--lane` → USAGE with next_action naming the flag. Unknown lane = empty list, not a refusal |
| Store: ack set (proposal for Ludmila) | `notice ack` input | `.lattice/todo/notices/<sha256(lane) hex 16>.json` `{schema: lattice.todo_notice_acks.v1, lane, acks: [{notice_id, acked_at, actor}]}` written through the existing Store writer transaction. On each write, acks of notices no longer open are dropped (bounded by the lane's open notices) | Corrupt file → `STORE_CORRUPT` on that lane only, with the path; list still answers with `acked:false` and names it in `ack_unreadable` |
| Plan: `lattice todo notice ack --lane <lane> --notice <id>[,<id>…]` | Current open notices of the lane | `lattice.todo_notice_ack_result.v1 {lane, acked: [id], already: [id], closed: [id], result_digest}`. An id that is already closed is reported under `closed`, not refused (nothing is left to acknowledge). Repeating an ack is `already` | Id belonging to another lane → `closed` for this lane (no cross-lane write) |
| Delivery (Flora, outside Lattice) | (a) the `notices` array of any mutation the BellTeam `lattice` MCP tool runs; (b) `todo notice list --lane <bot> --json` for recovery (seat start, missed delivery, CLI used outside MCP) | Delivers each unacked notice to the lane's seat, then `todo notice ack`. Duplicate delivery is prevented by the ack, not by Lattice remembering deliveries | Contract: Lattice never pushes; it returns notices in the result of the write that caused them and keeps them listable until acked or closed |

## State and self-exit (guards rule)

No new guard. The only refusal is USAGE (missing `--lane` / `--notice`), which names the flag.

```
(no notice) --done|retire|unblock|phase accept makes T ready--> open/unacked
open/unacked --notice ack--> open/acked
open/*       --T started|retired|blocked|prerequisite reopened|plan retired--> closed (not listed)
closed       --T ready again (new trigger set, new notice_id)--> open/unacked
```

## Contracts to agree

- Flora (bot-7e777fe5): the read contract above (`notices` in mutation results, `notice list`,
  `notice ack`, notice fields, lane = exact plan lane string). Lattice does not resolve names to
  bots; the delivery side maps a lane to its seat.
- Ludmila: the ack set path, schema, pruning rule and that it is written through the Store writer
  (not a journal event, so plan journals and hold/commit/resume stay byte-identical).

## Out of scope

Script/CI completion notices (Trony); delivery code (Flora); notices for tasks with no prerequisite;
a session-context field (the seat already reads `turn.startable`; adding `turn.notices` is a later
choice).

## Verification for notice-impl

One test file: done of a predecessor (same plan and cross-plan) returns the successor in `notices`
with its lane; `notice list` shows it until `ack`, then not by default; start closes it; reopen of
the predecessor then done again opens a new id; enforced plan without a witness row gives the
declare next_action; `unchanged` done returns `notices: []`.
