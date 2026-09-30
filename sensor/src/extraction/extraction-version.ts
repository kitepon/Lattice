/**
 * Extraction version
 *
 * A monotonically-increasing integer that identifies the *shape and depth* of
 * what the extractor writes into the graph. Unlike `CURRENT_SCHEMA_VERSION`
 * (which tracks the SQLite table layout and is migrated in place), this tracks
 * the EXTRACTED CONTENT — node kinds, edges, synthesizers, resolver coverage.
 *
 * When an index was built by an older engine whose `EXTRACTION_VERSION` is
 * below the running engine's, the data on disk is structurally fine but
 * *stale*: it's missing whatever a newer extractor would now produce. A schema
 * migration can't backfill that — only a re-index can. So this is the signal
 * `lattice sensor status` uses to recommend a re-index, and the reason `lattice sensor
 * upgrade` reminds users to refresh their projects.
 *
 * BUMP THIS when a release changes extraction output enough that existing
 * indexes should be rebuilt to benefit — e.g. a new language/framework
 * extractor, a new dynamic-dispatch synthesizer, a new node/edge kind, or a
 * resolver fix that materially changes which edges exist. Do NOT bump for
 * pure bug fixes, CLI/UX changes, or schema-only migrations. Over-bumping
 * turns the re-index hint into noise — keep it honest (see CLAUDE.md, "Honesty
 * in the product is load-bearing").
 */
// 25 (2026-07-29): value-ref write distinction (TS/JS), name-filter relaxation
// (+8.8% value-ref edges), import binding metadata (default/named/namespace +
// alias), decorator/attribute-inclusive extents (extent_start_line), Rust
// attribute_item collection — all change extraction output for unchanged text.
// 26 (2026-08-03): upstream sync 04ab45c..49c11fc. Lattice and upstream had each
// bumped to 25 independently, so the two "25"s meant different output — 26 is
// the first value that means one thing. Carries upstream's extraction changes
// across 54 commits plus its native kernel work.
// 28 (2026-09-30): upstream sync 49c11fc..7639c78. Upstream reached 27 on its own,
// so 27 would name upstream-only output; 28 is above both (ADR 0155 Decision 5).
export const EXTRACTION_VERSION = 28;
