import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BRIDGE_CONFIG_SCHEMA, configureBridge, readBridgeConfig, restoreBridgeConfig } from '../src/bridge-config.mjs';
import { recoverConfiguredBridge, runBridgeCli } from '../src/bridge-cli.mjs';
import { writeBridgeDaemonDescriptor } from '../src/bridge-daemon.mjs';

function output(isTTY = false) {
  let value = '';
  return { stream: { isTTY, write(chunk) { value += chunk; } }, read: () => value };
}

function launchAgentDouble({ calls = [], install = null, described = null } = {}) {
  let state = { installed: false, loaded: false, content: null };
  return {
    snapshot: async () => ({ ...state }),
    install: async (options) => {
      calls.push(`install:${options.config.listen.port}`);
      if (install !== null) await install(options);
      state = { installed: true, loaded: true, content: '<plist/>' };
    },
    disable: async () => { calls.push('disable'); state = { installed: false, loaded: false, content: null }; },
    restore: async ({ snapshot }) => { calls.push('restore'); state = { ...snapshot }; },
    describe: async ({ snapshot }) => (snapshot.installed !== true ? null
      : described ?? { node_path: '/opt/homebrew/bin/node', node_exists: true,
        bridge_path: '/usr/local/lib/node_modules/@quolu/lattice/bin/lattice-bridge.mjs',
        bridge_exists: true }),
    state: () => ({ ...state }),
  };
}

function runtimeIdentityDouble(identity = { state: 'not_running', pid: null, version: null,
  node_path: null, node_version: null, bridge_path: null }) {
  return async () => ({ ...identity });
}

test('設定済みbridgeの常駐欠落は工程入口から正規reconfigureで復旧する', async () => {
  let received = null;
  await recoverConfiguredBridge({ config: { enabled: true }, env: {},
    launchAgent: launchAgentDouble(), runtimeIdentity: runtimeIdentityDouble(),
    reconfigure: async (options) => { received = options.argv; return 0; } });
  assert.deepEqual(received, ['reconfigure', '--json']);
});

test('実行中の版だけのずれは既存の自動更新に任せる', async () => {
  const bridgePath = '/usr/local/lib/node_modules/@quolu/lattice/bin/lattice-bridge.mjs';
  const launchAgent = launchAgentDouble();
  await launchAgent.install({ config: { listen: { port: 55000 } } });
  await recoverConfiguredBridge({ config: { enabled: true }, env: {}, launchAgent,
    runtimeIdentity: runtimeIdentityDouble({ state: 'running', version: '0.0.1',
      bridge_path: bridgePath, node_path: null }),
    reconfigure: async () => { assert.fail('版だけのずれで常駐を再設定した'); } });
});

test('DHCP追従済みの本人socketを設定IPへ昇格するreconfigureは自ポート衝突にしない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-reconfigure-rebound-'));
  const env = { LATTICE_CONFIG_DIR: root, LATTICE_BRIDGE_INSTANCE_TOKEN: 'a'.repeat(64) };
  context.after(() => rm(root, { recursive: true, force: true }));
  const reserved = await configureBridge({ address: '127.0.0.1', env });
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen({ host: '127.0.0.1', port: reserved.listen.port }, resolve);
  });
  context.after(() => new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve())));
  const oldConfig = {
    schema: BRIDGE_CONFIG_SCHEMA, enabled: true,
    listen: { address: '127.0.0.9', port: occupied.address().port }, allowed_hosts: ['127.0.0.9'],
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318/' }, hub: null,
    updated_at: '2026-09-22T00:00:00.000Z',
  };
  await restoreBridgeConfig(oldConfig, { env });
  await writeBridgeDaemonDescriptor({ config: oldConfig,
    binding: { address: '127.0.0.1', port: oldConfig.listen.port }, env });
  const stdout = output(); const stderr = output();
  const code = await runBridgeCli({ argv: ['reconfigure', '--listen', '127.0.0.1', '--json'], env,
    stdout: stdout.stream, stderr: stderr.stream,
    daemon: { ensure: async () => {}, requestStop: async () => ({ state: 'stopped' }), clearStop: async () => {} },
    launchAgent: launchAgentDouble(), runtimeIdentity: runtimeIdentityDouble({ state: 'running', pid: process.pid }),
  });
  assert.equal(code, 0, stderr.read());
  assert.equal(JSON.parse(stdout.read()).listen.address, '127.0.0.1');
});

test('hubへ届かないsetupは設定保存を公開成功として返さない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-delivery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = output(); const stderr = output();
  const code = await runBridgeCli({
    argv: ['setup', '--listen', '127.0.0.1', '--hub', 'http://hub.example', '--json'],
    stdout: stdout.stream, stderr: stderr.stream, env: { LATTICE_CONFIG_DIR: root },
    launchAgent: launchAgentDouble(), ensureDashboard: async () => {},
    verifyDelivery: async () => { throw Object.assign(new Error('配信先に届かない'),
      { code: 'BRIDGE_HUB_DELIVERY_UNCONFIRMED' }); },
  });
  assert.equal(code, 1, stdout.read());
  assert.equal(JSON.parse(stderr.read()).code, 'BRIDGE_HUB_DELIVERY_UNCONFIRMED');
  assert.equal((await readBridgeConfig({ env: { LATTICE_CONFIG_DIR: root } })).enabled, true,
    '通信失敗でも保存した接続設定は残し、次の復旧入口で使う');
});

test('共通setupは常駐の既存入口から配信確認まで実行しstdout契約を保つ', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-delivery-order-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const stdout = output(); const stderr = output();
  const code = await runBridgeCli({
    argv: ['setup', '--listen', '127.0.0.1', '--hub', 'http://hub.example', '--json'],
    stdout: stdout.stream, stderr: stderr.stream, env: { LATTICE_CONFIG_DIR: root },
    launchAgent: launchAgentDouble({ calls }),
    ensureDashboard: async () => { calls.push('dashboard'); },
    verifyDelivery: async () => { calls.push('delivery');
      return { schema: 'lattice.dashboard_delivery.v1', state: 'hub_delivered' }; },
  });
  assert.equal(code, 0, stderr.read());
  assert.equal(JSON.parse(stderr.read()).state, 'hub_delivered');
  const result = JSON.parse(stdout.read());
  assert.equal(result.schema, 'lattice.bridge_cli_result.v4');
  assert.equal(Object.hasOwn(result, 'delivery'), false);
  assert.deepEqual(calls, ['dashboard', `install:${result.listen.port}`, 'delivery']);
});

test('bridge CLIはsetup/status/reconfigure/disableをJSON契約で提供する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const calls = [];
  const daemon = { ensure: async () => { calls.push('ensure'); }, stop: async () => { calls.push('stop'); } };
  const launchAgent = launchAgentDouble({ calls });
  const invoke = async (argv) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const initial = await invoke(['status', '--json']);
  assert.equal(initial.code, 0);
  assert.equal(JSON.parse(initial.stdout).enabled, false);
  const setup = await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto', '--dashboard',
    '--allow-host', 'lattice.kitepon.dev', '--allow-host', 'dashboard.example', '--json']);
  assert.equal(setup.code, 0, setup.stderr);
  const setupPort = JSON.parse(setup.stdout).listen.port;
  assert.ok(Number.isSafeInteger(setupPort) && setupPort >= 49_152);
  assert.deepEqual(JSON.parse(setup.stdout).allowed_hosts,
    ['127.0.0.1', 'dashboard.example', 'lattice.kitepon.dev']);
  const changed = await invoke(['reconfigure', '--upstream', 'http://127.0.0.1:4318', '--json']);
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).upstream.mode, 'url');
  const disabled = await invoke(['disable', '--json']);
  assert.equal(disabled.code, 0);
  assert.equal(JSON.parse(disabled.stdout).enabled, false);
  assert.deepEqual(calls, [`install:${setupPort}`, `install:${setupPort}`, 'disable']);
});

test('bridge CLIは--hubの設定・持ち越し・noneでの解除をJSON契約で提供する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-cli-hub-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble();
  const invoke = async (argv) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent, ensureDashboard: async () => {},
      verifyDelivery: async () => ({ state: 'hub_delivered' }) });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const setup = await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto', '--dashboard',
    '--hub', 'http://192.168.1.2:8080', '--json']);
  assert.equal(setup.code, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout).hub, { url: 'http://192.168.1.2:8080/' });
  const carried = await invoke(['reconfigure', '--upstream', 'http://127.0.0.1:4318', '--json']);
  assert.equal(carried.code, 0, carried.stderr);
  assert.deepEqual(JSON.parse(carried.stdout).hub, { url: 'http://192.168.1.2:8080/' },
    'reconfigure without --hub must carry the current hub forward, matching --upstream');
  const cleared = await invoke(['reconfigure', '--hub', 'none', '--json']);
  assert.equal(cleared.code, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).hub, null);
  const status = await invoke(['status', '--json']);
  assert.equal(JSON.parse(status.stdout).hub, null);
});

test('statusは常駐設定の実行対象の消滅を名指しし、reconfigureのremedyを返す', async (context) => {
  // 実被弾（2026-08-08・2026-08-10）の症状は「公開viewerから端末が消えた」だけで、
  // 原因特定にlaunchctl/psの手掘りが要った。statusが1回で答えられなければ直っていない。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-persistence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble({ described: {
    node_path: '/opt/homebrew/Cellar/node/26.5.1/bin/node', node_exists: false,
    bridge_path: '/usr/local/lib/node_modules/@quolu/lattice/bin/lattice-bridge.mjs',
    bridge_exists: true } });
  const invoke = async (argv, overrides = {}) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent, ...overrides });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json'])).code, 0);

  const status = await invoke(['status', '--json'],
    { runtimeIdentity: runtimeIdentityDouble({ state: 'unattested', pid: 4321, version: null,
      node_path: null, node_version: null, bridge_path: null }) });
  assert.equal(status.code, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.schema, 'lattice.bridge_cli_result.v4');
  assert.equal(parsed.persistence.state, 'installed');
  assert.equal(parsed.persistence.node_path, '/opt/homebrew/Cellar/node/26.5.1/bin/node');
  assert.equal(parsed.persistence.node_exists, false);
  assert.equal(parsed.runtime.state, 'unattested');
  assert.equal(parsed.remedy, 'lattice bridge reconfigure --json',
    '起動対象が消えている状態は、必ず打つべきコマンドまで出さなければ手掘りが残る');
});

test('bridge有効なのに常駐設定が無い状態にもremedyを出す（再起動で戻らない）', async (context) => {
  // 手でplistを消した後などに起きる。いま走っているdaemonが最後の1つで、
  // 再起動すれば二度と戻らない。reachable=trueのまま黙るのが最悪の面である。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-not-installed-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble();
  const invoke = async (argv) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json'])).code, 0);
  await launchAgent.disable();

  const parsed = JSON.parse((await invoke(['status', '--json'])).stdout);
  assert.equal(parsed.enabled, true, '設定は有効なまま');
  assert.equal(parsed.persistence.state, 'not_installed');
  assert.equal(parsed.remedy, 'lattice bridge reconfigure --json');
});

test('statusは実走processと常駐設定の乖離を分類し、自己解消する版差にremedyを出さない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-drift-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const globalBridge = '/usr/local/lib/node_modules/@quolu/lattice/bin/lattice-bridge.mjs';
  const launchAgent = launchAgentDouble({ described: { node_path: '/opt/homebrew/bin/node',
    node_exists: true, bridge_path: globalBridge, bridge_exists: true } });
  const invoke = async (argv, overrides = {}) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent, ...overrides });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json'])).code, 0);
  const running = (extra) => runtimeIdentityDouble({ state: 'running', pid: 777, version: null,
    node_path: null, node_version: 'v26.7.0', bridge_path: globalBridge, ...extra });

  // npm更新後の版差はdaemon自身が版drift検知で降りて再起動するので自己解消する。
  const versionOnly = JSON.parse((await invoke(['status', '--json'],
    { runtimeIdentity: running({ version: '0.0.0-stale' }) })).stdout);
  assert.deepEqual(versionOnly.runtime_drift, ['version']);
  assert.equal(versionOnly.remedy, null, '自己解消する差にコマンドを出すと本物の障害が埋もれる');

  // dev treeの残骸が走っている状態は自己解消しない。
  const treeDrift = JSON.parse((await invoke(['status', '--json'],
    { runtimeIdentity: running({ bridge_path: '/Users/kite/Developer/Lattice/bin/lattice-bridge.mjs' }) })).stdout);
  assert.deepEqual(treeDrift.runtime_drift, ['bridge_path']);
  assert.equal(treeDrift.remedy, 'lattice bridge reconfigure --json');
});

test('bridge registerはbridge無効なら拒否し、registrar未設定ならnot_configuredを返す', async (context) => {
  // 出荷しているのにCLIから一度も走らせていないコマンドを残さない。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-register-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble();
  const invoke = async (argv) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };

  // bridgeが無効なうちは登録するものが無い。黙って成功扱いしない。
  const disabled = await invoke(['register', '--json']);
  assert.notEqual(disabled.code, 0);
  assert.equal(JSON.parse(disabled.stderr).code, 'BRIDGE_DISABLED');

  const setup = await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json']);
  assert.equal(setup.code, 0);

  // registrarのssh設定が無い環境では、失敗ではなくnot_configuredとして返す。
  const registered = await invoke(['register', '--json']);
  assert.equal(registered.code, 0, registered.stderr);
  const result = JSON.parse(registered.stdout);
  assert.equal(result.state, 'not_configured');
  assert.equal(result.port, JSON.parse(setup.stdout).listen.port);
});

test('bridge CLIは非JSON・低port・未知flagをtyped errorにする', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-cli-fail-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const argv of [
    ['setup'],
    ['setup', '--port', '4318', '--json'],
    ['setup', '--wat', '--json'],
  ]) {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env: { LATTICE_CONFIG_DIR: root }, daemon: { ensure: async () => {}, stop: async () => {} },
      launchAgent: launchAgentDouble() });
    assert.notEqual(code, 0);
    assert.equal(JSON.parse(stderr.read()).schema, 'lattice.cli_error.v2');
  }
});

test('daemon bind失敗はsetup configをrollbackし成功を返さない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-cli-rollback-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = output(); const stderr = output();
  const failure = Object.assign(new Error('bind failed'), { code: 'BRIDGE_DAEMON_UNAVAILABLE' });
  const launchAgent = launchAgentDouble({ install: async () => { throw failure; } });
  const code = await runBridgeCli({
    argv: ['setup', '--listen', '127.0.0.1', '--port', 'auto', '--json'],
    stdout: stdout.stream, stderr: stderr.stream, env: { LATTICE_CONFIG_DIR: root },
    daemon: { ensure: async () => {}, stop: async () => {} }, launchAgent,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr.read()).code, 'BRIDGE_DAEMON_UNAVAILABLE');
  const statusOut = output();
  await runBridgeCli({ argv: ['status', '--json'], stdout: statusOut.stream, stderr: output().stream,
    env: { LATTICE_CONFIG_DIR: root } });
  assert.equal(JSON.parse(statusOut.read()).configured, false);
});

test('reconfigureのLaunchAgent起動失敗は旧config・旧agent・旧daemon所有状態へrollbackする',
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-agent-rollback-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const env = { LATTICE_CONFIG_DIR: root };
    let installCount = 0;
    const launchAgent = launchAgentDouble({ install: async () => {
      installCount += 1;
      if (installCount === 2) {
        throw Object.assign(new Error('bootstrap failed'), { code: 'BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED' });
      }
    } });
    const daemon = { ensure: async () => { throw new Error('loaded agent rollback must own daemon'); },
      stop: async () => {} };
    const invoke = async (argv) => {
      const stdout = output(); const stderr = output();
      const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
        env, daemon, launchAgent });
      return { code, stdout: stdout.read(), stderr: stderr.read() };
    };
    assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
      '--dashboard', '--json'])).code, 0);
    const original = await readBridgeConfig({ env });
    const failed = await invoke(['reconfigure', '--port', 'auto', '--json']);
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stderr).code, 'BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED');
    assert.deepEqual(await readBridgeConfig({ env }), original);
    assert.deepEqual(launchAgent.state(), { installed: true, loaded: true, content: '<plist/>' });
  });

test('対話setup wizardは安全側confirmからlisten/port/upstreamを収集して実行する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-wizard-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const answers = [true, '127.0.0.1', 'custom', '58750', 'dashboard', 'lattice.kitepon.dev'];
  const prompts = { isCancel: () => false,
    confirm: async () => answers.shift(), text: async () => answers.shift(), select: async () => answers.shift() };
  const stdout = output(true); const stderr = output();
  const code = await runBridgeCli({ argv: ['setup'], stdin: { isTTY: true }, stdout: stdout.stream,
    stderr: stderr.stream, env: { LATTICE_CONFIG_DIR: root }, prompts,
    daemon: { ensure: async () => {}, stop: async () => {} }, launchAgent: launchAgentDouble() });
  assert.equal(code, 0, stderr.read());
  assert.match(stdout.read(), /127\.0\.0\.1:58750/u);
  const statusOut = output();
  await runBridgeCli({ argv: ['status', '--json'], stdout: statusOut.stream, stderr: output().stream,
    env: { LATTICE_CONFIG_DIR: root } });
  const status = JSON.parse(statusOut.read());
  assert.equal(status.listen.port, 58_750);
  assert.deepEqual(status.allowed_hosts, ['127.0.0.1', 'lattice.kitepon.dev']);
});

test('wizardのenable拒否/cancelはconfigを変更せず非TTYはhangせず案内する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-wizard-cancel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = output(true); const stderr = output();
  const launchAgent = launchAgentDouble();
  const code = await runBridgeCli({ argv: ['setup'], stdin: { isTTY: true }, stdout: stdout.stream,
    stderr: stderr.stream, env: { LATTICE_CONFIG_DIR: root },
    prompts: { isCancel: () => false, confirm: async () => false },
    daemon: { ensure: async () => { throw new Error('must not run'); }, stop: async () => {} }, launchAgent });
  assert.equal(code, 0);
  assert.match(stdout.read(), /変更していません/u);
  const canceled = Symbol('cancel');
  const canceledOut = output(true);
  const canceledCode = await runBridgeCli({ argv: ['setup'], stdin: { isTTY: true }, stdout: canceledOut.stream,
    stderr: output().stream, env: { LATTICE_CONFIG_DIR: root },
    prompts: { isCancel: (value) => value === canceled, confirm: async () => true, text: async () => canceled },
    daemon: { ensure: async () => { throw new Error('must not run'); }, stop: async () => {} }, launchAgent });
  assert.equal(canceledCode, 0);
  assert.match(canceledOut.read(), /変更していません/u);
  const nonTtyError = output();
  const nonTty = await runBridgeCli({ argv: ['setup'], stdin: { isTTY: false }, stdout: output().stream,
    stderr: nonTtyError.stream, env: { LATTICE_CONFIG_DIR: root }, launchAgent });
  assert.equal(nonTty, 2);
  assert.equal(JSON.parse(nonTtyError.read()).code, 'BRIDGE_SETUP_REQUIRES_TTY');
  const statusOut = output();
  await runBridgeCli({ argv: ['status', '--json'], stdout: statusOut.stream, stderr: output().stream,
    env: { LATTICE_CONFIG_DIR: root } });
  assert.equal(JSON.parse(statusOut.read()).configured, false);
});

test('lifecycle operation lockは遅延失敗Aのrollbackが後発成功Bを消さない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-operation-lock-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  let releaseA;
  let enteredA;
  const aEntered = new Promise((resolve) => { enteredA = resolve; });
  const aGate = new Promise((resolve) => { releaseA = resolve; });
  let firstInstall = true;
  const launchAgent = launchAgentDouble({ install: async () => {
    if (!firstInstall) return;
    firstInstall = false;
    enteredA();
    await aGate;
    throw Object.assign(new Error('A failed'), { code: 'A_FAILED' });
  } });
  const invoke = (argv, daemon) => {
    const stdout = output(); const stderr = output();
    return runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream, env, daemon, launchAgent })
      .then((code) => ({ code, stdout: stdout.read(), stderr: stderr.read() }));
  };
  const first = invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--upstream', 'http://127.0.0.1:4318', '--json'], { ensure: async () => {}, stop: async () => {} });
  await aEntered;
  const second = invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--upstream', 'http://127.0.0.1:4319', '--json'], { ensure: async () => {}, stop: async () => {} });
  releaseA();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 1);
  assert.equal(b.code, 0, b.stderr);
  const statusOut = output();
  await runBridgeCli({ argv: ['status', '--json'], stdout: statusOut.stream, stderr: output().stream, env });
  const final = JSON.parse(statusOut.read());
  assert.equal(final.listen.port, JSON.parse(b.stdout).listen.port);
  assert.equal(final.upstream.url, 'http://127.0.0.1:4319/');
});

test('disableはdaemon停止受領証が得られなければ設定を消さず失敗する', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-stop-gate-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const installedAgent = launchAgentDouble();
  const invoke = async (argv, daemon, launchAgent = installedAgent) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const daemon = { ensure: async () => {}, requestStop: async () => {
    throw Object.assign(new Error('stop receipt timed out'), { code: 'BRIDGE_DAEMON_STOP_FAILED' });
  } };
  assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json'], daemon)).code, 0);
  const unmanagedAgent = launchAgentDouble();
  const disabled = await invoke(['disable', '--json'], daemon, unmanagedAgent);
  assert.equal(disabled.code, 1);
  assert.equal(JSON.parse(disabled.stderr).code, 'BRIDGE_DAEMON_STOP_FAILED');
  assert.equal((await readBridgeConfig({ env })).enabled, true);
});

test('setupはdev treeからの常駐化を警告し、global install配下では黙る', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-devtree-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble();
  const invoke = async (argv, bridgePath) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent, bridgePath });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  const fromTree = await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto', '--dashboard', '--json'],
    '/Users/kite/Developer/Lattice/bin/lattice-bridge.mjs');
  assert.equal(fromTree.code, 0, fromTree.stderr);
  assert.deepEqual(JSON.parse(fromTree.stdout).warnings.map((warning) => warning.code),
    ['BRIDGE_PERSISTED_FROM_DEVELOPMENT_TREE']);
  const fromGlobal = await invoke(['reconfigure', '--json'],
    '/usr/local/lib/node_modules/@quolu/lattice/bin/lattice-bridge.mjs');
  assert.deepEqual(JSON.parse(fromGlobal.stdout).warnings, []);
});

test('statusはhubに拒否されたprojectを名指しし、止め方をremedyに出す', async (context) => {
  // 拒否はdaemonのstderrにしか出ず、LaunchAgentはStandardErrorPathを持たない。
  // 利用者に見えるのは「新規projectが公開工程表に出ない」だけだった（2026-08-10）。
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-heartbeat-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CONFIG_DIR: root };
  const daemon = { ensure: async () => {}, stop: async () => {} };
  const launchAgent = launchAgentDouble();
  const invoke = async (argv, overrides = {}) => {
    const stdout = output(); const stderr = output();
    const code = await runBridgeCli({ argv, stdout: stdout.stream, stderr: stderr.stream,
      env, daemon, launchAgent, ...overrides });
    return { code, stdout: stdout.read(), stderr: stderr.read() };
  };
  assert.equal((await invoke(['setup', '--listen', '127.0.0.1', '--port', 'auto',
    '--dashboard', '--json'])).code, 0);

  const running = (lastHeartbeat) => runtimeIdentityDouble({ state: 'running', pid: 4242,
    version: null, node_path: null, node_version: null, bridge_path: null, last_heartbeat: lastHeartbeat });

  const partial = JSON.parse((await invoke(['status', '--json'], {
    runtimeIdentity: running({ state: 'partial', at: '2026-08-10T05:00:00.000Z',
      rejected_projects: ['lattice'], reclaimed_projects: [], detail: null }),
  })).stdout);
  assert.equal(partial.runtime.last_heartbeat.state, 'partial');
  assert.deepEqual(partial.runtime.last_heartbeat.rejected_projects, ['lattice']);
  assert.equal(partial.remedy, 'lattice todo dashboard remove lattice --json');

  // 全部受理されている時に警告を出すと、本物の拒否が埋もれる。
  const accepted = JSON.parse((await invoke(['status', '--json'], {
    runtimeIdentity: running({ state: 'accepted', at: '2026-08-10T05:00:00.000Z',
      rejected_projects: [], reclaimed_projects: [], detail: null }),
  })).stdout);
  assert.equal(accepted.remedy, null);
});
