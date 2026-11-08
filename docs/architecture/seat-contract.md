# Seat contract — what the AI states, what the machine derives

Owner goal (2026-11-07): Lattice must be light enough for a BellTeam seat (an AI
running in a Linux container) to use without reading documents. This contract is
the acceptance instrument for that goal. It governs every authoring input, the
seat-facing command surface and the error shape. It does not touch the claimed
product logic (see the patent claim map in [function-map.md](function-map.md)).

Principle: the AI states judgements; the machine derives facts. An input never
asks the AI for a fact the machine can compute. A refusal names the field and
the rule.

## Division of labour

| The AI states (allowed in inputs) | The machine derives (never requested) |
|---|---|
| Plan title, purpose, final outcome, acceptance | project_id match, plan_key uniqueness, plan_version assignment |
| Task title, design memo (why, what, done-criterion), owner lane | task_id normalisation, ordering of tasks/phases/edges, identifier canonical form |
| Dependencies (A before B), joins | All digests (input, chain, plan, topology, revision), provenance, recorded_at, actor identity (from seat configuration) |
| Phase names and order, required evidence kinds | Gate evaluation, audit-pending derivation |
| On revision: the full desired state plus, per in-progress or done task, carry / reset / remove | Diff against the predecessor, migration table, CAS, retention of the old version, dangling-reference detection |
| Start / done / note / block intent and reason, evidence location | Evidence digest and blob, transition validity (readiness), re-read and publication |
| For an existing capability: the evidence reference | Feature-graph reachability and producer/consumer closure |

## Seat surface (minimal)

Write a plan (create, add and revise share one input shape), read state
(`status --json`, `session-context --json`), start, note, done, block/unblock,
dependency connect. Every other command remains but is not part of seat guidance.
Flags such as `--json` never change the outcome of a write command; a flag that
does not apply is ignored or reported by name, never a refusal of the command.

A seat may say who it is with `LATTICE_SEAT_ID` (letters, digits, `.`, `_`, `-`;
up to 64). The machine derives `seat_id`; it appears at the top level of
`session-context --json` (the turn-start read; `status --json` keeps its frozen
v1 shape, ADR 0131), and the default actor `agent` becomes the seat id
(`LATTICE_TODO_ACTOR_AGENT` still wins), so seats that share one OS user keep
their own `turn.own`. The seat's own
display and delivery state moves under `~/.lattice/seats/<seat_id>`
(`LATTICE_CONFIG_DIR` still wins when set), so the terminal identity and the
default actor `host` become per-seat as well. This is a one-time transition:
a start recorded before the seat first set `LATTICE_SEAT_ID` is retracted in
the old environment, or finished first. An unset or malformed id makes the
seat anonymous; nothing refuses.

## Turn-start read (a3, Snow 2026-11-08)

`lattice session-context --json` is the one read a seat makes at the start of a
turn (one process, one store read, ADR 0131). Schema `lattice.session_context.v2`
= v1 plus one object `turn`. Lattice records and shows; `turn` chooses and
assigns nothing.

| Field | Value |
|---|---|
| `turn.actor` | `{host, session, agent}` the CLI would write with now (`resolveTodoActor(env)`: `LATTICE_TODO_ACTOR_*`, else the seat defaults). |
| `turn.startable` | `todo.next_ready` as is (`plan_key, task_id, label, done_condition`). |
| `turn.own` | This seat's in-progress and blocked tasks: a task whose status is `in-progress` or `blocked` and whose latest `start` event in its plan's current journal was recorded with `actor.agent === turn.actor.agent`. Entry `{plan_key, task_id, label, status, started_at, blocked_reason, done_condition}`, sorted by plan_key then task_id. Done tasks are history and stay in `todo status`/`todo show`. A carried task whose start lies in a predecessor version appears after its rebind start (blocked carried tasks without one are not listed). |
| `turn.warning` | Present only when the store is missing or unreadable: `{reason}` (the status reason). `startable` and `own` are then `[]`; the read never refuses. |

`lattice status --json` keeps `lattice.project_status.v1` exactly; when a store
exists and work is active (`active_run_present`) its `next_action.command` is
`lattice session-context --json` instead of `lattice todo status`. Other
next_action branches are unchanged.

## Error shape

`code` names the kind; `detail.pointer` names the field; `detail.rule` names the
rule that was broken; `detail.next_action` says how to repair. A refusal caused by
an unmet dependency names the blocking task, not the flag that was passed.

## Measurement

Time for a fresh seat, without documents, to author its first plan and start one
task; number of schemas it had to read. Baseline 2026-11-07: about two hours and
four schemas (supervisor's own seat). Target: minutes and zero.

## Ownership

Supervisor (Lattice統括) owns this contract; Plan/lifecycle implements the input
and error shape (tasks t03, t04, t05, t06, t19 of plan
lattice-modernization-20261107); Store implements the append and revision reader
(t02, t10); Surfaces implement per-seat state and identity (t07). Changes to this
file travel in the same diff as the implementation they govern.
