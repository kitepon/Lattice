# ADR 0203: Evidence is plain text in the done event; nothing re-verifies stored evidence

Status: accepted (2026-11-15, b11/k4, Ludmila; direction by the Owner via Snow White). Supersedes the first draft of this ADR
("batched, uncapped reads"): the reads are removed, not sped up.

## Context

Every Store read and write replayed all evidence and read each blob through `git cat-file` to compare its digest, then set
`evidence_unverified`. A per-process cache held 512 blobs, so a chart with more distinct evidence (`bellteam-dev-added`) started
one git process per extra blob and per eviction: 13.3 s of a 16.1 s `todo add` in Trony's production profile (22:36 JST). The
flag blocked nothing; nobody demands the check; Git and the PRs already hold the real evidence. Lattice records who does what, in
which order, and where it stands.

## Decision

Removed, each with "protected: nothing named" (guards.named-protection, guards.remove-unnamed):

| Removed guard | What it did | Protected |
|---|---|---|
| evidence blob re-read on every read and write (`readEvidenceBlob`, the 512-entry cache, `prefetchVerificationObjects` for evidence, the `evidence_unverified` annotation) | `git cat-file` per blob, sha256 compare | nothing named (it only set a flag) |
| `reachableObjects` check on read | `git rev-list` of all refs | nothing named |
| hard evidence / import-source verification of the new event at append | refused a done whose blob was missing | nothing named (the new done carries no blob) |
| import-source re-verification on read | `git cat-file` per pinned source | nothing named |
| per-read hash-chain re-verification, per-line canonical re-check of the journal, canonical re-check and revision/genesis binding comparison of plan.json/revision.json, whole-snapshot comparison and the `snapshot_stale` write refusal | recomputed every digest of the whole history before each operation | nothing named; a stale snapshot is rebuilt, not a refusal |

Kept: the write lock and the head check (`manifest_journal_head_mismatch`, the event's `previous_digest`) that stops two writers
overwriting each other; schema/shape validation of every record (also how a newer Lattice's value is recognised); the prospective
replay of the new event (it validates the transition and computes the new state, it does not re-check history); the descriptor-shape
check of legacy evidence. `evidence_unverified` stays in the task/snapshot/status shapes as a constant `false` for this version.

`lattice todo verify` is the one explicit, opt-in check: it reads with `verifyHistory: true` (hash chain, canonical bytes,
revision/genesis binding, whole-snapshot comparison) and runs `findUnverifiedTodoEvidence` (blobs read in `cat-file --batch` chunks of
128, reachability).

New record shapes (Alice's CLI writes them):
- `done` authored: `{done_mode:'authored', imported:false, message[, test_result]}`: plain text, 1..16384 UTF-8 bytes, no blob, descriptor or
  digest. Replay sets the task's `evidence` to `{message}` so it is carried across revisions like any evidence.
- `phase_accept`: `{review_event_digest[, message]}`; `phase_reject`: `{review_event_digest, reason[, message]}`; no `decision_evidence`
  or `evidence_slots` (the phase's `decision_evidence` stays null). `required_evidence_slots` stays in the plan definition for this
  version (removing it is a plan-schema change).
- Legacy records (`evidence` descriptors, `historical_import`, `evidence_promotion`, `decision_evidence`) stay valid and are never migrated.

## Consequences

- A read or write of a store with 600 done tasks that carry evidence starts no git process for it. Measurement in the PR.
- A reader older than this release refuses a new done / accept / reject (`journal_schema_invalid`); install on every seat before the CLI
  writes the new shapes.
- Not removed: replay of the journal to compute task state on read (it derives the state; making the snapshot the source of truth is a
  separate design change), and the hard import-source check of `todo migrate` (a one-off import, not a read or write of a chart).
