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
