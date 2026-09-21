/**
 * Terminal-side bridge-hub heartbeat client (bh3).
 *
 * Wires the pure wire contract in `bridge-hub-protocol.mjs` (bh1) around this
 * terminal's own state: a persisted terminal identity, the project set this
 * terminal is actually serving (asked of the dashboard daemon itself, ADR
 * 0165), and the configured hub origin
 * (`bridge-config.mjs`'s `hub` field). It sends `POST /__lattice/hub/register`
 * on `bridge-hub-server.mjs`'s (bh2) contract — the request body is the raw
 * `lattice.bridge_hub_registration_request.v1` object, unmodified in transit.
 *
 * DHCP addresses are never read or sent here: ADR 0162 has the hub derive
 * `address` from the registration connection's own source, the same safety
 * property `bridge-registrar.mjs` relies on. A moved lease is invisible to
 * this module by design — the next heartbeat just arrives from a new source.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bridgeConfigPaths } from './bridge-config.mjs';
import { BRIDGE_HUB_HEARTBEAT_INTERVAL_MS, validateBridgeHubRegistrationRequest } from './bridge-hub-protocol.mjs';
import { readServedTodoDashboardProjectIds } from './todo-dashboard-registry.mjs';

export { BRIDGE_HUB_HEARTBEAT_INTERVAL_MS };

const TERMINAL_IDENTITY_SCHEMA = 'lattice.bridge_hub_terminal_identity.v1';
const HEARTBEAT_RESULT_SCHEMA = 'lattice.bridge_hub_heartbeat_result.v1';
const REGISTRATION_REQUEST_SCHEMA = 'lattice.bridge_hub_registration_request.v1';
const REGISTER_PATH = '__lattice/hub/register';
const DEFAULT_TIMEOUT_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class BridgeHubHeartbeatError extends Error {
  constructor(code, message, detail = undefined, cause = undefined) {
    super(message, { cause });
    this.name = 'BridgeHubHeartbeatError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function terminalIdentityPath(env) {
  return path.join(bridgeConfigPaths(env).root, 'bridge-hub-terminal.json');
}

/**
 * This terminal's stable bridge-hub identity, created once and reused across
 * restarts. It must survive restarts: registration is a full-state
 * reconciliation keyed by terminal_id (ADR 0162 Decision 4), so a fresh id on
 * every daemon start would make the hub see "a new terminal" contesting the
 * same project_ids the old id still owns until its TTL lapses — self-inflicted
 * contention, answered now by a `rejected` entry rather than a failed request.
 */
export async function readOrCreateBridgeHubTerminalId({ env = process.env } = {}) {
  const refs = bridgeConfigPaths(env);
  await mkdir(refs.root, { recursive: true, mode: 0o700 });
  const ref = terminalIdentityPath(env);
  for (;;) {
    try {
      const value = JSON.parse(await readFile(ref, 'utf8'));
      if (value?.schema === TERMINAL_IDENTITY_SCHEMA && IDENTIFIER.test(value.terminal_id)) return value.terminal_id;
      throw new BridgeHubHeartbeatError('BRIDGE_HUB_TERMINAL_IDENTITY_INVALID',
        'bridge hub terminal identity file is invalid');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const terminalId = randomBytes(16).toString('hex');
    const temporary = `${ref}.${terminalId}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schema: TERMINAL_IDENTITY_SCHEMA, terminal_id: terminalId })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      // 完成済みのbytesだけを、既存のIDを上書きせず公開する。
      await link(temporary, ref);
      return terminalId;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // 同時生成の勝者が公開した完成済みIDを読む。
    } finally {
      await unlink(temporary);
    }
  }
}

/**
 * The terminal's own display name, shown for every project it registers
 * (registry entries are per-project but `display_name` is terminal-wide —
 * ADR 0162 Decision 2). Hostname, not a project name: the active project set
 * changes heartbeat to heartbeat but the terminal's identity does not.
 */
function terminalDisplayName() {
  return hostname().slice(0, 128) || 'terminal';
}

/** Build and validate one registration/heartbeat request. Throws rather than
  * sending a request the hub would reject as malformed. */
export function buildBridgeHubRegistrationRequest({ terminalId, port, projectIds, adopt = [] }) {
  const request = {
    schema: REGISTRATION_REQUEST_SCHEMA,
    terminal_id: terminalId,
    display_name: terminalDisplayName(),
    port,
    project_ids: [...new Set(projectIds)].sort((left, right) => left.localeCompare(right, 'en')),
    adopt: [...adopt],
  };
  if (!validateBridgeHubRegistrationRequest(request)) {
    throw new BridgeHubHeartbeatError('BRIDGE_HUB_HEARTBEAT_REQUEST_INVALID',
      'constructed bridge hub registration request is invalid', { request });
  }
  return request;
}

/**
 * Send one heartbeat. Never throws for a remote or network failure — the
 * bridge daemon loop calling this must keep serving locally even when the
 * hub is unreachable, matching `bridge-registrar.mjs`'s posture. Failures are
 * returned typed so callers can surface or log them instead of losing them.
 */
export async function sendBridgeHubHeartbeat({ hubUrl, request, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(new URL(REGISTER_PATH, hubUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { schema: HEARTBEAT_RESULT_SCHEMA, state: 'unreachable',
      detail: (error?.message ?? 'network error').slice(0, 500) };
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.status !== 200) {
    return { schema: HEARTBEAT_RESULT_SCHEMA, state: 'rejected', status: response.status, detail: body };
  }
  // A hub that accepted some ids and refused others answers 200 with a non-empty
  // `rejected`. Calling that plain 'accepted' would hide exactly the case this
  // protocol change exists to make visible: a project of ours is live on another
  // terminal and will never reach the published view from here until someone
  // adopts it. Give it its own state so `bridge status` can report it without
  // having to know the registration result's shape.
  const rejected = Array.isArray(body?.rejected) ? body.rejected : [];
  if (rejected.length > 0) {
    return { schema: HEARTBEAT_RESULT_SCHEMA, state: 'partial', result: body };
  }
  return { schema: HEARTBEAT_RESULT_SCHEMA, state: 'accepted', result: body };
}

/**
 * Compact projection of the last heartbeat, for the daemon's attested health
 * response and from there `lattice bridge status`.
 *
 * Until now a hub that refused this terminal's projects said so only in the
 * daemon's stderr, and the bridge LaunchAgent has no StandardErrorPath — so the
 * only symptom an operator ever saw was a project that silently never appeared
 * on the published dashboard (2026-08-10). The result has to reach a surface a
 * person actually reads.
 */
export function bridgeHubHeartbeatSummary(result, at = null) {
  if (result === null || result === undefined) return null;
  const rejected = Array.isArray(result.result?.rejected) ? result.result.rejected : [];
  const reclaimed = Array.isArray(result.result?.reclaimed_from_offline)
    ? result.result.reclaimed_from_offline : [];
  const detail = result.detail === undefined || result.detail === null ? null
    : (typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail)).slice(0, 300);
  return {
    state: result.state,
    at,
    rejected_projects: rejected.map((entry) => entry.project_id)
      .sort((left, right) => left.localeCompare(right, 'en')),
    reclaimed_projects: [...reclaimed],
    detail,
  };
}

/**
 * Periodic controller for the bridge daemon's own poll loop
 * (`bin/lattice-bridge.mjs`). Call `tick({ config })` on every iteration; it
 * self-throttles to `intervalMs` and is a no-op (no disk or network access)
 * whenever the terminal has no hub configured, so callers pay only a null
 * check on the common path.
 */
export function createBridgeHubHeartbeatController({
  env = process.env, fetchImpl = fetch, now = () => Date.now(),
  intervalMs = BRIDGE_HUB_HEARTBEAT_INTERVAL_MS,
  readServedProjectIds = readServedTodoDashboardProjectIds,
} = {}) {
  let lastSentAt = null;
  let lastResult = null;
  let lastResultAt = null;
  const record = (result, atMs) => {
    lastResult = result;
    lastResultAt = new Date(atMs).toISOString();
    return result;
  };
  return Object.freeze({
    async tick({ config, force = false }) {
      if (config?.hub == null) {
        lastSentAt = null; lastResult = null; lastResultAt = null; return null;
      }
      const nowMs = now();
      if (!force && lastSentAt !== null && nowMs - lastSentAt < intervalMs) return lastResult;
      lastSentAt = nowMs;
      // 名乗る集合は、この端末が実際に配信している集合そのものを使う。登録簿から別途
      // 数え直すと、配信している側と名乗る側が別々の基準を持ち、必ずずれる（ADR 0165）。
      const projectIds = await readServedProjectIds({ env });
      if (projectIds === null) {
        return record({ schema: HEARTBEAT_RESULT_SCHEMA, state: 'skipped_no_dashboard' }, nowMs);
      }
      if (projectIds.length === 0) {
        return record({ schema: HEARTBEAT_RESULT_SCHEMA, state: 'skipped_no_projects' }, nowMs);
      }
      const terminalId = await readOrCreateBridgeHubTerminalId({ env });
      const request = buildBridgeHubRegistrationRequest({
        terminalId, port: config.listen.port, projectIds,
      });
      return record(
        await sendBridgeHubHeartbeat({ hubUrl: config.hub.url, request, fetchImpl }), nowMs,
      );
    },
    lastHeartbeatResult: () => lastResult,
    lastHeartbeatSummary: () => bridgeHubHeartbeatSummary(lastResult, lastResultAt),
  });
}
