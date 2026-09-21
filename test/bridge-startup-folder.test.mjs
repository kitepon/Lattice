import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// This module's file operations are platform-agnostic (plain fs calls), but
// its module-doc rationale (Task Scheduler ONLOGON needs elevation, wscript
// hides the console) is Windows-specific. Running the file-shape assertions
// on any OS still verifies the logic; only the *meaning* is Windows-only.
// Real end-to-end verification (does wscript.exe actually start the
// supervisor, does taskkill /T /F actually stop the whole tree) can only
// happen on real Windows and was done by hand against a live machine, not in
// this suite — see evidence/bridge-hub for that record.
import {
  BRIDGE_STARTUP_LABEL, bridgeStartupFolderPaths, describeBridgeStartupFolder,
  disableBridgeStartupFolder, installBridgeStartupFolder, restoreBridgeStartupFolder,
  snapshotBridgeStartupFolder, waitForBridgeStartupReady,
} from '../src/bridge-startup-folder.mjs';
import { writeBridgeDaemonDescriptor } from '../src/bridge-daemon.mjs';
import { configureBridge } from '../src/bridge-config.mjs';

async function fixture(context, prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      APPDATA: path.join(root, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      LATTICE_CONFIG_DIR: path.join(root, 'config'),
    },
  };
}

function taskkillDouble() {
  let running = false;
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'wscript.exe') { running = true; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'taskkill.exe') {
      if (!running) return { code: 128, stdout: '', stderr: 'ERROR: The process not found.' };
      running = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  return { runner, calls, isRunning: () => running, kill: () => { running = false; } };
}

function config(port, updatedAt = '2026-07-21T00:00:00.000Z') {
  return { enabled: true, listen: { address: '192.168.1.11', port }, updated_at: updatedAt };
}

test('Startup ready判定は設定IPでなくattested descriptorの実bindingを待つ', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-ready-rebound-');
  await mkdir(env.LATTICE_CONFIG_DIR, { recursive: true });
  const reserved = await configureBridge({ address: '127.0.0.1', env });
  const instanceToken = 'f'.repeat(64);
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
  const value = { enabled: true, listen: { address: '127.0.0.9', port: server.address().port },
    updated_at: '2026-09-22T00:00:00.000Z' };
  await writeBridgeDaemonDescriptor({ config: value,
    binding: { address: '127.0.0.1', port: value.listen.port },
    env: { ...env, LATTICE_BRIDGE_INSTANCE_TOKEN: instanceToken } });
  const ready = await waitForBridgeStartupReady({ config: value, instanceToken, env, timeoutMs: 300 });
  assert.equal(ready.address, '127.0.0.1');
});

test('installは絶対pathの引用符付き起動scriptとdescriptorをatomic writeし、supervisorへ即座に渡す', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-install-');
  const control = taskkillDouble();
  let ready;
  await installBridgeStartupFolder({ config: config(58_770), env, runner: control.runner,
    waitReady: async (value) => { ready = value; return { pid: 42 }; } });
  const refs = bridgeStartupFolderPaths(env);
  const launcherContent = await readFile(refs.launcher, 'utf8');
  assert.match(launcherContent, /CreateObject\("WScript\.Shell"\)/u);
  assert.match(launcherContent, /shell\.Run """.*node.*""" & " " & """.*lattice-bridge-supervisor\.mjs""" & " " & """.*descriptor\.json""", 0, False/u);
  const descriptorContent = JSON.parse(await readFile(refs.descriptor, 'utf8'));
  assert.equal(descriptorContent.schema, 'lattice.bridge_supervisor_descriptor.v1');
  assert.match(descriptorContent.bridgePath, /lattice-bridge\.mjs$/u);
  assert.equal(descriptorContent.pidPath, refs.pidfile);
  assert.match(descriptorContent.env.LATTICE_BRIDGE_INSTANCE_TOKEN, /^[0-9a-f]{64}$/u);
  assert.equal(descriptorContent.env.LATTICE_CONFIG_DIR, env.LATTICE_CONFIG_DIR);
  assert.match(ready.instanceToken, /^[0-9a-f]{64}$/u);
  assert.deepEqual(control.calls.at(-1), ['wscript.exe', refs.launcher]);
});

test('launcherは検証済みの安定aliasを焼き、describeが実行対象と実在を返す', async (context) => {
  // nvm-windowsのjunction差し替えは、homebrewのCellar削除と同じ形で起動対象を
  // 消す。焼くのは実体pathでなくstableNodePathが検証した側でなければならない。
  const { root, env } = await fixture(context, 'lattice-startup-stable-node-');
  const control = taskkillDouble();
  const stable = path.join(root, 'nodejs', 'node.exe');
  await mkdir(path.dirname(stable), { recursive: true });
  await writeFile(stable, 'binary', { mode: 0o755 });
  const asked = [];
  await installBridgeStartupFolder({ config: config(58_776), env, runner: control.runner,
    stableNode: async ({ resolved }) => { asked.push(resolved); return stable; },
    waitReady: async () => {} });
  assert.equal(asked.length, 1, '実体pathを解決してから安定aliasを問い合わせる');
  const launcherContent = await readFile(bridgeStartupFolderPaths(env).launcher, 'utf8');
  assert.ok(launcherContent.includes(`"""${stable}"""`), launcherContent);

  const described = await describeBridgeStartupFolder({
    snapshot: await snapshotBridgeStartupFolder({ env }) });
  assert.equal(described.node_path, stable);
  assert.equal(described.node_exists, true);
  assert.match(described.bridge_path, /lattice-bridge\.mjs$/u);
  assert.equal(described.bridge_exists, true);

  // node実体が消えた状態は必ず読み取れる（KeepAlive相当の空回りを黙らせない）。
  await rm(stable, { force: true });
  const dead = await describeBridgeStartupFolder({
    snapshot: await snapshotBridgeStartupFolder({ env }) });
  assert.equal(dead.node_path, stable);
  assert.equal(dead.node_exists, false);
});

test('未installのstartup folderはdescribeでnullを返す（存在しないものを説明しない）', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-describe-absent-');
  assert.equal(await describeBridgeStartupFolder({
    snapshot: await snapshotBridgeStartupFolder({ env }) }), null);
});

test('launcherだけ残る分裂状態はsnapshotで記録し、復旧経路を拒否しない', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-split-');
  const refs = bridgeStartupFolderPaths(env);
  await mkdir(path.dirname(refs.launcher), { recursive: true });
  await mkdir(path.dirname(refs.descriptor), { recursive: true });
  await writeFile(refs.launcher, 'orphan launcher');
  const snapshot = await snapshotBridgeStartupFolder({ env });
  assert.equal(snapshot.split, true);
  assert.equal(snapshot.installed, false);
  assert.equal(snapshot.launcherContent, 'orphan launcher');
  assert.equal(snapshot.descriptorContent, null);
});

test('reconfigureは旧supervisorをtaskkillで止めてから新descriptor/launcherへ差し替える', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-reconfigure-');
  const control = taskkillDouble();
  const refs = bridgeStartupFolderPaths(env);
  const stopped = [];
  const ready = [];
  const common = { env, runner: control.runner,
    waitStopped: async ({ listen }) => { stopped.push(listen); },
    waitReady: async ({ config: value }) => { ready.push(value.listen.port); } };
  // Nothing is running before the first install (no pidfile) — that stop is a no-op.
  await installBridgeStartupFolder({ ...common, config: config(58_771) });
  const first = await readFile(refs.descriptor, 'utf8');
  // The unit-test double never really spawns a supervisor, so simulate what a
  // real one would have done: record its own pid via the descriptor's pidPath.
  await mkdir(path.dirname(refs.pidfile), { recursive: true });
  await writeFile(refs.pidfile, '5353', 'utf8');
  await installBridgeStartupFolder({ ...common,
    config: config(58_772, '2026-07-21T00:01:00.000Z'), previousListen: config(58_771).listen });
  const second = await readFile(refs.descriptor, 'utf8');
  assert.notEqual(first, second);
  assert.deepEqual(stopped, [config(58_771).listen]);
  assert.deepEqual(ready, [58_771, 58_772]);
  assert.ok(control.calls.some((args) => args[0] === 'taskkill.exe' && args.includes('/T') && args.includes('/F')));
});

test('日本語Windowsで再起動前のPIDが残っていても再設定できる', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-stale-pid-');
  const refs = bridgeStartupFolderPaths(env);
  await mkdir(refs.runtimeDirectory, { recursive: true });
  await writeFile(refs.pidfile, '5353');
  context.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, 5353);
    assert.equal(signal, 0);
    throw Object.assign(new Error('終了済み'), { code: 'ESRCH' });
  });
  let launched = false;
  await installBridgeStartupFolder({ config: config(58_773), env,
    runner: async ([command]) => {
      if (command === 'taskkill.exe') return { code: 128, stderr: 'エラー: プロセス "5353" が見つかりませんでした。' };
      launched = true;
      return { code: 0 };
    }, waitReady: async () => {}, waitStopped: async () => {} });
  assert.equal(launched, true);
});

test('disableはtaskkillと停止確認の後だけfileを除去し、snapshotから復旧できる', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-disable-');
  const control = taskkillDouble();
  const refs = bridgeStartupFolderPaths(env);
  await installBridgeStartupFolder({ config: config(58_773), env, runner: control.runner,
    waitReady: async () => {} });
  // Simulate the (unmocked) supervisor recording its own pid after install started it.
  await mkdir(path.dirname(refs.pidfile), { recursive: true });
  await writeFile(refs.pidfile, '9001', 'utf8');
  const snapshot = await snapshotBridgeStartupFolder({ env });
  const stopped = [];
  await disableBridgeStartupFolder({ snapshot, listen: config(58_773).listen, env, runner: control.runner,
    waitStopped: async ({ listen }) => { stopped.push(listen); } });
  await assert.rejects(readFile(refs.launcher), { code: 'ENOENT' });
  await assert.rejects(readFile(refs.descriptor), { code: 'ENOENT' });
  assert.deepEqual(stopped, [config(58_773).listen]);
  await restoreBridgeStartupFolder({ snapshot, config: config(58_773), env, runner: control.runner,
    waitStopped: async () => {}, waitReady: async () => {} });
  assert.equal(await readFile(refs.launcher, 'utf8'), snapshot.launcherContent);
  assert.equal(await readFile(refs.descriptor, 'utf8'), snapshot.descriptorContent);
});

test('registrar設定はdescriptor.jsonへ焼き込まれる（supervisorはshell環境を継承しない）', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-registrar-');
  const control = taskkillDouble();
  await installBridgeStartupFolder({
    config: config(58_774),
    env: { ...env,
      LATTICE_BRIDGE_REGISTRAR_SSH_HOST: 'main-server',
      LATTICE_BRIDGE_REGISTRAR_SCRIPT: '/home/kite/license-server/bin/lattice-bridge-register.sh' },
    runner: control.runner,
    waitReady: async () => ({ pid: 43 }),
  });
  const refs = bridgeStartupFolderPaths(env);
  const descriptorContent = JSON.parse(await readFile(refs.descriptor, 'utf8'));
  assert.equal(descriptorContent.env.LATTICE_BRIDGE_REGISTRAR_SSH_HOST, 'main-server');
  assert.equal(descriptorContent.env.LATTICE_BRIDGE_REGISTRAR_SCRIPT,
    '/home/kite/license-server/bin/lattice-bridge-register.sh');
});

test('registrar未設定のdescriptorには登録用の環境変数を入れない', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-no-registrar-');
  const control = taskkillDouble();
  await installBridgeStartupFolder({ config: config(58_775), env, runner: control.runner,
    waitReady: async () => ({ pid: 44 }) });
  const refs = bridgeStartupFolderPaths(env);
  const descriptorContent = JSON.parse(await readFile(refs.descriptor, 'utf8'));
  assert.equal(descriptorContent.env.LATTICE_BRIDGE_REGISTRAR_SSH_HOST, undefined);
  assert.equal(descriptorContent.env.LATTICE_BRIDGE_REGISTRAR_SCRIPT, undefined);
});

test('registrarが片側だけの環境ではinstallせずtypedに落とす', async (context) => {
  const { env } = await fixture(context, 'lattice-startup-partial-registrar-');
  const control = taskkillDouble();
  await assert.rejects(
    installBridgeStartupFolder({ config: config(58_776),
      env: { ...env, LATTICE_BRIDGE_REGISTRAR_SSH_HOST: 'main-server' },
      runner: control.runner, waitReady: async () => ({ pid: 45 }) }),
    (error) => error?.code === 'BRIDGE_REGISTRAR_INVALID',
  );
});

test('launcher起動失敗はtyped errorで、symlink/巨大fileは変更前に拒否する', async (context) => {
  const { root, env } = await fixture(context, 'lattice-startup-fail-');
  const control = taskkillDouble();
  const failingRunner = async (args) => {
    if (args[0] === 'wscript.exe') return { code: 1, stdout: '', stderr: 'launch failed' };
    return control.runner(args);
  };
  await assert.rejects(installBridgeStartupFolder({ config: config(58_777), env,
    runner: failingRunner, waitReady: async () => {} }), { code: 'BRIDGE_STARTUP_LAUNCHER_FAILED' });

  const refs = bridgeStartupFolderPaths(env);
  await rm(refs.launcher, { force: true });
  const target = path.join(root, 'target.vbs');
  await writeFile(target, 'unsafe');
  await symlink(target, refs.launcher);
  await assert.rejects(snapshotBridgeStartupFolder({ env }),
    { code: 'BRIDGE_STARTUP_FOLDER_FILE_UNSAFE' });
});

test(`label定数は${BRIDGE_STARTUP_LABEL}のまま安定している（launcher/pidfile名がこれに依存）`, () => {
  assert.equal(BRIDGE_STARTUP_LABEL, 'LatticeBridge');
});
