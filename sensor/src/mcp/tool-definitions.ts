/**
 * The static MCP tool surface: tool definitions and the allowlist-filtered list
 * the proxy answers `tools/list` with. Lives apart from {@link ./tools} (the
 * handlers, ~8k lines plus the whole engine behind them) so a thin proxy session
 * lists the tools without loading any of that.
 */

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  /** Behavioral hints for clients (see {@link ToolAnnotations}). */
  annotations?: ToolAnnotations;
  /**
   * MCP `_meta` on the tool definition. `anthropic/alwaysLoad: true` makes
   * Claude Code load the tool at session start instead of deferring it behind
   * its tool search (https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral).
   */
  _meta?: Record<string, unknown>;
}

/**
 * MCP ToolAnnotations — behavioral hints a client MAY use to decide how, or
 * whether, to run a tool (introduced in the 2025-03-26 spec, carried in
 * 2025-06-18). They are advisory and never to be trusted for security, but
 * clients gate on them: Cursor's Ask mode, for one, refuses any MCP tool that
 * doesn't advertise `readOnlyHint: true` (issue #1018).
 *
 * The field is purely additive — a client that predates annotations ignores it
 * — so lattice sensor advertises these even though `initialize` still negotiates the
 * 2024-11-05 protocol version.
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default (unset): false. */
  readOnlyHint?: boolean;
  /** Meaningful only when NOT read-only: may the tool perform destructive updates? */
  destructiveHint?: boolean;
  /** If true, repeat calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** If true, the tool interacts with an open world of external entities. */
  openWorldHint?: boolean;
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Absolute path to the project to query (or any directory inside it) — lattice sensor uses the nearest .lattice/sensor/ index at or above that path. Omit to use this session\'s default project. Pass it to query a second codebase, or when the server root has no index of its own (e.g. a monorepo where only sub-projects are indexed, so there is no default project).',
};

/**
 * EVERY lattice sensor MCP tool is query-only: it reads the pre-built index and never
 * mutates the workspace. An agent may separately choose to invoke the explicit
 * `lattice sensor init` CLI when its host grants workspace writes and shell execution.
 * Advertising this MCP-tool read-only contract lets clients that gate on it run
 * the tools where a possibly-mutating tool would be blocked — most concretely,
 * Cursor's Ask mode, which rejects any MCP tool lacking `readOnlyHint: true`
 * (issue #1018). `idempotentHint`: a repeated query has no additional effect.
 * `openWorldHint: false`: the domain is the closed local index, not an open
 * external world. Shared so the contract is declared once; a hypothetical
 * mutating tool would simply not reference it.
 */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * All LatticeSensor MCP tools
 *
 * Designed for minimal context usage - use lattice_sensor_explore as the primary tool
 * (one call usually answers the whole question), and only use other tools for
 * targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'lattice_sensor_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use lattice_sensor_explore instead to get the actual source / understand an area in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_callers',
    description: 'List functions that call <symbol>. For the full flow, use lattice_sensor_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist (e.g. one UserService per app in a monorepo)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_callees',
    description: 'List functions that <symbol> calls. For the full flow, use lattice_sensor_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_impact',
    description: 'List symbols affected by changing <symbol>. Use before a refactor.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_node',
    description: 'Two modes. (1) READ A FILE — use INSTEAD of the Read tool: pass `file` (a path or basename) with no `symbol` and it returns that file\'s current on-disk source with line numbers, exactly the shape Read gives you (`<n>\\t<line>`, safe to Edit from), narrowable with `offset`/`limit` just like Read — PLUS a one-line note of which files depend on it. Same bytes as Read, faster (served from the index), with the blast radius attached. Use it whenever you would Read a source file. (2) ONE SYMBOL you can name — its location, signature, verbatim source (includeCode=true) and caller/callee trail in one call, so before changing it you see what calls it and what your edit would break. For an AMBIGUOUS name it returns EVERY matching definition\'s body in one call (so you never Read a file to find the right overload); pass `file`/`line` to pin one. Use lattice_sensor_explore for several related symbols or the full flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to read (symbol mode). Omit it and pass `file` alone to read a whole file like Read.',
        },
        includeCode: {
          type: 'boolean',
          description: 'Symbol mode: include the symbol\'s full body (default: false). Ignored in file mode, which always returns source unless `symbolsOnly` is set.',
          default: false,
        },
        file: {
          type: 'string',
          description: 'A file path or basename (e.g. "harness.rs", "src/auth/session.ts"). Pass it ALONE (no symbol) to READ the file like the Read tool — its full source with line numbers + which files depend on it. Or pass it WITH a symbol to disambiguate an overloaded name to the definition in this file.',
        },
        offset: {
          type: 'number',
          description: 'File mode: 1-based line to start reading from, exactly like Read\'s offset. Defaults to the start of the file.',
        },
        limit: {
          type: 'number',
          description: 'File mode: maximum number of lines to return, exactly like Read\'s limit. Defaults to the whole file (capped at 2000 lines, like Read).',
        },
        symbolsOnly: {
          type: 'boolean',
          description: 'File mode: return just the file\'s symbol map + dependents (a cheap structural overview) instead of its source.',
          default: false,
        },
        line: {
          type: 'number',
          description: 'Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you).',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_explore',
    description: 'PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus the call path among them. Query can be a natural-language question OR a bag of symbol/file names. Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). For a flow question, name the symbols spanning the flow (e.g. "mutateElement renderScene"). A natural-language question works too — no prior lattice_sensor_search needed.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
    // Loaded from the first prompt in Claude Code, which otherwise defers every
    // MCP tool behind a ToolSearch step (#1696).
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'lattice_sensor_status',
    description: 'Index health check (files, nodes, edges, last indexed time, and added/modified/removed counts) AND the version/execution-mode declaration surface: reports the running Lattice sensor version, the index schema stats, and a machine-readable `mode: daemon|direct` + `reason` field describing how this session is served (see ADR 0049). Skip unless debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'lattice_sensor_files',
    description: 'Indexed file tree with language + symbol counts. Faster than Glob for project layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-LatticeSensor case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.LATTICE_SENSOR_MCP_TOOLS;
  if (!raw || !raw.trim()) {
    return tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^lattice_sensor_/, '')));
  }
  const allow = new Set(raw.split(',').map(s => s.trim().replace(/^lattice_sensor_/, '')).filter(Boolean));
  return allow.size ? tools.filter(t => allow.has(t.name.replace(/^lattice_sensor_/, ''))) : tools;
}

/**
 * ADR 0049 / 0059: Lattice MCP v1 publishes exactly these eight compatibility
 * tool names. The provider is Lattice; narrowing the default based on repo size
 * would silently remove contracted surfaces and make host acceptance ambiguous.
 */
export const DEFAULT_MCP_TOOLS = new Set([
  'search', 'callers', 'callees', 'impact', 'node', 'explore', 'status', 'files',
]);
