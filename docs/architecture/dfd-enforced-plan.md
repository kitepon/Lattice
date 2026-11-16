# Data flow: enforced plan gates (ADR 0200, 2026-11-12)

Owner: Plan/lifecycle (todo-cli). Store owns only the new `coordination_mode` value. Canonical ownership in
[function-map](function-map.md). Every gate reads state already computed; none adds a judgement. ADR 0200 gate 4 (done must name a URL or a commit) is gone: `todo done` asks for no evidence.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Store: `coordination_mode` | event payload `{mode, reason}` | `TODO_COORDINATION_MODES` = witness, conversation, enforced; projected as `member.coordination.mode` | Unknown mode refuses as before |
| Plan: start gates (1–3) | `startAdvisory` result (computed before the journal append, unchanged), plan mode, `--override-reason` | mode `enforced`: coverage `missing` or self unknown `witness_missing` → gate 1 (`declared_unobserved`, a recorded row on a Store root with no commit, passes: [witness declare](dfd-witness-declare.md)); `drift_intersecting` true or self unknown `record_stale` → gate 3; `conflicts_with_active` non-empty and no override → gate 2. Order 1, 3, 2. Other modes: advisory only (unchanged) | `TODO_TRANSITION_REFUSED` + next_action (`witness declare …`, `dependency connect …` / `--override-reason`); nothing written |
| Plan: no-code lanes (g3) | `member.plan.tasks[].lane`, `readTodoChartMeta().no_code_lanes` (host-set once with `chart set --no-code-lane`; an unreadable meta marks none) | In an `enforced` plan, `todo start` of a task whose lane is marked skips gates 1–3 (`noCodeTask`): it counts as declared with an empty boundary, so it needs no witness row and can neither conflict nor go stale. Code tasks keep every gate. Gate 4 no longer exists. Lattice names no lane | Clear the list with `chart set --no-code-lane ''`. |
| Plan: phase gate (5) | plan mode, phase gate_policy | mode `enforced` and gate_policy `heavy`: `phase_close_unaudited` refuses (single command and each `phase baseline` item, which lists it under `failed` with the code) | `enforced_heavy_phase_unaudited` + next_action `phase review` → `phase accept`, or revise the phase gate_policy |
| Plan: phase decision text | `phase accept [--message <text>]` / `phase reject --reason <text> [--message <text>]` (the one-version `--evidence <file>` alias reads the file's text into `--message`, exclusive with it) | The decision binds to the current review; the optional text is recorded in the `phase_accept`/`phase_reject` event only. No evidence, no slots: the phase closes on the decision alone. A seat that cannot write a file (BellTeam MCP) uses `--message` and reaches gate 5's exit | An unreviewed phase refuses `phase_not_reviewing` + next_action `phase review` |
| Plan: audit guidance | `phaseAuditRequired(member, gate_policy)` (todo-audit-pending, the same predicate gate 5 uses) | `todo status` `audit_pending.next_commands`, `phase status` guidance and `lattice status` `next_action` drop `close-unaudited` for that phase and offer `phase review` → `accept` | Guidance never names a command gate 5 refuses |

State and self-exit (guards rule):

```
start refused (1) --witness declare--> declared --start--> in-progress
start refused (1) on a Store root with no commit --witness declare (row recorded, not observed)--> declared_unobserved --start--> in-progress
start refused (3) --witness declare (recompile)--> fresh --start--> in-progress
start refused (2) --predecessor add--> not startable --active done--> ready --start--> in-progress
                  --start --override-reason--> in-progress (reason recorded)
close refused (5) --phase review--> review --phase accept [--message <text>]--> accepted
                  --plan revise (gate_policy light)--> close-unaudited allowed
any gate          --independence mode --set witness|conversation (recorded)--> warnings only
```
