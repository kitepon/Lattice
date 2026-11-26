# Data flow: lattice-mcp launcher, thin proxy and lazy modes (seat cost, plan lattice-seat-cost-20261126 s1)

Status: implemented by `bin/lattice-mcp.mjs`, `sensor/src/mcp/index.ts` (`MCPServer`), `sensor/src/mcp/proxy.ts`
(`runLocalHandshakeProxy`), `sensor/src/mcp/handshake-info.ts`, `sensor/src/mcp/tool-definitions.ts`.
Owner: Code graph role (Neve). Contract kept: ADR 0049 Decision 8 (stdout carries MCP frames only, exit codes, the daemon
re-invoke argv `serve --mcp --path <root>` with `LATTICE_SENSOR_DAEMON_INTERNAL=1`, the Node version guard first).
Receipt publication is [dfd-mcp-startup-receipt](dfd-mcp-startup-receipt.md); it is unchanged.

Why: every seat session runs one `lattice-mcp`. It used to import the whole sensor (engine, query pool, SQLite layer, ~140
modules, ~50 MB) before choosing a mode, and a proxy spawned a second `node -e` liveness watchdog (~45 MB). A proxy only pipes
stdio to the shared daemon, so neither was used. Measured on Linux, node 26.13.1, one proxy-mode session: 91.7 MB + a 43.3 MB
watchdog process before; 67.5 MB, no second process after (a bare `node` is 45.5 MB; the receipt worker thread is about 12 MB of the rest).

| Owner / step | Input / read | Output / decision | Failure / recovery |
|---|---|---|---|
| `bin/lattice-mcp.mjs` | argv, `process.versions.node` | Node version guard first, then `import('../sensor/dist/mcp/index.js')` (the launcher module, not the library index), `new MCPServer(path, receipt).start()` | Unchanged: guard block / import / construct / start failures are `MCP_STARTUP_FAILED` with the stage recorded; a known option without a value exits 2 |
| `MCPServer.start` (mcp/index.ts) | `LATTICE_SENSOR_DAEMON_INTERNAL`, `LATTICE_SENSOR_NO_DAEMON`, the project root (`resolveServerRoot`) | Decides daemon / direct / proxy with light modules only (directory, daemon-paths, writer-lock, daemon-registry, version) | Any proxy-path throw before the host is served falls back to direct mode, as before |
| `MCPServer.startDaemonProcess` | The re-invoke form | `import('./daemon')` here, then lock, bind, serve | Unchanged; `./daemon` is not loaded by any other mode |
| `MCPServer.startDirect` | No daemon wanted or no index root | `import()` of engine, session and transport here, then the pre-existing single-process session with its own PPID and liveness watchdogs | Unchanged; second direct session on one project serves read-only |
| `MCPServer.runProxyWithLocalHandshake` | Daemon socket candidates | `runLocalHandshakeProxy` with `getDaemonSocket` (probe, spawn detached daemon, poll) and `makeEngine` (async: loads the engine module only when called) | Daemon never binds, version skew, lost connection: the fallback engine below |
| `runLocalHandshakeProxy` (mcp/proxy.ts), attached | Host stdin lines; the verified daemon socket | Answers `initialize`, `tools/list` (from `tool-definitions`), resources/prompts probes locally from static data; forwards every other line to the daemon and relays replies. Loads no engine, session or tool handler. No watchdog process: a pure pipe runs no long synchronous work | Host stdin end/error or PPID loss: exit 0. Windows only: a liveness watchdog covers the connect window and is stopped once the daemon is attached (#943) |
| `runLocalHandshakeProxy`, fallback | `makeEngine()` after `getDaemonSocket` gave no socket, or the daemon died (`connection-lost`) | Loads the engine on first use, sets execution mode `direct` with the typed reason, arms the liveness watchdog process (the in-process engine can wedge the main thread; a worker thread cannot stop a non-allocating V8 loop, see `liveness-watchdog.ts`), re-serves in-flight requests | `makeEngine` refusing (live legacy daemon, unreadable lock): the call answers a protocol error and the next call tries again (the memoized attempt is cleared) |
| `handshake-info` (`SERVER_INFO`, `PROTOCOL_VERSION`, `initializeInstructions`) | Package version | Same payload for the session and the proxy's local handshake; `session.ts` re-exports them | none |
| `tool-definitions` (`tools`, `getStaticTools`, `DEFAULT_MCP_TOOLS`) | `LATTICE_SENSOR_MCP_TOOLS` allowlist | The static MCP tool surface; `tools.ts` (handlers) imports it and re-exports it | none |
| Shared daemon (`Daemon`) | Proxy sockets | One engine, watcher and writer per project; keeps its liveness watchdog process | Unchanged |

State it owns: none new. The daemon lock, socket, writer lock and index stay with the daemon and engine as before.
No other product reads `sensor/dist/mcp/*` internals; `mcp/index.ts` no longer re-exports `StdioTransport`, `tools`,
`ToolHandler` or `Daemon` (nothing imported them from there; use their own modules).

Evidence: `test/mcp-thin-proxy.test.mjs` runs the real bin against a real daemon and asserts the loaded sensor modules exclude
the engine path and that no `node -e` child was spawned (Linux, macOS); `sensor/__tests__/proxy-liveness-watchdog.test.ts`
keeps the fallback watchdog contract.
