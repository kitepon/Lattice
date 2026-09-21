/**
 * Windows bridge persistence via the per-user Startup folder — the Windows
 * counterpart to `bridge-launch-agent.mjs`'s macOS LaunchAgent, with the same
 * public contract (`snapshot`/`install`/`disable`/`restore`) so `bridge-cli.mjs`
 * can select between them by `process.platform` without changing its own flow.
 *
 * Windows has no per-user analogue of launchd's KeepAlive supervision, and
 * Task Scheduler's `ONLOGON` trigger requires elevation this product's "no
 * ritual beyond one-time setup" bar cannot spend (verified empirically: both
 * `schtasks /Create /SC ONLOGON` and `Register-ScheduledTask -Trigger
 * (New-ScheduledTaskTrigger -AtLogOn)` return access-denied under a normal,
 * non-elevated user token). The Startup folder needs no elevation — writing
 * into `%APPDATA%\...\Startup` is an ordinary per-user file operation — but it
 * only *starts* something at logon; nothing supervises it afterward.
 *
 * `lattice-bridge-supervisor.mjs` supplies that supervision (spawn, wait for
 * exit, restart) in plain JS rather than a batch GOTO loop: a loop's own
 * process is awkward to track and kill reliably on Windows, while a Node
 * process's pid is not. The Startup-folder `.vbs` launcher runs the
 * supervisor hidden (`WindowStyle 0`) so no console window appears at logon
 * or at any crash-restart — the same class of bug the Windows-console-
 * avalanche P0 hotfix (`windowsHide`, 0.52.4) exists to avoid, here via a
 * different mechanism since this process tree is spawned by Windows logon
 * rather than by this codebase's own `child_process.spawn`. Stopping the
 * whole tree (supervisor + whatever bridge child it currently owns) uses
 * `taskkill /T /F /PID <supervisor pid>` — Windows's own recursive-kill,
 * since a forcibly-terminated supervisor gets no chance to clean up its own
 * child.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BridgeConfigError, readBridgeConfig } from './bridge-config.mjs';
import { readBridgeDaemonDescriptor } from './bridge-daemon.mjs';
import {
  DEFAULT_BRIDGE_PATH, DEFAULT_SUPERVISOR_PATH, stableNodePath,
} from './bridge-executable.mjs';
import { bridgeRegistrarSettings } from './bridge-registrar.mjs';

export const BRIDGE_STARTUP_LABEL = 'LatticeBridge';
const DESCRIPTOR_SCHEMA = 'lattice.bridge_supervisor_descriptor.v1';
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const execFileAsync = promisify(execFile);

function fail(code, message, cause = undefined) {
  return new BridgeConfigError(code, message, undefined, cause);
}

export function bridgeStartupFolderPaths(env = process.env) {
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  if (typeof appData !== 'string' || !path.isAbsolute(appData)) {
    throw fail('BRIDGE_STARTUP_FOLDER_APPDATA_INVALID', 'APPDATA must be an absolute path');
  }
  if (typeof localAppData !== 'string' || !path.isAbsolute(localAppData)) {
    throw fail('BRIDGE_STARTUP_FOLDER_APPDATA_INVALID', 'LOCALAPPDATA must be an absolute path');
  }
  // The launcher must live in the Startup folder — Windows only runs what it
  // finds there. Everything it launches lives in our own runtime directory
  // instead: Startup-folder contents are conventionally opaque shortcuts, and
  // keeping the real state (descriptor, pidfile) in a folder this module
  // fully owns keeps the safety checks below meaningful.
  const startupDirectory = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const runtimeDirectory = path.join(localAppData, 'Lattice', 'bridge-startup');
  return Object.freeze({
    startupDirectory, runtimeDirectory,
    launcher: path.join(startupDirectory, `${BRIDGE_STARTUP_LABEL}.vbs`),
    descriptor: path.join(runtimeDirectory, 'descriptor.json'),
    pidfile: path.join(runtimeDirectory, 'supervisor.pid'),
  });
}

async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw fail('BRIDGE_STARTUP_FOLDER_DIR_UNSAFE', 'startup folder path is unsafe');
  }
}

async function strictFile(ref, maxBytes = 65_536) {
  let before;
  let handle;
  try {
    before = await lstat(ref);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new Error('unsafe startup file');
    }
    handle = await open(ref, fsConstants.O_RDONLY);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) {
      throw new Error('startup file changed during validation');
    }
    const content = await handle.readFile('utf8');
    const after = await lstat(ref);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('startup file changed during read');
    }
    return content;
  } catch (error) {
    if (error?.code === 'ENOENT' && before === undefined) return null;
    throw fail('BRIDGE_STARTUP_FOLDER_FILE_UNSAFE', 'bridge startup file is unsafe', error);
  } finally {
    await handle?.close();
  }
}

async function atomicFile(ref, content) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, ref);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function executablePath(ref, label) {
  if (typeof ref !== 'string' || !path.isAbsolute(ref)) {
    throw fail('BRIDGE_STARTUP_FOLDER_EXECUTABLE_INVALID', `${label} path must be absolute`);
  }
  let resolved;
  let stats;
  try {
    resolved = await realpath(ref);
    stats = await lstat(resolved);
  } catch (error) {
    throw fail('BRIDGE_STARTUP_FOLDER_EXECUTABLE_INVALID', `${label} is unavailable`, error);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw fail('BRIDGE_STARTUP_FOLDER_EXECUTABLE_INVALID', `${label} is unsafe`);
  }
  return resolved;
}

/** VBS escapes an embedded `"` by doubling it. Paths we generate never
  * contain one (`executablePath`/our own runtime dir), so this only guards
  * against that invariant silently breaking rather than mis-escaping. */
function vbsQuoted(label, value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('"')) {
    throw fail('BRIDGE_STARTUP_FOLDER_VALUE_UNSAFE', `${label} is unsafe to embed in the startup launcher`);
  }
  return `"""${value}"""`;
}

function launcherScript({ nodePath, supervisorPath, descriptorPath }) {
  // WScript.Shell.Run(command, windowStyle, waitOnReturn). windowStyle 0 =
  // hidden, waitOnReturn False = fire-and-forget (the supervisor outlives
  // wscript.exe, which exits right after this call).
  const command = [vbsQuoted('node executable', nodePath), vbsQuoted('supervisor script', supervisorPath),
    vbsQuoted('descriptor path', descriptorPath)].join(' & " " & ');
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run ${command}, 0, False\r\n`;
}

function supervisorDescriptor({ bridgePath, pidfile, instanceToken, env }) {
  const forwarded = { LATTICE_BRIDGE_INSTANCE_TOKEN: instanceToken };
  if (env.LATTICE_CONFIG_DIR !== undefined) {
    if (typeof env.LATTICE_CONFIG_DIR !== 'string' || !path.isAbsolute(env.LATTICE_CONFIG_DIR)) {
      throw fail('BRIDGE_CONFIG_DIR_INVALID', 'LATTICE_CONFIG_DIR must be absolute');
    }
    forwarded.LATTICE_CONFIG_DIR = env.LATTICE_CONFIG_DIR;
  }
  // Same rationale as the LaunchAgent plist: nothing here inherits the
  // installer's shell environment at restart time, so registrar settings must
  // be baked in or self-registration silently never fires after a crash restart.
  const registrar = bridgeRegistrarSettings(env);
  if (registrar !== null) {
    forwarded.LATTICE_BRIDGE_REGISTRAR_SSH_HOST = registrar.host;
    forwarded.LATTICE_BRIDGE_REGISTRAR_SCRIPT = registrar.script;
  }
  return JSON.stringify({ schema: DESCRIPTOR_SCHEMA, bridgePath, pidPath: pidfile, env: forwarded });
}

export async function defaultStartupRunner(args) {
  try {
    const result = await execFileAsync(args[0], args.slice(1), { encoding: 'utf8', windowsHide: true });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (Number.isInteger(error?.code)) {
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw fail('BRIDGE_STARTUP_LAUNCHER_UNAVAILABLE', 'the startup launcher could not be executed', error);
  }
}

function healthHost(address) {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

export async function waitForBridgeStartupReady({ config, instanceToken, env, timeoutMs = START_TIMEOUT_MS }) {
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
  throw fail('BRIDGE_STARTUP_FOLDER_START_FAILED', 'bridge startup process did not become healthy');
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
  throw fail('BRIDGE_STARTUP_FOLDER_STOP_FAILED', 'bridge startup process socket did not stop');
}

export async function snapshotBridgeStartupFolder({ env = process.env } = {}) {
  const refs = bridgeStartupFolderPaths(env);
  await prepareDirectory(refs.startupDirectory);
  await prepareDirectory(refs.runtimeDirectory);
  const launcherContent = await strictFile(refs.launcher);
  const descriptorContent = await strictFile(refs.descriptor);
  const split = (launcherContent === null) !== (descriptorContent === null);
  return Object.freeze({ installed: launcherContent !== null && descriptorContent !== null,
    split, launcherContent, descriptorContent });
}

async function pathPresent(ref) {
  if (typeof ref !== 'string') return false;
  try { await stat(ref); return true; } catch { return false; }
}

/**
 * The Windows counterpart of `describeBridgeLaunchAgent`, reporting the same
 * shape: what the persisted launcher runs and whether it is still there. The
 * node path comes from the `.vbs` (first triple-quoted argument), the bridge
 * script from the supervisor descriptor that owns it.
 */
export async function describeBridgeStartupFolder({ snapshot } = {}) {
  if (snapshot?.installed !== true) return null;
  const quoted = typeof snapshot.launcherContent === 'string'
    ? [...snapshot.launcherContent.matchAll(/"""([^"]*)"""/gu)].map((match) => match[1]) : [];
  const nodePath = quoted.length > 0 ? quoted[0] : null;
  let bridgePath = null;
  try {
    const parsed = JSON.parse(snapshot.descriptorContent);
    if (typeof parsed?.bridgePath === 'string') bridgePath = parsed.bridgePath;
  } catch {}
  return {
    node_path: nodePath, node_exists: await pathPresent(nodePath),
    bridge_path: bridgePath, bridge_exists: await pathPresent(bridgePath),
  };
}

/** Read the supervisor's own recorded pid and kill its whole process tree
  * (`taskkill /T /F`) — a forcibly-terminated supervisor cannot clean up its
  * child itself, so the tree kill is what actually stops the bridge, not the
  * SIGTERM handler `lattice-bridge.mjs` relies on when Node manages it directly. */
async function stopRunning({ env, listen, runner, waitStopped }) {
  const refs = bridgeStartupFolderPaths(env);
  let pidText;
  try { pidText = await readFile(refs.pidfile, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw fail('BRIDGE_STARTUP_FOLDER_STOP_FAILED', 'could not read supervisor pidfile', error);
  }
  const pid = Number(pidText.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const result = await runner(['taskkill.exe', '/T', '/F', '/PID', String(pid)]);
  // Windowsの表示言語に依存せず、既に終了したプロセスを判定する。
  if (result.code !== 0) {
    let absent = false;
    try { process.kill(pid, 0); } catch (error) { absent = error?.code === 'ESRCH'; }
    if (!absent) {
      throw fail('BRIDGE_STARTUP_FOLDER_STOP_FAILED', 'could not stop bridge supervisor process tree');
    }
  }
  await waitStopped({ listen, env });
  await rm(refs.pidfile, { force: true });
}

export async function installBridgeStartupFolder({ config, env = process.env,
  runner = defaultStartupRunner, nodePath = process.execPath,
  bridgePath = DEFAULT_BRIDGE_PATH, supervisorPath = DEFAULT_SUPERVISOR_PATH,
  waitReady = waitForBridgeStartupReady, waitStopped = defaultWaitStopped,
  stableNode = stableNodePath, previousListen = null } = {}) {
  if (config?.enabled !== true) throw fail('BRIDGE_DISABLED', 'bridge is disabled');
  const refs = bridgeStartupFolderPaths(env);
  await prepareDirectory(refs.startupDirectory);
  await prepareDirectory(refs.runtimeDirectory);
  await strictFile(refs.launcher);
  await strictFile(refs.descriptor);
  // Same reasoning as the LaunchAgent: validate the real binary, bake a
  // verified stable alias for it. nvm-windows swaps the version behind the
  // `C:\Program Files\nodejs` junction exactly the way Homebrew swaps the
  // Cellar directory behind `/opt/homebrew/bin/node`.
  const resolvedNode = await executablePath(nodePath, 'node executable');
  const bakedNode = await stableNode({ resolved: resolvedNode, env });
  const resolvedBridge = await executablePath(bridgePath, 'bridge executable');
  const resolvedSupervisor = await executablePath(supervisorPath, 'supervisor executable');
  const instanceToken = randomBytes(32).toString('hex');
  const descriptorContent = supervisorDescriptor({
    bridgePath: resolvedBridge, pidfile: refs.pidfile, instanceToken, env,
  });
  await stopRunning({ env, listen: previousListen, runner, waitStopped });
  await atomicFile(refs.descriptor, descriptorContent);
  await atomicFile(refs.launcher,
    launcherScript({ nodePath: bakedNode, supervisorPath: resolvedSupervisor, descriptorPath: refs.descriptor }));
  await launch(runner, ['wscript.exe', refs.launcher], 'BRIDGE_STARTUP_LAUNCHER_FAILED',
    'could not start the bridge startup process');
  return waitReady({ config, instanceToken, env });
}

async function launch(runner, args, code, message) {
  let result;
  try { result = await runner(args); } catch (error) {
    if (error instanceof BridgeConfigError) throw error;
    throw fail(code, message, error);
  }
  if (!result || result.code !== 0) throw fail(code, message);
  return result;
}

export async function disableBridgeStartupFolder({ snapshot, listen, env = process.env,
  runner = defaultStartupRunner, waitStopped = defaultWaitStopped } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean') {
    throw new TypeError('bridge startup folder snapshot required');
  }
  const refs = bridgeStartupFolderPaths(env);
  const stopped = snapshot.installed;
  if (stopped) await stopRunning({ env, listen, runner, waitStopped });
  await rm(refs.launcher, { force: true });
  await rm(refs.descriptor, { force: true });
  return { removed: snapshot.installed, stopped };
}

export async function restoreBridgeStartupFolder({ snapshot, listen = null, env = process.env,
  runner = defaultStartupRunner, waitStopped = defaultWaitStopped,
  config = undefined, waitReady = waitForBridgeStartupReady } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean'
    || (snapshot.installed
      && (typeof snapshot.launcherContent !== 'string' || typeof snapshot.descriptorContent !== 'string'))) {
    throw new TypeError('bridge startup folder snapshot required');
  }
  const refs = bridgeStartupFolderPaths(env);
  await prepareDirectory(refs.startupDirectory);
  await prepareDirectory(refs.runtimeDirectory);
  await stopRunning({ env, listen, runner, waitStopped });
  if (snapshot.installed) {
    await atomicFile(refs.descriptor, snapshot.descriptorContent);
    await atomicFile(refs.launcher, snapshot.launcherContent);
    await launch(runner, ['wscript.exe', refs.launcher], 'BRIDGE_STARTUP_ROLLBACK_FAILED',
      'could not restore the bridge startup process');
    const restoredConfig = config ?? await readBridgeConfig({ env });
    let tokenMatch = null;
    try { tokenMatch = JSON.parse(snapshot.descriptorContent).env?.LATTICE_BRIDGE_INSTANCE_TOKEN ?? null; }
    catch { tokenMatch = null; }
    if (restoredConfig?.enabled !== true || typeof tokenMatch !== 'string' || !/^[0-9a-f]{64}$/u.test(tokenMatch)) {
      throw fail('BRIDGE_STARTUP_ROLLBACK_FAILED', 'restored bridge startup process is not attestable');
    }
    await waitReady({ config: restoredConfig, instanceToken: tokenMatch, env });
  } else {
    await rm(refs.launcher, { force: true });
    await rm(refs.descriptor, { force: true });
  }
  return snapshot;
}
