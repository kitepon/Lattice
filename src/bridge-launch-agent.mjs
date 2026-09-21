import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BridgeConfigError, readBridgeConfig } from './bridge-config.mjs';
import { readBridgeDaemonDescriptor } from './bridge-daemon.mjs';
import { DEFAULT_BRIDGE_PATH, stableNodePath } from './bridge-executable.mjs';
import { bridgeRegistrarSettings } from './bridge-registrar.mjs';

export const BRIDGE_LAUNCH_AGENT_LABEL = 'dev.kitepon.lattice.bridge';
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
// launchd の default ExitTimeOut は 5 秒。bootout の exit 0 はその前に返り、
// label が domain から消えるのは process が落ちた後である。
const UNLOAD_TIMEOUT_MS = 8_000;
const execFileAsync = promisify(execFile);

function fail(code, message, cause = undefined, detail = undefined) {
  return new BridgeConfigError(code, message, detail, cause);
}

function userId() {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw fail('BRIDGE_LAUNCH_AGENT_UID_INVALID', 'current user id is unavailable');
  }
  return uid;
}

export function bridgeLaunchAgentPaths(env = process.env) {
  const home = env.HOME;
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw fail('BRIDGE_LAUNCH_AGENT_HOME_INVALID', 'HOME must be an absolute path');
  }
  const directory = path.join(home, 'Library', 'LaunchAgents');
  return Object.freeze({ directory,
    plist: path.join(directory, `${BRIDGE_LAUNCH_AGENT_LABEL}.plist`) });
}

async function prepareDirectory(directory, uid = userId()) {
  const home = path.dirname(path.dirname(directory));
  const library = path.dirname(directory);
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const ref of [home, library, directory]) {
    await mkdir(ref, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    const stats = await lstat(ref);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid
      || (stats.mode & 0o022) !== 0) {
      throw fail('BRIDGE_LAUNCH_AGENT_DIR_UNSAFE', 'LaunchAgents path is unsafe');
    }
  }
}

async function strictPlist(ref, uid = userId()) {
  let before;
  let handle;
  try {
    before = await lstat(ref);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid
      || (before.mode & 0o777) !== 0o600 || before.size > 65_536) {
      throw new Error('unsafe plist');
    }
    handle = await open(ref, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== uid || opened.dev !== before.dev
      || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('plist changed during validation');
    }
    const content = await handle.readFile('utf8');
    const after = await lstat(ref);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('plist changed during read');
    }
    return content;
  } catch (error) {
    if (error?.code === 'ENOENT' && before === undefined) return null;
    throw fail('BRIDGE_LAUNCH_AGENT_PLIST_UNSAFE', 'bridge LaunchAgent plist is unsafe', error);
  } finally {
    await handle?.close();
  }
}

async function atomicPlist(ref, content) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, ref);
    await chmod(ref, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function executablePath(ref, label, { executable = true, uid = userId() } = {}) {
  if (typeof ref !== 'string' || !path.isAbsolute(ref)) {
    throw fail('BRIDGE_LAUNCH_AGENT_EXECUTABLE_INVALID', `${label} path must be absolute`);
  }
  let resolved;
  let stats;
  try {
    resolved = await realpath(ref);
    stats = await lstat(resolved);
  } catch (error) {
    throw fail('BRIDGE_LAUNCH_AGENT_EXECUTABLE_INVALID', `${label} is unavailable`, error);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || ![0, uid].includes(stats.uid)
    || (stats.mode & 0o022) !== 0
    || executable && (stats.mode & 0o111) === 0) {
    throw fail('BRIDGE_LAUNCH_AGENT_EXECUTABLE_INVALID', `${label} is unsafe`);
  }
  return resolved;
}

function plistDocument({ nodePath, bridgePath, instanceToken, env }) {
  const environment = [['LATTICE_BRIDGE_INSTANCE_TOKEN', instanceToken]];
  if (env.LATTICE_CONFIG_DIR !== undefined) {
    if (typeof env.LATTICE_CONFIG_DIR !== 'string' || !path.isAbsolute(env.LATTICE_CONFIG_DIR)) {
      throw fail('BRIDGE_CONFIG_DIR_INVALID', 'LATTICE_CONFIG_DIR must be absolute');
    }
    environment.push(['LATTICE_CONFIG_DIR', env.LATTICE_CONFIG_DIR]);
  }
  // The daemon registers its upstream on every new binding, but only if it can
  // see the registrar settings. launchd does not inherit the shell environment,
  // so without baking them in here the self-registration silently never fires —
  // which is exactly the kind of quiet non-recovery this whole path exists to
  // remove. `bridgeRegistrarSettings` rejects a half-configured pair rather than
  // installing an agent that would skip registration forever.
  const registrar = bridgeRegistrarSettings(env);
  if (registrar !== null) {
    environment.push(['LATTICE_BRIDGE_REGISTRAR_SSH_HOST', registrar.host]);
    environment.push(['LATTICE_BRIDGE_REGISTRAR_SCRIPT', registrar.script]);
  }
  const environmentXml = environment.map(([key, value]) =>
    `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(bridgePath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

export async function defaultLaunchctlRunner(args) {
  try {
    const result = await execFileAsync('/bin/launchctl', args, { encoding: 'utf8' });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw fail('BRIDGE_LAUNCHCTL_UNAVAILABLE', 'launchctl could not be executed', error);
  }
}

function domain(uid) { return `gui/${uid}`; }
function service(uid) { return `${domain(uid)}/${BRIDGE_LAUNCH_AGENT_LABEL}`; }

function launchctlDetail(result) {
  const stderr = typeof result?.stderr === 'string' ? result.stderr.trim() : '';
  return {
    launchctl_code: Number.isInteger(result?.code) ? result.code : null,
    stderr: stderr.length > 0 ? stderr.slice(0, 1_024) : null,
  };
}

async function launchctl(runner, args, code, message, accepted = [0]) {
  let result;
  try { result = await runner(args); } catch (error) {
    if (error instanceof BridgeConfigError) throw error;
    throw fail(code, message, error);
  }
  if (!result || !Number.isInteger(result.code) || !accepted.includes(result.code)) {
    throw fail(code, message, undefined, launchctlDetail(result));
  }
  return result;
}

async function loadedState(runner, uid) {
  const result = await launchctl(runner, ['print', service(uid)],
    'BRIDGE_LAUNCHCTL_STATUS_FAILED', 'could not inspect bridge LaunchAgent', [0, 113]);
  return result.code === 0;
}

function healthHost(address) {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

export async function waitForBridgeLaunchAgentReady({ config, instanceToken, env, timeoutMs = START_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const descriptor = await readBridgeDaemonDescriptor({ env });
    if (descriptor?.port === config.listen.port && descriptor?.config_updated_at === config.updated_at) {
      try {
        const response = await fetch(
          `http://${healthHost(descriptor.address)}:${descriptor.port}/__lattice/bridge-health`, {
            headers: { 'x-lattice-bridge-instance-token': instanceToken },
            signal: AbortSignal.timeout(400),
          });
        const body = response.status === 200 ? await response.json() : null;
        if (body?.schema === 'lattice.bridge_health.v1' && body.pid === descriptor.pid
          && body.address === descriptor.address && body.port === descriptor.port
          && body.updated_at === config.updated_at) return descriptor;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw fail('BRIDGE_LAUNCH_AGENT_START_FAILED', 'bridge LaunchAgent did not become healthy');
}

async function defaultWaitStopped({ listen, timeoutMs = STOP_TIMEOUT_MS }) {
  if (listen === null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${healthHost(listen.address)}:${listen.port}/__lattice/bridge-health`,
        { signal: AbortSignal.timeout(300) });
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw fail('BRIDGE_LAUNCH_AGENT_STOP_FAILED', 'bridge LaunchAgent socket did not stop');
}

export async function snapshotBridgeLaunchAgent({ env = process.env,
  runner = defaultLaunchctlRunner, uid = userId() } = {}) {
  const refs = bridgeLaunchAgentPaths(env);
  await prepareDirectory(refs.directory, uid);
  const content = await strictPlist(refs.plist, uid);
  const loaded = await loadedState(runner, uid);
  const split = loaded && content === null;
  return Object.freeze({ installed: content !== null, loaded, split, content });
}

const PROGRAM_ARGUMENTS_PATTERN =
  /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/u;

/** Inverse of `xml`, innermost-last so an escaped `&amp;lt;` survives intact. */
function unxml(value) {
  return value.replaceAll('&apos;', "'").replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

async function pathPresent(ref) {
  if (typeof ref !== 'string') return false;
  try { await stat(ref); return true; } catch { return false; }
}

/**
 * What the installed plist actually tells launchd to run, and whether those
 * paths still exist. A LaunchAgent whose ProgramArguments point at a deleted
 * binary is the product's worst failure mode: KeepAlive keeps respinning it,
 * nothing logs, and the only visible symptom is a terminal missing from the
 * published view. Reporting it here is what turns that into an answer
 * `lattice bridge status` can give in one call.
 */
export async function describeBridgeLaunchAgent({ snapshot } = {}) {
  if (snapshot?.installed !== true) return null;
  const match = typeof snapshot.content === 'string'
    ? snapshot.content.match(PROGRAM_ARGUMENTS_PATTERN) : null;
  const nodePath = match === null ? null : unxml(match[1]);
  const bridgePath = match === null ? null : unxml(match[2]);
  return {
    node_path: nodePath, node_exists: await pathPresent(nodePath),
    bridge_path: bridgePath, bridge_exists: await pathPresent(bridgePath),
  };
}

async function waitUnloaded({ runner, uid, timeoutMs = UNLOAD_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!await loadedState(runner, uid)) return;
    if (Date.now() >= deadline) {
      throw fail('BRIDGE_LAUNCHCTL_BOOTOUT_FAILED', 'bridge LaunchAgent did not unload');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function bootoutIfLoaded({ runner, uid }) {
  if (!await loadedState(runner, uid)) return false;
  await launchctl(runner, ['bootout', service(uid)], 'BRIDGE_LAUNCHCTL_BOOTOUT_FAILED',
    'could not stop bridge LaunchAgent');
  // bootout の exit 0 は unload 受付だけである。label が残ったまま bootstrap すると
  // launchd は 5 Input/output error を返す（2026-08-19 実測。print が 113 になって
  // から bootstrap すれば通る）。
  await waitUnloaded({ runner, uid });
  return true;
}

export async function installBridgeLaunchAgent({ config, env = process.env,
  runner = defaultLaunchctlRunner, uid = userId(), nodePath = process.execPath,
  bridgePath = DEFAULT_BRIDGE_PATH,
  waitReady = waitForBridgeLaunchAgentReady, waitStopped = defaultWaitStopped,
  stableNode = stableNodePath, previousListen = null } = {}) {
  if (config?.enabled !== true) throw fail('BRIDGE_DISABLED', 'bridge is disabled');
  const refs = bridgeLaunchAgentPaths(env);
  await prepareDirectory(refs.directory, uid);
  await strictPlist(refs.plist, uid);
  // The safety checks run against the real binary; what goes into the plist is
  // a stable alias for it when one can be verified, so a version-manager
  // upgrade cannot delete the path launchd was told to exec. See
  // bridge-executable.mjs for why the alias is not additionally permission-checked.
  const resolvedNode = await executablePath(nodePath, 'node executable', { uid });
  const bakedNode = await stableNode({ resolved: resolvedNode, env });
  const resolvedBridge = await executablePath(bridgePath, 'bridge executable', { executable: false, uid });
  const instanceToken = randomBytes(32).toString('hex');
  const content = plistDocument({ nodePath: bakedNode, bridgePath: resolvedBridge, instanceToken, env });
  const stopped = await bootoutIfLoaded({ runner, uid });
  if (stopped) await waitStopped({ listen: previousListen, env });
  await atomicPlist(refs.plist, content);
  await launchctl(runner, ['bootstrap', domain(uid), refs.plist],
    'BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED', 'could not start bridge LaunchAgent');
  return waitReady({ config, instanceToken, env });
}

export async function disableBridgeLaunchAgent({ snapshot, listen, env = process.env,
  runner = defaultLaunchctlRunner, uid = userId(), waitStopped = defaultWaitStopped } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean' || typeof snapshot.loaded !== 'boolean') {
    throw new TypeError('bridge LaunchAgent snapshot required');
  }
  const refs = bridgeLaunchAgentPaths(env);
  if (snapshot.loaded) {
    await bootoutIfLoaded({ runner, uid });
    await waitStopped({ listen, env });
  }
  await rm(refs.plist, { force: true });
  return { removed: snapshot.installed, stopped: snapshot.loaded };
}

export async function restoreBridgeLaunchAgent({ snapshot, listen = null, env = process.env,
  runner = defaultLaunchctlRunner, uid = userId(), waitStopped = defaultWaitStopped,
  config = undefined, waitReady = waitForBridgeLaunchAgentReady } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean' || typeof snapshot.loaded !== 'boolean'
    || (snapshot.installed && typeof snapshot.content !== 'string')) {
    throw new TypeError('bridge LaunchAgent snapshot required');
  }
  const refs = bridgeLaunchAgentPaths(env);
  await prepareDirectory(refs.directory, uid);
  const stopped = await bootoutIfLoaded({ runner, uid });
  if (stopped) await waitStopped({ listen, env });
  if (snapshot.split === true) {
    await rm(refs.plist, { force: true });
    return snapshot;
  }
  if (snapshot.installed) await atomicPlist(refs.plist, snapshot.content);
  else await rm(refs.plist, { force: true });
  if (snapshot.loaded) {
    await launchctl(runner, ['bootstrap', domain(uid), refs.plist],
      'BRIDGE_LAUNCHCTL_ROLLBACK_FAILED', 'could not restore bridge LaunchAgent');
    const restoredConfig = config ?? await readBridgeConfig({ env });
    const tokenMatch = snapshot.content.match(
      /<key>LATTICE_BRIDGE_INSTANCE_TOKEN<\/key>\s*<string>([0-9a-f]{64})<\/string>/u);
    if (restoredConfig?.enabled !== true || tokenMatch === null) {
      throw fail('BRIDGE_LAUNCHCTL_ROLLBACK_FAILED', 'restored bridge LaunchAgent is not attestable');
    }
    await waitReady({ config: restoredConfig, instanceToken: tokenMatch[1], env });
  }
  return snapshot;
}
