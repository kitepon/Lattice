# Data flow: Resolve and Touched, the code graph's public interfaces (ADR 0204 §4, a3 and a6, 2026-11-16)

Status: implemented by `src/sensor-resolve.mjs`, `sensor/src/graph/anchor-resolve.ts`, the sensor command `lattice-sensor resolve` (JSON on stdin) and the public `lattice sensor resolve <path#symbol>... [--path <root>] [--related] --json` (`sensor-cli.mjs`; unresolved anchors exit 0, malformed text is listed in `malformed`, no index → `LATTICE_SENSOR_NOT_INITIALIZED` with `next_action: lattice sensor init <root> --json`).
Owner: Code graph role (Neve). Callers: Plan/lifecycle (declaration, add-time judgment, `chart repo sync` re-resolve).
Contract and the other interfaces (Observe, Touched): `dfd-function-conflict` (ADR 0204, PR 214); Observe is
[dfd-witness-declare](dfd-witness-declare.md) (compile row).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Plan/lifecycle: `parseAnchor(text)` | `path#symbol` | `{path, symbol}` split at the FIRST `#` (Ruby `Foo#bar` keeps its `#`) | `null` for a text with no `#`, an empty path or an empty symbol: the caller reports it as malformed; the add happens |
| Code graph: `resolveAnchors({root, anchors, related?})` | `{path, symbol}[]` (repo-relative, `/`); the maintained index of `root` (Observe makes it); one `lattice-sensor resolve` process, JSON on stdin | `resolved[]` one entry per span: `{path, symbol, qualified, kind, start_line, end_line, related?}`; `ambiguous[]` when one written symbol names different definitions in its file; `unresolved[]` | A miss is an answer, never a fuzzy hit: `unresolved[] {path, symbol, reason, nearest[], elsewhere[]}`, reason `symbol_not_found` / `file_not_indexed` / `symbol_empty` / `path_invalid`; `nearest` = closest names in the same file, `elsewhere` = same-name definitions in other files (a wrong path). No index → `SensorResolveError RESOLVE_INDEX_MISSING`; other sensor failures `RESOLVE_SENSOR_FAILED` |
| Code graph: matching rule (in `anchor-resolve.ts`) | The written symbol as a chain (split on `.` or `::`, Erlang `/n` arity ignored) and the file's nodes (not `file`, `import`, `export`, `parameter`) | A node matches when the end of its qualified chain equals the written chain on a separator boundary (`Bar.baz`, `x.J.f`); leading parts the extractor keeps in the path (Rust modules, Python packages) may match a path segment | A longer container never matches by substring (`FooBar.baz` ≠ `Bar.baz`); a bare name returns every span of that name in the file |
| Code graph: `related` (only when asked) | The resolved node ids | Direct callers and callees, at most 20 each, `truncated` when more | Information and freshness only; never a conflict by itself (Owner: same function) |
| Code graph: `proposeSymbols({root, title, memo})` (seed fallback 2b) | Identifiers that look like code in the title and memo (backticked, `name(`, camelCase, snake_case, `Capitalised.dotted`; at most 30) | `proposed[] {name, definitions[]}` for exact names, `too_common[]` (more than 5 definitions), `not_found[]` | A proposal for the AI that adds the task; nothing is recorded. `not_found` and `too_common` are returned so "no proposal" is never read as "touches nothing" |

State it owns: none. The index (`.lattice/sensor/`) is read through the sensor CLI only; Plan/lifecycle never opens it.
Cost: one process, about 0.2 s for five anchors on a 1,100-file index (budget: Resolve + overlap for one task ≤ 1 s).

## Touched (a6)

Implemented by `src/sensor-touched.mjs` (`touchedFunctions`, `parseUnifiedZeroDiff`), `sensor/src/graph/touched-symbols.ts`, the sensor
command `lattice-sensor touched` (JSON on stdin) and the public `lattice sensor touched <from> [<to>] [--path <root>] --json`
(`lattice.sensor_touched_result.v1`; bad ref → `LATTICE_SENSOR_TOUCHED_GIT_FAILED`). Plan/lifecycle records the answer on the task.

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| Code graph: `touchedFunctions({repoRoot, from, to = HEAD})` | `git diff --unified=0 --find-renames <from> <to>` (commits only; never the working tree's uncommitted state) | Hunks `{old_start, old_count, new_start, new_count}` per file with status (modified, added, deleted, renamed, binary) | A ref that does not resolve or a git failure: `SensorResolveError TOUCHED_GIT_FAILED`; an empty diff answers empty |
| Code graph: Observe for the range end (`withObservedTree`, shared with the independence compile) | `to` sha | `to` is HEAD and the tree is clean (outside `.lattice/`) → incremental `sensor sync` of the maintained index; otherwise a disposable worktree of `to` with a fresh index (removed afterwards). No refusal | Same fallback as the compile observation; the worktree path costs a full index (about 12 s on 1,100 files) and is the rare case |
| Code graph: attribution (`touchedSymbols`) | Each hunk's NEW-side lines and the index of `to` | The innermost indexed symbols the lines overlap (a hunk inside `Bar.baz` is `Bar.baz`, not `Bar`; a one-line class and method resolve to the method): `touched[] {path, symbol, kind, start_line, end_line}` | Nothing is dropped: `unattributed[] {path, reason, old_range, new_range}` with reason `outside_any_symbol` (imports, top-level code), `partly_outside_any_symbol`, `deleted_outside_any_symbol` (a whole function removed between symbols; `old_range` names the lines), `file_not_indexed` (non-code or unindexed), `file_deleted`, `renamed`, `binary`. Plan/lifecycle reads unattributed as file-level, never as "touched nothing" |

Not decided here: what Plan/lifecycle does with `unattributed` beyond treating it as file-level (a5/C).
