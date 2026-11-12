# ADR 0200 — A plan declared `enforced` stops the steps a seat would skip

- Status: Accepted
- Date: 2026-11-12
- Owners: Lattice (Snow White)
- Decision source: Owner ruling (Approval Box, 2026-11-12 JST: 「1〜5を強制にする（置き場が整ってから順に入れる）」)
- Supersedes, for `enforced` plans only: ADR 0160 §3 (unjudged does not block dispatch), ADR 0128 (conflict is advisory), ADR 0181 (done is not an audit gate), ADR 0148 (close-unaudited on any gate_ready phase)
- Diagram: [dfd-enforced-plan](../architecture/dfd-enforced-plan.md)

## Context

BellTeam's coordinator chart (Lattice 0.85.5, ~15 members on one repo) used only plan create/revise, start/note/done and
dependency connect. Both plans were declared `conversation`. No witness row was declared, three heavy phases were closed
unaudited, paused tasks were marked in the title instead of `todo block`, and done evidence stayed unverified. Advisories
were read and passed by. The Owner ruled that steps whose omission causes harm stop the command until they are done.

## Decision

`todo independence mode --set enforced --reason <text>` declares a plan `enforced`: witness coordination plus five gates.
The default for every other plan is unchanged (warnings only). Each gate names what it protects and its self-exit:

| # | Command | Refuses when | Protects | Self-exit |
|---|---|---|---|---|
| 1 | `todo start` | the task has no witness row (or the plan has no compiled record) | two members writing the same files unaware | `todo independence witness declare --plan --task --owns ...` |
| 2 | `todo start` | the task conflicts with an in-progress task and no `--override-reason` is given | silent concurrent edits of one boundary | `todo dependency connect` (wait), or `--override-reason <text>` (recorded) |
| 3 | `todo start` | main moved under the task's declared boundary since the record (drift intersecting, record stale) | a judgement made against code that no longer exists | `witness declare` again (it recompiles) |
| 4 | `todo done` | neither `--evidence` nor a `--message` naming an http(s) URL or a commit reachable from HEAD | completion with no traceable change | add the PR URL or the merged commit |
| 5 | `phase close-unaudited` (and `phase baseline`) | the phase's gate_policy is `heavy` | an audit the plan author required being skipped | `phase review` → `accept`, or revise the phase to a non-heavy gate_policy (recorded) |

Gates 1–3 need the store to live in a checkout of the code the tasks change (the sensor observes the store's own repo).
A host declares `enforced` only after that.

Switching a plan from `enforced` back to `witness` or `conversation` is a recorded `coordination_mode` event (actor and
reason); Lattice does not forbid it. Which plans must be `enforced` is the host's rule (ADR 0178).

## Consequences

- `coordination_mode` accepts a third value `enforced`. A Lattice older than 0.88.0 rejects the whole store
  (`STORE_CORRUPT` `journal_schema_invalid`, for every plan, not only that one) while an active plan version holds it.
  Declaring `witness` again does not bring older readers back (the `enforced` event stays in the hash chain); only
  `plan revise` does, after which 0.85.4–0.87.x read that plan as undeclared. Every reader of a store must therefore be
  0.88.0 or later before a plan in it is declared `enforced` (Store review, Ludmilla, 2026-11-12).
- Refusals are `TODO_TRANSITION_REFUSED` with reasons `enforced_witness_undeclared`, `enforced_witness_stale`,
  `enforced_conflict_with_active`, `enforced_done_reference_missing`, `enforced_heavy_phase_unaudited`, each with
  `next_action`. Nothing is written on a refusal.
- Advisories, guidance and parallel candidates treat `enforced` as `witness`, except that the audit guidance
  (`todo status` audit_pending, `phase status`, `lattice status`) does not offer `close-unaudited` for a phase gate 5
  would refuse; it offers `phase review` → `accept`.
