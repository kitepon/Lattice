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
up to 64). The machine derives `seat_id` into the top level of `status --json`
and `session-context --json`, and keeps the seat's own display and delivery
state under `~/.lattice/seats/<seat_id>` (`LATTICE_CONFIG_DIR` still wins when
set). An unset or malformed id makes the seat anonymous; nothing refuses.

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
