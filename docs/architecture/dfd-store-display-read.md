# Store display read: verified checkpoint and typed inconsistency

Status: accepted boundary, DESIGN ONLY. Implementation starts after PR55/56
merge and bounded shared-Store recovery, and after Leviathan reviews this Store
row connected to Snow White's display row. It is excluded from the recovery diff.
Owner: Store. Consumer/banner/empty-state rendering: display owner. The canonical
[function map](function-map.md) composes this contract; operational lifecycle
reads, writes, validation and recovery retain the [strict flow](dfd-todo-start.md).

## Public function and result

Proposed Store export: `readTodoStoreForDisplay({repoRoot})`. It accepts no writer
capability, forWrite option or stale-binding flag and never invokes recovery or
publishes canonical Store files. It returns:

`{state:verified|last_verified|unavailable,store,verified_at,source,inconsistency}`

- `verified`: a successful strict raw read as observed; current read-only view.
- `last_verified`: the prior verified checkpoint plus the current typed failure.
- `unavailable`: no valid checkpoint; store/verified_at/source are null and the
  current typed failure is retained. Display supplies an explicit empty state.
- `inconsistency`: null on strict success; otherwise `{code,detail:{reason,...}}`
  from the current read. No invented healthy result or partial merged view.

## Snapshot identity and serialization

The single derived checkpoint is project-local:
`.lattice/generated/store-display/last-verified.json`. It is outside authoritative
todo membership and must never be read by a writer, verifier, dispatcher or
recovery path. Store owns path safety, schema/digest validation and atomic
publication; the display consumer does not write this artifact.

The checkpoint wraps one complete serializable Store display view, verified_at,
source bindings and a self digest. Data fields are manifest/project identity and
all active members' descriptors, plans, revisions, projected tasks/phases,
coordination, lifecycle events, plan-scoped events and derived snapshot data.
Implementation-only file bytes (activeBytes/segment bytes), lock capabilities and
process caches are excluded. Relative artifact refs may remain data. The same
read-only data shape is used on verified and last_verified results; the display
row must consume these documented fields rather than internal byte buffers.
Do not independently re-project Plan meaning inside this Store serializer.

`source` binds the canonical repository identity and project_id, manifest_digest,
and for each sorted plan_key the active version, plan/topology digests, lifecycle
head and plan-scoped head (null for an empty chain). The cache stores a repository
identity digest, not an absolute host path for publication. The project identity
must be established from independently validated current project/manifest metadata
before a retained checkpoint can be attributed to that request; unknown/mismatched
identity yields unavailable. A copied checkpoint is never accepted for another
repository/project. Source tokens identify the observed version; they do not
claim that a prior view is the latest current state.

Plan-scoped appends do not alter manifest_digest. A manifest-only cache hit cannot
justify verified freshness; every successful current result must validate the
complete strict raw view and its source heads. A checkpoint is persisted only
after that validation, as one unit; never assemble it from individually cached
current member snapshots.

## Function/data flow and recovery transitions

| Step / owner | Input and decision | Output / failure and automatic exit |
|---|---|---|
| Store strict display read | Resolve requested repository; use a stable raw read with existing identity/hash/replay/full merged-graph checks and named publication-window retry bounds | No canonical writes, lock reclaim or recovery. A typed current failure goes to checkpoint selection; no validation is waived. |
| Store checkpoint publication | Serialize the complete verified view and bound source metadata; validate the checkpoint; use atomic file publication | Return verified and inconsistency:null. No intermediate or partial checkpoint may replace the previous one. |
| Checkpoint write failure | Current view already passed strict validation | Preserve current verified result and prior checkpoint bytes; report a typed checkpoint-publication diagnostic through existing reporting. Do not turn a healthy current read into HTTP500. The next strict success retries derived publication. |
| Typed current read failure | Read last-verified checkpoint, validate schema/self digest/repository+project identity | Valid checkpoint returns last_verified with its original verified_at/source plus the current typed inconsistency. Never label the fallback current. |
| Missing/invalid/unsafe/wrong-target checkpoint | There is no attributable verified view | Return unavailable with store:null and typed current inconsistency. Protect wrong-target data and existing bytes; no checkpoint repair from unvalidated current data. |
| Subsequent strict success | Full current graph and source bindings validate again | last_verified/unavailable → verified, refresh checkpoint and clear current inconsistency automatically. No manual unlock or canonical recovery is required by this display state. |
| Display connection / Snow White | Consume state, store, verified_at, source and typed inconsistency | Display owns last_verified banner, unavailable empty state, public diagnostic selection and HTTP/SSE behavior. It must not convert a typed Store display result into HTTP500 or authorize mutations from it. |

There is currently no durable globally verified checkpoint. Before the first
successful strict read, the reader cannot promise a pre-incident historical view.
Seed after the bounded recovery; do not fabricate one from per-plan snapshot.json.

## Changed-range verification (future implementation only)

Cover complete verified publication; typed inconsistency + previous view;
plan-scoped-only head change; checkpoint persistence across restart; absent,
corrupt and wrong-target checkpoint; publication failure retaining current view
and previous bytes; next strict success clearing the diagnostic; zero canonical
mutations/recovery on this entry; and strict writer/reader behavior unchanged.
Store tests cover this row, display tests cover the connected renderer row.
No tests or implementation are part of this design draft. DFD, function map,
implementation and affected checks must ship in the same eventual diff.
