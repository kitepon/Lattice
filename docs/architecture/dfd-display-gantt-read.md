# Gantt display: verified, unverified, last-verified and unavailable rendering

Status: DESIGN ONLY, connected to the [Store display read](dfd-store-display-read.md).
Delta 2026-11-08 (guards.remove-unnamed): `unverified` added; `unavailable` only when nothing is readable.
Implementation starts after the PR55/56 merge and the bounded shared-Store recovery,
and after Leviathan reviews this row together with the Store row.
Owner: Snow White (display: gantt HTML, SSE, public dashboard daemon, banner and
empty state). Store owns the read, the checkpoint and the typed inconsistency.

## Problem this removes

Since 2026-11-07 23:26 JST the public roadmap has returned HTTP 500
`STORE_INCONSISTENT` for the whole page. One stale cross-plan connection pair
makes the strict read throw, and `finishRequestFailure` turns any thrown read into
500. A read-only view stops as a whole because of a write-side consistency fault.

## Current call sites (all change together)

| Caller | Today | After |
|---|---|---|
| `bin/lattice-dashboard.mjs` registry `render` / `readHead` (public daemon) | `readCachedStore` (process-local `createTodoStoreCache`, manifest-only identity) | `readTodoStoreForDisplay({repoRoot})` |
| `src/todo-cli.mjs` `serveGantt` `render` / `readHead` (local live gantt) | `readTodoStoreStable` | `readTodoStoreForDisplay({repoRoot})` |
| `src/todo-gantt-live.mjs` request/SSE handling | thrown read → 500 / SSE `lattice-error` and stream closed | consumes the typed result; no 500 for a typed Store display result |

`renderTodoGanttForProject`, `ganttLiveHeadDigest` and the other one-shot CLI
renders keep their strict reads; only the two serving paths above change.

## Data flow

| Step | Input → output | Failure / automatic exit |
|---|---|---|
| Read | `readTodoStoreForDisplay` → `{state, store, verified_at, source, inconsistency, dropped_members}` | Store-owned; no recovery and no writes from the display. |
| Precedence (one rule) | see the state table below | The Store returns exactly one state; the display never re-orders it. |
| `verified` | `store` → existing `renderTodoGanttForProject({readModel: store})` | Page is identical to today. |
| `unverified` | current manifest members read raw by the Store's public reader (no lock, recovery, writer or validation; shape `{project_id, manifest, members:[{descriptor, snapshot}]}`, no schema guarantee) → display-owned tolerant projection into the renderer's read model (a member, task or phase that cannot be projected is dropped and named, like a Store `dropped_members` entry; its neighbours still render, never a 500) → renderer with every current-file overlay omitted, plus a banner: "未検証の現在の状態を表示中。計画は整合していない: `code` / `reason`", the fixed list of omitted overlays, and each dropped member named | Shows what the Owner needs to judge remaining work while the store is inconsistent. Never stamps `verified_at`, never feeds the checkpoint. Overlays are omitted because computing them can reach strict Store validation. |
| `last_verified` | checkpoint `store` only → renderer with every current-file overlay unconditionally omitted, plus a banner at the top: "最後に確認できた状態（verified_at）を表示中。現在の計画は整合していない: `code` / `reason`" and the fixed list of omitted overlays | Overlays (presentation, independence frontier, seam proposals, notes, structures, narratives) read current files and would render plausibly against an older store, so none is computed: no overlay I/O while degraded, including in the head token. |
| `unavailable` | zero members readable and no checkpoint → HTTP 200 HTML empty state naming `code` / `reason`, no gantt | Not a guard: nothing is refused, there is nothing to show. No 500. Self-exit: the next poll that can read any member bytes returns `unverified` (or `verified`), and SSE reloads the page. |
| Public diagnostic | `inconsistency` → banner and empty state | Show only `code` and the `detail.reason` slug; other detail fields never leave the server. In `unverified` and `last_verified` the page and diagnostic never claim validation. |
| Change detection | `readTodoStoreDisplaySource({repoRoot})` (same fields as `source`, unverified, never displayed) → compare with the token observed at the last full-read attempt, memoized per project next to its result (not the result's `source`, which in last_verified is the checkpoint's and in unavailable is null). The raw read of `unverified` is the same full read on the same memo/ceiling path: an inconsistent store with an unchanged token reuses the memoized `unverified` result and adds no read loop | Equal → reuse the memoized result, degraded or not; different, first observation, or token recovery after a failure → full `readTodoStoreForDisplay`. A token change during an attempt invalidates the memo for the next poll. A probe failure falls back to one full read; a persisting identical failure must not loop full reads every 500 ms. A full revalidation at least every ~30 s lets same-head repairs exit on their own. In-flight reads and the memo are shared per project. Ships in the same unit as the daemon switch. |
| Head token | digest of `source` + `state` + `inconsistency.code`, plus the existing overlay digests only in `verified` | A plan-scoped-only append moves `source` and reloads connected pages (today's `ganttLiveHeadDigest` binds only `manifest_digest`). A state change also reloads them via the existing SSE path. |
| SSE | `state` events carry the token; `lattice-error` is kept only for faults outside the typed display result | The stream no longer closes on a typed inconsistency. |
| Real server faults | renderer bug, I/O fault outside the Store result | Still 500 with the existing `lattice.todo_gantt_http_error.v1`. |


### State precedence (one ordered rule)

| Order | Store condition | State shown | Banner says |
|---|---|---|---|
| 1 | strict read succeeds | `verified` | nothing (page as today) |
| 2 | strict read fails, at least one current member readable raw | `unverified` (current raw), even if a checkpoint exists | "未検証の現在の状態", `code` / `reason`, dropped members |
| 3 | strict read fails, no current member readable, checkpoint exists | `last_verified` | "最後に確認できた状態（verified_at）", `code` / `reason` |
| 4 | strict read fails, nothing readable, no checkpoint | `unavailable` | empty state with `code` / `reason` |

Current raw outranks the checkpoint: the Owner reads the page to judge the current
plan, and an older verified page would hide work already recorded. A member whose
snapshot is unreadable or unparsable is dropped and named; the other members still render.

The display never writes the checkpoint, never labels `last_verified` as current,
and never authorizes a mutation from a display result.

## Coach review

Leviathan, 2026-11-08 (/srv/bellteam/bots/bot-c859d9f1/docs/reviews/lattice-store-display-read-review-20261107.md):
boundary accepted; R1 (no overlays in last_verified), R3 (source token + memo + ~30 s
revalidation) and R4 (head token binds source) are applied above. The memo compares against the token observed at the full read; display row closed. R2 (publish the
checkpoint only when `source` changes), the token export and the `verified_at`
stamped at observation start belong to the Store row.

## Changed-range checks (implementation only)

Typed `STORE_INCONSISTENT` with readable members → 200 `unverified` page (banner, no `verified_at`, checkpoint untouched) even when a checkpoint exists; one unparsable member → only that member dropped and named; a member that parses as JSON but has a malformed or missing task/phase field → only that member (or task/phase) dropped and named, page 200; no readable member with a checkpoint → 200 `last_verified` page with its `verified_at`; nothing readable and no checkpoint → 200 empty state; strict success
after either → the token changes and SSE triggers a reload; `last_verified` → no
overlay output and the fixed omitted list shown; a plan-scoped-only append → the head
token changes; equal source token → no full read until the ~30 s revalidation, including while degraded (last_verified or unavailable with an unchanged token); a persisting probe failure → no 500 ms full-read loop; the
public diagnostic carries only `code` and the reason slug; a renderer fault → 500 as today; one-shot CLI
gantt still fails strictly. Prior gantt suites are not repeated.
