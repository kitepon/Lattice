/**
 * Bridge hub HTTP server (bh2) — the multi-terminal aggregator that fronts
 * several `lattice bridge` instances behind a single public origin.
 *
 * This module wires I/O (sockets, disk, the clock) around the pure contract
 * in `bridge-hub-protocol.mjs` (bh1). It does not reinvent registration,
 * heartbeat, staleness, or conflict semantics — it only supplies the parts
 * the contract deliberately does not own: an HTTP surface, a locked file
 * store, and a reverse proxy to the owning terminal's bridge.
 *
 * Endpoints:
 * - `POST /__lattice/hub/register` — a terminal's registration/heartbeat call.
 * - `GET /projects/` — the aggregate listing across all registered terminals.
 * - `* /projects/<project_id>/*` — reverse proxy to the owning terminal's
 *   bridge, or a typed 404/503 when the project is unknown or offline.
 *
 * Safety posture mirrors `bridge-server.mjs` (Host allow-list, hop-by-hop
 * header stripping, Forwarded header regeneration, origin-form request
 * target validation, streaming proxy via `.pipe()` so SSE is never
 * buffered) without importing from it — `bridge-server.mjs` is owned by a
 * concurrent task and this module must not couple to it mid-flight.
 */

import { createServer, request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  mkdir, open, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';

import {
  applyBridgeHubRegistration, BRIDGE_HUB_HEARTBEAT_TTL_MS, BridgeHubProtocolError,
  projectBridgeHubRegistry, validateBridgeHubRegistryEntry,
} from './bridge-hub-protocol.mjs';
import { escapeHtml, renderBridgeHubLanding } from './bridge-hub-landing.mjs';
import { terminalPublicLabel } from './terminal-identity.mjs';

const LOOPBACK = '127.0.0.1';
const HUB_HTTP_ERROR_SCHEMA = 'lattice.bridge_hub_http_error.v1';
const HUB_REGISTRY_DOCUMENT_SCHEMA = 'lattice.bridge_hub_registry_document.v1';
const HUB_PUBLIC_PROJECT_SCHEMA = 'lattice.bridge_hub_public_project.v1';
const HUB_PUBLIC_VISIBILITY_SCHEMA = 'lattice.bridge_hub_public_visibility.v1';
const MAX_REGISTRATION_BODY_BYTES = 65_536;
const LOCK_ATTEMPTS = 240;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 30_000;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff' };
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const UNTRUSTED_CLIENT_IP_HEADERS = new Set([
  'cf-connecting-ip', 'client-ip', 'fastly-client-ip', 'true-client-ip',
  'x-cluster-client-ip', 'x-proxyuser-ip',
]);
const PROJECT_ROUTE = /^\/projects\/([^/]+)(?:\/.*)?$/u;

export class BridgeHubServerError extends Error {
  constructor(code, message, detail = undefined, cause = undefined) {
    super(message, { cause });
    this.name = 'BridgeHubServerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// --- Host allow-list validation (equivalent to bridge-server.mjs's
// validatedRequestHost/normalizeBridgeAllowedHost, reimplemented locally so
// this module does not depend on a file a concurrent task is editing). ---

function normalizeHubAllowedHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new BridgeHubServerError('BRIDGE_HOST_INVALID', 'allowed host is invalid');
  }
  if (isIP(value) !== 0) return value.toLowerCase();
  const withoutDot = value.endsWith('.') ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(ascii)
    || ascii.split('.').some((label) => label.length === 0 || label.length > 63
      || label.startsWith('-') || label.endsWith('-'))) {
    throw new BridgeHubServerError('BRIDGE_HOST_INVALID', 'allowed host is invalid');
  }
  return ascii;
}

function validatedHubHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || /[\s\\/@,]/u.test(value)) {
    throw new BridgeHubServerError('BRIDGE_HOST_INVALID', 'request Host is invalid');
  }
  let parsed;
  try { parsed = new URL(`http://${value}`); } catch {
    throw new BridgeHubServerError('BRIDGE_HOST_INVALID', 'request Host is invalid');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/'
    || parsed.search !== '' || parsed.hash !== '') {
    throw new BridgeHubServerError('BRIDGE_HOST_INVALID', 'request Host is invalid');
  }
  const rawHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const hostname = normalizeHubAllowedHost(rawHostname);
  const authorityHost = hostname.includes(':') ? `[${hostname}]` : hostname;
  return { hostname, authority: parsed.port === '' ? authorityHost : `${authorityHost}:${parsed.port}` };
}

// --- Origin-form request-target validation (equivalent to bridge-server.mjs's
// upstreamUrl guard against absolute-form targets, encoded path bytes, and
// dot-segment escapes). Applied to every route, not only the proxy path. ---

function validatedHubRequestTarget(requestUrl) {
  if (typeof requestUrl !== 'string' || requestUrl.includes('#') || !/^\/(?!\/)[^\s]*$/u.test(requestUrl)) {
    throw new BridgeHubServerError('BRIDGE_HUB_REQUEST_TARGET_INVALID', 'hub requires an origin-form request target');
  }
  const rawPath = requestUrl.split('?', 1)[0];
  if (rawPath.includes('\\') || rawPath.includes('%')) {
    throw new BridgeHubServerError('BRIDGE_HUB_REQUEST_TARGET_INVALID',
      'hub request target contains encoded path bytes or a backslash');
  }
  if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new BridgeHubServerError('BRIDGE_HUB_REQUEST_TARGET_INVALID', 'hub request target contains a dot segment');
  }
  return requestUrl;
}

// --- Proxy header handling (equivalent to bridge-server.mjs's
// forwardHeaders/forwardedHeaders: strip hop-by-hop and untrusted
// client-ip headers, then regenerate Forwarded/X-Forwarded-* from the
// connection hub itself observed). ---

function hubConnectionTokens(headers) {
  const value = headers.connection;
  return new Set((Array.isArray(value) ? value.join(',') : value ?? '')
    .split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function hubForwardHeaders(headers) {
  const nominated = hubConnectionTokens(headers);
  return Object.fromEntries(Object.entries(headers)
    .filter(([name, value]) => value !== undefined && name !== 'host'
      && name.toLowerCase() !== 'forwarded' && name.toLowerCase() !== 'x-real-ip'
      && !name.toLowerCase().startsWith('x-forwarded-')
      && !UNTRUSTED_CLIENT_IP_HEADERS.has(name.toLowerCase())
      && !HOP_BY_HOP.has(name.toLowerCase()) && !nominated.has(name.toLowerCase())));
}

function hubForwardedHeaders(incoming, host) {
  const remote = incoming.socket.remoteAddress ?? 'unknown';
  const forwardedFor = remote.includes(':') ? `"[${remote}]"` : remote;
  return {
    forwarded: `for=${forwardedFor};host="${host.authority}";proto=http`,
    'x-forwarded-for': remote,
    'x-forwarded-host': host.authority,
    'x-forwarded-proto': 'http',
    'x-real-ip': remote,
  };
}

// --- Response rendering. /projects/ listing negotiates JSON on an explicit
// `Accept: application/json` and defaults to HTML (spec: humans browsing the
// index). The per-project 404/503 negotiate the other way — JSON unless
// `Accept` explicitly asks for text/html — matching todo-gantt-live.mjs's
// notFoundHtml convention, since a bridge/monitoring client is the more
// likely caller there. ---

function respondError(response, status, code, detail = null) {
  if (response.headersSent) { response.destroy(); return; }
  const body = detail === null ? { schema: HUB_HTTP_ERROR_SCHEMA, code } : { schema: HUB_HTTP_ERROR_SCHEMA, code, detail };
  response.writeHead(status, JSON_HEADERS);
  response.end(`${JSON.stringify(body)}\n`);
}

// The landing renderer lives in bridge-hub-landing.mjs (ADR 0164: the hub
// landing is the public product face; the room-2474 "stay identical to
// dashboardHtml" constraint is superseded by that ADR).

function hubProjectStatusHtml(code, projectId, requestPath, message) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">`
    + `<title>${escapeHtml(code)} — Lattice hub</title></head>`
    + `<body><h1>${escapeHtml(message)}</h1><p>project_id: ${escapeHtml(projectId)}</p>`
    + `<code>${escapeHtml(requestPath)}</code></body></html>`;
}

function respondProjectStatus(incoming, response, status, code, projectId, requestPath, message) {
  const accept = String(incoming.headers.accept ?? '').toLowerCase();
  if (!accept.includes('text/html')) {
    response.writeHead(status, JSON_HEADERS);
    response.end(`${JSON.stringify({ schema: HUB_HTTP_ERROR_SCHEMA, code, project_id: projectId, message })}\n`);
    return;
  }
  const html = hubProjectStatusHtml(code, projectId, requestPath, message);
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  response.end(html);
}

// --- A single async mutex guarding the registration critical section
// (read -> apply -> write) against two concurrent registration requests
// racing each other's read before either has written, which would lose one
// terminal's update. File-level durability (atomic rename, 0600, a lock
// file) is a separate concern owned by writeBridgeHubRegistry below. ---

function createMutex() {
  let queue = Promise.resolve();
  return (task) => {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  };
}

function readRequestBody(incoming, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        incoming.off('data', onData);
        incoming.resume();
        reject(new BridgeHubServerError('BRIDGE_HUB_REQUEST_BODY_TOO_LARGE', 'registration request body exceeds limit'));
        return;
      }
      chunks.push(chunk);
    };
    incoming.on('data', onData);
    incoming.once('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    incoming.once('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

// === File-based registry persistence ===
// Mirrors todo-dashboard-registry.mjs's withLock/atomicJson pattern
// (temp-file write + rename, 0600 mode, PID-liveness lock with stale
// takeover) without importing it — that module's `withLock` is private, and
// this hub registry lives in its own runtime directory keyed by
// LATTICE_HUB_RUNTIME_DIR rather than LATTICE_DASHBOARD_RUNTIME_DIR.

function hubRuntimeDir(env) {
  const configured = env.LATTICE_HUB_RUNTIME_DIR;
  return typeof configured === 'string' && path.isAbsolute(configured)
    ? configured : path.join(homedir(), '.lattice', 'hub');
}

function hubRuntimePaths(env) {
  const root = hubRuntimeDir(env);
  return {
    root,
    registry: path.join(root, 'terminals.json'),
    lock: path.join(root, 'registry.lock'),
    visibility: path.join(root, 'public-visibility.json'),
  };
}

async function readJsonDocument(ref, missing) {
  let bytes;
  try { bytes = await readFile(ref, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return missing;
    throw error;
  }
  try { return JSON.parse(bytes); } catch {
    throw new BridgeHubServerError('BRIDGE_HUB_REGISTRY_FILE_INVALID', `hub registry JSON is invalid: ${ref}`);
  }
}

async function atomicJson(ref, value) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, ref);
}

async function withFileLock(lockRef, action) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockRef, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      try { return await action(); } finally {
        await handle.close();
        await rm(lockRef, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(await readFile(lockRef, 'utf8'));
        let alive = Number.isSafeInteger(lock.pid) && lock.pid > 0;
        if (alive) { try { process.kill(lock.pid, 0); } catch { alive = false; } }
        if (!alive || Date.now() - Date.parse(lock.created_at) > LOCK_STALE_MS) {
          await rm(lockRef, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  throw new BridgeHubServerError('BRIDGE_HUB_REGISTRY_BUSY', 'hub registry lock timed out');
}

function validRegistryDocument(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.schema === HUB_REGISTRY_DOCUMENT_SCHEMA && Array.isArray(value.entries)
    && value.entries.every(validateBridgeHubRegistryEntry);
}

/** What a terminal is called on the public listing (ADR 0197). Never its self-reported name. */
function publicTerminalName(terminalId, terminalDisplayNames) {
  const label = terminalPublicLabel(terminalId);
  return Object.hasOwn(terminalDisplayNames, label) ? terminalDisplayNames[label] : label;
}

const EMPTY_VISIBILITY = Object.freeze({
  hidden_project_ids: Object.freeze([]), hidden_terminal_ids: Object.freeze([]), display_names: Object.freeze({}),
  terminal_display_names: Object.freeze({}),
});

function validVisibilityDocument(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.schema === HUB_PUBLIC_VISIBILITY_SCHEMA
    && Object.keys(value).every((key) =>
      ['schema', 'hidden_project_ids', 'hidden_terminal_ids', 'display_names', 'terminal_display_names']
        .includes(key))
    && Array.isArray(value.hidden_project_ids)
    && value.hidden_project_ids.every((entry) => typeof entry === 'string')
    && Array.isArray(value.hidden_terminal_ids)
    && value.hidden_terminal_ids.every((entry) => typeof entry === 'string')
    && value.display_names !== null && typeof value.display_names === 'object'
    && !Array.isArray(value.display_names)
    && Object.values(value.display_names).every((entry) => typeof entry === 'string')
    // 任意（ADR 0197）。無い旧fileはそのまま読め、端末は導出labelで出る。
    && (value.terminal_display_names === undefined
      || (value.terminal_display_names !== null && typeof value.terminal_display_names === 'object'
        && !Array.isArray(value.terminal_display_names)
        && Object.values(value.terminal_display_names)
          .every((entry) => typeof entry === 'string' && entry.length > 0 && entry === entry.trim())));
}

/**
 * Read the operator's public-visibility file (ADR 0164 Decision 3): which
 * projects/terminals stay off the public listing, how project ids render, and
 * what each terminal is called in public (`terminal_display_names`, keyed by
 * the terminal's public label — ADR 0197).
 * Hot-read per request so edits apply without a hub restart. A missing file
 * hides nothing; a malformed file is a typed error, never a silent republish
 * of an internal terminal.
 */
export async function readBridgeHubPublicVisibility({ env = process.env } = {}) {
  const refs = hubRuntimePaths(env);
  let document;
  try {
    document = await readJsonDocument(refs.visibility, EMPTY_VISIBILITY);
  } catch (error) {
    throw new BridgeHubServerError('BRIDGE_HUB_VISIBILITY_FILE_INVALID',
      `hub public-visibility JSON is invalid: ${refs.visibility}`, undefined, error);
  }
  if (document === EMPTY_VISIBILITY) return document;
  if (!validVisibilityDocument(document)) {
    throw new BridgeHubServerError('BRIDGE_HUB_VISIBILITY_FILE_INVALID', 'hub public-visibility file is invalid');
  }
  return {
    hidden_project_ids: document.hidden_project_ids,
    hidden_terminal_ids: document.hidden_terminal_ids,
    display_names: document.display_names,
    terminal_display_names: document.terminal_display_names ?? EMPTY_VISIBILITY.terminal_display_names,
  };
}

/** Read the persisted registry. A missing file is an empty registry, not an error. */
export async function readBridgeHubRegistry({ env = process.env } = {}) {
  const refs = hubRuntimePaths(env);
  const document = await readJsonDocument(refs.registry, { schema: HUB_REGISTRY_DOCUMENT_SCHEMA, entries: [] });
  if (!validRegistryDocument(document)) {
    throw new BridgeHubServerError('BRIDGE_HUB_REGISTRY_FILE_INVALID', 'hub registry file is invalid');
  }
  return document.entries;
}

/** Persist a registry snapshot atomically (temp file + rename, 0600, locked). */
export async function writeBridgeHubRegistry({ env = process.env, entries }) {
  if (!Array.isArray(entries) || !entries.every(validateBridgeHubRegistryEntry)) {
    throw new BridgeHubServerError('BRIDGE_HUB_REGISTRY_FILE_INVALID', 'hub registry entries are invalid');
  }
  const refs = hubRuntimePaths(env);
  await mkdir(refs.root, { recursive: true, mode: 0o700 });
  await withFileLock(refs.lock, async () => {
    await atomicJson(refs.registry, { schema: HUB_REGISTRY_DOCUMENT_SCHEMA, entries });
  });
}

// === HTTP server ===

export async function startBridgeHubServer({
  registryStore, port = 0, allowedHosts, env = process.env, fetchImpl = fetch,
  now = () => new Date(), ttlMs = BRIDGE_HUB_HEARTBEAT_TTL_MS, listenAddress = LOOPBACK,
} = {}) {
  // fetchImpl is accepted for DI parity with the rest of this codebase's bridge
  // modules (see bridge-server.mjs's resolveUpstream) but this server's proxy
  // path streams via node:http (see handleProjectProxy) so SSE is never
  // buffered; fetchImpl has no current call site here.
  void fetchImpl;
  if (!(allowedHosts instanceof Set) || allowedHosts.size === 0) {
    throw new BridgeHubServerError('BRIDGE_HUB_CONFIG_INVALID', 'allowedHosts must be a non-empty Set');
  }
  // Defaults to loopback, matching every other bridge/dashboard server in this
  // codebase. bh5 needs this configurable: on the deployment host, Caddy runs
  // in a Docker bridge network and can only reach the host's docker-bridge
  // gateway address (e.g. 172.18.0.1), never a literal 127.0.0.1 bind — the
  // same reason bridge-server.mjs's own listen address is configurable rather
  // than hardcoded. The safety boundary stays `allowedHosts`, not the bind
  // address; unlike bridge-config.mjs's DHCP-following `resolveBridgeListenAddress`,
  // the hub's own host does not move, so that reconciliation machinery is not
  // ported here.
  if (typeof listenAddress !== 'string' || isIP(listenAddress) === 0) {
    throw new BridgeHubServerError('BRIDGE_HUB_CONFIG_INVALID', 'listenAddress must be an IP literal');
  }
  const normalizedAllowedHosts = new Set([...allowedHosts].map(normalizeHubAllowedHost));
  const store = registryStore ?? {
    read: () => readBridgeHubRegistry({ env }),
    write: (entries) => writeBridgeHubRegistry({ env, entries }),
  };
  const registrationLock = createMutex();

  async function handleRegister(incoming, response) {
    if (incoming.method !== 'POST') {
      response.setHeader('allow', 'POST');
      respondError(response, 405, 'BRIDGE_HUB_METHOD_NOT_ALLOWED');
      return;
    }
    let body;
    try { body = await readRequestBody(incoming, MAX_REGISTRATION_BODY_BYTES); } catch (error) {
      respondError(response, error?.code === 'BRIDGE_HUB_REQUEST_BODY_TOO_LARGE' ? 413 : 400,
        error?.code ?? 'BRIDGE_HUB_REQUEST_BODY_INVALID');
      return;
    }
    let request;
    try { request = JSON.parse(body.toString('utf8')); } catch {
      respondError(response, 400, 'BRIDGE_HUB_REQUEST_BODY_INVALID');
      return;
    }
    const remoteAddress = incoming.socket.remoteAddress;
    if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) {
      respondError(response, 500, 'BRIDGE_HUB_REMOTE_ADDRESS_UNAVAILABLE');
      return;
    }
    let result;
    try {
      result = await registrationLock(async () => {
        const entries = await store.read();
        const applied = applyBridgeHubRegistration({
          registry: entries, request, remoteAddress, now: now(), ttlMs,
        });
        await store.write(applied.registry);
        return applied.result;
      });
    } catch (error) {
      if (error instanceof BridgeHubProtocolError) {
        // A contested project_id no longer throws — it comes back in the 200
        // body's `rejected`. Only a malformed request or registry lands here.
        const status = error.code === 'BRIDGE_HUB_REGISTRATION_INVALID' ? 400 : 500;
        respondError(response, status, error.code, error.detail ?? null);
        return;
      }
      respondError(response, 500, error?.code ?? 'BRIDGE_HUB_REGISTRATION_FAILED');
      return;
    }
    response.writeHead(200, JSON_HEADERS);
    response.end(`${JSON.stringify(result)}\n`);
  }

  async function handleLanding(incoming, response, lang) {
    if (incoming.method !== 'GET') {
      response.setHeader('allow', 'GET');
      respondError(response, 405, 'BRIDGE_HUB_METHOD_NOT_ALLOWED');
      return;
    }
    const entries = await store.read();
    const visibility = await readBridgeHubPublicVisibility({ env });
    const hiddenProjects = new Set(visibility.hidden_project_ids);
    const hiddenTerminals = new Set(visibility.hidden_terminal_ids);
    // The visibility filter applies to the listing only (both HTML and JSON);
    // `/projects/<hidden>/` keeps proxying — hidden is not private (ADR 0164
    // Decision 3, deliberately: smoke tests fetch their own page, operators
    // keep the direct URL).
    const projected = projectBridgeHubRegistry({ registry: entries, now: now(), ttlMs })
      .filter((entry) => !hiddenProjects.has(entry.project_id) && !hiddenTerminals.has(entry.terminal_id));
    // Only the fields humans need for the public index are exposed; internal
    // routing fields (terminal_id, address, port) stay server-side, matching
    // the codebase's existing posture of not leaking topology to public
    // responses (bridge-server.mjs's public bridge-health strips pid/address
    // the same way).
    //
    // `display_name` is the exception that proved the rule: it used to be the
    // terminal's self-reported name, which was its OS hostname, published to
    // anyone (ADR 0197). The public name is now the hub's to give — the
    // operator's entry in `terminal_display_names`, else the label derived
    // from the terminal id. What a terminal reports about itself stays in the
    // registry, so a terminal still running an older Lattice cannot put its
    // hostname back on the page, and neither can a stale offline entry.
    const view = projected.map((entry) => ({
      schema: HUB_PUBLIC_PROJECT_SCHEMA,
      project_id: entry.project_id,
      display_name: publicTerminalName(entry.terminal_id, visibility.terminal_display_names),
      status: entry.status,
      last_seen_at: entry.last_seen_at,
    }));
    const accept = String(incoming.headers.accept ?? '').toLowerCase();
    if (accept.includes('application/json')) {
      response.writeHead(200, JSON_HEADERS);
      response.end(`${JSON.stringify(view)}\n`);
      return;
    }
    const html = renderBridgeHubLanding({ projects: view, lang, displayNames: visibility.display_names });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' });
    response.end(html);
  }

  async function handleProjectProxy(incoming, response, requestUrl, encodedProjectId, host) {
    let projectId;
    try { projectId = decodeURIComponent(encodedProjectId); } catch {
      respondError(response, 400, 'BRIDGE_HUB_PROJECT_ID_INVALID');
      return;
    }
    const entries = await store.read();
    const projected = projectBridgeHubRegistry({ registry: entries, now: now(), ttlMs });
    const entry = projected.find((candidate) => candidate.project_id === projectId);
    if (entry === undefined) {
      respondProjectStatus(incoming, response, 404, 'BRIDGE_HUB_PROJECT_NOT_FOUND', projectId, requestUrl,
        '指定されたプロジェクトはhubに登録されていません。');
      return;
    }
    if (entry.status === 'offline') {
      respondProjectStatus(incoming, response, 503, 'BRIDGE_HUB_PROJECT_OFFLINE', projectId, requestUrl,
        '配信元の端末が現在オフラインです。heartbeatの再送または端末の起動状態を確認してください。');
      return;
    }
    const targetHost = entry.address.includes(':') ? `[${entry.address}]` : entry.address;
    const target = new URL(requestUrl, `http://${targetHost}:${entry.port}/`);
    let upstreamResponse = null;
    const proxyRequest = httpRequest(target, {
      method: incoming.method,
      headers: { ...hubForwardHeaders(incoming.headers), ...hubForwardedHeaders(incoming, host), host: target.host },
    }, (incomingResponse) => {
      upstreamResponse = incomingResponse;
      response.writeHead(incomingResponse.statusCode ?? 502, hubForwardHeaders(incomingResponse.headers));
      incomingResponse.once('error', () => response.destroy());
      // Stream, do not buffer: this is the SSE-safety requirement (plan's
      // "known trap" section). incomingResponse.pipe forwards each chunk as
      // it arrives rather than waiting for the upstream response to end.
      incomingResponse.pipe(response);
    });
    proxyRequest.once('error', (error) => respondError(response, 502,
      error?.code === 'ECONNREFUSED' ? 'BRIDGE_HUB_UPSTREAM_REFUSED' : 'BRIDGE_HUB_PROXY_FAILED'));
    incoming.once('aborted', () => proxyRequest.destroy());
    response.once('close', () => {
      if (!response.writableFinished) {
        proxyRequest.destroy();
        upstreamResponse?.destroy();
      }
    });
    incoming.pipe(proxyRequest);
  }

  const handleRequest = async (incoming, response) => {
    let host;
    try { host = validatedHubHost(incoming.headers.host); } catch (error) {
      respondError(response, 400, error?.code ?? 'BRIDGE_HOST_INVALID');
      return;
    }
    if (!normalizedAllowedHosts.has(host.hostname)) {
      respondError(response, 421, 'BRIDGE_HOST_NOT_ALLOWED');
      return;
    }
    let requestUrl;
    try { requestUrl = validatedHubRequestTarget(incoming.url); } catch (error) {
      respondError(response, 400, error?.code ?? 'BRIDGE_HUB_REQUEST_TARGET_INVALID');
      return;
    }
    const rawPath = requestUrl.split('?', 1)[0];
    if (rawPath === '/__lattice/hub/register') { await handleRegister(incoming, response); return; }
    // The landing (ADR 0164) serves the same page at `/` and `/projects/`
    // (the old `/` -> `/projects/` 301 is retired: both public inbound links
    // land on the product face), with the EN variant path-separated under
    // `/en/` mirroring the root site's convention. These literal matches must
    // stay ahead of PROJECT_ROUTE so `/projects/` never parses as a project id.
    if (rawPath === '/' || rawPath === '/projects/') { await handleLanding(incoming, response, 'ja'); return; }
    if (rawPath === '/en/' || rawPath === '/en/projects/') { await handleLanding(incoming, response, 'en'); return; }
    if (rawPath === '/en') {
      response.writeHead(301, { location: '/en/', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (rawPath.startsWith('/en/projects/')) {
      // Per-project pages are language-neutral; strip the prefix instead of
      // 404ing a hand-edited EN URL. Query strings survive the strip.
      response.writeHead(301, { location: requestUrl.slice('/en'.length), 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const match = PROJECT_ROUTE.exec(rawPath);
    if (match !== null) { await handleProjectProxy(incoming, response, requestUrl, match[1], host); return; }
    respondError(response, 404, 'BRIDGE_HUB_ROUTE_NOT_FOUND');
  };

  const server = createServer((incoming, response) => {
    handleRequest(incoming, response).catch((error) => respondError(response, 500,
      error?.code ?? 'BRIDGE_HUB_REQUEST_FAILED'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: listenAddress, port }, resolve);
  });
  const boundAddress = server.address();
  const actualPort = typeof boundAddress === 'object' && boundAddress !== null ? boundAddress.port : port;
  let closed = false;
  return Object.freeze({
    host: listenAddress,
    port: actualPort,
    close: async () => {
      if (closed) return;
      closed = true;
      const completion = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      await completion;
    },
  });
}
