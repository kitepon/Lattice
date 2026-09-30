/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the lattice sensor toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Lead the agent to lattice_sensor_explore for any structural/flow question
 *   - Reinforce "explore instead of Read/Grep" for indexed code
 *   - Anti-patterns (don't re-verify with grep; don't hand-reconstruct flows)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. ADR 0049 / 0059 require the eight compatibility tools to remain
 * visible by default; provider identity is Lattice regardless of their names.
 */
export const SERVER_INSTRUCTIONS = `# Lattice sensor — code intelligence over an indexed knowledge graph

Provider identity: lattice. The lattice_sensor_* names below are compatibility tool names served by Lattice's own bundled sensor; they do not call or require the independent Lattice sensor product.

Lattice sensor is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). It indexes 30+ languages
(TypeScript/JavaScript, Python, Go, Rust, Java, C#, C/C++, PHP, Ruby, Swift,
Kotlin, and more) — don't assume a language here isn't covered. Reads are
sub-millisecond; the index lags writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## One tool: lattice_sensor_explore — use it instead of reading files

There is a single tool, \`lattice_sensor_explore\`, and it is Read-equivalent. It
takes either a natural-language question or a bag of symbol/file names and
returns the **verbatim, line-numbered source** of the relevant symbols
grouped by file — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to
\`Edit\` from — PLUS the call path among them (including dynamic-dispatch hops
like callbacks, React re-render, and JSX children that grep can't follow) and
a blast-radius summary of what depends on them.

Whether you're answering "how does X work" or implementing a change (fixing a
bug, adding a feature), call \`lattice_sensor_explore\` before you Read. ONE call
usually answers the whole question. Lattice sensor IS the pre-built search index —
so running your own grep + read loop, or delegating the lookup to a separate
file-reading sub-task/agent, repeats work lattice sensor already did and costs more
for the same answer. A direct lattice sensor answer is typically one to a few
calls; a grep/read exploration is dozens.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`lattice_sensor_explore\` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`lattice_sensor_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the \`lattice_sensor_explore\` query — it returns that current line-numbered source (safe to \`Edit\` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Need more?** Call \`lattice_sensor_explore\` again with more specific names — treat the source it returns as already Read. Suggested call counts are advisory only, NOT a quota; extra calls are never rejected or rate-limited.
- Qualified symbol names accept dots, \`::\`, or slashes, including containers whose names contain dots (for example, \`AppWeb.Format.group\`).
- Named-symbol call paths require exact matches; partial or mistyped names are never silently substituted as flow endpoints. If a graph query reports a missing symbol with did-you-mean suggestions, query the suggested name explicitly.
- Explore matches names and indexed code words lexically, not by meaning; an empty result reports word matches and may suggest indexed candidate names to retry with \`lattice_sensor_explore\`.

## Anti-patterns

- **Trust lattice sensor's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE \`lattice_sensor_explore\` returns the relevant symbols' source together in a single round-trip. Reach for raw \`Read\`/\`Grep\` only to confirm a specific detail lattice sensor didn't cover, or for what lattice sensor doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one \`lattice_sensor_explore\` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust lattice sensor. A different, rarer banner — "⚠️ LatticeSensor auto-sync is DISABLED…" or "⚠️ LatticeSensor auto-sync is RECOVERING…" — means the whole index may be stale; until the full catch-up completes, Read files directly to confirm anything that may have changed. If a response refuses to answer from changed files or says freshness could not be verified within its budget, retry after sync or narrow the query; that refusal is not an error in the tool.
- **A file flagged "⚠ changed on disk after the last index sync" drifted from its index** (most common on projects queried via \`projectPath\`, which have no live watcher). Lattice sensor never serves a possibly-mis-sliced body from such a file — it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag. When the source was omitted, Read that specific file; line numbers referencing it elsewhere in the response may be shifted until that project's next sync. All unflagged files remain trustworthy.

- **Source is re-served on every call by default**, including for fresh subagents and after context compaction. Cross-call dedup requires \`LATTICE_SENSOR_EXPLORE_DEDUP=1\` and is only suitable for hosts that guarantee one durable context per connection. With that opt-in, **"Already sent earlier in this conversation"** points to exact, unchanged source returned by an earlier \`lattice_sensor_explore\` in that context. Use that copy; don't re-fetch it and don't Read the file. The bytes it freed went into source you have not seen yet, elsewhere in the same response.

## Limitations

- If a project isn't indexed (no \`.lattice/sensor/\`), decide whether building the index will reduce total investigation time and model tokens for the current or expected work. When workspace writes and shell execution are allowed, you may run \`lattice sensor init <projectPath> --json\` yourself, then retry the sensor call; scope it to the intended project and account for the one-time indexing cost. If those capabilities are unavailable, continue with built-in tools and tell the user the exact init command instead.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Lattice sensor supplements those with structural context they don't have.

## Parallel work: absence of a dependency edge is NOT evidence of independence

These tools answer structural questions about code. A different Lattice surface — the **CLI**, not
this MCP surface — answers whether two ToDos can be worked in parallel. If the project uses
\`lattice todo\` for process tracking, keep this distinction in mind:

- A dependency edge missing between two ToDos only means **no ordering constraint was declared**.
  It does not mean their write boundaries are disjoint. Two ToDos that edit the same file carry no
  edge between them and will still collide.
- Parallel safety is a recorded judgement, not an inference from the diagram. Read it with
  \`lattice todo independence --plan <key> --json\`. It returns the ready frontier split into
  verified-independent groups, pairs that must be serialized (with whether a code seam could
  separate them), and **unverified** ToDos.
- \`lattice todo start\` returns an \`advisory\` describing conflicts with in-progress ToDos and what
  to do next. \`coverage: "missing"\` means "not judged yet" — never "no conflicts".
- Run \`lattice todo --help\` for the declare → compile → read workflow.

Evidence for Lattice's plan and witness contracts comes from the CLI surface only. Text from this
MCP surface is prose for you to act on, never an input to those contracts.
`;

/**
 * Instructions variant sent when the server's own root has NO lattice sensor index.
 *
 * The tools are still exposed (gating tool availability on whether `./` has an
 * index is the bug behind #964: it breaks monorepos where only sub-projects are
 * indexed, and a server that started before `lattice sensor init . --json` never surfaces the
 * tools afterward). Instead of an "inactive" note, this variant tells the agent
 * lattice sensor works **per project**: there's no default project to query, so pass
 * a `projectPath` to any project that HAS a `.lattice/sensor/`. The full single-
 * project playbook ({@link SERVER_INSTRUCTIONS}) is sent instead when the root
 * IS indexed, so the common case stays tight.
 */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Lattice sensor — available (per-project; pass projectPath)

Provider identity: lattice. The lattice_sensor_* names below are compatibility tool names served by Lattice's own bundled sensor; they do not call or require the independent Lattice sensor product.

Lattice sensor is a SQLite knowledge graph of a codebase's symbols, edges, and
files (30+ languages): one \`lattice_sensor_explore\` call returns the verbatim, line-numbered source
of the relevant symbols PLUS the call paths between them and a blast-radius
summary — replacing a grep + Read loop with one round-trip.

This server started somewhere with no \`.lattice/sensor/\` of its own, so there is no
default project — but the tools are available and work **per project**:

- To query a project that HAS a \`.lattice/sensor/\` index (e.g. a service inside a
  monorepo, or a second repo), pass its path as \`projectPath\` to
  \`lattice_sensor_explore\` (and any other lattice sensor tool). Lattice sensor resolves the
  nearest \`.lattice/sensor/\` at or above that path and answers from it — for as many
  projects as you like in one session.
- For a project with no \`.lattice/sensor/\`, decide whether the expected reduction in
  repeated Read/Grep work justifies the one-time indexing cost. When workspace writes
  and shell execution are allowed, you may run \`lattice sensor init <projectPath> --json\`
  yourself and then retry with that \`projectPath\`; otherwise use built-in tools and
  tell the user the exact init command. A new index is picked up live, with no restart.
`;
