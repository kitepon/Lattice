# Store: superseded versions keep only their difference

Owner: Store (b10-plan-copy-per-add, Ludmila, 2026-11-15; reported by Trony from production, [ADR 0202](../adr/0202-superseded-plan-versions-keep-a-difference.md)).
Product bug: `todo add` / `plan revise` left a full `plan.json`, a `revision.json` that repeats the same plan, a `snapshot.json`
and a journal in a new version directory every time. `bellteam-dev-added`: 612 versions, 475 MB, for a 415 KB plan.
No lifecycle, event, manifest or plan schema changes. [Function map](function-map.md) lists the functions.

## Data flow

```text
successor write (applyTodoRevision / applyPhaseTodoRevision / ... / createSuccessorTodoPlan)
  manifest switched to version N+1 (full: plan.json, revision.json, snapshot.json, journal)   <- unchanged format, old readers read it
  withLock tail (repairAfter writers, lock held):
    for each member: compactSupersededVersions(member)               hook: direct predecessor N only
      N already holds compact.json.gz and no plan.json -> stop        (one stat)
      read N fully (readRetainedVersion), buildVersionCompact(N, anchor = N+1)
         patch = diffJson(plan N+1 -> plan N); applyJsonPatch must give plan N exactly, else null (nothing changes)
      write N/compact.json.gz (atomic)  ->  rm N/{plan,revision,snapshot}.json  ->  journal/active.jsonl -> active.jsonl.gz
    any failure is swallowed: the version keeps its full files and the next write retries

lattice todo compact [--plan <key>] [--limit <n>]                    sweep: whole predecessor chain, newest first, bounded
  same function, `sweep: true`: also walks through compacted versions (rebuilding the anchor), finishes a compaction
  cut short after compact.json.gz (removes the leftover files), returns {compacted, stopped, next_version}
```

## What a compacted version keeps

| File | Content | Rebuild |
|---|---|---|
| `compact.json.gz` | `lattice.todo_version_compact.v1`: plan_key/version/digest, predecessor digest and version, topology digest, anchor (the successor) version and digest, `plan_patch` (successor plan -> this plan), `revision` (this version's revision without the `desired_plan` it repeats; null for a genesis version), `compact_digest`; canonical JSON, gzip | `reconstructPlan(record, anchorPlan)` equals the original canonical plan (checked against `plan_digest`/`plan_version` and `validateTodoPlan`); `reconstructRevision(record, plan)` equals the original revision |
| `journal/active.jsonl.gz` | the version's journal segment, same bytes | `readJournal` falls back to it when `active.jsonl` is absent |
| removed: `plan.json`, `revision.json`, `snapshot.json` | repeated plan, repeated plan, derived cache | plan/revision from the record; snapshot is replay output (`snapshot --rebuild`) and was only ever read for the active version |

Immutable parts are not touched: the event hash chain, `plan-scoped.jsonl` and its sealed segments, notes, evidence, `backchain.json`,
revision ids (the version directory name and `plan_version` stay; other records keep pointing at them).

## Readers (all in Store or the note store, read-only)

| Reader | Before | Now |
|---|---|---|
| `retainedPlanVersion` (coordination inheritance, carried blocks, cross-plan rebind lookup) | parse and validate each retained `plan.json` | identity (3 digests) from the record when compacted |
| `readRetainedVersion(repoRoot, base, version, activePlan)` (exported) | n/a | full `{plan, revision}` from its own files or by walking `anchor_plan_version` to the active plan |
| cross-plan rebind predecessor read, `predecessorSourceInventory` | `plan.json` / scan of every version directory | `readRetainedVersion`; the inventory walks the revision bindings instead of parsing every version |
| `readNoteMigrations` (`todo-note-store`) | `plan.json` + `revision.json` of each version | the record's `revision.task_migration` and `predecessor_plan_version` |
| `readJournal` | `journal/active.jsonl` | also `active.jsonl.gz` when the plain file is absent |

A read pays this per retained version, per process (`bellteam-dev-added`: 888 versions in a day, one `todo note` took 4.4 s, `status` 1.9 s, on a copy of the production Store).
w1-store-write-slow follows the k4 rule (a read no longer re-verifies history; `todo verify` does) on the two history reads k4 had left:

| Read | Before | Now |
|---|---|---|
| `readVersionCompact(dir, max, {verify})` | every read: gunzip, parse, canonical re-serialization, `compact_digest` self digest | `verify: false` (`retainedPlanVersion`, `readNoteMigrations`): gunzip, parse, shape check. Default `verify: true` (the compaction writers' `readRetainedVersion`): unchanged. The record is not memoized (m1, below): each caller memoizes the small value it derives |
| `readPlanScopedJournal(repoRoot, ref, {verify})` | every read: per-event canonical re-check and the whole hash chain | `verify: false` (the member's chain on a read, the inherited-coordination walk): sealed-segment digest, per-event schema and event self digest, kind check. `verifyHistory: true` (`todo verify`) restores the canonical re-check and the hash chain |
| `readNoteMigrations` | one `structuredClone` of every version's task migration per call | the memoized migration is shared; `migrationIndex` only reads it |

w4 (same day): one command reads the Store about a dozen times (`todo add`: 16 `manifest.json` reads). `parseJournalSegment` and `parseCanonicalJsonLine` remember, per process, the bytes they accepted, keyed by sha256 of the bytes, the ref (artifacts) and the mode; a repeat read of the same bytes only runs `JSON.parse`, so callers still get fresh objects. Changed bytes miss the key and are validated again; a failure is never remembered; a strict (`verifyHistory`) read is not satisfied by a read-mode entry.

Still per retained version on every read: one `lstat` (memo identity), one gunzip + parse of `compact.json.gz`, and one entry of the note migration index. Nothing else walks history.

m1-read-skips-retained-revisions (2026-11-20, Flora a466: module CLI children 450-560 MB each on bellteam, 1,649 retained versions of `bellteam-dev-added`). Measured on a copy of the production Store: one `session-context` opened 1,795 `compact.json.gz` and 979 `plan-scoped.jsonl`, because the inherited-coordination walk (`inheritedTodoCoordination`) reached a declaration made 975 revisions back and scanned every version for each predecessor digest. Two changes, no format change:

| Step | Before | Now |
|---|---|---|
| `readVersionCompact` | memoized the whole record per version (a revision's per-task migration: the RSS grew with the revision count) | not memoized. `retainedPlanVersion` memoizes only the three digests by file identity; `readNoteMigrations` already memoizes its small migration |
| `carriedPlanScopedChain` (every revision writer) | carried live cross-plan edges and open schedule connections | also carries the predecessor's effective coordination (its own declaration, else the inherited one) as one `coordination_mode` event with the original actor, time and reason, so the new version's own chain holds it and the walk ends at the version itself ([phase revision flow](dfd-store-phase-revision.md)) |

A plan whose version has no declaration in its own chain still walks its lineage once per read (an undeclared plan, or a version written before this release): exit = declare the mode once (`todo independence mode`) or the next revision carries it. On the production copy: `session-context` 454 MB / 2.8 s to 234 MB / 0.9 s (the two undeclared plans, 84 and 62 versions, remain).

Unchanged: the active version, `manifest.json`, `status`/`session-context`/`display read` shapes, every event schema.

## Failure and exit

- Round trip not exact, retained version unreadable, anchor mismatch: the walk stops, the version keeps its full files, the sweep result says
  `stopped` and `next_version`; nothing is deleted before `compact.json.gz` is durable. Exit: fix the cause and rerun; no guard blocks a write.
- A corrupt `compact.json.gz`: readers skip the version as unreadable (same as an unreadable `plan.json`); the sweep refuses with
  `STORE_INCONSISTENT/compact_record_invalid`.
- Old CLIs (before this change) read the active version unchanged. They see a compacted version's plan as missing, so coordination
  inheritance from, and cross-plan rebinding through, a compacted older version degrade as for any unreadable version. Roll the release
  out to every seat before running `todo compact` on a shared chart.
- The sweep holds the Store lock; `--limit` (default 40 versions, about 5 s) bounds how long. Rerun until `compacted` is 0.

## Checks

`test/todo-version-compact.test.mjs`: patch round trip, record digest/anchor refusals, hook compaction after four `todo add`, byte-exact plan,
revision and journal rebuild, a note carried through compacted revisions, legacy-store sweep, bounded sweep, cut-short compaction.
