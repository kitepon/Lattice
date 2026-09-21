import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import {
  chmod, lstat, mkdir, open, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { parseTree } from 'jsonc-parser';

export const BRIDGE_CONFIG_SCHEMA = 'lattice.bridge_config.v1';
export const BRIDGE_PORT_MIN = 49_152;
export const BRIDGE_PORT_MAX = 65_535;
const CONFIG_NAME = 'bridge.json';
const LOCK_NAME = 'bridge.lock';
const OPERATION_LOCK_NAME = 'bridge-operation.lock';
const LOCK_ATTEMPTS = 240;
const LOCK_WAIT_MS = 25;
const LOCK_STALE_MS = 30_000;
const AUTO_PORT_ATTEMPTS = 256;

export class BridgeConfigError extends Error {
  constructor(code, message, detail = undefined, cause = undefined) {
    super(message, { cause });
    this.name = 'BridgeConfigError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function configRoot(env) {
  const configured = env.LATTICE_CONFIG_DIR;
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
      throw new BridgeConfigError('BRIDGE_CONFIG_DIR_INVALID', 'LATTICE_CONFIG_DIR must be absolute');
    }
    return configured;
  }
  return path.join(homedir(), '.lattice');
}

export function bridgeConfigPaths(env = process.env) {
  const root = configRoot(env);
  return Object.freeze({ root, config: path.join(root, CONFIG_NAME), lock: path.join(root, LOCK_NAME),
    operationLock: path.join(root, OPERATION_LOCK_NAME) });
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateListen(listen) {
  if (!exact(listen, ['address', 'port']) || isIP(listen.address) === 0
    || !Number.isSafeInteger(listen.port) || listen.port < BRIDGE_PORT_MIN
    || listen.port > BRIDGE_PORT_MAX) {
    throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'bridge listen configuration is invalid');
  }
}

export function normalizeBridgeAllowedHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new BridgeConfigError('BRIDGE_ALLOWED_HOST_INVALID', 'allowed host is invalid');
  }
  if (isIP(value) !== 0) return value.toLowerCase();
  const withoutDot = value.endsWith('.') ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(ascii)
    || ascii.split('.').some((label) => label.length === 0 || label.length > 63
      || label.startsWith('-') || label.endsWith('-'))) {
    throw new BridgeConfigError('BRIDGE_ALLOWED_HOST_INVALID', 'allowed host is invalid');
  }
  return ascii;
}

function normalizeAllowedHosts(address, values) {
  if (!Array.isArray(values) || values.length > 32) {
    throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'allowed hosts must be an array');
  }
  const hosts = new Set([normalizeBridgeAllowedHost(address)]);
  if (address === '0.0.0.0') hosts.add('127.0.0.1');
  if (address === '::') hosts.add('::1');
  for (const value of values) hosts.add(normalizeBridgeAllowedHost(value));
  if (hosts.size > 32) throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'too many allowed hosts');
  return Object.freeze([...hosts].sort((left, right) => left.localeCompare(right, 'en')));
}

export function normalizeBridgeUpstream(upstream) {
  if (upstream?.mode === 'dashboard_descriptor' && exact(upstream, ['mode'])) {
    return Object.freeze({ mode: 'dashboard_descriptor' });
  }
  if (upstream?.mode !== 'url' || !exact(upstream, ['mode', 'url']) || typeof upstream.url !== 'string') {
    throw new BridgeConfigError('BRIDGE_UPSTREAM_INVALID', 'bridge upstream configuration is invalid');
  }
  let parsed;
  try { parsed = new URL(upstream.url); } catch {
    throw new BridgeConfigError('BRIDGE_UPSTREAM_INVALID', 'bridge upstream URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.search !== '') {
    throw new BridgeConfigError('BRIDGE_UPSTREAM_INVALID', 'bridge upstream URL must be an HTTP origin or base path');
  }
  parsed.pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return Object.freeze({ mode: 'url', url: parsed.href });
}

/**
 * The hub this terminal heartbeats to (bh3), or null when unconfigured — most
 * terminals never opt in. Unlike `upstream`, there is only one shape: an
 * explicit HTTP(S) origin. There is no descriptor-derived variant because the
 * hub is a separate host on the LAN, not something this terminal can discover
 * from its own local state.
 */
export function normalizeBridgeHubUrl(hub) {
  if (hub === null) return null;
  if (!exact(hub, ['url']) || typeof hub.url !== 'string') {
    throw new BridgeConfigError('BRIDGE_HUB_URL_INVALID', 'bridge hub configuration is invalid');
  }
  let parsed;
  try { parsed = new URL(hub.url); } catch {
    throw new BridgeConfigError('BRIDGE_HUB_URL_INVALID', 'bridge hub URL is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== ''
    || parsed.hash !== '' || parsed.search !== '') {
    throw new BridgeConfigError('BRIDGE_HUB_URL_INVALID', 'bridge hub URL must be an HTTP origin');
  }
  parsed.pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return Object.freeze({ url: parsed.href });
}

export function validateBridgeConfig(value) {
  if (!exact(value, ['schema', 'enabled', 'listen', 'allowed_hosts', 'upstream', 'hub', 'updated_at'])
    || value.schema !== BRIDGE_CONFIG_SCHEMA || typeof value.enabled !== 'boolean'
    || !validTimestamp(value.updated_at)) {
    throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'bridge configuration schema is invalid');
  }
  validateListen(value.listen);
  const allowedHosts = normalizeAllowedHosts(value.listen.address, value.allowed_hosts);
  if (allowedHosts.length !== value.allowed_hosts.length
    || allowedHosts.some((host, index) => host !== value.allowed_hosts[index])) {
    throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'allowed hosts are not canonical');
  }
  const upstream = normalizeBridgeUpstream(value.upstream);
  const hub = normalizeBridgeHubUrl(value.hub);
  return Object.freeze({
    schema: BRIDGE_CONFIG_SCHEMA,
    enabled: value.enabled,
    listen: Object.freeze({ address: value.listen.address, port: value.listen.port }),
    allowed_hosts: allowedHosts,
    upstream,
    hub,
    updated_at: value.updated_at,
  });
}

async function prepareRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new BridgeConfigError('BRIDGE_CONFIG_DIR_INVALID', 'bridge config directory is unsafe');
  }
  if ((stats.mode & 0o077) !== 0) await chmod(root, 0o700);
}

async function readDocument(ref) {
  let stats;
  try { stats = await lstat(ref); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BridgeConfigError('BRIDGE_CONFIG_UNREADABLE', 'bridge config cannot be read', undefined, error);
  }
  // Windows has no POSIX permission-bit model: `fs.stat().mode` never reports
  // 0600 there regardless of what `mode`/`chmod` requested at write time, so
  // this check is a hard, unconditional block on every platform but darwin/
  // linux — verified against a real Windows host (`BRIDGE_CONFIG_MODE_INVALID`
  // on a config `configureBridge` itself had just written moments earlier).
  // The other checks (regular file, not a symlink) still apply everywhere.
  if (!stats.isFile() || stats.isSymbolicLink()
    || (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600)) {
    throw new BridgeConfigError('BRIDGE_CONFIG_MODE_INVALID', 'bridge config must be a regular 0600 file');
  }
  let value;
  try {
    const text = await readFile(ref, 'utf8');
    const errors = [];
    const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
    const duplicate = (node) => {
      if (node?.type === 'object') {
        const keys = new Set();
        for (const property of node.children ?? []) {
          const [key, child] = property.children ?? [];
          if (keys.has(key?.value) || duplicate(child)) return true;
          keys.add(key?.value);
        }
      } else if (node?.type === 'array') return (node.children ?? []).some(duplicate);
      return false;
    };
    if (errors.length > 0 || tree === undefined || duplicate(tree)) {
      throw new Error('duplicate or invalid JSON');
    }
    value = JSON.parse(text);
  } catch (error) {
    throw new BridgeConfigError('BRIDGE_CONFIG_INVALID', 'bridge config JSON is invalid', undefined, error);
  }
  // `hub` (bh3) postdates this schema's v1 tag, which never changed — an on-disk
  // config written before bh3 has no `hub` key at all. Treat that absence as
  // "never configured" rather than a schema violation, so a bridge that has
  // been running since before hub support existed keeps reading its own
  // config instead of failing closed the next time this code is deployed.
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && value.hub === undefined) {
    value = { ...value, hub: null };
  }
  return validateBridgeConfig(value);
}

export async function readBridgeConfig({ env = process.env } = {}) {
  return readDocument(bridgeConfigPaths(env).config);
}

async function atomicWrite(ref, value) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, ref);
    await chmod(ref, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withLock(ref, action) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(ref, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      try { return await action(); } finally {
        await handle.close();
        await rm(ref, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(await readFile(ref, 'utf8'));
        let alive = Number.isSafeInteger(lock.pid) && lock.pid > 0;
        if (alive) try { process.kill(lock.pid, 0); } catch { alive = false; }
        if (!alive || Date.now() - Date.parse(lock.created_at) > LOCK_STALE_MS) {
          await rm(ref, { force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  throw new BridgeConfigError('BRIDGE_CONFIG_BUSY', 'bridge config lock timed out');
}

export async function withBridgeOperationLock({ env = process.env } = {}, action) {
  if (typeof action !== 'function') throw new TypeError('bridge operation action required');
  const refs = bridgeConfigPaths(env);
  await prepareRoot(refs.root);
  return withLock(refs.operationLock, action);
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function bindCandidate(address, port, createCandidateServer) {
  const server = createCandidateServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: address, port, exclusive: true }, resolve);
    });
    return server;
  } catch (error) {
    try { server.close(); } catch {}
    if (['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error?.code)) return null;
    throw new BridgeConfigError('BRIDGE_BIND_FAILED', 'bridge candidate bind failed', { address, port }, error);
  }
}

async function reservePort({ address, requestedPort, createCandidateServer, choosePort }) {
  if (requestedPort !== null) {
    const server = await bindCandidate(address, requestedPort, createCandidateServer);
    if (server === null) {
      throw new BridgeConfigError('BRIDGE_PORT_UNAVAILABLE', 'requested bridge port is unavailable',
        { address, port: requestedPort });
    }
    return { port: requestedPort, server };
  }
  const attempted = new Set();
  while (attempted.size < AUTO_PORT_ATTEMPTS) {
    let port = choosePort();
    if (!Number.isSafeInteger(port) || port < BRIDGE_PORT_MIN || port > BRIDGE_PORT_MAX) {
      port = randomInt(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX + 1);
    }
    while (attempted.has(port)) {
      port = port === BRIDGE_PORT_MAX ? BRIDGE_PORT_MIN : port + 1;
    }
    attempted.add(port);
    const server = await bindCandidate(address, port, createCandidateServer);
    if (server !== null) return { port, server };
  }
  throw new BridgeConfigError('BRIDGE_PORT_EXHAUSTED', 'no exclusive high bridge port could be bound',
    { address, attempts: attempted.size });
}

function validateMutation({ address, port, upstream, hub, allowedHosts }) {
  if (typeof address !== 'string' || isIP(address) === 0) {
    throw new BridgeConfigError('BRIDGE_LISTEN_INVALID', 'bridge listen address must be an IP literal');
  }
  if (port !== null && (!Number.isSafeInteger(port) || port < BRIDGE_PORT_MIN || port > BRIDGE_PORT_MAX)) {
    throw new BridgeConfigError('BRIDGE_PORT_INVALID', `bridge port must be ${BRIDGE_PORT_MIN}..${BRIDGE_PORT_MAX}`);
  }
  return { upstream: normalizeBridgeUpstream(upstream), hub: normalizeBridgeHubUrl(hub),
    allowedHosts: normalizeAllowedHosts(address, allowedHosts) };
}

export async function configureBridge({
  address, port = null, upstream = { mode: 'dashboard_descriptor' }, hub = null, allowedHosts = [],
  env = process.env, now = () => new Date(),
  createCandidateServer = () => createServer(),
  choosePort = () => randomInt(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX + 1),
  reuseCurrentPort = true,
  activeBinding = null,
} = {}) {
  const normalized = validateMutation({ address, port, upstream, hub, allowedHosts });
  const refs = bridgeConfigPaths(env);
  await prepareRoot(refs.root);
  return withLock(refs.lock, async () => {
    const current = await readDocument(refs.config);
    const selectedPort = port ?? (reuseCurrentPort && current?.enabled && current.listen.address === address
      ? current.listen.port : null);
    const bindingUnchanged = current?.enabled === true && current.listen.address === address
      && current.listen.port === selectedPort
      // activeBindingはbridge-cliがinstance tokenで本人確認した待受だけを渡す。
      // DHCP追従済みの自分のsocketを再予約すると、無関係なport競合と誤認する。
      || current?.enabled === true && activeBinding?.address === address
        && activeBinding.port === selectedPort;
    let reservation = null;
    try {
      if (!bindingUnchanged) {
        reservation = await reservePort({ address, requestedPort: selectedPort,
          createCandidateServer, choosePort });
      }
      const config = validateBridgeConfig({
        schema: BRIDGE_CONFIG_SCHEMA,
        enabled: true,
        listen: { address, port: bindingUnchanged ? selectedPort : reservation.port },
        allowed_hosts: normalized.allowedHosts,
        upstream: normalized.upstream,
        hub: normalized.hub,
        updated_at: now().toISOString(),
      });
      await atomicWrite(refs.config, config);
      return config;
    } finally {
      if (reservation !== null) await closeServer(reservation.server);
    }
  });
}

export async function disableBridge({ env = process.env, now = () => new Date() } = {}) {
  const refs = bridgeConfigPaths(env);
  await prepareRoot(refs.root);
  return withLock(refs.lock, async () => {
    const current = await readDocument(refs.config);
    if (current === null) return null;
    const config = validateBridgeConfig({ ...current, enabled: false, updated_at: now().toISOString() });
    await atomicWrite(refs.config, config);
    return config;
  });
}

export async function restoreBridgeConfig(config, { env = process.env } = {}) {
  if (config !== null) validateBridgeConfig(config);
  const refs = bridgeConfigPaths(env);
  await prepareRoot(refs.root);
  return withLock(refs.lock, async () => {
    if (config === null) await rm(refs.config, { force: true });
    else await atomicWrite(refs.config, config);
    return config;
  });
}
