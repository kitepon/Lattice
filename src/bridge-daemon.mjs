import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { parseTree } from 'jsonc-parser';

import {
  BRIDGE_PORT_MAX, BRIDGE_PORT_MIN, BridgeConfigError, bridgeConfigPaths, readBridgeConfig,
} from './bridge-config.mjs';
import { resolveBridgeListenAddress } from './bridge-address.mjs';
import packageJson from '../package.json' with { type: 'json' };

const DESCRIPTOR_SCHEMA = 'lattice.bridge_daemon.v1';
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const STOP_REQUEST_SCHEMA = 'lattice.bridge_stop_request.v1';
const STOP_RECEIPT_SCHEMA = 'lattice.bridge_stop_receipt.v1';
const ACTIVE_MARKER_SCHEMA = 'lattice.bridge_daemon_active.v1';
const CONTROL_MAX_BYTES = 65_536;
/** control fileの差し替え競合だけを吸収する再読の上限と間隔（`readStrictJson`が唯一の使用者）。 */
const CONTROL_READ_RETRY_LIMIT = 50;
const CONTROL_READ_RETRY_DELAY_MS = 10;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function bridgeDaemonDescriptorPath(env = process.env) {
  return path.join(bridgeConfigPaths(env).root, 'bridge-daemon.json');
}

export function bridgeDaemonActiveMarkerPath(env = process.env) {
  return path.join(bridgeConfigPaths(env).root, 'bridge-daemon-active.json');
}

function bridgeStopPaths(env) {
  const root = bridgeConfigPaths(env).root;
  return { request: path.join(root, 'bridge-stop-request.json'),
    receipt: path.join(root, 'bridge-stop-receipt.json') };
}

export async function removeBridgeDaemonDescriptor({ env = process.env } = {}) {
  await rm(bridgeDaemonDescriptorPath(env), { force: true });
}

export async function removeBridgeDaemonActiveMarker({ env = process.env } = {}) {
  await rm(bridgeDaemonActiveMarkerPath(env), { force: true });
}

async function atomicDescriptor(ref, value) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    for (let attempt = 0;; attempt += 1) {
      try { await rename(temporary, ref); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)
          || attempt >= CONTROL_READ_RETRY_LIMIT - 1) throw error;
        await sleep(CONTROL_READ_RETRY_DELAY_MS);
      }
    }
    await chmod(ref, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

function duplicateJsonKey(node) {
  if (node?.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const [key, child] = property.children ?? [];
      if (keys.has(key?.value) || duplicateJsonKey(child)) return true;
      keys.add(key?.value);
    }
  } else if (node?.type === 'array') return (node.children ?? []).some(duplicateJsonKey);
  return false;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

/** 読み取り中の差し替え・消失につけるmarker。内容の異常と同じ顔をさせない。 */
const CONTROL_READ_RACE = Symbol('bridge_control_read_race');

function controlReadRace(message) {
  const error = new Error(message);
  error[CONTROL_READ_RACE] = true;
  return error;
}

async function readStrictJsonOnce(ref, label) {
  let before;
  let handle;
  try {
    before = await lstat(ref);
    // Windows has no POSIX permission-bit model — see bridge-config.mjs's
    // readDocument for the same guard and the real-host verification.
    if (!before.isFile() || before.isSymbolicLink()
      || (process.platform !== 'win32' && (before.mode & 0o777) !== 0o600)
      || before.size > CONTROL_MAX_BYTES) throw new Error(`${label} unsafe`);
    handle = await open(ref, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > CONTROL_MAX_BYTES) {
      throw controlReadRace(`${label} changed during validation`);
    }
    const text = await handle.readFile('utf8');
    // `open`が成功した時点で、このfdは検証済みinodeを指している。書き手はtemp fileへ
    // 書き切ってからrenameするので、そのinodeの内容は完結していて後から変わらない。
    // つまり**読んでいる最中にpathが差し替わっても、読み取った内容は正しいsnapshotである**。
    // ここでinodeの差し替えを失敗にすると、正しい読みを競合として捨てることになり、
    // 書き手が連続publishしている間は何度再試行しても抜けられない（Linux CIで実測）。
    //
    // 一方、**同じinodeのまま**sizeが変わったのは、atomicでない書き込みか改変であり、
    // 完結した内容を読んだ保証が無い。こちらは競合として再読する。
    const after = await lstat(ref).catch(() => null);
    if (after !== null && after.dev === opened.dev && after.ino === opened.ino
      && after.size !== opened.size) {
      throw controlReadRace(`${label} mutated in place during read`);
    }
    const errors = [];
    const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
    if (errors.length > 0 || tree === undefined || duplicateJsonKey(tree)) {
      throw new Error(`${label} JSON invalid`);
    }
    return JSON.parse(text);
  } catch (error) {
    // 最初のlstatで無い＝未起動。読み始めた後に消えたのは停止との競合で、再読でnullへ落ち着く。
    if (error?.code === 'ENOENT') {
      if (before === undefined) return null;
      throw controlReadRace(`${label} removed during read`);
    }
    throw error;
  } finally { await handle?.close(); }
}

/**
 * 公開はatomic renameなので、読み手はinodeの差し替えに必ず出会う。差し替えを跨いだ読みは
 * 内容の異常ではなく再読で解ける競合であり、壊れたcontrol fileと同じerrorにしてはならない。
 *
 * 再試行するのは`CONTROL_READ_RACE`が付いた3条件だけである——検証中のinode／size変化、
 * 読み取り中の同一inode内でのsize変化、最初のlstat後の消失。最大`CONTROL_READ_RETRY_LIMIT`回、
 * `CONTROL_READ_RETRY_DELAY_MS`基準のjitter付きbackoffで再読し、超えたらtyped errorで落とす。
 * **読み終えた後のinode差し替えは競合ではない**——読んだ内容は完結したsnapshotだからである。
 * JSON不正・schema不正・mode不正は競合ではないので一度も再試行せず即fail closedにする。
 */
async function readStrictJson(ref, code, label) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readStrictJsonOnce(ref, label);
    } catch (error) {
      if (error?.[CONTROL_READ_RACE] !== true || attempt >= CONTROL_READ_RETRY_LIMIT) {
        throw new BridgeConfigError(code, `${label} invalid`, undefined, error);
      }
      // 固定間隔だと、周期的に書き換える相手と歩調が揃って毎回衝突しうる。ばらつかせる。
      const backoff = CONTROL_READ_RETRY_DELAY_MS * (attempt + 1) * (1 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

async function readStrictControl(ref, schema, keys) {
  const value = await readStrictJson(ref, 'BRIDGE_STOP_CONTROL_INVALID', 'bridge stop control');
  if (value === null) return null;
  const timestampKey = keys.find((key) => key.endsWith('_at'));
  if (value?.schema !== schema || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
    || keys.includes('nonce')
      && (typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/u.test(value.nonce))
    || keys.includes('address') && isIP(value.address) === 0
    || keys.includes('port')
      && (!Number.isSafeInteger(value.port) || value.port < BRIDGE_PORT_MIN || value.port > BRIDGE_PORT_MAX)
    || timestampKey === undefined || !isIsoTimestamp(value[timestampKey])) {
    throw new BridgeConfigError('BRIDGE_STOP_CONTROL_INVALID', 'bridge stop control schema invalid');
  }
  return value;
}

async function readBridgeDaemonActiveMarker(env) {
  return (await readStrictControl(bridgeDaemonActiveMarkerPath(env), ACTIVE_MARKER_SCHEMA,
    ['schema', 'address', 'port', 'started_at']));
}

export async function readBridgeStopRequest({ env = process.env } = {}) {
  return readStrictControl(bridgeStopPaths(env).request, STOP_REQUEST_SCHEMA,
    ['schema', 'nonce', 'requested_at']);
}

export async function writeBridgeStopReceipt({ nonce, env = process.env }) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/u.test(nonce)) {
    throw new BridgeConfigError('BRIDGE_STOP_CONTROL_INVALID', 'bridge stop nonce invalid');
  }
  await atomicDescriptor(bridgeStopPaths(env).receipt, {
    schema: STOP_RECEIPT_SCHEMA, nonce, stopped_at: new Date().toISOString(),
  });
}

export async function clearBridgeStopControl({ env = process.env } = {}) {
  const refs = bridgeStopPaths(env);
  await rm(refs.request, { force: true });
  await rm(refs.receipt, { force: true });
}

export async function requestBridgeDaemonStop({ env = process.env, listen = null } = {}) {
  let descriptor = null;
  try { descriptor = await readBridgeDaemonDescriptor({ env }); } catch {}
  let config = null;
  try { config = await readBridgeConfig({ env }); } catch (error) {
    if (!['BRIDGE_CONFIG_INVALID', 'BRIDGE_CONFIG_MODE_INVALID'].includes(error?.code)) throw error;
  }
  if (descriptor !== null && await attestKnownBinding(descriptor, config) === null
    && !await bridgeEndpointAvailable({ address: descriptor.address, port: descriptor.port })) {
    return { state: 'not_running', nonce: null };
  }
  if (descriptor === null) {
    const refs = bridgeStopPaths(env);
    let descriptorExists = true;
    try { await lstat(bridgeDaemonDescriptorPath(env)); } catch (error) {
      if (error?.code === 'ENOENT') descriptorExists = false;
    }
    let activeMarker;
    let activeMarkerInvalid = false;
    try { activeMarker = await readBridgeDaemonActiveMarker(env); } catch (error) {
      if (error?.code !== 'BRIDGE_STOP_CONTROL_INVALID') throw error;
      activeMarkerInvalid = true;
      activeMarker = null;
    }
    if (!descriptorExists) {
      const witnessedListen = activeMarker === null ? listen : activeMarker;
      if (!activeMarkerInvalid
        && (witnessedListen === null || !await bridgeEndpointAvailable(witnessedListen))) {
        return { state: 'not_running', nonce: null };
      }
    }
  }
  const refs = bridgeStopPaths(env);
  const nonce = randomBytes(32).toString('hex');
  await rm(refs.receipt, { force: true });
  await atomicDescriptor(refs.request, {
    schema: STOP_REQUEST_SCHEMA, nonce, requested_at: new Date().toISOString(),
  });
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const receipt = await readStrictControl(refs.receipt, STOP_RECEIPT_SCHEMA,
      ['schema', 'nonce', 'stopped_at']);
    if (receipt?.nonce === nonce) return { state: 'stopped', nonce };
  }
  throw new BridgeConfigError('BRIDGE_DAEMON_STOP_FAILED', 'bridge daemon stop receipt timed out');
}

export async function writeBridgeDaemonDescriptor({ config, binding = config?.listen, identity = null,
  env = process.env } = {}) {
  const instanceToken = identity?.instance_token ?? env.LATTICE_BRIDGE_INSTANCE_TOKEN;
  if (typeof instanceToken !== 'string' || !/^[0-9a-f]{64}$/u.test(instanceToken)) {
    throw new BridgeConfigError('BRIDGE_INSTANCE_TOKEN_INVALID', 'bridge instance token is invalid');
  }
  if (isIP(binding?.address) === 0 || !Number.isSafeInteger(binding?.port)
    || binding.port < BRIDGE_PORT_MIN || binding.port > BRIDGE_PORT_MAX
    || !Number.isSafeInteger(identity?.pid ?? process.pid) || (identity?.pid ?? process.pid) <= 0
    || identity !== null && !isIsoTimestamp(identity.started_at)) {
    throw new BridgeConfigError('BRIDGE_DAEMON_DESCRIPTOR_INVALID', 'bridge daemon descriptor identity is invalid');
  }
  const descriptor = { schema: DESCRIPTOR_SCHEMA, pid: identity?.pid ?? process.pid,
    address: binding.address, port: binding.port,
    config_updated_at: config.updated_at, instance_token: instanceToken,
    started_at: identity?.started_at ?? new Date().toISOString() };
  await atomicDescriptor(bridgeDaemonDescriptorPath(env), descriptor);
  await atomicDescriptor(bridgeDaemonActiveMarkerPath(env), {
    schema: ACTIVE_MARKER_SCHEMA, address: descriptor.address, port: descriptor.port,
    started_at: descriptor.started_at,
  });
  return descriptor;
}

export async function readBridgeDaemonDescriptor({ env = process.env } = {}) {
  const value = await readStrictJson(bridgeDaemonDescriptorPath(env),
    'BRIDGE_DAEMON_DESCRIPTOR_INVALID', 'bridge daemon descriptor');
  if (value === null) return null;
  if (value?.schema !== DESCRIPTOR_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.address !== 'string' || isIP(value.address) === 0
    || !Number.isSafeInteger(value.port) || value.port < BRIDGE_PORT_MIN || value.port > BRIDGE_PORT_MAX
    || !isIsoTimestamp(value.config_updated_at) || !isIsoTimestamp(value.started_at)
    || typeof value.instance_token !== 'string' || !/^[0-9a-f]{64}$/u.test(value.instance_token)
    || Object.keys(value).sort().join(',')
      !== 'address,config_updated_at,instance_token,pid,port,schema,started_at') {
    throw new BridgeConfigError('BRIDGE_DAEMON_DESCRIPTOR_INVALID', 'bridge daemon descriptor schema invalid');
  }
  return value;
}

function healthHost(address) {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

async function bridgeEndpointAvailable(listen) {
  try {
    const response = await fetch(`http://${healthHost(listen.address)}:${listen.port}/__lattice/bridge-health`,
      { signal: AbortSignal.timeout(300) });
    const body = response.status === 200 ? await response.json() : null;
    return body?.schema === 'lattice.bridge_health.v1';
  } catch { return false; }
}

export async function waitForBridgeSocketClose({ listen, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  if (listen === null || typeof listen !== 'object') throw new TypeError('bridge listen required');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await bridgeEndpointAvailable(listen)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !await bridgeEndpointAvailable(listen);
}

async function attest(descriptor, { address = descriptor?.address } = {}) {
  if (descriptor === null) return null;
  try {
    const response = await fetch(`http://${healthHost(address)}:${descriptor.port}/__lattice/bridge-health`, {
      headers: { 'x-lattice-bridge-instance-token': descriptor.instance_token },
      signal: AbortSignal.timeout(400),
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    return body?.schema === 'lattice.bridge_health.v1' && body.pid === descriptor.pid ? body : null;
  } catch { return null; }
}

function currentBinding(config, interfaces = networkInterfaces()) {
  if (config === null || config.enabled !== true) return null;
  const address = resolveBridgeListenAddress({ configured: config.listen.address, interfaces }).effective;
  return address === null ? null : { address, port: config.listen.port };
}

async function attestCurrentBinding(descriptor, config, { interfaces = networkInterfaces() } = {}) {
  const binding = currentBinding(config, interfaces);
  if (descriptor === null || binding === null || descriptor.port !== binding.port) return null;
  const body = await attest(descriptor, { address: binding.address });
  return body === null ? null : { body, binding };
}

// 設定変更から次のreconcileまでの間は、旧socketだけが本人確認に応答することがある。
// 現在の待受に続いてdescriptorの既知の宛先を確認し、instance tokenによる本人確認を保つ。
async function attestKnownBinding(descriptor, config, options = {}) {
  const current = await attestCurrentBinding(descriptor, config, options);
  if (current !== null) return current;
  const body = await attest(descriptor);
  return body === null ? null : { body,
    binding: { address: descriptor.address, port: descriptor.port } };
}

const UNIDENTIFIED_RUNTIME = Object.freeze({ pid: null, version: null, node_path: null,
  node_version: null, bridge_path: null, last_heartbeat: null });

/**
 * Who is actually serving right now — pid, product version, node binary — as
 * reported by the running process itself over its attested health endpoint,
 * not as recorded by any file. This is the only way to see that a daemon is
 * executing code or a node binary that no longer matches what a restart would
 * pick up. A malformed descriptor is reported as its own state rather than
 * thrown: this feeds `lattice bridge status`, the command an operator reaches
 * for precisely when something is already broken.
 */
export async function readBridgeRuntimeIdentity({ env = process.env, interfaces = networkInterfaces() } = {}) {
  let descriptor;
  try { descriptor = await readBridgeDaemonDescriptor({ env }); } catch (error) {
    if (error?.code !== 'BRIDGE_DAEMON_DESCRIPTOR_INVALID') throw error;
    return { ...UNIDENTIFIED_RUNTIME, state: 'descriptor_invalid' };
  }
  if (descriptor === null) return { ...UNIDENTIFIED_RUNTIME, state: 'not_running' };
  // 旧版daemonはDHCP移動後も設定IPをdescriptorへ残す。
  // serverと共通の同一subnet条件で現在の待受を解決してから本人確認する。
  let config = null;
  try {
    config = await readBridgeConfig({ env });
  } catch (error) {
    if (!['BRIDGE_CONFIG_INVALID', 'BRIDGE_CONFIG_MODE_INVALID'].includes(error?.code)) throw error;
  }
  const body = (await attestKnownBinding(descriptor, config, { interfaces }))?.body ?? null;
  if (body === null) return { ...UNIDENTIFIED_RUNTIME, state: 'unattested', pid: descriptor.pid };
  const text = (value) => (typeof value === 'string' ? value : null);
  return { state: 'running', pid: descriptor.pid, version: text(body.version),
    node_path: text(body.node_path), node_version: text(body.node_version),
    bridge_path: text(body.bridge_path),
    // Absent from daemons older than 0.55.2 — null then means "this daemon does
    // not report it", not "the hub accepted everything".
    last_heartbeat: body.last_heartbeat ?? null };
}

async function healthy(descriptor, config, options = {}) {
  const attested = await attestCurrentBinding(descriptor, config, options);
  return attested !== null && attested.body.updated_at === config.updated_at ? attested : null;
}

async function preserveHealthyDescriptor(descriptor, config, options) {
  const attested = await healthy(descriptor, config, options);
  if (attested === null) return null;
  if (descriptor.address === attested.binding.address && descriptor.port === attested.binding.port) return descriptor;
  return writeBridgeDaemonDescriptor({ config, binding: attested.binding, identity: descriptor, env: options.env });
}

export async function ensureBridgeDaemon({ env = process.env, interfaces = networkInterfaces(),
  spawnDaemon = spawn } = {}) {
  const config = await readBridgeConfig({ env });
  if (config === null || !config.enabled) throw new BridgeConfigError('BRIDGE_DISABLED', 'bridge is disabled');
  const previous = await readBridgeDaemonDescriptor({ env });
  const options = { env, interfaces };
  const alreadyHealthy = await preserveHealthyDescriptor(previous, config, options);
  if (alreadyHealthy !== null) return alreadyHealthy;
  if (previous !== null && previous.port === config.listen.port
    && await attestKnownBinding(previous, config, options) !== null) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const reconciled = await readBridgeDaemonDescriptor({ env });
      if (reconciled?.pid === previous.pid) {
        const healthyDescriptor = await preserveHealthyDescriptor(reconciled, config, options);
        if (healthyDescriptor !== null) return healthyDescriptor;
      }
    }
    throw new BridgeConfigError('BRIDGE_DAEMON_UNAVAILABLE',
      'existing bridge daemon did not reconcile the updated config');
  }
  const instanceToken = randomBytes(32).toString('hex');
  const child = spawnDaemon(process.execPath, [path.resolve(import.meta.dirname, '../bin/lattice-bridge.mjs')], {
    detached: true, stdio: 'ignore', env: { ...env, LATTICE_BRIDGE_INSTANCE_TOKEN: instanceToken },
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descriptor = await readBridgeDaemonDescriptor({ env });
    const healthyDescriptor = await preserveHealthyDescriptor(descriptor, config, options);
    if (healthyDescriptor !== null) {
      if (previous !== null && previous.pid !== descriptor.pid) {
        if (await attestCurrentBinding(previous, config, options) !== null) {
          try { process.kill(previous.pid, 'SIGTERM'); } catch {}
        }
      }
      return healthyDescriptor;
    }
  }
  throw new BridgeConfigError('BRIDGE_DAEMON_UNAVAILABLE', 'bridge daemon did not bind and become healthy');
}

export async function stopBridgeDaemon({ env = process.env, interfaces = networkInterfaces() } = {}) {
  const descriptor = await readBridgeDaemonDescriptor({ env });
  if (descriptor === null) return null;
  let config = null;
  try { config = await readBridgeConfig({ env }); } catch (error) {
    if (!['BRIDGE_CONFIG_INVALID', 'BRIDGE_CONFIG_MODE_INVALID'].includes(error?.code)) throw error;
  }
  if (await attestKnownBinding(descriptor, config, { interfaces }) === null) {
    let alive = true;
    try { process.kill(descriptor.pid, 0); } catch { alive = false; }
    if (!alive) {
      await rm(bridgeDaemonDescriptorPath(env), { force: true });
      await removeBridgeDaemonActiveMarker({ env });
      return descriptor;
    }
    throw new BridgeConfigError('BRIDGE_DAEMON_ATTESTATION_FAILED',
      'bridge daemon identity could not be attested; refusing to signal descriptor PID');
  }
  try { process.kill(descriptor.pid, 'SIGTERM'); } catch (error) {
    if (error?.code !== 'ESRCH') throw new BridgeConfigError('BRIDGE_DAEMON_STOP_FAILED', 'bridge daemon signal failed');
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let alive = true;
    try { process.kill(descriptor.pid, 0); } catch { alive = false; }
    if (!alive) {
      await rm(bridgeDaemonDescriptorPath(env), { force: true });
      await removeBridgeDaemonActiveMarker({ env });
      return descriptor;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new BridgeConfigError('BRIDGE_DAEMON_STOP_FAILED', 'bridge daemon did not stop');
}

const PACKAGE_JSON_PATH = path.resolve(import.meta.dirname, '../package.json');

/**
 * Whether the on-disk package.json now reports a different version than the
 * one this running process loaded at start — i.e. `npm install`/`update`
 * replaced the files under a still-running daemon (the "daemon の版持ち"
 * trap, AGENTS.md: a daemon keeps serving whatever module it imported at
 * startup no matter what gets installed afterward). A long-running process
 * cannot hot-swap its own already-imported modules; the only fix is to exit
 * and let whatever supervises it (launchd's KeepAlive, the Windows
 * supervisor's restart loop) relaunch a fresh process that imports the new
 * code. Read failures return `false` — an unrelated fs hiccup must not force
 * a restart loop.
 */
export async function bridgeDaemonVersionDrifted({ packageJsonPath = PACKAGE_JSON_PATH } = {}) {
  let onDisk;
  try {
    onDisk = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch { return false; }
  return typeof onDisk?.version === 'string' && onDisk.version !== packageJson.version;
}
