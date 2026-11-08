# Store display read: current raw data, verified checkpoint and typed inconsistency

Status: boundary delta for connected review, DESIGN ONLY. PR61 stays first.
Implementation retains the existing PR55/56 merge and bounded shared-Store
recovery ordering, followed by Leviathan review of this Store row connected to
Snow White's display row (e901d32b, dfd-display-gantt-read.md). It is excluded from the recovery diff.
Owner: Store. Consumer/banner/empty-state rendering: display owner. The canonical
[function map](function-map.md) composes this contract; operational lifecycle
reads, writes, validation and recovery retain the [strict flow](dfd-todo-start.md).

## Public function and result

Proposed Store export: `readTodoStoreForDisplay({repoRoot})`. It accepts no writer
capability, forWrite option or stale-binding flag and never invokes recovery or
publishes canonical Store files. It returns:

`{state:verified|unverified|last_verified|unavailable,store,verified_at,source,inconsistency,dropped_members}`

Store returns exactly one state in this order; display never reorders it:

1. Strict success returns `verified`, the complete current verified view.
2. Strict failure and at least one current member snapshot readable as raw JSON
   returns `unverified`, even when a valid checkpoint exists.
3. No current member snapshot readable, but a valid attributable checkpoint
   exists, returns `last_verified`.
4. Neither current member data nor a valid checkpoint is readable: `unavailable`.

`verified_at` is the strict observation-start timestamp for verified, the original
checkpoint timestamp for last_verified, and null for unverified/unavailable.
`inconsistency` is null on strict success; otherwise it preserves the original
current `{code,detail:{reason,...}}`. `dropped_members` is an array naming each
unreadable/unparsable current member by plan_key, snapshot_ref and typed
code/reason; unverified omits only those members, preserving readable neighbors.
It is empty when no current member was dropped. Checkpoint selection never turns
unreadable members into fictitious current members.

The unverified `store` is a state-discriminated raw display value:
`{project_id,manifest,members:[{descriptor,snapshot}]}`. Values come from the
current manifest and parsed member snapshot JSON, not replay or a merged graph.
Consumers read raw snapshot tasks/phases where present and tolerate absent or
malformed fields; Store does not synthesize Plan meaning or assert schema,
bindings, digest, status or readiness validity. It is never passed to operational
Store APIs. Unavailable has store/verified_at null. A last_verified store retains
the complete verified view shape described below.

For unverified, `source` is the currently observed repository/project/manifest
and per-member source/head metadata, including plan-scoped heads; never the
checkpoint source. Observe metadata for all enumerated members, including dropped
members, with null plus a diagnostic for unreadable fields. These are hints,
not verified bindings. A plan-scoped append while inconsistent changes the current
source and therefore display's source + state + inconsistency.code head token.
Last_verified keeps the checkpoint source; unavailable has source:null. Observed tokens remain separate from
checkpoint source as specified in the cheap connection below.

## Verified checkpoint identity and serialization

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
identity prevents use of that checkpoint; current raw data is still attempted. A copied checkpoint is never accepted for another
repository/project. Source tokens identify the observed version; they do not
claim that a prior view is the latest current state.

Plan-scoped appends do not alter manifest_digest. A manifest-only cache hit cannot
justify verified freshness; every successful current result must validate the
complete strict raw view and its source heads. A checkpoint is persisted only
after that validation, as one unit, and only when its source differs from the
source in the retained valid checkpoint (absence/invalidity counts as no matching
source). Unchanged source preserves checkpoint bytes and its timestamp; the
current verified response may carry the new observation timestamp. Never assemble
a checkpoint from individually cached current member snapshots. Stamp verified_at
at observation start, not completion: daemon/local readers can race, and an older
source may publish last. The next strict success observes the source difference
and republishes it; no stronger source-version ordering is claimed.

## Current raw-member read

The raw path belongs to public `readTodoStoreForDisplay`, in the same export
family as `readTodoStoreDisplaySource`; consumers never reach Store internals.
After strict failure it reads the current manifest and each listed snapshot
independently. It uses bounded filesystem reads, JSON parsing and existing path
containment/alias checks to prevent secret exposure or wrong-target reads. These
I/O protections do not invoke Store schema/digest/replay/merged-graph validation.
There is no lock, recovery, writer, canonical publication or strict-validation
side effect on this raw path. Never use readTodoStore's recovering entry here.

"Current members" means only entries enumerable from the manifest read for this
attempt. If that manifest is unreadable, unparsable or cannot enumerate members,
no current members can be selected; retain the manifest diagnostic and proceed
to checkpoint selection. Do not scan directories, use checkpoint membership as
current, or invent a last-readable-manifest cache. A bad member alone is dropped
and named, not a reason to discard readable members. Here "readable" means a
snapshot whose bytes can be read and parsed as JSON, not semantic validity.

Unverified never writes/replaces the checkpoint, never stamps verified_at and
never becomes verification evidence. Missing current data is an observation,
not a refusal or a latched state. On the next poll that reads current member
bytes, last_verified/unavailable changes to unverified (or verified if strict
read succeeds) without manual action. Raw reads use the same full-read memo and
about30-second revalidation ceiling as the connected display row; unchanged
source reuses the result, including unverified, and adds no extra read loop.
The bounded revalidation retries manifest and member reads even after same-head
readability repairs, with no manual unlock or unbounded memo retention.

## Cheap change-detection connection

Store also exports proposed `readTodoStoreDisplaySource({repoRoot})`, returning
the same source fields as the full result (repository/project identity, manifest
digest, sorted member version/plan/topology digests and lifecycle/plan-scoped
heads). It reads only source/head metadata, with path/format safety, without
chain replay, hash verification, graph validation, snapshots or recovery. These
values are unverified observations used only as invalidation hints. The display
never publishes them, labels freshness from them or supplies them to a writer.
If the source cannot be read/parsed, the probe fails and display obtains the
actual typed result from the full display reader.

The poller memoizes the token observed for the last full-read attempt separately
from result.source: last_verified returns an older checkpoint source and
unverified returns current observed source; unavailable returns null. Comparing polls to either would cause full reads every
500 ms during degradation. An unchanged observed token reuses the typed result,
including unverified and other degraded results. Initial/change/probe-failure observations trigger a
full read; persistent unchanged probe failure must not become a 500-ms full-read
loop. A bounded full revalidation ceiling of about30 seconds applies even when
heads do not change, providing exit for same-head repairs or missed hints. If the
probe recovers, trigger the full read again. A change during a full-read attempt
leaves the memo invalidated for the next poll. Share in-flight/memo work per
project across clients.

Checkpoint publication still depends on the fully validated result source, not
on the probe. This cheap export ships in the same unit as the daemon switch;
shipping a full graph read per daemon poll until a later optimization is not
within this contract. Expected work is source/head metadata per active member
rather than full history/graph verification; no benchmark is claimed by this
design. Display's live head must bind verified source + state + inconsistency
code; that rendering/notification digest remains display-owned.

## Function/data flow and recovery transitions

| Step / owner | Input and decision | Output / failure and automatic exit |
|---|---|---|
| Store strict display read | Resolve requested repository; use a stable raw read with existing identity/hash/replay/full merged-graph checks and named publication-window retry bounds | No canonical writes, lock reclaim or recovery. A typed current failure goes to current raw-member selection, then checkpoint selection; strict validation is never waived. |
| Store checkpoint publication | Serialize the complete verified view and bound source metadata; validate the checkpoint; atomically publish only if source differs from the retained valid checkpoint | Return verified and inconsistency:null. No intermediate or partial checkpoint may replace the previous one. |
| Checkpoint write failure | Current view already passed strict validation | Preserve current verified result and prior checkpoint bytes; report a typed checkpoint-publication diagnostic through existing reporting. Do not turn a healthy current read into HTTP500. The next strict success retries derived publication. |
| Typed current read failure | Public display reader attempts current manifest member snapshots raw, without Store validation, lock, recovery or writer | At least one readable member returns unverified with current observed source, original inconsistency and named dropped_members, even if a checkpoint exists; verified_at is null and checkpoint bytes are untouched. |
| No current member readable | Read retained checkpoint and validate schema/self digest/repository+project identity | Valid checkpoint returns last_verified with its original verified_at/source plus the current typed inconsistency. No checkpoint yields unavailable; store/verified_at null and diagnostics retained. |
| Missing/invalid/unsafe/wrong-target checkpoint | Do not attribute wrong-target data to the request or overwrite existing bytes | Current raw data still wins when readable. Otherwise return unavailable as the present observation; next poll retries current raw reads and leaves automatically when member bytes become readable. |
| Subsequent strict success | Full current graph and source bindings validate again | unverified/last_verified/unavailable → verified, refresh checkpoint and clear current inconsistency automatically. No manual unlock or canonical recovery is required by this display state. |
| Display connection / Snow White | Consume exactly the Store-selected state, store, verified_at, source, inconsistency and dropped_members | Display owns unverified/current diagnostic and last_verified banners, no-data diagnostics, public diagnostic selection and HTTP/SSE behavior. It must not convert a typed Store display result into HTTP500 or authorize mutations from it. |

There is currently no durable globally verified checkpoint. Before the first
successful strict read, the reader cannot promise a pre-incident historical view.
Until strict success seeds one, readable current snapshots are shown as unverified,
not fabricated as a historically verified checkpoint.

## Changed-range verification (future implementation only)

Cover complete verified publication and unchanged-source no-write; the exact
four-state precedence, including raw current data before an existing checkpoint;
unverified never publishing checkpoint/stamping verified_at; per-member
unreadable/unparsable drops preserving readable neighbors; unreadable manifest
meaning no enumerable current members; zero readable members with/without a
checkpoint; next full-read poll leaving last_verified/unavailable when member bytes become
readable, including same-head repairs within the bounded revalidation ceiling; current source plan-scoped head changes while inconsistent;
plan-scoped-only head change; checkpoint persistence across restart; absent,
corrupt and wrong-target checkpoint; publication failure retaining current view
and previous bytes; next strict success clearing the diagnostic; zero canonical
mutations/recovery on this entry; and strict writer/reader behavior unchanged.
Store tests cover this row and cheap token/no-recovery contract. Display tests cover the connected renderer row, including degraded+unchanged observed token memoization and bounded full revalidation.
No tests or implementation are part of this design draft. DFD, function map,
implementation and affected checks must ship in the same eventual diff.
