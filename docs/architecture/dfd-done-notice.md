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
| Plan: `projectTodoNotices(store, {lane?, declared})` (pure, todo-notices.mjs) | Store view (all active members); ready set = `projectTodoStatus(…).next_ready` (the rule `todo status` uses); prerequisites from `createTodoReadiness(store).prerequisiteRefs` (predecessor tasks incl. cross-plan, phase-accept edges, predecessors' phases) plus the own phase's predecessor phases; trigger = each prerequisite's latest journal event; plan coordination mode; `declared(plan, task)` from the enforced plans' witness sets | Open notices sorted by plan_key, task_id: `{notice_id, plan_key, plan_version, task_id, title, lane, done_condition, coordination_mode, triggers: [{plan_key, task_id \| phase_id, kind, event_digest, recorded_at, actor}], next_action}`. `next_action` is what the start path accepts: on an `enforced` plan whose witness has no row for T, the `todo independence witness declare … --task T --owns <path>` command (gate 1 would refuse a bare start; same rule as [enforced plan](dfd-enforced-plan.md) done hints); otherwise `lattice todo start --plan <key> --task <T>` | Unreadable member: skipped and named in `unreadable: [plan_key]` (as `parallel_candidates`); never "no notices" |
| Plan: mutation result `notices` (todo-cli `releasesTasks` → `openNotices` before and after the action, `withNotices` re-digests the result) | The writes that can release a task: `done`, `retire`, `unblock`, `phase accept`, `phase close-unaudited`, `dependency disconnect`; one Store read before and one after the action (outside the write lock, also around `--atomic-commit`) | `lattice.todo_mutation_result` (which already carries `project_id`) gains `notices: [notice]` = notices open after the event and not before (all lanes; usually the successors this done/unblock/retire/accept released, cross-plan included). Empty array when none. `unchanged: true` results carry `notices: []` | Projection failure after a committed append does not undo or fail the mutation: `notices: null` + `notices_unavailable: <reason>`; `notice list` recovers them |
| Plan: `lattice todo notice list [--lane <lane>] [--include-acked] [--json]` | `projectTodoNotices(store, {lane})`; the ack sets | `lattice.todo_notice_list_result.v1 {project_id, lane, notices: [notice + acked:boolean], ack_unreadable: [{lane_file, code, reason}], result_digest}`. An unreadable Store refuses as every todo read does (nothing to list from); an unreadable ack file only puts its notices back to `acked:false` and names it in `ack_unreadable`. Default lists unacked only. No `--lane` = every lane (`lane: null`), so a reader recovers a whole project in one call (Flora). Lane match is the exact lane string the plan records | Unknown lane = empty list, not a refusal |
| Store: ack set (Ludmila, `src/todo-notice-store.mjs`; API `readTodoNoticeAcks({repoRoot, lane})` → record or `null`, `readAllTodoNoticeAcks({repoRoot})` → `{acks: [record], unreadable: [{lane_file, code, reason}]}`, `ackTodoNotices({repoRoot, lane, noticeIds, openIds, actor, now})` → `{acked, already}`) | `notice ack` input; the open ids Plan computed from a stable Store read (no main lock); `noticeIds` must be a subset of `openIds` (Plan reports the rest as `closed` before calling) | `.lattice/todo/notices/<sha256(lane) hex 16>.json` `{schema: lattice.todo_notice_acks.v1 (todo-contracts), lane, acks: [{notice_id, acked_at, actor}] sorted by id, acks_digest}` (self digest, canonical bytes), written by `atomicWrite` (temp+rename+fsync) under its own `notices/.write.lock` (`withStoreLock`, like notes), never the lifecycle lock; unchanged sets are not rewritten. Host-local, not git-tracked in any repository: the directory carries its own `.gitignore` (`*`) and the `STORE_PATHS` excludes in todo-store-git-transaction carry `notices/` (an ack must not make the next `--atomic-commit` refuse `todo_store_dirty_at_atomic_entry`); losing it means redelivery, never loss (precedent: independence.json, ADR 0127). Each write drops acks not in `openIds` (housekeeping; list filters by open ids anyway). Uninitialized-store detection (`transientStoreDirectory`) tolerates `notices/` residue, and authoring a new store clears it under its lock (acks of a gone store name notices that cannot open again) | Digest mismatch, non-canonical bytes, a `lane` field not equal to the requested lane (prefix collision) or bad shape → `STORE_CORRUPT` for that lane with the path (`readAllTodoNoticeAcks` names it in `unreadable`, the others still read; list answers `acked:false` and names it in `ack_unreadable`); the next `ack` on that lane replaces it (its acks were already unusable). Unknown newer schema → `UNSUPPORTED_SCHEMA`/`newer_lattice_value` (#142 rule, `rejectNewerTodoSchema`, family `todo_notice_acks` in `NEWEST_KNOWN_TODO_SCHEMA`) on read and on ack (never downgraded). No published Store → `STORE_WRITE_CONFLICT`/`store_missing` (protects against writing a Store skeleton outside a Store; leaves once the Store is initialized) |
| Plan: `lattice todo notice ack --lane <lane> --notice <id>[,<id>…]` | Current open notices of the lane | `lattice.todo_notice_ack_result.v1 {lane, acked: [id], already: [id], closed: [id], result_digest}`. An id that is already closed is reported under `closed`, not refused (nothing is left to acknowledge). Repeating an ack is `already` | Id belonging to another lane → `closed` for this lane (no cross-lane write) |
| Delivery (Flora, outside Lattice) | (a) the `notices` array of any mutation the BellTeam `lattice` MCP tool runs; (b) `todo notice list --lane <bot> --json` for recovery (seat start, missed delivery, CLI used outside MCP) | Delivers each unacked notice to the lane's seat, then `todo notice ack`. Duplicate delivery is prevented by the ack, not by Lattice remembering deliveries | Contract: Lattice never pushes; it returns notices in the result of the write that caused them and keeps them listable until acked or closed |

## State and self-exit (guards rule)

No new guard. The only refusal is USAGE on `notice ack` (missing `--lane` / `--notice`), which names the flag.

```
(no notice) --done|retire|unblock|phase accept makes T ready--> open/unacked
open/unacked --notice ack--> open/acked
open/*       --T started|retired|blocked|prerequisite reopened|plan retired--> closed (not listed)
closed       --T ready again (new trigger set, new notice_id)--> open/unacked
```

## Contracts

- Flora (bot-7e777fe5), agreed 2026-11-12: primary input is the mutation result `notices` (every
  BellTeam Lattice write goes through the seat tool, which sees the result right after the write);
  `notice list` (no lane, unacked) is recovery at module start, after `notices: null`, and for failed
  deliveries. BellTeam lanes are Bot ids (or `owner`), ASCII; the module pushes only to a lane equal
  to a roster Bot id, others stay unacked in the list. Ack after BellTeam accepts the delivery
  (queued/running/steered) or reports it unknown (never resent); a failed delivery is not acked.
  `notice_id` is the dedupe key. `project_id` comes from the mutation result / list result.
- Ludmila, agreed 2026-11-12: the ack set row above; the Store API is hers (in notice-impl, split
  to her lane). Not a journal event, so plan journals and hold/commit/resume stay byte-identical.
- A `start` then `retract` puts T back to pending with the same trigger set, so the notice keeps
  its id and an existing ack: no redelivery. Chosen: the lane retracted its own start and already
  knows; `unblock` (someone else's block lifted) is in the trigger set and does re-notify.

## Out of scope

Script/CI completion notices (Trony); delivery code (Flora); notices for tasks with no prerequisite;
a session-context field (the seat already reads `turn.startable`; adding `turn.notices` is a later
choice).

## Verification for notice-impl

One test file: done of a predecessor (same plan and cross-plan) returns the successor in `notices`
with its lane; `notice list` shows it until `ack`, then not by default; start closes it; reopen of
the predecessor then done again opens a new id; enforced plan without a witness row gives the
declare next_action; `unchanged` done returns `notices: []`.
