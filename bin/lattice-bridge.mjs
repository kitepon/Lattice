#!/usr/bin/env node

import { readBridgeConfig } from '../src/bridge-config.mjs';
import {
  bridgeDaemonVersionDrifted, readBridgeStopRequest, removeBridgeDaemonActiveMarker,
  removeBridgeDaemonDescriptor, writeBridgeDaemonDescriptor, writeBridgeStopReceipt,
} from '../src/bridge-daemon.mjs';
import { createBridgeHubHeartbeatController } from '../src/bridge-hub-heartbeat.mjs';
import { migrateBridgeToHub, retireBridgeTunnelLaunchAgent } from '../src/bridge-hub-migration.mjs';
import { bridgeRegistrarSettings } from '../src/bridge-registrar.mjs';
import { bridgeRuntimeController } from '../src/bridge-server.mjs';

// Throttles bridgeDaemonVersionDrifted's disk read and the migration/tunnel-
// retirement checks' subprocess calls (ssh, launchctl) — the 250ms reconcile
// tick exists for local responsiveness, not for polling external processes
// 4x/sec. Migration and tunnel-retirement share this interval: once migrated,
// the migration check itself becomes a single cheap config-field read
// (`current.hub !== null`), so there is no cost to leaving both armed forever.
const BACKGROUND_CHECK_INTERVAL_MS = 60_000;

const env = process.env;
const hubHeartbeat = createBridgeHubHeartbeatController({ env });
let lastVersionCheckAt = 0;
let lastMigrationCheckAt = 0;
const instanceToken = env.LATTICE_BRIDGE_INSTANCE_TOKEN;
if (typeof instanceToken !== 'string' || !/^[0-9a-f]{64}$/u.test(instanceToken)) {
  process.stderr.write(`${JSON.stringify({ schema: 'lattice.bridge_daemon_error.v1',
    code: 'BRIDGE_INSTANCE_TOKEN_INVALID', message: 'bridge instance token is invalid' })}\n`);
  process.exit(1);
}
const controller = bridgeRuntimeController({ env, instanceToken,
  heartbeat: () => hubHeartbeat.lastHeartbeatSummary() });
let timer;
let closing = false;
let descriptorFingerprint = null;
let heartbeatBinding = null;
let checking = false;
let failClosedError = null;
let hubHeartbeatError = null;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await controller.close();
};

try {
  const stopRequest = await readBridgeStopRequest({ env });
  if (stopRequest !== null) {
    await writeBridgeStopReceipt({ nonce: stopRequest.nonce, env });
    await removeBridgeDaemonDescriptor({ env });
    await removeBridgeDaemonActiveMarker({ env });
    process.exit(0);
  }
  const config = await readBridgeConfig({ env });
  if (config === null || !config.enabled) throw Object.assign(new Error('bridge disabled'), { code: 'BRIDGE_DISABLED' });
  const binding = await controller.reconcile();
  await writeBridgeDaemonDescriptor({ config, binding, env });
  descriptorFingerprint = JSON.stringify([config.updated_at, binding.address, binding.port]);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ schema: 'lattice.bridge_daemon_error.v1',
    code: error?.code ?? 'BRIDGE_DAEMON_FAILED', message: error?.message ?? 'bridge daemon failed' })}\n`);
  process.exit(1);
}

timer = setInterval(async () => {
  if (checking || closing) return;
  checking = true;
  try {
    const stopRequest = await readBridgeStopRequest({ env });
    if (stopRequest !== null) {
      await close();
      await writeBridgeStopReceipt({ nonce: stopRequest.nonce, env });
      await removeBridgeDaemonDescriptor({ env });
      await removeBridgeDaemonActiveMarker({ env });
      process.exit(0);
    }
    // A stale-version exit is a clean stop, not a failure: whatever supervises
    // this process (launchd KeepAlive, the Windows supervisor loop) relaunches
    // it immediately, and the fresh process imports whatever is on disk now —
    // this is the mechanism that makes "npm update, done" actually true rather
    // than leaving an already-running daemon serving replaced code forever.
    if (Date.now() - lastVersionCheckAt >= BACKGROUND_CHECK_INTERVAL_MS) {
      lastVersionCheckAt = Date.now();
      if (await bridgeDaemonVersionDrifted({})) {
        await close();
        await removeBridgeDaemonDescriptor({ env });
        await removeBridgeDaemonActiveMarker({ env });
        process.exit(0);
      }
    }
    // bh5 auto-migration: a terminal still carrying the pre-hub registrar env
    // (LaunchAgent-baked, so it outlives any single process) upgrades itself
    // to hub registration with no operator action — see bridge-hub-migration.mjs's
    // module doc for why this is the whole point of the owner's "update it,
    // done" acceptance test. Runs on the same throttle as the version check;
    // once migrated it is a single cheap config-field read, so leaving it
    // armed forever costs nothing. Tunnel retirement is attempted alongside
    // it (not gated to the migration transition alone) so a retirement that
    // failed once keeps getting retried rather than being a one-shot.
    if (Date.now() - lastMigrationCheckAt >= BACKGROUND_CHECK_INTERVAL_MS) {
      lastMigrationCheckAt = Date.now();
      if (bridgeRegistrarSettings(env) !== null) {
        await migrateBridgeToHub({ env }).catch((error) => {
          process.stderr.write(`${JSON.stringify({ schema: 'lattice.bridge_daemon_error.v1',
            code: error?.code ?? 'BRIDGE_HUB_MIGRATION_FAILED',
            message: error?.message ?? 'bridge hub migration failed' })}\n`);
        });
        const migratedConfig = await readBridgeConfig({ env });
        if (migratedConfig?.hub !== null && migratedConfig?.hub !== undefined) {
          // retireBridgeTunnelLaunchAgent's own contract never throws for any
          // expected outcome (not loaded, bootout failure, launchctl absent —
          // all typed returns); this catch is only for a genuinely unexpected
          // bug in that function, and it is still logged, not swallowed.
          await retireBridgeTunnelLaunchAgent({ env }).catch((error) => {
            process.stderr.write(`${JSON.stringify({ schema: 'lattice.bridge_daemon_error.v1',
              code: error?.code ?? 'BRIDGE_TUNNEL_RETIREMENT_FAILED',
              message: error?.message ?? 'bridge tunnel retirement failed' })}\n`);
          });
        }
      }
    }
    const config = await readBridgeConfig({ env });
    if (config === null || !config.enabled) {
      await close();
      await removeBridgeDaemonDescriptor({ env });
      await removeBridgeDaemonActiveMarker({ env });
      process.exit(0);
    }
    const binding = await controller.reconcile();
    failClosedError = null;
    const nextDescriptorFingerprint = JSON.stringify([config.updated_at, binding.address, binding.port]);
    if (descriptorFingerprint !== nextDescriptorFingerprint) {
      await writeBridgeDaemonDescriptor({ config, binding, env });
      descriptorFingerprint = nextDescriptorFingerprint;
    }
    // Hub heartbeat failures are reported but never fail-close local traffic:
    // an unreachable hub is a routing problem for the hub's aggregate view,
    // not a reason to stop serving this terminal's own dashboard directly.
    // Network/hub-rejection failures already come back as typed results, not
    // throws (sendBridgeHubHeartbeat's contract) — only a local error (e.g.
    // the terminal identity file) reaches this catch.
    try {
      const bindingFingerprint = JSON.stringify([binding.address, binding.port]);
      const forceHeartbeat = heartbeatBinding !== bindingFingerprint;
      heartbeatBinding = bindingFingerprint;
      const heartbeat = await hubHeartbeat.tick({ config, force: forceHeartbeat });
      // 直前に書いた指紋は、健全な状態へ戻った時にだけ捨てる。判定より前に捨てると
      // 比較相手が毎周期nullになり、同じ結果をpoll周期ごとに書き続ける。stderrの
      // 消費者が居ない常駐（WindowsのStartup launcher、LaunchAgent）では、この
      // 書込みが積み上がること自体が常駐を不安定にする。
      if (['unreachable', 'rejected', 'partial'].includes(heartbeat?.state)) {
        const fingerprint = JSON.stringify(heartbeat);
        if (fingerprint !== hubHeartbeatError) process.stderr.write(`${fingerprint}\n`);
        hubHeartbeatError = fingerprint;
      } else hubHeartbeatError = null;
    } catch (error) {
      const failure = { schema: 'lattice.bridge_daemon_error.v1',
        code: error?.code ?? 'BRIDGE_HUB_HEARTBEAT_FAILED',
        message: error?.message ?? 'bridge hub heartbeat failed' };
      const fingerprint = JSON.stringify(failure);
      if (fingerprint !== hubHeartbeatError) process.stderr.write(`${fingerprint}\n`);
      hubHeartbeatError = fingerprint;
    }
  } catch (error) {
    const failure = { schema: 'lattice.bridge_daemon_error.v1',
      code: error?.code ?? 'BRIDGE_RECONCILE_FAILED',
      message: error?.message ?? 'bridge reconcile failed' };
    const fingerprint = JSON.stringify(failure);
    if (fingerprint !== failClosedError) process.stderr.write(`${fingerprint}\n`);
    failClosedError = fingerprint;
    // Public traffic fails closed immediately. Keep only the local control loop alive so an
    // authenticated nonce stop request can still receive a socket-closed receipt.
    await controller.close();
  } finally { checking = false; }
}, 250);
process.once('SIGINT', () => close().finally(() => process.exit(0)));
process.once('SIGTERM', () => close().finally(() => process.exit(0)));
