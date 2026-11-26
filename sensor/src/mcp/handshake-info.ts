/**
 * The `initialize` payload pieces shared by the full MCP session and the proxy's
 * local handshake. Kept in a module of its own (it imports only the version) so
 * the proxy answers the handshake without loading the session, engine and tool
 * handler behind {@link ./session}.
 */
import { LatticeSensorPackageVersion } from './version';

/**
 * MCP Server Info — kept on the session because some clients log it. The
 * version tracks the real package version (was a hard-coded '0.1.0').
 */
// Exported so the proxy can answer `initialize` locally with the IDENTICAL
// payload the daemon would send — no drift between the two handshake paths.
export const SERVER_INFO = {
  name: 'lattice-sensor',
  version: LatticeSensorPackageVersion,
};

/**
 * Instructions for the `initialize` response, with an optional notice
 * appended (`notice` non-null). Exported so the proxy's local handshake
 * sends the IDENTICAL payload — same convention as SERVER_INFO.
 *
 * ADR 0049 Decision 4: the upstream update-availability notice (#1243,
 * `getUpdateNotice()`) is no longer wired to the default parameter here — the
 * MCP surface must not mix an upstream-GitHub-sourced update notice into
 * agent-visible instructions. `notice` defaults to `null`, so callers that
 * pass only `base` get byte-identical instructions; the parameter itself
 * stays for tests and any future Lattice-owned notice.
 */
export function initializeInstructions(base: string, notice: string | null = null): string {
  if (!notice) return base;
  return (
    `${base}\n\n---\n${notice} This server keeps running the old version until ` +
    `the user upgrades — mention it when convenient; do not run the upgrade yourself.`
  );
}

/** MCP Protocol Version (latest the server claims). */
export const PROTOCOL_VERSION = '2024-11-05';
