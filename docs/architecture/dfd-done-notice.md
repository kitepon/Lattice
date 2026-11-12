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

## Waiting (wait-design, 2026-11-12)

Status: design for task `lattice-waiting-notice-20261112/wait-design` (Quo's ruling 2026-11-12:
(1) a notice tells the lane it CAN start, never an order; the lane may be on other work and decides;
(2) a lane that is explicitly idle-waiting must always be told; (3) command completion is Trony's,
outside Lattice). Shape accepted by the coordinator; Store rows agreed with Ludmila (A-D folded in), delivery with
Flora (amendments folded in), 2026-11-12.

Boundary: a wait is a record ("this agent stopped work and waits for T to become startable"). It
starts nothing and gates nothing; readiness, the start/done gates and hold/commit/resume are
unchanged, and plan journals stay byte-identical (no new event kind).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan: `lattice todo wait --plan <key> --task <T> [--reason <text>]` / `… --cancel` | actor agent (`resolveTodoActor`), Store view, the open notices | `lattice.todo_wait_result.v1 {project_id, plan_key, task_id, agent, since, reason, state, notice, result_digest}`. `state`: `waiting` (recorded; T pending or blocked and not yet startable), `startable_now` (nothing recorded; `notice` = T's open notice, or `null` with the start `next_action` when T has no prerequisite), `not_pending` (nothing recorded; T's status named), `cancelled` (`--cancel`; `false`-valued `cancelled` when there was none). Repeating a wait keeps its `since` and takes the new reason. Several agents may wait on one task | No refusal beyond USAGE (missing `--plan`/`--task`, unknown task = `TASK_NOT_FOUND` as every todo command): a state, not a guard |
| Plan: wait in effect (`waitInEffect(store, wait)`, pure) | the wait, T's status and own journal events | In effect while T is `pending` or `blocked` and no own `start` or `retire` event is recorded after `since`. So start, retire, start-then-retract and done clear it; a block plus unblock by someone else keeps it (the waiter is still woken) | Shortcut (code comment): a start-then-retract in an earlier plan version followed by a revise can bring a wait back; chosen over a revise silently dropping waits (ruling 2) |
| Store: waits record (Ludmila, `todo-notice-store.mjs`; API `readAllTodoNoticeWaits({repoRoot})` → `{waits: [record], unreadable: [{wait_file, code, reason}]}`, `writeTodoNoticeWait({repoRoot, planKey, taskId, agent, reason, now, keep})` → `{recorded, since}` (`recorded: false` = (task, agent) existed: `since` kept, reason replaced), `cancelTodoNoticeWait({repoRoot, planKey, taskId, agent})` → `{cancelled}`) | `todo wait` input; Plan's `keep` predicate (`waitInEffect` bound to one Store read: synchronous and pure, it runs under the notices lock and is applied to the existing waits only; Plan checks the new wait, T pending or blocked, before calling) | `.lattice/todo/notices/wait-<sha256(plan_key) hex 16>.json` (flat in `notices/`, so the lock, `.gitignore`, mkdir path and the abandoned-store residue sweep are reused; a `waits/` directory would make re-initialization over a gone Store fail) `{schema: lattice.todo_notice_waits.v1, plan_key, waits: [{task_id, agent, since, reason}] sorted by (task_id, agent), waits_digest}` (self digest, canonical bytes; `plan_key`/`task_id` `isTodoIdentifier`, `agent` the lane check, `since` a strict timestamp, `reason` null or a non-empty string without control characters, at most 1024 chars), `atomicWrite` under `notices/.write.lock`; host-local and git-ignored like the ack sets. Each write drops the waits `keep` rejects (housekeeping). Readers return raw records, so Plan applies `waitInEffect` when it lists too. `cancelTodoNoticeWait` takes no `keep` | Corrupt / prefix collision → `STORE_CORRUPT` for that file, named in `unreadable` (its waits read as none); the next write replaces it. Prefix collision is checked against `plan_key`; no published Store → `STORE_WRITE_CONFLICT`/`store_missing`. Newer schema → `UNSUPPORTED_SCHEMA`/`newer_lattice_value` (`NEWEST_KNOWN_TODO_SCHEMA` gains `todo_notice_waits: 1`), never downgraded. **Known limits:** host-local, so another host's clone does not see the mark; a lost file loses the wake mark (the notice itself still lists as information), and re-running `todo wait` restores it; a file may still hold waits that ended after its last write, including files of plans that no longer exist: bounded leftovers Plan ignores |
| Plan: notice fields (`projectTodoNotices`) | the waits in effect for T | Each notice gains `waiting: [{agent, since, reason}]` (sorted by agent; `[]` when nobody waits), `waiting_digest` = Store's `todoNoticeWaitingDigest(waiters)` (sha256 hex of `canonicalizeTodoArtifact` of the sorted `[[agent, since], …]`; of `[]` when nobody waits). The Store owns this function because it needs digest(`[]`) to read v1 acks; Plan imports it and never computes the digest itself, and `summary`: without waiters `"<plan>/<task> 「<title>」 can start now. Information, not a request: whether and when to start is the lane's call."`, with waiters `"<plan>/<task> 「<title>」 can start now. <agent>[, <agent>] waiting since <since>."` (wording aligned with Flora's delivery text, BellTeam #1190). `next_action` keeps its key and value and means "the command, if you start". `notice_id` is unchanged (waits do not change the readiness it names) | Waits unreadable → `waiting: []` for those tasks and the file named in `wait_unreadable` on `notice list` (never "nobody waits" silently) |
| Store: ack key (Ludmila; ack set `lattice.todo_notice_acks.v2`) | `notice ack` with the current `waiting_digest` of each notice | `acks: [{notice_id, waiting_digest, recipients, acked_at, actor}]` unique and sorted by (notice_id, waiting_digest), where `recipients` = the lane plus the waiting agents the notice had when acked (non-empty, sorted, unique, each passing the lane check, containing the lane); `ackTodoNotices({repoRoot, lane, notices: [{notice_id, waiting_digest, recipients}], openIds, actor, now})` → `{acked: [pair], already: [pair]}` (every notice_id in `openIds`; an existing pair is `already` and keeps its first entry). Housekeeping drops acks whose notice_id is no longer open and keeps every digest variant of an open notice, so `acked_recipients` never loses recipients already informed (bounded: one ack per waiter set an open notice went through). A v1 file reads as `waiting_digest` = digest of `[]` and `recipients` = `[lane]`, so existing acks stay valid for notices without waiters; the next write rewrites it as v2 (`todo_notice_acks: 2`), which an older Lattice refuses as newer and never overwrites. `notice list` marks a notice acked iff the pair matches, so a wait added after an ack makes it unacked again (must be delivered). Every notice (mutation results and `notice list`) carries `acked_recipients` = the union of `recipients` over this lane's acks of its `notice_id` (`[]` when never acked), so delivery sends a re-opened notice only to the recipients not yet covered (Flora, 2026-11-12) | As the v1 ack set |
| Delivery (Flora, outside Lattice) | mutation result `notices`, `notice list` | A notice with `waiting` is always delivered and wakes each waiting agent that is a roster Bot (the "writer's own lane is not sent" skip does not apply to another waiter); a notice without waiters is information to the lane. Recipients: the lane (information) plus every waiter that is a roster Bot (wake); the writing Bot is skipped whether lane or waiter (it has the notice in its own result); recipients in `acked_recipients` are skipped. One ack per notice after every recipient answered accepted/unknown/refused; a failed or thrown send = no ack, retried at the next run (Flora, agreed 2026-11-12) | As for notices |

State and self-exit (no new guard):

```
(no wait) --todo wait, T not startable--> waiting
(no wait) --todo wait, T startable--> startable_now (nothing recorded; notice/next_action returned)
waiting   --T becomes startable--> notice open with waiting (delivered, wakes each waiter)
waiting   --T start|retire, or --cancel--> no wait
notice acked (waiting_digest d) --a new wait--> unacked (waiting_digest d') --ack--> acked
```

Verification for wait-impl: one test file: wait on a pending T, done of the predecessor returns the
notice with `waiting` and the waiter-set digest; `notice list` keeps it unacked until ack; a wait
added after an ack makes it unacked with `acked_recipients` naming the lane; start clears the wait (and a retract does not bring it back);
wait on a startable T returns `startable_now` and writes nothing; `--cancel`; a v1 ack file still
reads.

## Out of scope

Script/CI completion notices (Trony); delivery code (Flora); notices for tasks with no prerequisite (a wait on such a task answers `startable_now`);
a session-context field (the seat already reads `turn.startable`; adding `turn.notices` is a later
choice).

## Verification for notice-impl

One test file: done of a predecessor (same plan and cross-plan) returns the successor in `notices`
with its lane; `notice list` shows it until `ack`, then not by default; start closes it; reopen of
the predecessor then done again opens a new id; enforced plan without a witness row gives the
declare next_action; `unchanged` done returns `notices: []`.
