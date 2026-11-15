# ADR 0203: Evidence blob verification is batched and has no count cap

Status: accepted (2026-11-15, b11-evidence-git-spawn-per-write, Ludmila; measured by Trony on production)

## Context

Every Store read verifies the evidence descriptor of each done task by reading its blob with `git cat-file` and comparing the
sha256. A per-process cache held at most 512 blobs (`EVIDENCE_BLOB_CACHE_LIMIT`), `prefetchVerificationObjects` stopped seeding
when it was full, and `readEvidenceBlob` evicted the oldest entry when full. On `bellteam-dev-added` (more distinct evidence
blobs than 512) every extra blob, and every eviction, started its own git process. Trony's server-side CPU profile of one
`todo add` (16.07 s): 13.3 s in `spawnSync` of git, 10.4 s from `readTodoStoreView` and 2.7 s from `replay`; canonicalize and
validate under 1.3 s. This is a count cap of the kind ADR 0201 removed, and it protects nothing.

## Decision

- The cache stores only the sha256 of each verified blob (the verifier uses nothing else), not its bytes, and has no count cap.
  An oid names its bytes, so a recorded digest cannot go stale; only successful reads are recorded, as before.
- `prefetchVerificationObjects` reads the evidence oids of a store in batches of 128 per `cat-file --batch` (bounded buffer),
  so a read costs about `ceil(distinct blobs / 128)` git processes, not one per blob.
- Unchanged: the body limit (`narrativeSectionBytes`), digest and reachability checks, the failure paths (a failed read is not
  recorded and is re-checked per item as before).

## Consequences

- `test/todo-evidence-spawn-count.test.mjs`: 520 distinct blobs read in a fresh process with at most 6 `cat-file` spawns (the old
  code failed it; building the same store with the old code took 153 s instead of 49 s).
- A blob that is missing or over the body limit is still checked per item (and per read). A store with many such descriptors keeps
  that cost; not measured on production, no evidence it is the 13 s.
