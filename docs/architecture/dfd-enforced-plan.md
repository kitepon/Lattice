# Data flow: enforced plan gates (ADR 0200, 2026-11-12)

Owner: Plan/lifecycle (todo-cli). Store owns only the new `coordination_mode` value. Canonical ownership in
[function-map](function-map.md). Every gate reads state already computed; none adds a judgement.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Store: `coordination_mode` | event payload `{mode, reason}` | `TODO_COORDINATION_MODES` = witness, conversation, enforced; projected as `member.coordination.mode` | Unknown mode refuses as before |
| Plan: start gates (1–3) | `startAdvisory` result (computed before the journal append, unchanged), plan mode, `--override-reason` | mode `enforced`: coverage `missing` or self unknown `witness_missing` → gate 1 (`declared_unobserved`, a recorded row on a Store root with no commit, passes: [witness declare](dfd-witness-declare.md)); `drift_intersecting` true or self unknown `record_stale` → gate 3; `conflicts_with_active` non-empty and no override → gate 2. Order 1, 3, 2. Other modes: advisory only (unchanged) | `TODO_TRANSITION_REFUSED` + next_action (`witness declare …`, `dependency connect …` / `--override-reason`); nothing written |
| Plan: done gate (4) | plan mode, `--evidence`, `--message`, git of the store repo | mode `enforced`: pass if `--evidence`, or the message holds an `http(s)://` URL, or a 7–40 hex token that `git merge-base --is-ancestor <tok> HEAD` accepts. A repeated done stays `unchanged` (checked inside the write path) | `enforced_done_reference_missing` + next_action `todo done … --message "<PR URL or merged sha>"`; nothing written |
| Plan: phase gate (5) | plan mode, phase gate_policy | mode `enforced` and gate_policy `heavy`: `phase_close_unaudited` refuses (single command and each `phase baseline` item, which lists it under `failed` with the code) | `enforced_heavy_phase_unaudited` + next_action `phase review` → `phase accept`, or revise the phase gate_policy |
| Plan: phase decision evidence | `phase accept --message <text>` / `phase reject --reason <text> --message <text>` (exclusive with `--evidence` and `--input`), the store repo's object store | The text becomes message evidence through the same path as `todo done --message` (`.lattice/todo/evidence/<plan>/<phase>-<outcome>/<sha256>.md`, blob written with `hash-object -w`, no commit needed); same descriptor, same `phase_accept`/`phase_reject` event, same single-slot rule. Read side, read-only (`isTodoEvidenceUncommitted`): `phase status` and the decision result carry `decision_evidence_state` committed / uncommitted / null, and `todo verify` lists an uncommitted decision under `uncommitted_evidence` with `phase_id`. A seat that cannot write into the Store root (BellTeam MCP) reaches gate 5's exit this way; it is never shown as audited by committed evidence | `--message` with `--evidence` refuses (`flags_exclusive`); several slots still need `--input`. The blob is anchored under `refs/lattice/evidence/<oid>` when written ([evidence anchors](dfd-todo-start.md)), so gc keeps it; anchored is not committed, so the state stays `uncommitted` |
| Plan: done hints in refusal guidance | todo-cli `enforcedPlanKeys` (Store read on a store refusal; `[]` if unreadable) → guidance context `enforcedPlans`; the plan key each hint names | `cli-refusal-guidance` `doneCommand`: a hint for a plan in `enforcedPlans` offers `todo done … --message "<PR URL or merged commit sha>"` (`ENFORCED_DONE_MESSAGE`, the same text as gate 4's next_action); other plans keep their hint as it was. Covers unfinished predecessor, in-progress under the OS user, reopen of an open task, retract without a start | Guidance never offers a done gate 4 refuses; an unreadable store falls back to the unchanged hint |
| Plan: audit guidance | `phaseAuditRequired(member, gate_policy)` (todo-audit-pending, the same predicate gate 5 uses) | `todo status` `audit_pending.next_commands`, `phase status` guidance and `lattice status` `next_action` drop `close-unaudited` for that phase and offer `phase review` → `accept` | Guidance never names a command gate 5 refuses |

State and self-exit (guards rule):

```
start refused (1) --witness declare--> declared --start--> in-progress
start refused (1) on a Store root with no commit --witness declare (row recorded, not observed)--> declared_unobserved --start--> in-progress
start refused (3) --witness declare (recompile)--> fresh --start--> in-progress
start refused (2) --dependency connect--> waiting --active done--> ready --start--> in-progress
                  --start --override-reason--> in-progress (reason recorded)
done refused (4)  --done --message "<URL|merged sha>"--> done
close refused (5) --phase review--> review --phase accept (--evidence <file> | --message <text>)--> accepted
                  --plan revise (gate_policy light)--> close-unaudited allowed
any gate          --independence mode --set witness|conversation (recorded)--> warnings only
```
