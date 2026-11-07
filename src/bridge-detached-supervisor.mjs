/**
 * Bridge persistence for Linux and any other OS without launchd or a Startup
 * folder: the third adapter behind `bridge-cli.mjs`'s `platformLaunchAgent`,
 * with the same contract (`snapshot`/`describe`/`install`/`disable`/`restore`)
 * as `bridge-launch-agent.mjs` (macOS) and `bridge-startup-folder.mjs`
 * (Windows). State is a supervisor descriptor plus pidfile under
 * `<seat root>/bridge-linux/`; `install` spawns `bin/lattice-bridge-supervisor.mjs`
 * detached, and that supervisor restarts a crashed bridge. Nothing here runs
 * another OS's tool, so `lattice todo dashboard ensure` on a Linux seat no
 * longer probes `/bin/launchctl` inside delivery recovery.
 *
 * shortcut: no boot/login persistence on Linux (a BellTeam seat is a container
 * whose setup re-runs `bridge reconfigure` after restart), upgrade to a
 * `systemd --user` unit when a seat runs on a host with a user session manager.
 * Flow: docs/architecture/dfd-bridge-persistence.md.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { BridgeConfigError, bridgeConfigPaths } from './bridge-config.mjs';
import { DEFAULT_BRIDGE_PATH, DEFAULT_SUPERVISOR_PATH } from './bridge-executable.mjs';
import { observeDashboardProcess } from './dashboard-process-control.mjs';
import { supervisorDescriptor, waitForBridgeStartupReady } from './bridge-startup-folder.mjs';

const START_FAILED = 'BRIDGE_DETACHED_SUPERVISOR_START_FAILED';
const STOP_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 3_000;

function fail(code, message, cause = undefined) {
  return new BridgeConfigError(code, message, undefined, cause);
}

export function bridgeDetachedSupervisorPaths(env = process.env) {
  const directory = path.join(bridgeConfigPaths(env).root, 'bridge-linux');
  return Object.freeze({
    directory,
    descriptor: path.join(directory, 'descriptor.json'),
    pidfile: path.join(directory, 'supervisor.pid'),
  });
}

async function optionalFile(ref) {
  try { return await readFile(ref, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicFile(ref, content) {
  const temporary = `${ref}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, ref);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function present(ref) {
  if (typeof ref !== 'string') return false;
  try { await stat(ref); return true; } catch { return false; }
}

async function executablePath(ref, label) {
  if (typeof ref !== 'string' || !path.isAbsolute(ref)) {
    throw fail('BRIDGE_DETACHED_SUPERVISOR_EXECUTABLE_INVALID', `${label} path must be absolute`);
  }
  try {
    const resolved = await realpath(ref);
    if (!(await stat(resolved)).isFile()) throw new Error('not a file');
    return resolved;
  } catch (error) {
    throw fail('BRIDGE_DETACHED_SUPERVISOR_EXECUTABLE_INVALID', `${label} is unavailable`, error);
  }
}

function healthHost(address) {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '[::1]';
  return address.includes(':') ? `[${address}]` : address;
}

/** The old bridge must have released its socket before the new one binds it. */
async function defaultWaitStopped({ listen, timeoutMs = SOCKET_TIMEOUT_MS }) {
  if (!listen) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${healthHost(listen.address)}:${listen.port}/__lattice/bridge-health`,
        { signal: AbortSignal.timeout(300) });
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw fail('BRIDGE_DETACHED_SUPERVISOR_STOP_FAILED', 'bridge socket did not stop');
}

async function stopRunning({ refs, listen, waitStopped }) {
  // shortcut: live numeric-only supervisors require owner-authenticated retirement before upgrading.
  const content = await optionalFile(refs.pidfile);
  let identity;
  try { identity = JSON.parse(content); } catch {}
  if (Number.isSafeInteger(identity?.pid) && identity.pid > 0
    && typeof identity.birth === 'string' && identity.birth.length > 0) {
    const matches = async () => {
      try { return (await observeDashboardProcess(identity.pid))?.birth === identity.birth; }
      catch { return false; } // An unavailable observation never licenses a signal.
    };
    if (await matches()) {
      try { process.kill(identity.pid, 'SIGTERM'); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (await matches() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (await matches()) throw fail('BRIDGE_DETACHED_SUPERVISOR_STOP_FAILED', 'bridge supervisor did not stop');
      await waitStopped({ listen });
    }
  }
  await rm(refs.pidfile, { force: true });
}

export function defaultDetachedLaunch({ nodePath, supervisorPath, descriptorPath, env }) {
  const child = spawn(nodePath, [supervisorPath, descriptorPath], { env, detached: true, stdio: 'ignore' });
  child.unref();
}

export async function snapshotBridgeDetachedSupervisor({ env = process.env } = {}) {
  const refs = bridgeDetachedSupervisorPaths(env);
  await mkdir(refs.directory, { recursive: true, mode: 0o700 });
  const descriptorContent = await optionalFile(refs.descriptor);
  return Object.freeze({ installed: descriptorContent !== null, split: false,
    launcherContent: null, descriptorContent });
}

export async function describeBridgeDetachedSupervisor({ snapshot } = {}) {
  if (snapshot?.installed !== true) return null;
  const descriptor = JSON.parse(snapshot.descriptorContent);
  const nodePath = typeof descriptor.nodePath === 'string' ? descriptor.nodePath : null;
  return { node_path: nodePath, node_exists: await present(nodePath),
    bridge_path: descriptor.bridgePath, bridge_exists: await present(descriptor.bridgePath) };
}

export async function installBridgeDetachedSupervisor({ config, env = process.env,
  nodePath = process.execPath, bridgePath = DEFAULT_BRIDGE_PATH, supervisorPath = DEFAULT_SUPERVISOR_PATH,
  launch = defaultDetachedLaunch, waitReady = waitForBridgeStartupReady,
  waitStopped = defaultWaitStopped, previousListen = null } = {}) {
  if (config?.enabled !== true) throw fail('BRIDGE_DISABLED', 'bridge is disabled');
  const refs = bridgeDetachedSupervisorPaths(env);
  await mkdir(refs.directory, { recursive: true, mode: 0o700 });
  const resolvedNode = await executablePath(nodePath, 'node executable');
  const resolvedBridge = await executablePath(bridgePath, 'bridge executable');
  const resolvedSupervisor = await executablePath(supervisorPath, 'supervisor executable');
  const instanceToken = randomBytes(32).toString('hex');
  const descriptorContent = supervisorDescriptor({
    bridgePath: resolvedBridge, pidfile: refs.pidfile, instanceToken, env, nodePath: resolvedNode,
  });
  await stopRunning({ refs, listen: previousListen, waitStopped });
  await atomicFile(refs.descriptor, descriptorContent);
  await launch({ nodePath: resolvedNode, supervisorPath: resolvedSupervisor, descriptorPath: refs.descriptor, env });
  return waitReady({ config, instanceToken, env, failureCode: START_FAILED });
}

export async function disableBridgeDetachedSupervisor({ snapshot, listen, env = process.env,
  waitStopped = defaultWaitStopped } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean') {
    throw new TypeError('bridge detached supervisor snapshot required');
  }
  const refs = bridgeDetachedSupervisorPaths(env);
  if (snapshot.installed) await stopRunning({ refs, listen, waitStopped });
  await rm(refs.descriptor, { force: true });
  await rm(refs.pidfile, { force: true });
  return { removed: snapshot.installed, stopped: snapshot.installed };
}

export async function restoreBridgeDetachedSupervisor({ snapshot, listen = null, env = process.env,
  launch = defaultDetachedLaunch, waitStopped = defaultWaitStopped, config = undefined,
  supervisorPath = DEFAULT_SUPERVISOR_PATH, waitReady = waitForBridgeStartupReady } = {}) {
  if (!snapshot || typeof snapshot.installed !== 'boolean'
    || (snapshot.installed && typeof snapshot.descriptorContent !== 'string')) {
    throw new TypeError('bridge detached supervisor snapshot required');
  }
  const refs = bridgeDetachedSupervisorPaths(env);
  await mkdir(refs.directory, { recursive: true, mode: 0o700 });
  await stopRunning({ refs, listen, waitStopped });
  if (!snapshot.installed) return;
  await atomicFile(refs.descriptor, snapshot.descriptorContent);
  const descriptor = JSON.parse(snapshot.descriptorContent);
  await launch({ nodePath: descriptor.nodePath ?? process.execPath, supervisorPath, descriptorPath: refs.descriptor, env });
  if (config !== undefined) {
    await waitReady({ config, instanceToken: descriptor.env?.LATTICE_BRIDGE_INSTANCE_TOKEN, env,
      failureCode: 'BRIDGE_DETACHED_SUPERVISOR_ROLLBACK_FAILED' });
  }
}
