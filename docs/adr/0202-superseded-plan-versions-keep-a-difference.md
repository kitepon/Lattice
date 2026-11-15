# ADR 0202: A superseded plan version keeps only its difference from its successor

Status: accepted (2026-11-15, b10-plan-copy-per-add, Ludmila; reported by Trony from production)

## Context

Every successor write (`todo add`, `plan revise`, `todo predecessor add`, ...) publishes a new version directory with a full `plan.json`,
a `revision.json` that embeds the same plan again, a `snapshot.json` and a journal whose genesis lists every task. Nothing ever removed
the previous version. On the BellTeam chart `bellteam-dev-added` held 612 version directories, 475 MB, for a current 415,673 B plan; the
Owner called it stupid. Readers that walk retained versions (coordination inheritance, carried blocks, note migrations, cross-plan
rebind) also parsed and validated every retained `plan.json`, which grows with the version count.

## Decision

Once a successor is active, its predecessor keeps `compact.json.gz`: the reverse patch from the successor plan, its revision without the
repeated plan, and the identity digests readers need. Its `plan.json`, `revision.json` and `snapshot.json` are removed and its journal
segment is stored gzip-packed. The plan, the revision and the journal bytes rebuild exactly (tests compare byte for byte). The newest
version stays a full copy, so a write of one task stores one full active copy plus a patch of that task, not a copy per revision.

The same function runs after every successor write (direct predecessor) and as `lattice todo compact` for stores written before
(bounded by `--limit`). It deletes nothing until the record is durable and the round trip is exact; a failure leaves the full files.

## Consequences

- 61 versions of a 400-task plan, measured side by side: 64 MB before, 1.9 MB now; the 60th `todo add` took 5.5 s before and 1.4 s now (it grew with the version count before). The growth per revision is the patch and the packed journal.
- A seat older than this release reads the active version unchanged but treats a compacted version as unreadable (inheritance from, and
  rebinding through, a compacted older version degrade). Release to every seat first, then run `todo compact` on the shared chart.
- Not done: the active version is still written in full on every revision (about one plan, 1 MB for a 415 KB plan), and the per-task
  `state_migration` in each genesis stays (it is packed). Writing deltas for the active version needs a new manifest/plan schema and a
  reader rollout; it is a separate decision.
