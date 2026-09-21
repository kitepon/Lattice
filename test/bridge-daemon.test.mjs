import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BRIDGE_CONFIG_SCHEMA, configureBridge, disableBridge, readBridgeConfig, restoreBridgeConfig } from '../src/bridge-config.mjs';
import { runBridgeCli } from '../src/bridge-cli.mjs';
import {
  bridgeDaemonActiveMarkerPath, bridgeDaemonDescriptorPath, bridgeDaemonVersionDrifted,
  ensureBridgeDaemon, readBridgeDaemonDescriptor, readBridgeRuntimeIdentity, readBridgeStopRequest, requestBridgeDaemonStop,
  stopBridgeDaemon, writeBridgeDaemonDescriptor, writeBridgeStopReceipt,
} from '../src/bridge-daemon.mjs';
import packageJson from '../package.json' with { type: 'json' };

const unmanagedLaunchAgent = Object.freeze({
  snapshot: async () => ({ installed: false, loaded: false, content: null }),
  install: async () => {},
  disable: async () => {},
  restore: async () => {},
});

const DHCP_REBOUND = '127.0.0.1';
const DHCP_REBOUND_INTERFACES = { lo0: [{ address: DHCP_REBOUND, internal: false }] };

const closeServer = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

async function legacyBindingFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-legacy-binding-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_BRIDGE_INSTANCE_TOKEN: 'c'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const reserved = await configureBridge({ address: DHCP_REBOUND, env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  const server = createServer((request, response) => {
    if (request.url !== '/__lattice/bridge-health'
      || request.headers['x-lattice-bridge-instance-token'] !== env.LATTICE_BRIDGE_INSTANCE_TOKEN) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ schema: 'lattice.bridge_health.v1', pid: process.pid,
      address: '::1', port: server.address().port, updated_at: config.updated_at,
      version: '0.68.1', node_path: process.execPath, node_version: process.version,
      bridge_path: '/old/lattice-bridge.mjs', last_heartbeat: null })}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '::1', port: reserved.listen.port, exclusive: true }, resolve);
  });
  context.after(() => closeServer(server));
  const config = {
    schema: BRIDGE_CONFIG_SCHEMA, enabled: true,
    // DHCP候補はこの/24に限定する。::1はreconcile前の旧socketを模した第二のloopback。
    listen: { address: '127.0.0.9', port: server.address().port },
    allowed_hosts: ['127.0.0.9'], upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' }, hub: null,
    updated_at: new Date().toISOString(),
  };
  await restoreBridgeConfig(config, { env });
  await writeBridgeDaemonDescriptor({ config, binding: { address: '::1', port: config.listen.port }, env });
  return { config, env, server };
}

async function assertBridgeIdentityGone(url, pid) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(300) }); } catch { return; }
  const body = response.status === 200 ? await response.json() : null;
  assert.notEqual(body?.pid, pid);
}

test('未設定でdaemon state証拠もなければdisableはno-op成功する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-fresh-disable-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(() => rm(root, { recursive: true, force: true }));
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } } });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).recovery, 'bridge_was_not_running');
});

test('enabled configでもdaemon socketが存在しなければdisableできる', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-no-daemon-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(() => rm(root, { recursive: true, force: true }));
  await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } } });
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).recovery, 'bridge_was_not_running');
});

test('configが既にdisabledでも残存daemonの停止確認を省略しない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-disabled-running-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(async () => {
    await stopBridgeDaemon({ env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const config = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  const descriptor = await ensureBridgeDaemon({ env });
  const health = `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
  assert.equal((await fetch(health)).status, 200);
  await disableBridge({ env });
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } } });
  assert.equal(code, 0, stderr);
  await assertBridgeIdentityGone(health, descriptor.pid);
});

test('config fileが消えても残存daemonの停止確認を省略しない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-missing-config-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(async () => {
    await stopBridgeDaemon({ env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const config = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  const descriptor = await ensureBridgeDaemon({ env });
  const health = `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
  await rm(path.join(root, 'bridge.json'), { force: true });
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } } });
  assert.equal(code, 0, stderr);
  await assertBridgeIdentityGone(health, descriptor.pid);
});

test('configとdescriptorが同時に消えてもactive markerで停止受領証を必須にする', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-missing-state-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(async () => {
    await stopBridgeDaemon({ env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const config = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  const descriptor = await ensureBridgeDaemon({ env });
  const health = `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
  await rm(path.join(root, 'bridge.json'), { force: true });
  await rm(bridgeDaemonDescriptorPath(env), { force: true });
  let stdout = ''; let stderr = '';
  const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } } });
  assert.equal(code, 0, stderr);
  await assertBridgeIdentityGone(health, descriptor.pid);
});

test('crash後のstale active markerは保存listenのsocket不存在を証明してcleanupできる',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-stale-marker-'));
    const env = { ...process.env, LATTICE_CONFIG_DIR: root };
    context.after(() => rm(root, { recursive: true, force: true }));
    const config = await configureBridge({ address: '127.0.0.1', env,
      upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
    const descriptor = await ensureBridgeDaemon({ env });
    process.kill(descriptor.pid, 'SIGKILL');
    const health = `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
    await assert.rejects(fetch(health, { signal: AbortSignal.timeout(500) }));
    await rm(bridgeDaemonDescriptorPath(env), { force: true });
    let stdout = ''; let stderr = '';
    const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } } });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).recovery, 'bridge_was_not_running');
  });

test('descriptor missingかつactive marker破損でもunknownとしてnonce停止を要求する',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-corrupt-marker-'));
    const env = { ...process.env, LATTICE_CONFIG_DIR: root };
    context.after(async () => {
      await stopBridgeDaemon({ env }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    const config = await configureBridge({ address: '127.0.0.1', env,
      upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
    const descriptor = await ensureBridgeDaemon({ env });
    await rm(bridgeDaemonDescriptorPath(env), { force: true });
    await writeFile(bridgeDaemonActiveMarkerPath(env), '{}\n', { mode: 0o600 });
    let stdout = ''; let stderr = '';
    const code = await runBridgeCli({ argv: ['disable', '--json'], env, launchAgent: unmanagedLaunchAgent,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } } });
    assert.equal(code, 0, stderr);
    const health = `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
    await assertBridgeIdentityGone(health, descriptor.pid);
  });

test('setup daemonは実socket healthまで待ち、同一port再設定を反映しdisableで停止する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-daemon-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'dashboard') };
  let running = false;
  context.after(async () => {
    if (running) await stopBridgeDaemon({ env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const first = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });
  const descriptor = await ensureBridgeDaemon({ env });
  running = true;
  assert.equal(descriptor.port, first.listen.port);
  const beforeIdle = (await stat(bridgeDaemonDescriptorPath(env))).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await stat(bridgeDaemonDescriptorPath(env))).mtimeMs, beforeIdle);
  const healthUrl = `http://127.0.0.1:${first.listen.port}/__lattice/bridge-health`;
  assert.equal((await fetch(healthUrl)).status, 200);

  const changed = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4319/' } });
  const reused = await ensureBridgeDaemon({ env });
  assert.equal(reused.pid, descriptor.pid);
  assert.equal((await (await fetch(healthUrl, { headers: {
    'x-lattice-bridge-instance-token': reused.instance_token,
  } })).json()).updated_at, changed.updated_at);

  await disableBridge({ env });
  await stopBridgeDaemon({ env });
  running = false;
  await assertBridgeIdentityGone(healthUrl, descriptor.pid);
});

test('旧設定IPのdescriptorは同一subnetの実bindingをattestして同一daemonのまま収束する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-dhcp-upgrade-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_BRIDGE_INSTANCE_TOKEN: 'd'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const reserved = await configureBridge({ address: DHCP_REBOUND, env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' } });

  // 旧版は、DHCP rebind後も「設定した127.0.0.9」をdescriptorとhealthへ書いた。
  // 実socketだけは同一/24の127.0.0.1で動いている状態を、OSの実interfacesを
  // 触らず注入する。異networkを選ぶ余地はこのfixtureに無い。
  let config;
  const server = createServer((request, response) => {
    if (request.url !== '/__lattice/bridge-health'
      || request.headers['x-lattice-bridge-instance-token'] !== env.LATTICE_BRIDGE_INSTANCE_TOKEN) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ schema: 'lattice.bridge_health.v1', pid: process.pid,
      address: config.listen.address, port: config.listen.port, updated_at: config.updated_at,
      version: '0.68.1', node_path: process.execPath, node_version: process.version,
      bridge_path: '/old/lattice-bridge.mjs', last_heartbeat: null })}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: DHCP_REBOUND, port: reserved.listen.port, exclusive: true }, resolve);
  });
  context.after(() => closeServer(server));
  config = {
    schema: BRIDGE_CONFIG_SCHEMA, enabled: true,
    listen: { address: '127.0.0.9', port: server.address().port },
    allowed_hosts: ['127.0.0.9'], upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' }, hub: null,
    updated_at: new Date().toISOString(),
  };
  await restoreBridgeConfig(config, { env });
  await writeBridgeDaemonDescriptor({ config, env });

  const before = await readBridgeDaemonDescriptor({ env });
  assert.equal(before.address, config.listen.address, '旧descriptorは設定IPを保持している');
  assert.equal((await readBridgeRuntimeIdentity({ env, interfaces: DHCP_REBOUND_INTERFACES })).state, 'running',
    'statusは実bindingでattestでき、unattestedへ誤分類しない');

  let spawned = false;
  const converged = await ensureBridgeDaemon({ env, interfaces: DHCP_REBOUND_INTERFACES,
    spawnDaemon: () => { spawned = true; throw new Error('同一daemonを二重起動した'); } });
  assert.equal(spawned, false);
  assert.equal(converged.pid, process.pid);
  assert.equal(converged.address, DHCP_REBOUND);
  assert.equal(converged.port, config.listen.port);
  assert.equal((await readBridgeDaemonDescriptor({ env })).address, DHCP_REBOUND);
  assert.equal(JSON.parse(await readFile(bridgeDaemonActiveMarkerPath(env), 'utf8')).address, DHCP_REBOUND);
});

test('新IPへreconcile前でも旧bindingの本人応答を待ち、二重daemonを起動しない', async (context) => {
  const { config, env, server } = await legacyBindingFixture(context);
  const interfaces = DHCP_REBOUND_INTERFACES;
  setTimeout(() => {
    server.close((error) => {
      if (error) throw error;
      server.listen({ host: DHCP_REBOUND, port: config.listen.port, exclusive: true });
    });
  }, 75);
  let spawned = false;
  const converged = await ensureBridgeDaemon({ env, interfaces,
    spawnDaemon: () => { spawned = true; throw new Error('旧daemonのreconcile待機中に二重起動した'); } });
  assert.equal(spawned, false);
  assert.equal(converged.address, DHCP_REBOUND);
});

test('旧bindingだけで本人確認できるdescriptorも停止要求・停止を拒否しない', async (context) => {
  const { config, env } = await legacyBindingFixture(context);
  const receipt = (async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const request = await readBridgeStopRequest({ env });
      if (request !== null) {
        await writeBridgeStopReceipt({ nonce: request.nonce, env });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('stop request was not written');
  })();
  assert.equal((await requestBridgeDaemonStop({ env, listen: config.listen })).state, 'stopped');
  await receipt;

  let terminated = false;
  context.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, process.pid);
    if (signal === 'SIGTERM') { terminated = true; return; }
    if (signal === 0 && terminated) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.equal((await stopBridgeDaemon({ env, interfaces: DHCP_REBOUND_INTERFACES })).pid, process.pid);
  assert.equal(terminated, true);
});

test('stale descriptorの未証明PIDにはsignalを送らない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-stale-descriptor-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_BRIDGE_INSTANCE_TOKEN: 'a'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = await configureBridge({ address: '127.0.0.1', env });
  await writeBridgeDaemonDescriptor({ config, env });
  await assert.rejects(stopBridgeDaemon({ env }),
    (error) => error.code === 'BRIDGE_DAEMON_ATTESTATION_FAILED');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('stale descriptorだけが残った停止要求は待たずにnot_runningへ収束する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-stale-stop-request-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_BRIDGE_INSTANCE_TOKEN: 'a'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = await configureBridge({ address: '127.0.0.1', env });
  await writeBridgeDaemonDescriptor({ config, env });

  const result = await requestBridgeDaemonStop({ env, listen: config.listen });

  assert.deepEqual(result, { state: 'not_running', nonce: null });
  assert.equal(await readBridgeStopRequest({ env }), null);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('daemon descriptor/controlはduplicate・unsafe range・不正timestampをstrict拒否する',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-strict-daemon-state-'));
    const env = { ...process.env, LATTICE_CONFIG_DIR: root };
    context.after(() => rm(root, { recursive: true, force: true }));
    const now = new Date().toISOString();
    const descriptor = `{"schema":"lattice.bridge_daemon.v1","schema":"lattice.bridge_daemon.v1",`
      + `"pid":${process.pid},"address":"127.0.0.1","port":58755,"config_updated_at":"${now}",`
      + `"instance_token":"${'a'.repeat(64)}","started_at":"${now}"}\n`;
    await writeFile(bridgeDaemonDescriptorPath(env), descriptor, { mode: 0o600 });
    await assert.rejects(readBridgeDaemonDescriptor({ env }),
      (error) => error.code === 'BRIDGE_DAEMON_DESCRIPTOR_INVALID');
    await writeFile(bridgeDaemonDescriptorPath(env), `${JSON.stringify({
      schema: 'lattice.bridge_daemon.v1', pid: process.pid, address: 'not-an-ip', port: 4318,
      config_updated_at: 'not-a-time', instance_token: 'a'.repeat(64), started_at: now,
    })}\n`, { mode: 0o600 });
    await assert.rejects(readBridgeDaemonDescriptor({ env }),
      (error) => error.code === 'BRIDGE_DAEMON_DESCRIPTOR_INVALID');
    const request = path.join(root, 'bridge-stop-request.json');
    await writeFile(request, `{"schema":"lattice.bridge_stop_request.v1",`
      + `"nonce":"${'a'.repeat(64)}","nonce":"${'b'.repeat(64)}","requested_at":"${now}"}\n`,
    { mode: 0o600 });
    await assert.rejects(readBridgeStopRequest({ env }),
      (error) => error.code === 'BRIDGE_STOP_CONTROL_INVALID');
  });

test('invalid config/descriptorでもdisableは未証明PIDをkillせずpublic socketをfail closed停止する',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-corrupt-disable-'));
    const env = { ...process.env, LATTICE_CONFIG_DIR: root };
    context.after(async () => {
      await stopBridgeDaemon({ env }).catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    const directDaemonLaunchAgent = { ...unmanagedLaunchAgent,
      install: async ({ env: installEnv }) => ensureBridgeDaemon({ env: installEnv }) };
    const invoke = async (argv) => {
      let stdout = ''; let stderr = '';
      const code = await runBridgeCli({ argv, env, launchAgent: directDaemonLaunchAgent,
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: (value) => { stderr += value; } } });
      return { code, stdout, stderr };
    };
    const setupArgs = ['setup', '--listen', '127.0.0.1', '--port', 'auto', '--dashboard', '--json'];
    const configuredHealth = async () => {
      const config = await readBridgeConfig({ env });
      return `http://127.0.0.1:${config.listen.port}/__lattice/bridge-health`;
    };
    const initialSetup = await invoke(setupArgs);
    assert.equal(initialSetup.code, 0, initialSetup.stderr);
    const health = await configuredHealth();
    const initialDescriptor = await readBridgeDaemonDescriptor({ env });
    assert.equal((await fetch(health)).status, 200);
    await writeFile(path.join(root, 'bridge.json'), '{}\n', { mode: 0o600 });
    const invalidConfig = await invoke(['disable', '--json']);
    assert.equal(invalidConfig.code, 0, invalidConfig.stderr);
    assert.equal(JSON.parse(invalidConfig.stdout).recovery,
      'invalid_config_removed_after_fail_closed_shutdown');
    await assertBridgeIdentityGone(health, initialDescriptor.pid);

    const secondSetup = await invoke(setupArgs);
    assert.equal(secondSetup.code, 0, secondSetup.stderr);
    const secondHealth = await configuredHealth();
    const secondDescriptor = await readBridgeDaemonDescriptor({ env });
    assert.equal((await fetch(secondHealth)).status, 200);
    await rm(bridgeDaemonDescriptorPath(env), { force: true });
    const absentDescriptor = await invoke(['disable', '--json']);
    assert.equal(absentDescriptor.code, 0, absentDescriptor.stderr);
    await assertBridgeIdentityGone(secondHealth, secondDescriptor.pid);

    const thirdSetup = await invoke(setupArgs);
    assert.equal(thirdSetup.code, 0, thirdSetup.stderr);
    const thirdHealth = await configuredHealth();
    const thirdDescriptor = await readBridgeDaemonDescriptor({ env });
    assert.equal((await fetch(thirdHealth)).status, 200);
    await writeFile(bridgeDaemonDescriptorPath(env), '{}\n', { mode: 0o600 });
    const invalidDescriptor = await invoke(['disable', '--json']);
    assert.equal(invalidDescriptor.code, 0, invalidDescriptor.stderr);
    assert.equal(JSON.parse(invalidDescriptor.stdout).recovery,
      'invalid_descriptor_removed_after_fail_closed_shutdown');
    await assertBridgeIdentityGone(thirdHealth, thirdDescriptor.pid);
  });

// 書き手はatomic renameでdescriptorを公開するので、読み手はinode差し替えに必ず出会う。
// 「読んでいる最中に差し替わった」は内容の異常ではなく、再読で解ける競合である。
test('公開中のdescriptorを読み続けても差し替え競合で落ちない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-descriptor-race-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root,
    LATTICE_BRIDGE_INSTANCE_TOKEN: 'b'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = { listen: { address: '127.0.0.1', port: 58_771 },
    updated_at: new Date().toISOString() };
  await writeBridgeDaemonDescriptor({ config, env });

  let publishing = true;
  const publisher = (async () => {
    while (publishing) await writeBridgeDaemonDescriptor({ config, env });
  })();

  const failures = [];
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const descriptor = await readBridgeDaemonDescriptor({ env });
      assert.equal(descriptor?.port, 58_771);
    } catch (error) { failures.push(error?.code ?? String(error)); }
  }
  publishing = false;
  await publisher;

  assert.deepEqual(failures, []);
});

test('内容が壊れたdescriptorは再試行せずfail closedのまま', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-descriptor-broken-'));
  const env = { ...process.env, LATTICE_CONFIG_DIR: root };
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(bridgeDaemonDescriptorPath(env), '{"schema":"nope"}\n', { mode: 0o600 });
  await assert.rejects(readBridgeDaemonDescriptor({ env }),
    (error) => error?.code === 'BRIDGE_DAEMON_DESCRIPTOR_INVALID');
  // 未起動（fileが無い）は異常ではなくnull。
  await rm(bridgeDaemonDescriptorPath(env), { force: true });
  assert.equal(await readBridgeDaemonDescriptor({ env }), null);
});

test('bridgeDaemonVersionDriftedは実package.jsonに対して自分自身のversionと一致しfalseを返す', async () => {
  assert.equal(await bridgeDaemonVersionDrifted({}), false);
});

test('bridgeDaemonVersionDriftedはon-diskのversionが異なる時だけtrueを返す', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-version-drift-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageJsonPath = path.join(root, 'package.json');

  await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: '99.99.99' }), 'utf8');
  assert.equal(await bridgeDaemonVersionDrifted({ packageJsonPath }), true);

  await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: packageJson.version }), 'utf8');
  assert.equal(await bridgeDaemonVersionDrifted({ packageJsonPath }), false);
});

test('bridgeDaemonVersionDriftedは読み取り不能・壊れたJSONではfalseを返す（無関係なfs事故で再起動loopにしない）', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-version-drift-bad-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await bridgeDaemonVersionDrifted({ packageJsonPath: path.join(root, 'missing.json') }), false);

  const brokenPath = path.join(root, 'broken.json');
  await writeFile(brokenPath, 'not json', 'utf8');
  assert.equal(await bridgeDaemonVersionDrifted({ packageJsonPath: brokenPath }), false);
});
