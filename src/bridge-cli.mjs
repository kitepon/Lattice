import { realpath } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as clack from '@clack/prompts';

import packageJson from '../package.json' with { type: 'json' };
import { resolveBridgeListenAddress } from './bridge-address.mjs';
import { registerBridgeUpstream } from './bridge-registrar.mjs';
import { ensureTodoDashboardDaemon } from './todo-dashboard-registry.mjs';
import { verifyBridgeHubDelivery } from './dashboard-delivery.mjs';
import {
  BridgeConfigError, configureBridge, disableBridge, readBridgeConfig, restoreBridgeConfig,
  normalizeBridgeAllowedHost, withBridgeOperationLock,
} from './bridge-config.mjs';
import {
  clearBridgeStopControl, ensureBridgeDaemon, readBridgeDaemonDescriptor,
  readBridgeRuntimeIdentity, removeBridgeDaemonActiveMarker, removeBridgeDaemonDescriptor,
  requestBridgeDaemonStop, stopBridgeDaemon,
} from './bridge-daemon.mjs';
import { bridgeDevelopmentTreeWarning, DEFAULT_BRIDGE_PATH } from './bridge-executable.mjs';
import {
  describeBridgeLaunchAgent, disableBridgeLaunchAgent, installBridgeLaunchAgent,
  restoreBridgeLaunchAgent, snapshotBridgeLaunchAgent,
} from './bridge-launch-agent.mjs';
import {
  describeBridgeStartupFolder, disableBridgeStartupFolder, installBridgeStartupFolder,
  restoreBridgeStartupFolder, snapshotBridgeStartupFolder,
} from './bridge-startup-folder.mjs';

// v2 adds the liveness fields. `enabled` only says the configuration is on;
// it never said the bridge could actually be reached, which let a DHCP lease
// change take the published surface down while status kept reporting health.
// v3 adds `hub` (bh3): the terminal's registered bridge-hub, if any.
// v4 adds `persistence`/`runtime`/`runtime_drift`/`remedy`/`warnings`: the
// configuration being reachable still said nothing about whether the OS
// persistence entry points at binaries that exist, or whether the process
// actually serving is the code and node a restart would bring back.
const RESULT_SCHEMA = 'lattice.bridge_cli_result.v4';
const REACHABILITY_PROBE_TIMEOUT_MS = 750;
const RECONFIGURE_COMMAND = 'lattice bridge reconfigure --json';

/** TCP connect probe. Answers "is anything accepting there right now". */
export function probeBridgeListener({ address, port, timeoutMs = REACHABILITY_PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection({ host: address, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Liveness of the configured listen address: does it still exist on this host,
 * did it move inside its subnet, and is anything accepting connections there.
 */
async function bridgeLiveness(config, { interfaces = networkInterfaces(), probe = probeBridgeListener } = {}) {
  if (config === null || config.enabled !== true) {
    return { listen_state: 'unconfigured', effective_listen: null, listen_candidates: [],
      reachable: null, liveness_reason: null };
  }
  const resolved = resolveBridgeListenAddress({ configured: config.listen.address, interfaces });
  const effective = resolved.effective === null ? null
    : { address: resolved.effective, port: config.listen.port };
  const reachable = effective === null ? false
    : await probe({ address: effective.address, port: effective.port });
  return {
    listen_state: resolved.state,
    effective_listen: effective,
    listen_candidates: resolved.candidates,
    reachable,
    liveness_reason: resolved.reason ?? (reachable ? null : 'listener_not_accepting'),
  };
}

// The bridge's own persistence mechanism is OS-specific; everything above
// this line (config, daemon lifecycle, registrar) is not. Selecting by
// `process.platform` here — rather than requiring every caller to pick — is
// what lets `lattice bridge setup` on Windows persist via the Startup folder
// exactly the way it persists via a LaunchAgent on macOS, with no separate
// command or manual step (see bridge-startup-folder.mjs's module doc for why
// Task Scheduler's ONLOGON trigger could not be used instead).
function platformLaunchAgent() {
  if (process.platform === 'win32') {
    return { snapshot: snapshotBridgeStartupFolder, install: installBridgeStartupFolder,
      disable: disableBridgeStartupFolder, restore: restoreBridgeStartupFolder,
      describe: describeBridgeStartupFolder };
  }
  return { snapshot: snapshotBridgeLaunchAgent, install: installBridgeLaunchAgent,
    disable: disableBridgeLaunchAgent, restore: restoreBridgeLaunchAgent,
    describe: describeBridgeLaunchAgent };
}

const UNREADABLE_PERSISTENCE = Object.freeze({ loaded: null, node_path: null, node_exists: false,
  bridge_path: null, bridge_exists: false });

/**
 * What the OS persistence entry (LaunchAgent plist, Windows Startup launcher)
 * actually points at, and whether those paths still exist. A read failure is
 * reported as `unreadable` rather than thrown: this is a diagnostic, and it
 * is worth least on exactly the broken hosts where it would otherwise abort.
 */
async function bridgePersistence({ launchAgent, env }) {
  try {
    const snapshot = await launchAgent.snapshot({ env });
    const described = await launchAgent.describe({ snapshot, env });
    // `loaded` is launchd-specific; the Windows Startup folder has no such
    // concept and reports null rather than pretending to know.
    const loaded = typeof snapshot?.loaded === 'boolean' ? snapshot.loaded : null;
    if (snapshot?.split === true) {
      return { state: 'unreadable', ...UNREADABLE_PERSISTENCE, loaded,
        error: 'BRIDGE_PERSISTENCE_STATE_SPLIT' };
    }
    if (described === null) return { state: 'not_installed', ...UNREADABLE_PERSISTENCE, loaded, error: null };
    return { state: 'installed', loaded, ...described, error: null };
  } catch (error) {
    // Only environment failures degrade into a report: typed BridgeConfigErrors
    // and raw fs errnos both carry a string `code`. Anything else is a defect in
    // this codebase (a missing describe implementation, a bad argument) and must
    // surface as itself rather than be laundered into "unreadable".
    if (typeof error?.code !== 'string') throw error;
    return { state: 'unreadable', ...UNREADABLE_PERSISTENCE, error: error.code };
  }
}

/**
 * Where the running process disagrees with what a restart would produce.
 * `node_path` is compared through realpath because the persisted path is
 * deliberately a stable alias (see bridge-executable.mjs) — the strings are
 * expected to differ; the binaries behind them are not.
 */
async function bridgeRuntimeDrift(persistence, runtime) {
  if (persistence?.state !== 'installed' || runtime?.state !== 'running') return [];
  const drift = [];
  if (runtime.bridge_path !== null && persistence.bridge_path !== null
    && runtime.bridge_path !== persistence.bridge_path) drift.push('bridge_path');
  if (runtime.node_path !== null && persistence.node_path !== null) {
    const target = await realpath(persistence.node_path).catch(() => null);
    if (target !== null && target !== runtime.node_path) drift.push('node_path');
  }
  if (runtime.version !== null && runtime.version !== packageJson.version) drift.push('version');
  return drift;
}

/**
 * `version` drift alone carries no remedy on purpose: the daemon polls its own
 * on-disk package version and exits for the supervisor to relaunch on the new
 * code (see bridgeDaemonVersionDrifted), so it resolves itself within a minute.
 * Everything else here outlives the current process: a missing binary, a
 * mismatched path, or an enabled bridge with no persistence entry at all all
 * survive until someone reinstalls the entry.
 */
function bridgeRemedy(persistence, drift, runtime) {
  // A hub that refused some of this terminal's projects keeps serving the rest,
  // so nothing else looks wrong — the refused ids simply never reach the
  // published dashboard from here. They are held by another terminal that is
  // still heartbeating; this resolves itself if that terminal goes offline, and
  // otherwise the way out is to stop claiming the id here. (The protocol has an
  // `adopt` field for taking one over deliberately, but nothing populates it —
  // there is no CLI for it, so naming it as a remedy would be naming a door
  // that does not open.)
  const rejected = runtime?.last_heartbeat?.rejected_projects ?? [];
  if (rejected.length > 0) {
    return `lattice todo dashboard remove ${rejected[0]} --json`;
  }
  if (persistence === null) return null;
  if (persistence.state === 'unreadable') return RECONFIGURE_COMMAND;
  // Only reached with the bridge enabled, so "nothing is installed" means the
  // currently-serving daemon is the last one: nothing brings it back at reboot.
  if (persistence.state === 'not_installed') return RECONFIGURE_COMMAND;
  if (persistence.state === 'installed'
    && (!persistence.node_exists || !persistence.bridge_exists)) return RECONFIGURE_COMMAND;
  return drift.includes('node_path') || drift.includes('bridge_path') ? RECONFIGURE_COMMAND : null;
}

async function bridgeDiagnostics({ config, launchAgent, env, runtimeIdentity }) {
  if (config?.enabled !== true) return null;
  const persistence = await bridgePersistence({ launchAgent, env });
  const runtime = await runtimeIdentity({ env });
  const drift = await bridgeRuntimeDrift(persistence, runtime);
  return { persistence, runtime, drift, remedy: bridgeRemedy(persistence, drift, runtime) };
}

function fail(stderr, code, message) {
  stderr.write(`${JSON.stringify({ schema: 'lattice.cli_error.v2', code, message })}\n`);
  return 2;
}

function parseOptions(words) {
  const options = { address: undefined, port: undefined, upstream: undefined, hub: undefined, allowedHosts: [] };
  for (let index = 0; index < words.length; index += 1) {
    const flag = words[index];
    if (flag === '--listen') {
      if (options.address !== undefined) throw new BridgeConfigError('USAGE', 'duplicate --listen');
      options.address = words[++index];
    }
    else if (flag === '--port') {
      if (options.port !== undefined) throw new BridgeConfigError('USAGE', 'duplicate --port');
      const value = words[++index];
      options.port = value === 'auto' ? null : Number(value);
    } else if (flag === '--dashboard') {
      if (options.upstream !== undefined) throw new BridgeConfigError('USAGE', 'upstream option is ambiguous');
      options.upstream = { mode: 'dashboard_descriptor' };
    } else if (flag === '--upstream') {
      if (options.upstream !== undefined) throw new BridgeConfigError('USAGE', 'upstream option is ambiguous');
      options.upstream = { mode: 'url', url: words[++index] };
    } else if (flag === '--hub') {
      if (options.hub !== undefined) throw new BridgeConfigError('USAGE', 'duplicate --hub');
      const value = words[++index];
      options.hub = value === 'none' ? null : { url: value };
    } else if (flag === '--allow-host') options.allowedHosts.push(words[++index]);
    else throw new BridgeConfigError('USAGE', `unknown bridge option: ${flag}`);
    if ((flag === '--listen' || flag === '--port' || flag === '--upstream' || flag === '--hub' || flag === '--allow-host')
      && words[index] === undefined) throw new BridgeConfigError('USAGE', `missing value for ${flag}`);
  }
  return options;
}

function result(action, config, recovery = null, liveness = null, diagnostics = null, warnings = null) {
  return { schema: RESULT_SCHEMA, action, configured: config !== null, enabled: config?.enabled ?? false,
    listen: config?.listen ?? null, allowed_hosts: config?.allowed_hosts ?? null,
    upstream: config?.upstream ?? null, hub: config?.hub ?? null, updated_at: config?.updated_at ?? null, recovery,
    listen_state: liveness?.listen_state ?? null,
    effective_listen: liveness?.effective_listen ?? null,
    listen_candidates: liveness?.listen_candidates ?? null,
    reachable: liveness?.reachable ?? null,
    liveness_reason: liveness?.liveness_reason ?? null,
    persistence: diagnostics?.persistence ?? null,
    runtime: diagnostics?.runtime ?? null,
    runtime_drift: diagnostics?.drift ?? null,
    remedy: diagnostics?.remedy ?? null,
    warnings };
}

/** 設定済みbridgeの常駐が欠けた場合だけ、正規の再設定経路で復旧する。 */
export async function recoverConfiguredBridge({ config, env = process.env,
  launchAgent = platformLaunchAgent(), runtimeIdentity = readBridgeRuntimeIdentity,
  reconfigure = runBridgeCli } = {}) {
  const diagnostics = await bridgeDiagnostics({ config, launchAgent, env, runtimeIdentity });
  if (diagnostics === null) return;
  if (diagnostics.persistence.state === 'installed'
    && diagnostics.persistence.node_exists && diagnostics.persistence.bridge_exists
    && diagnostics.runtime?.state === 'running'
    && diagnostics.drift.every((field) => field === 'version')) return;
  let errorOutput = '';
  const code = await reconfigure({ argv: ['reconfigure', '--json'], env,
    stdout: { write() {} }, stderr: { write(chunk) { errorOutput += chunk; } },
    launchAgent, runtimeIdentity });
  if (code !== 0) {
    const error = JSON.parse(errorOutput);
    throw new BridgeConfigError(error.code, error.message, error.detail);
  }
}

export async function collectBridgeSetupWizard({ input, output, prompts = clack } = {}) {
  const common = { input, output };
  const enabled = await prompts.confirm({ ...common,
    message: 'Lattice dashboardのnetwork bridgeを有効にしますか？', initialValue: false });
  if (prompts.isCancel(enabled) || enabled !== true) return null;
  const address = await prompts.text({ ...common, message: 'listenするIP address',
    placeholder: '192.168.1.102', validate: (value) => isIP(value) === 0 ? 'IP literalを入力してください' : undefined });
  if (prompts.isCancel(address)) return null;
  const portMode = await prompts.select({ ...common, message: 'bridge port', initialValue: 'auto', options: [
    { value: 'auto', label: '自動選択', hint: '49152–65535からexclusive bind' },
    { value: 'custom', label: '指定する' },
  ] });
  if (prompts.isCancel(portMode)) return null;
  let port = null;
  if (portMode === 'custom') {
    const selected = await prompts.text({ ...common, message: 'port (49152–65535)',
      validate: (value) => /^\d+$/u.test(value) && Number(value) >= 49_152 && Number(value) <= 65_535
        ? undefined : '49152–65535の整数を入力してください' });
    if (prompts.isCancel(selected)) return null;
    port = Number(selected);
  }
  const upstreamMode = await prompts.select({ ...common, message: 'upstream', initialValue: 'dashboard', options: [
    { value: 'dashboard', label: '現在のLattice dashboard', hint: '再起動時もdescriptorから追従' },
    { value: 'custom', label: '固定URL' },
  ] });
  if (prompts.isCancel(upstreamMode)) return null;
  let upstream = { mode: 'dashboard_descriptor' };
  if (upstreamMode === 'custom') {
    const url = await prompts.text({ ...common, message: 'upstream HTTP(S) URL',
      placeholder: 'http://127.0.0.1:4318/' });
    if (prompts.isCancel(url)) return null;
    upstream = { mode: 'url', url };
  }
  const publicHost = await prompts.text({ ...common,
    message: '追加で許可する公開hostname（なければ空欄）', placeholder: 'lattice.kitepon.dev',
    validate: (value) => {
      if (value === '') return undefined;
      try { normalizeBridgeAllowedHost(value); return undefined; } catch {
        return 'portやschemeを含まないhostnameを入力してください';
      }
    } });
  if (prompts.isCancel(publicHost)) return null;
  return { address, port, upstream, allowedHosts: publicHost === '' ? [] : [publicHost] };
}

export async function runBridgeCli({ argv, stdout, stderr, env = process.env,
  stdin = process.stdin, daemon = { ensure: ensureBridgeDaemon, requestStop: requestBridgeDaemonStop,
    stop: stopBridgeDaemon, clearStop: clearBridgeStopControl },
  launchAgent = platformLaunchAgent(), runtimeIdentity = readBridgeRuntimeIdentity,
  bridgePath = DEFAULT_BRIDGE_PATH,
  ensureDashboard = ensureTodoDashboardDaemon, verifyDelivery = verifyBridgeHubDelivery,
  prompts = clack, probe = probeBridgeListener, interfaces = networkInterfaces() } = {}) {
  if (!Array.isArray(argv)) {
    return fail(stderr, 'USAGE', 'usage: lattice bridge <setup|reconfigure|status|disable|register> [options] --json');
  }
  const wizard = argv.length === 1 && argv[0] === 'setup';
  if (!wizard && argv.at(-1) !== '--json') {
    return fail(stderr, 'USAGE', 'usage: lattice bridge <setup|reconfigure|status|disable|register> [options] --json');
  }
  if (wizard && (!stdin?.isTTY || !stdout?.isTTY)) {
    return fail(stderr, 'BRIDGE_SETUP_REQUIRES_TTY',
      'interactive setup requires a TTY; use lattice bridge setup --listen <IP> --port auto --dashboard --json');
  }
  const [command, ...words] = wizard ? argv : argv.slice(0, -1);
  try {
    if (command === 'register' && words.length === 0) {
      const current = await readBridgeConfig({ env });
      if (current === null || current.enabled !== true) {
        return fail(stderr, 'BRIDGE_DISABLED', 'bridge is not enabled; nothing to register');
      }
      const resolved = resolveBridgeListenAddress({ configured: current.listen.address, interfaces });
      if (resolved.effective === null) {
        return fail(stderr, 'BRIDGE_LISTEN_ADDRESS_ABSENT',
          'configured bridge listen address is not present on this host');
      }
      const registration = await registerBridgeUpstream({ port: current.listen.port, env });
      stdout.write(`${JSON.stringify(registration)}\n`);
      return registration.state === 'failed' ? 1 : 0;
    }
    let config;
    let recovery = null;
    if (command === 'status' && words.length === 0) config = await readBridgeConfig({ env });
    else if (command === 'disable' && words.length === 0) {
      config = await withBridgeOperationLock({ env }, async () => {
        let previous;
        let descriptor = null;
        let invalidConfig = false;
        let invalidDescriptor = false;
        try {
          previous = await readBridgeConfig({ env });
        } catch (error) {
          if (!['BRIDGE_CONFIG_INVALID', 'BRIDGE_CONFIG_MODE_INVALID'].includes(error?.code)) throw error;
          invalidConfig = true;
        }
        try { descriptor = await readBridgeDaemonDescriptor({ env }); } catch (error) {
          if (error?.code !== 'BRIDGE_DAEMON_DESCRIPTOR_INVALID') throw error;
          invalidDescriptor = true;
        }
        const agentSnapshot = await launchAgent.snapshot({ env });
        const witnessedListen = previous?.listen ?? (descriptor === null ? null
          : { address: descriptor.address, port: descriptor.port });
        let stopResult = null;
        try {
          await launchAgent.disable({ snapshot: agentSnapshot, listen: witnessedListen, env });
          if (!agentSnapshot.loaded) {
            const requestStop = daemon.requestStop ?? daemon.stop ?? requestBridgeDaemonStop;
            stopResult = await requestStop({ env, listen: witnessedListen });
          }
          const disabled = invalidConfig ? await restoreBridgeConfig(null, { env })
            : await disableBridge({ env });
          if (invalidConfig) recovery = 'invalid_config_removed_after_fail_closed_shutdown';
          else if (invalidDescriptor) recovery = 'invalid_descriptor_removed_after_fail_closed_shutdown';
          await removeBridgeDaemonDescriptor({ env });
          await removeBridgeDaemonActiveMarker({ env });
          const clearStop = daemon.clearStop ?? clearBridgeStopControl;
          await clearStop({ env });
          if (stopResult?.state === 'not_running' && recovery === null) recovery = 'bridge_was_not_running';
          return disabled;
        } catch (error) {
          try {
            await launchAgent.restore({ snapshot: agentSnapshot, listen: witnessedListen,
              config: previous, env });
          }
          catch (rollbackError) {
            throw new BridgeConfigError('BRIDGE_ROLLBACK_FAILED',
              `bridge disable failed and LaunchAgent rollback failed: ${rollbackError.message}`, undefined, error);
          }
          throw error;
        }
      });
    }
    else if (command === 'setup' || command === 'reconfigure') {
      const options = wizard ? await collectBridgeSetupWizard({ input: stdin, output: stdout, prompts })
        : parseOptions(words);
      if (options === null) {
        stdout.write('Lattice bridge setupを取り消しました。設定は変更していません。\n');
        return 0;
      }
      if (command === 'setup' && options.address === undefined) {
        throw new BridgeConfigError('USAGE', 'setup requires explicit --listen <IP> opt-in');
      }
      config = await withBridgeOperationLock({ env }, async () => {
        const clearStop = daemon.clearStop ?? clearBridgeStopControl;
        await clearStop({ env });
        const current = await readBridgeConfig({ env });
        const agentSnapshot = await launchAgent.snapshot({ env });
        let activeBinding = null;
        // DHCP追従済みdaemonの実socketを、手動で設定IPへ昇格させる場合がある。
        // tokenでattest済みのdescriptorだけが、この同一portの予約を省略できる。
        // それ以外の占有は従来どおりBRIDGE_PORT_UNAVAILABLEで止める。
        if (command === 'reconfigure' && options.address !== undefined && options.port === undefined
          && current?.enabled === true && current.listen.port !== undefined) {
          const descriptor = await readBridgeDaemonDescriptor({ env });
          const runtime = descriptor === null ? null : await runtimeIdentity({ env });
          if (runtime?.state === 'running' && descriptor.address === options.address
            && descriptor.port === current.listen.port) {
            activeBinding = { address: descriptor.address, port: descriptor.port };
          }
        }
        const configured = await configureBridge({
          address: options.address ?? current?.listen.address,
          port: options.port === undefined ? (command === 'reconfigure' ? current?.listen.port ?? null : null) : options.port,
          upstream: options.upstream ?? current?.upstream ?? { mode: 'dashboard_descriptor' },
          hub: options.hub === undefined ? current?.hub ?? null : options.hub, env,
          allowedHosts: options.allowedHosts.length > 0 ? options.allowedHosts
            : current?.allowed_hosts?.filter((host) => host !== current.listen.address) ?? [],
          reuseCurrentPort: options.port === undefined,
          activeBinding,
        });
        try {
          if (configured.hub !== null) await ensureDashboard({ env });
          if (!agentSnapshot.loaded && current !== null) {
            const requestStop = daemon.requestStop ?? daemon.stop ?? requestBridgeDaemonStop;
            await requestStop({ env, listen: current.listen });
            await clearStop({ env });
          }
          await launchAgent.install({ config: configured, previousListen: current?.listen ?? null, env });
        } catch (error) {
          try {
            await restoreBridgeConfig(current, { env });
            await clearStop({ env });
            await launchAgent.restore({ snapshot: agentSnapshot, listen: configured.listen,
              config: current, env });
            if (current?.enabled && !agentSnapshot.loaded) await daemon.ensure({ env });
          } catch (rollbackError) {
            throw new BridgeConfigError('BRIDGE_ROLLBACK_FAILED',
              `bridge setup failed and rollback failed: ${rollbackError.message}`, undefined, error);
          }
          throw error;
        }
        return configured;
      });
    } else return fail(stderr, 'USAGE', 'unknown bridge command or options');
    // hubを指定した設定は、保存・常駐起動だけでは成功にしない。通信故障時も設定は
    // 保持し、次の工程操作から同じ接続を復旧できるようにする。
    if ((command === 'setup' || command === 'reconfigure') && config.hub !== null) {
      const delivery = await verifyDelivery({ config, env });
      stderr.write(`${JSON.stringify(delivery)}\n`);
    }
    // Liveness and the persistence/runtime diagnostics are only meaningful for
    // a read: the mutating commands have just reconfigured the daemon and the
    // socket may not have settled yet.
    const liveness = command === 'status' ? await bridgeLiveness(config, { probe, interfaces }) : null;
    const diagnostics = command === 'status'
      ? await bridgeDiagnostics({ config, launchAgent, env, runtimeIdentity }) : null;
    // An install persisted straight out of a checkout is legitimate but must
    // never be silent — it is half of what made the 2026-08-10 outage take
    // manual launchctl archaeology to explain.
    const warnings = command === 'setup' || command === 'reconfigure'
      ? [bridgeDevelopmentTreeWarning(bridgePath)].filter((warning) => warning !== null) : null;
    if (wizard) {
      stdout.write(`Lattice bridgeを${config.listen.address}:${config.listen.port}で有効にしました。\n`);
      for (const warning of warnings ?? []) stdout.write(`警告: ${warning.message}\n`);
    } else stdout.write(`${JSON.stringify(result(command, config, recovery, liveness, diagnostics, warnings))}\n`);
    return 0;
  } catch (error) {
    const payload = { schema: 'lattice.cli_error.v2',
      code: error?.code ?? 'BRIDGE_FAILED', message: error?.message ?? 'bridge command failed' };
    if (error?.detail && typeof error.detail === 'object' && !Array.isArray(error.detail)
      && Object.keys(error.detail).length > 0) payload.detail = error.detail;
    stderr.write(`${JSON.stringify(payload)}\n`);
    return error?.code === 'USAGE' ? 2 : 1;
  }
}
