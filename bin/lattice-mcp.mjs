#!/usr/bin/env node
/**
 * Lattice MCP server entrypoint (ADR 0049 Decision 8).
 *
 * Thin bin that delegates to the sensor's MCP server — the same server
 * `sensor serve --mcp` starts (see sensor/src/bin/sensor.ts `serve`
 * command and sensor/src/mcp/index.ts `MCPServer`). Deliberately a SEPARATE
 * bin from `bin/lattice.mjs`: the CLI 6 面 axioms (stdout versioned JSON 1
 * 行, exit 0/1/2, `lattice.cli_error.v2`) apply ONLY to lattice.mjs, never
 * to this MCP surface (ADR 0049 Decision 1/8).
 *
 * Contract (ADR 0049 Decision 8):
 *   ① stdout is MCP protocol frames ONLY — every diagnostic goes to stderr.
 *      (The sensor's own MCPServer already honors this; nothing here writes
 *      to stdout.)
 *   ② Accepts the INTERNAL daemon re-invoke form (`serve --mcp --path
 *      <root>` + LATTICE_SENSOR_DAEMON_INTERNAL=1 env). The shared daemon
 *      re-execs `process.argv[1]` with exactly this argv shape
 *      (sensor/src/mcp/index.ts `spawnDetachedDaemon`) — when this process
 *      IS `process.argv[1]` (an MCP host launched it directly as
 *      `lattice-mcp`), rejecting that re-invoke would leave the daemon
 *      unable to ever start, silently pinning every session to direct mode
 *      (the exact silent-degradation trap the ADR calls out).
 *   ③ Exit semantics: usage violation before startup = exit 2; startup
 *      scrutiny failure = exit 1 + one `lattice.cli_error.v2` line on
 *      stderr; normal session end = exit 0 (delegated entirely to
 *      MCPServer, which calls process.exit on every one of its lifecycle
 *      paths — direct/proxy/daemon alike); session-established failures are
 *      MCP protocol errors and never reach this file (MCPServer keeps the
 *      process alive for those).
 *   ④ Node version guard (wave2レビューでのスコープ外発見の修理): this bin
 *      imports `../sensor/dist/index.js` directly, bypassing the sensor
 *      CLI's own Node-version guard (sensor/src/bin/sensor.ts, guarding
 *      against a Node 25.x V8 turboshaft WASM JIT Zone allocator OOM during
 *      tree-sitter grammar compilation, and a MIN_NODE_MAJOR floor). This
 *      file re-applies the SAME check — reusing thresholds/banners from
 *      `sensor/dist/bin/node-version-check.js` via `../src/node-version-
 *      guard.mjs`, never duplicating them — as the very first thing this
 *      script does, before argv parsing or the sensor import. That ordering
 *      also covers the internal daemon re-invoke path (②): the daemon
 *      re-execs this same file, so it re-enters at the top and hits the
 *      guard again unconditionally.
 */

import { evaluateNodeVersionGuard } from '../src/node-version-guard.mjs';

const CLI_ERROR_SCHEMA = 'lattice.cli_error.v2';

/** Usage violation BEFORE startup — exit 2, plain-text stderr (mirrors bin/lattice.mjs's own usageFailure shape). */
function usageFailure(message) {
  process.stderr.write(`lattice-mcp: ${message}\n`);
  process.exitCode = 2;
}

/** Startup-time scrutiny failure — exit 1, one lattice.cli_error.v2 JSON line on stderr. */
function startupFailure(code, message) {
  const payload = { schema: CLI_ERROR_SCHEMA, code, message };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}

/**
 * Parse argv into an optional project path. Accepts, in any order/presence:
 *   - `serve` — accepted, ignored (this bin IS always "serve --mcp"; the
 *     token only exists so the daemon's re-invoke argv shape parses cleanly)
 *   - `--mcp` — accepted, ignored (same reason)
 *   - `-p <path>` / `--path <path>` — explicit project root. The daemon
 *     re-invoke form always supplies this; a direct MCP-host launch may
 *     omit it and rely on `rootUri` reported by the client at `initialize`.
 * Any other token is a usage violation (exit 2) — no implicit fallback.
 */
function parseArgs(argv) {
  let path;
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'serve' || arg === '--mcp') continue;
    if (arg === '-p' || arg === '--path') {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: `${arg} requires a value` };
      }
      path = value;
      i += 1;
      continue;
    }
    unknown.push(arg);
  }
  if (unknown.length > 0) {
    return { error: `unsupported argument(s): ${unknown.join(' ')}` };
  }
  return { path };
}

// Node version guard (④) — runs before anything else, including argv
// parsing, so it also covers the internal daemon re-invoke form (②) which
// re-execs this exact file. Same semantics as the sensor CLI: nodeMajor >=
// 25 or < MIN_NODE_MAJOR blocks unless LATTICE_SENSOR_ALLOW_UNSAFE_NODE is set,
// in which case the banner is shown for visibility only and startup
// continues.
const nodeVersionGuard = evaluateNodeVersionGuard(
  process.versions.node,
  Boolean(process.env.LATTICE_SENSOR_ALLOW_UNSAFE_NODE),
);
if (nodeVersionGuard.banner) {
  process.stderr.write(`${nodeVersionGuard.banner}\n`);
}

if (nodeVersionGuard.blocked) {
  startupFailure('NODE_VERSION_UNSUPPORTED', nodeVersionGuard.banner);
} else {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.error) {
    usageFailure(parsed.error);
  } else {
    try {
      const { MCPServer } = await import('../sensor/dist/index.js');
      const server = new MCPServer(parsed.path);
      // MCPServer.start() resolves only when startup itself declined to serve
      // (there is no such path today — every mode keeps the process alive via
      // stdin/net.Server and exits through its own process.exit calls) or
      // throws on a genuine startup failure (e.g. the sentinel-version fatal
      // in MCPServer.start — ADR 0049 Decision 3(c)). Either way, nothing more
      // to do here on a clean resolve.
      await server.start();
    } catch (err) {
      // opt-in runtime error store（既定OFF・config有効時のみ）。観測失敗はstderr一行のbest-effort。
      const { observeRuntimeError, runtimeErrorSafeContext } = await import('../src/runtime-errors.mjs');
      observeRuntimeError('LATTICE.MCP_SERVER_FAILED', { safeContext: runtimeErrorSafeContext({ error: err }) });
      startupFailure('MCP_STARTUP_FAILED', err instanceof Error ? err.message : String(err));
    }
  }
}
