# Store: a value a newer Lattice wrote (newer-value-says-upgrade)

Store owns this read-time classification and the reader registration it uses
(`NEWEST_KNOWN_TODO_SCHEMA` in `src/todo-store.mjs`). Before it, a reader older than
the writer refused a store that was only newer with `STORE_CORRUPT
journal_schema_invalid`, which invites repair or deletion. Releases before this
change cannot be fixed; from this release on the reader tells "newer" from
"damaged". No record format changes, and nothing is written.

## Detection shape

A record that fails its validator is **newer** when one of these holds; otherwise
the existing refusal stays (`STORE_CORRUPT`, `STORE_INCONSISTENT`).

| Record (reader) | Newer when | Why this is not damage |
|---|---|---|
| Journal event, lifecycle `journal/active.jsonl` + `sealed/*` and `journal/plan-scoped.jsonl` (`parseJournalSegment`) | `schema` is `lattice.todo_event.vN` with N > `NEWEST_KNOWN_TODO_SCHEMA.todo_event` | The schema id names a version this reader has not registered; its digest rule is not this reader's to judge. |
| same | Intact (`event_digest` = its own self digest) and `kind` is a word not in `TODO_EVENT_KINDS` | The bytes are exactly what a writer produced; only the vocabulary is unknown. |
| same | Intact and `kind = coordination_mode` with `payload.mode` a word not in `TODO_COORDINATION_MODES` | Same (e.g. `enforced` read by a reader before 0.88.0). |
| `plan.json` (validator `validateTodoPlan`), `manifest.json` (`validateTodoManifest`) via `parseCanonicalJsonLine` | `schema` is `lattice.todo_plan.vN` / `lattice.todo_manifest.vN` with N above the registered newest | Same as the event schema id. A schema of another family stays `schema_invalid`. |
| Notice ack set `notices/<lane hash>.json` (`todo-notice-store.mjs`, via the exported `rejectNewerTodoSchema`) | `schema` is `lattice.todo_notice_acks.vN` with N above `NEWEST_KNOWN_TODO_SCHEMA.todo_notice_acks` | Same; `ack` also refuses it rather than downgrade it ([startable notices](dfd-done-notice.md)). |

Canonical-form, UTF-8, size, hash-chain, link and binding checks run as before; a
mismatched digest with an unknown value is damage and stays `STORE_CORRUPT
journal_schema_invalid`.

## Refusal

| Output | Content |
|---|---|
| code / reason | `UNSUPPORTED_SCHEMA` / `newer_lattice_value` (the existing code for "this reader does not know that format", already used for revision schemas) |
| detail | `ref` (Store-relative file), `pointer` (`/schema`, `/kind`, `/payload/mode`), `value`, `reader_version` (this package), `required_version` = `>reader_version` |
| next_action | Says the record was written by a newer Lattice, is not corrupt, must not be repaired or deleted, and to upgrade Lattice on this host to a version newer than `reader_version`, then rerun. The CLI keeps it (`withRefusalGuidance` keeps a concrete next_action). |
| exit | Upgrading the reading host leaves the state; the store is untouched. |

`unsupported_revision_schema` (revision.json) keeps its code and detail and gains
the same upgrade `next_action`.

## Registration

Teaching the validator a new event/plan/manifest schema version bumps
`NEWEST_KNOWN_TODO_SCHEMA` in the same diff; `test/todo-newer-value.test.mjs`
fails when the table and `src/todo-contracts.mjs` disagree. A new event kind or
coordination mode needs no registration: the existing lists are the vocabulary.

Not covered: `snapshot.json` (derived, `SNAPSHOT_INVALID`), witness/structure/note
artifacts, which keep their existing refusals.
