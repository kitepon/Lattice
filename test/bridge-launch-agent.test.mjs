import assert from 'node:assert/strict';
import {
  chmod, lstat, mkdir, readFile, realpath, rm, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// launchdはmacOS専用である。LinuxでこのtestをまわしてもLaunchAgentという概念が無く、
// 失敗はhostのnode配置（group-writableなruntime）を反映しているだけで製品の欠陥ではない。
// 実測: ubuntu runnerで7件が`node executable is unsafe`になっていた。
const macOnly = { skip: process.platform === 'darwin' ? false : 'launchd is macOS only' };

import {
  BRIDGE_LAUNCH_AGENT_LABEL, bridgeLaunchAgentPaths, describeBridgeLaunchAgent,
  disableBridgeLaunchAgent, installBridgeLaunchAgent, restoreBridgeLaunchAgent,
  snapshotBridgeLaunchAgent, waitForBridgeLaunchAgentReady,
} from '../src/bridge-launch-agent.mjs';
import { writeBridgeDaemonDescriptor } from '../src/bridge-daemon.mjs';
import { configureBridge } from '../src/bridge-config.mjs';

/** homebrew相当の版付きnode実体と、それを指す安定alias。 */
async function nodeTree(root, version) {
  const cellar = path.join(root, 'Cellar', 'node', version, 'bin');
  const stable = path.join(root, 'bin');
  await mkdir(cellar, { recursive: true });
  await mkdir(stable, { recursive: true });
  await writeFile(path.join(cellar, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await rm(path.join(stable, 'node'), { force: true });
  await symlink(path.join(cellar, 'node'), path.join(stable, 'node'));
  return { cellar, stable, resolved: await realpath(path.join(cellar, 'node')) };
}

async function fixture(context, prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { HOME: path.join(root, 'home'), LATTICE_CONFIG_DIR: path.join(root, 'config') } };
}

function launchctlDouble({ lingerPrints = 0 } = {}) {
  let loaded = false;
  let lingering = 0;
  let bootstrapFailure = false;
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'print') {
      if (lingering > 0) {
        lingering -= 1;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: loaded ? 0 : 113, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootout') {
      lingering = lingerPrints;
      loaded = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootstrap') {
      if (lingering > 0 || loaded) {
        return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };
      }
      if (bootstrapFailure) return { code: 5, stdout: '', stderr: 'failed' };
      loaded = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'enable') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected launchctl call: ${args.join(' ')}`);
  };
  return { runner, calls, isLoaded: () => loaded, reboot: () => { loaded = false; },
    failBootstrap: () => { bootstrapFailure = true; } };
}

test('ready判定は設定IPでなくattested descriptorの実bindingを待つ', async (context) => {
  const { env } = await fixture(context, 'lattice-launch-ready-rebound-');
  await mkdir(env.LATTICE_CONFIG_DIR, { recursive: true });
  const reserved = await configureBridge({ address: '127.0.0.1', env });
  const instanceToken = 'e'.repeat(64);
  const server = createServer((request, response) => {
    if (request.headers['x-lattice-bridge-instance-token'] !== instanceToken) {
      response.writeHead(403); response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ schema: 'lattice.bridge_health.v1', pid: process.pid,
      address: '127.0.0.1', port: server.address().port,
      updated_at: '2026-09-22T00:00:00.000Z' })}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: reserved.listen.port }, resolve);
  });
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const config = { enabled: true, listen: { address: '127.0.0.9', port: server.address().port },
    updated_at: '2026-09-22T00:00:00.000Z' };
  await writeBridgeDaemonDescriptor({ config, binding: { address: '127.0.0.1', port: config.listen.port },
    env: { ...env, LATTICE_BRIDGE_INSTANCE_TOKEN: instanceToken } });
  const ready = await waitForBridgeLaunchAgentReady({ config, instanceToken, env, timeoutMs: 300 });
  assert.equal(ready.address, '127.0.0.1');
});

function config(port, updatedAt = '2026-07-21T00:00:00.000Z') {
  return { enabled: true, listen: { address: '127.0.0.1', port }, updated_at: updatedAt };
}

test('LaunchAgentは引数分離した絶対pathとKeepAlive/RunAtLoadを0600 plistへatomic installする', macOnly,
  async (context) => {
    const { env } = await fixture(context, 'lattice-launch-agent-install-');
    const control = launchctlDouble();
    let ready;
    await installBridgeLaunchAgent({ config: config(58_760), env, runner: control.runner,
      waitReady: async (value) => { ready = value; return { pid: 42 }; } });
    const refs = bridgeLaunchAgentPaths(env);
    const stats = await lstat(refs.plist);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.isSymbolicLink(), false);
    assert.equal(stats.mode & 0o777, 0o600);
    const content = await readFile(refs.plist, 'utf8');
    assert.match(content, new RegExp(`<string>${BRIDGE_LAUNCH_AGENT_LABEL}</string>`, 'u'));
    assert.match(content, /<key>ProgramArguments<\/key>[\s\S]*<string>\/.*node<\/string>[\s\S]*lattice-bridge\.mjs<\/string>/u);
    assert.match(content, /<key>RunAtLoad<\/key>\s*<true\/>/u);
    assert.match(content, /<key>KeepAlive<\/key>\s*<true\/>/u);
    assert.match(content, /<key>LATTICE_CONFIG_DIR<\/key>/u);
    assert.match(ready.instanceToken, /^[0-9a-f]{64}$/u);
    assert.equal(control.isLoaded(), true);
    assert.equal(control.calls.at(-1)[0], 'bootstrap');
  });

test('bootout直後にprintが残っている間はbootstrapせず、消えてから載せる', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-unload-');
  const control = launchctlDouble({ lingerPrints: 3 });
  const order = [];
  const runner = async (args) => {
    order.push(args[0]);
    return control.runner(args);
  };
  await installBridgeLaunchAgent({ config: config(58_768), env, runner,
    waitReady: async () => {}, waitStopped: async () => {} });
  await installBridgeLaunchAgent({ config: config(58_769, '2026-07-21T00:01:00.000Z'), env, runner,
    previousListen: config(58_768).listen, waitReady: async () => {}, waitStopped: async () => {} });
  const second = order.slice(order.indexOf('bootout'));
  const bootstrapAt = second.indexOf('bootstrap');
  assert.ok(bootstrapAt > 0, 'reconfigureはbootoutのあとbootstrapする');
  assert.equal(second.slice(0, bootstrapAt).filter((name) => name === 'print').length >= 4, true,
    'bootout後のprint 113を待ってからbootstrapする');
  assert.equal(control.isLoaded(), true);
});

test('launchctl bootstrap失敗はexit codeとstderrをdetailへ残す', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-bootstrap-detail-');
  const control = launchctlDouble();
  control.failBootstrap();
  await assert.rejects(installBridgeLaunchAgent({ config: config(58_770), env,
    runner: control.runner, waitReady: async () => {} }), (error) => {
    assert.equal(error.code, 'BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED');
    assert.deepEqual(error.detail, { launchctl_code: 5, stderr: 'failed' });
    return true;
  });
});

test('reconfigureは旧service停止確認後にplistを置換し、新しいserviceのreadyを待つ', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-reconfigure-');
  const control = launchctlDouble();
  const stopped = [];
  const ready = [];
  const common = { env, runner: control.runner,
    waitStopped: async ({ listen }) => { stopped.push(listen); },
    waitReady: async ({ config: value }) => { ready.push(value.listen.port); } };
  await installBridgeLaunchAgent({ ...common, config: config(58_761) });
  const first = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  await installBridgeLaunchAgent({ ...common,
    config: config(58_762, '2026-07-21T00:01:00.000Z'), previousListen: config(58_761).listen });
  const second = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  assert.notEqual(first, second);
  assert.deepEqual(stopped, [config(58_761).listen]);
  assert.deepEqual(ready, [58_761, 58_762]);
  assert.ok(control.calls.some((args) => args[0] === 'bootout'));
});

test('disableはbootoutとsocket停止確認の後だけplistを除去し、snapshotから復旧できる', macOnly,
  async (context) => {
    const { env } = await fixture(context, 'lattice-launch-agent-disable-');
    const control = launchctlDouble();
    await installBridgeLaunchAgent({ config: config(58_763), env, runner: control.runner,
      waitReady: async () => {} });
    const snapshot = await snapshotBridgeLaunchAgent({ env, runner: control.runner });
    const stopped = [];
    await disableBridgeLaunchAgent({ snapshot, listen: config(58_763).listen, env, runner: control.runner,
      waitStopped: async ({ listen }) => { stopped.push(listen); } });
    await assert.rejects(readFile(bridgeLaunchAgentPaths(env).plist), { code: 'ENOENT' });
    assert.deepEqual(stopped, [config(58_763).listen]);
    assert.equal(control.isLoaded(), false);
    await restoreBridgeLaunchAgent({ snapshot, config: config(58_763), env, runner: control.runner,
      waitStopped: async () => {}, waitReady: async () => {} });
    assert.equal(await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8'), snapshot.content);
    assert.equal(control.isLoaded(), true);
  });

test('split rollbackは存在しないplistをbootstrapせず、分裂状態を忠実に戻す', macOnly,
  async (context) => {
    const { env } = await fixture(context, 'lattice-launch-agent-split-');
    const control = launchctlDouble();
    const snapshot = { installed: false, loaded: true, split: true, content: null };
    const restored = await restoreBridgeLaunchAgent({ snapshot, env, runner: control.runner });
    assert.deepEqual(restored, snapshot);
    assert.equal(control.calls.filter((args) => args[0] === 'bootstrap').length, 0);
    assert.equal(control.isLoaded(), false);
  });

test('再起動後も永続plistから同じProgramArguments/environmentでbootstrapできる', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-reboot-');
  const control = launchctlDouble();
  await installBridgeLaunchAgent({ config: config(58_764), env, runner: control.runner,
    waitReady: async () => {} });
  const before = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  control.reboot();
  assert.equal(control.isLoaded(), false);
  const snapshot = await snapshotBridgeLaunchAgent({ env, runner: control.runner });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.loaded, false);
  await control.runner(['bootstrap', `gui/${process.getuid()}`, bridgeLaunchAgentPaths(env).plist]);
  assert.equal(control.isLoaded(), true);
  assert.equal(await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8'), before);
});

test('launchctl bootstrap失敗はtyped errorで、symlink/緩いmode plistは変更前に拒否する', macOnly,
  async (context) => {
    const { root, env } = await fixture(context, 'lattice-launch-agent-fail-');
    const control = launchctlDouble();
    control.failBootstrap();
    await assert.rejects(installBridgeLaunchAgent({ config: config(58_765), env,
      runner: control.runner, waitReady: async () => {} }), { code: 'BRIDGE_LAUNCHCTL_BOOTSTRAP_FAILED' });

    const refs = bridgeLaunchAgentPaths(env);
    await rm(refs.plist, { force: true });
    const target = path.join(root, 'target.plist');
    await writeFile(target, 'unsafe', { mode: 0o600 });
    await symlink(target, refs.plist);
    await assert.rejects(snapshotBridgeLaunchAgent({ env, runner: control.runner }),
      { code: 'BRIDGE_LAUNCH_AGENT_PLIST_UNSAFE' });
    await rm(refs.plist);
    await writeFile(refs.plist, 'unsafe', { mode: 0o644 });
    await chmod(refs.plist, 0o644);
    await assert.rejects(snapshotBridgeLaunchAgent({ env, runner: control.runner }),
      { code: 'BRIDGE_LAUNCH_AGENT_PLIST_UNSAFE' });
  });

test('plistは版付き実体でなく安定aliasを焼き、node更新後も実行対象が生き残る', macOnly, async (context) => {
  // 2026-08-08と2026-08-10に実被弾した経路そのもの。brew upgrade nodeで旧Cellarが
  // 消えるとProgramArgumentsの実行対象が消滅し、KeepAliveが空回りするだけで
  // どこにもエラーが出ず、症状は「公開viewerから端末が消えた」だけになる。
  const { root, env } = await fixture(context, 'lattice-launch-agent-node-upgrade-');
  const control = launchctlDouble();
  const before = await nodeTree(root, '26.7.0');
  await installBridgeLaunchAgent({ config: config(58_766),
    env: { ...env, PATH: before.stable }, runner: control.runner,
    nodePath: before.resolved, waitReady: async () => {} });
  const content = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  assert.match(content, new RegExp(`<string>${path.join(before.stable, 'node')}</string>`, 'u'));
  assert.doesNotMatch(content, /26\.7\.0/u, '版付きpathを焼いた時点でnode更新に殺される');

  // brew upgrade node: 旧Cellarが消え、aliasが新しい実体を指す。
  await rm(path.join(root, 'Cellar', 'node', '26.7.0'), { recursive: true, force: true });
  await nodeTree(root, '26.8.0');
  const snapshot = await snapshotBridgeLaunchAgent({ env, runner: control.runner });
  const described = await describeBridgeLaunchAgent({ snapshot });
  assert.equal(described.node_exists, true, 'node更新後もlaunchdの実行対象は存在していなければならない');
  assert.equal(described.bridge_exists, true);
});

test('安定aliasが無い環境では版付きpathを焼き、消滅をstatusが読める形で報告する', macOnly, async (context) => {
  // 安定aliasを検証できない環境（nvm等）では起動継続は原理的に保証できない。
  // その時に守るべき条件は「継続」ではなく「沈黙しないこと」である。
  const { root, env } = await fixture(context, 'lattice-launch-agent-node-pinned-');
  const control = launchctlDouble();
  const tree = await nodeTree(root, '26.7.0');
  await unlink(path.join(tree.stable, 'node'));
  await installBridgeLaunchAgent({ config: config(58_767),
    env: { ...env, PATH: path.join(root, 'absent') }, runner: control.runner,
    nodePath: tree.resolved, waitReady: async () => {} });
  assert.match(await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8'), /26\.7\.0/u);

  const live = await describeBridgeLaunchAgent({
    snapshot: await snapshotBridgeLaunchAgent({ env, runner: control.runner }) });
  assert.equal(live.node_exists, true);
  await rm(path.join(root, 'Cellar', 'node', '26.7.0'), { recursive: true, force: true });
  const dead = await describeBridgeLaunchAgent({
    snapshot: await snapshotBridgeLaunchAgent({ env, runner: control.runner }) });
  assert.equal(dead.node_path, tree.resolved);
  assert.equal(dead.node_exists, false, '実行対象の消滅は必ず読み取れなければならない');
});

test('registrar設定はplistへ焼き込まれる（launchdはshell環境を継承しない）', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-registrar-');
  const control = launchctlDouble();
  await installBridgeLaunchAgent({
    config: config(58_761),
    env: { ...env,
      LATTICE_BRIDGE_REGISTRAR_SSH_HOST: 'main-server',
      LATTICE_BRIDGE_REGISTRAR_SCRIPT: '/home/kite/license-server/bin/lattice-bridge-register.sh' },
    runner: control.runner,
    waitReady: async () => ({ pid: 43 }),
  });
  const content = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  assert.match(content, /<key>LATTICE_BRIDGE_REGISTRAR_SSH_HOST<\/key>\s*<string>main-server<\/string>/u);
  assert.match(content, /<key>LATTICE_BRIDGE_REGISTRAR_SCRIPT<\/key>\s*<string>\/home\/kite\/license-server\/bin\/lattice-bridge-register\.sh<\/string>/u);
});

test('registrar未設定のplistには登録用の環境変数を入れない', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-no-registrar-');
  const control = launchctlDouble();
  await installBridgeLaunchAgent({ config: config(58_762), env, runner: control.runner,
    waitReady: async () => ({ pid: 44 }) });
  const content = await readFile(bridgeLaunchAgentPaths(env).plist, 'utf8');
  assert.doesNotMatch(content, /LATTICE_BRIDGE_REGISTRAR/u);
});

test('registrarが片側だけの環境ではLaunchAgentを入れずtypedに落とす', macOnly, async (context) => {
  const { env } = await fixture(context, 'lattice-launch-agent-partial-registrar-');
  const control = launchctlDouble();
  await assert.rejects(
    installBridgeLaunchAgent({ config: config(58_763),
      env: { ...env, LATTICE_BRIDGE_REGISTRAR_SSH_HOST: 'main-server' },
      runner: control.runner, waitReady: async () => ({ pid: 45 }) }),
    (error) => error?.code === 'BRIDGE_REGISTRAR_INVALID',
  );
});
