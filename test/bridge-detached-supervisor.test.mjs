import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bridgeDetachedSupervisorPaths, describeBridgeDetachedSupervisor, disableBridgeDetachedSupervisor,
  installBridgeDetachedSupervisor, restoreBridgeDetachedSupervisor, snapshotBridgeDetachedSupervisor,
} from '../src/bridge-detached-supervisor.mjs';
import { observeDashboardProcess } from '../src/dashboard-process-control.mjs';
import { registerManagedDaemonFixture } from './helpers/managed-daemon-fixture.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-detached-'));
  // Track spawned supervisors so cleanup stops them directly, not only via command-line discovery.
  const tracked = [];
  registerManagedDaemonFixture(context, root, { tracked });
  const bridgePath = path.join(root, 'bridge.mjs');
  await writeFile(bridgePath, 'setInterval(() => {}, 1000);\n');
  const calls = [];
  const children = [];
  const launch = async (options) => {
    await new Promise((resolve) => setImmediate(resolve));
    calls.push(options);
  };
  const launchSupervisor = async (options) => {
    const child = spawn(options.nodePath, [options.supervisorPath, options.descriptorPath], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    tracked.push(child.pid);
    const descriptor = JSON.parse(await readFile(options.descriptorPath, 'utf8'));
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const saved = JSON.parse(await readFile(descriptor.pidPath, 'utf8'));
        if (saved?.pid === child.pid || saved === child.pid) return saved;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      assert.equal(child.exitCode, null, 'supervisor exited before recording its identity');
      assert.ok(Date.now() < deadline, 'supervisor did not write its identity');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { root, bridgePath, env: { LATTICE_CONFIG_DIR: path.join(root, 'config') },
    calls, children, launch, launchSupervisor };
}

const config = { enabled: true, listen: { address: '127.0.0.1', port: 58_771 }, updated_at: '2026-11-07T00:00:00.000Z' };
const noWait = async () => {};

test('install writes its descriptor, awaits launch, and describe reports executable paths', async (context) => {
  const { env, calls, launch } = await fixture(context);
  let ready;
  await installBridgeDetachedSupervisor({ config, env, launch, waitStopped: noWait,
    waitReady: async (value) => {
      assert.equal(calls.length, 1, 'readiness must follow the async launcher');
      ready = value; return { pid: 1 };
    } });
  const refs = bridgeDetachedSupervisorPaths(env);
  assert.equal(refs.directory, path.join(env.LATTICE_CONFIG_DIR, 'bridge-linux'));
  const descriptor = JSON.parse(await readFile(refs.descriptor, 'utf8'));
  assert.equal(descriptor.schema, 'lattice.bridge_supervisor_descriptor.v1');
  assert.match(descriptor.bridgePath, /lattice-bridge\.mjs$/u);
  assert.equal(descriptor.pidPath, refs.pidfile);
  assert.equal(descriptor.nodePath, process.execPath);
  assert.equal(descriptor.env.LATTICE_CONFIG_DIR, env.LATTICE_CONFIG_DIR);
  assert.equal(ready.instanceToken, descriptor.env.LATTICE_BRIDGE_INSTANCE_TOKEN);
  assert.equal(ready.failureCode, 'BRIDGE_DETACHED_SUPERVISOR_START_FAILED');
  assert.deepEqual(calls.map((c) => path.basename(c.supervisorPath)), ['lattice-bridge-supervisor.mjs']);
  const snapshot = await snapshotBridgeDetachedSupervisor({ env });
  assert.equal(snapshot.installed, true);
  assert.deepEqual(await describeBridgeDetachedSupervisor({ snapshot }),
    { node_path: process.execPath, node_exists: true, bridge_path: descriptor.bridgePath, bridge_exists: true });
});

test('Linux real supervisor identity supports reinstall, disable, and restore',
  { skip: process.platform !== 'linux' }, async (context) => {
    const { env, children, bridgePath, launchSupervisor: launch } = await fixture(context);
    const refs = bridgeDetachedSupervisorPaths(env);
    const waitReady = async () => ({ pid: 1 });
    const options = { config, env, bridgePath, launch, waitReady, waitStopped: noWait };
    const legacy = spawn(process.execPath, ['-e', '', bridgePath], { stdio: 'ignore' });
    await once(legacy, 'exit');
    await mkdir(refs.directory, { recursive: true });
    await writeFile(refs.pidfile, String(legacy.pid));
    await installBridgeDetachedSupervisor(options);
    const first = JSON.parse(await readFile(refs.pidfile, 'utf8'));
    assert.deepEqual(first, await observeDashboardProcess(children[0].pid));
    assert.match(first.birth, /^linux:[^:]+:[0-9]+$/u);
    await installBridgeDetachedSupervisor(options);
    assert.equal(await observeDashboardProcess(first.pid), null);
    const second = JSON.parse(await readFile(refs.pidfile, 'utf8'));
    assert.deepEqual(second, await observeDashboardProcess(children[1].pid));
    const snapshot = await snapshotBridgeDetachedSupervisor({ env });
    assert.deepEqual(await disableBridgeDetachedSupervisor({ snapshot, listen: null, env, waitStopped: noWait }),
      { removed: true, stopped: true });
    assert.equal(await observeDashboardProcess(second.pid), null);
    assert.equal((await snapshotBridgeDetachedSupervisor({ env })).installed, false);
    await restoreBridgeDetachedSupervisor({ snapshot, env, launch, waitStopped: noWait, config,
      waitReady: async ({ instanceToken }) => {
        assert.equal(children.length, 3, 'restore must await the async launcher');
        const restored = JSON.parse(await readFile(refs.pidfile, 'utf8'));
        assert.deepEqual(restored, await observeDashboardProcess(children[2].pid));
        assert.equal(instanceToken, JSON.parse(snapshot.descriptorContent).env.LATTICE_BRIDGE_INSTANCE_TOKEN);
      } });
    assert.equal(await readFile(refs.descriptor, 'utf8'), snapshot.descriptorContent);
    await disableBridgeDetachedSupervisor({ snapshot, listen: null, env, waitStopped: noWait });
    assert.equal(await observeDashboardProcess(children[2].pid), null);
  });

for (const kind of ['birth mismatch', 'unknown birth', 'legacy numeric', 'malformed']) {
  test(`Linux stop discards ${kind} without signaling the live process`,
    { skip: process.platform !== 'linux' }, async (context) => {
      const { env, bridgePath, launch } = await fixture(context);
      await installBridgeDetachedSupervisor({ config, env, launch, waitReady: noWait });
      const refs = bridgeDetachedSupervisorPaths(env);
      const child = spawn(process.execPath, [bridgePath], { stdio: 'ignore' });
      await once(child, 'spawn');
      const identity = await observeDashboardProcess(child.pid);
      const content = kind === 'birth mismatch' ? JSON.stringify({ ...identity, birth: `${identity.birth}-old` })
        : kind === 'unknown birth' ? JSON.stringify({ ...identity, birth: null })
          : kind === 'legacy numeric' ? String(child.pid) : '{invalid';
      await writeFile(refs.pidfile, content);
      assert.deepEqual(await disableBridgeDetachedSupervisor({
        snapshot: await snapshotBridgeDetachedSupervisor({ env }), env,
        waitStopped: async () => assert.fail('unowned process must not be waited on'),
      }), { removed: true, stopped: false });
      assert.deepEqual(await observeDashboardProcess(child.pid), identity);
      await assert.rejects(readFile(refs.pidfile), { code: 'ENOENT' });
      assert.equal((await snapshotBridgeDetachedSupervisor({ env })).installed, false);
    });
}

for (const outcome of ['absent', 'different birth', 'unknown birth', 'observer error']) {
  test(`Linux stop reports post-signal ${outcome} accurately`,
    { skip: process.platform !== 'linux' }, async (context) => {
      const { env, bridgePath, launch } = await fixture(context);
      await installBridgeDetachedSupervisor({ config, env, launch, waitReady: noWait });
      const refs = bridgeDetachedSupervisorPaths(env);
      const child = spawn(process.execPath, [bridgePath], { stdio: 'ignore' });
      await once(child, 'spawn');
      const exited = once(child, 'exit');
      const identity = await observeDashboardProcess(child.pid);
      await writeFile(refs.pidfile, JSON.stringify(identity));
      let observations = 0;
      let socketWaits = 0;
      const confirmed = outcome === 'absent' || outcome === 'different birth';
      const result = await disableBridgeDetachedSupervisor({
        snapshot: await snapshotBridgeDetachedSupervisor({ env }), env,
        observeProcess: async (pid) => {
          assert.equal(pid, child.pid);
          if (observations++ === 0) return identity;
          if (outcome === 'observer error') throw Object.assign(new Error('unobservable'), { code: 'EACCES' });
          if (outcome === 'unknown birth') return { pid, birth: null, observation: 'unavailable' };
          await exited;
          return outcome === 'absent' ? null : { pid, birth: `${identity.birth}-new` };
        },
        waitStopped: async () => { socketWaits++; },
      });
      assert.deepEqual(result, { removed: true, stopped: confirmed });
      assert.equal(socketWaits, confirmed ? 1 : 0);
      assert.equal((await exited)[1], 'SIGTERM');
      await assert.rejects(readFile(refs.pidfile), { code: 'ENOENT' });
    });
}

test('supervisor writer preserves the Windows numeric pidfile contract',
  { skip: process.platform !== 'win32' }, async (context) => {
    const { env, bridgePath, launchSupervisor } = await fixture(context);
    await installBridgeDetachedSupervisor({ config, env, bridgePath, launch: launchSupervisor, waitReady: noWait });
    const saved = await readFile(bridgeDetachedSupervisorPaths(env).pidfile, 'utf8');
    assert.match(saved, /^[0-9]+$/u);
  });

test('a superseded supervisor on the same descriptor exits and stops its bridge', async (context) => {
  const { env, bridgePath, launchSupervisor, children } = await fixture(context);
  await installBridgeDetachedSupervisor({ config, env, bridgePath, launch: launchSupervisor, waitReady: noWait });
  const [first] = children;
  const { descriptor } = bridgeDetachedSupervisorPaths(env);
  // A second launch on the same descriptor (seat helper + product, 2026-11-08) takes the pidfile.
  await launchSupervisor({ nodePath: process.execPath,
    supervisorPath: path.resolve('bin/lattice-bridge-supervisor.mjs'), descriptorPath: descriptor });
  const [code] = await Promise.race([once(first, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('superseded supervisor kept running')), 10_000))]);
  assert.equal(code, 0);
  assert.equal(children[1].exitCode, null, 'the recorded supervisor keeps running');
});

test('uninstalled snapshot describes null and disable removes nothing', async (context) => {
  const { env } = await fixture(context);
  const snapshot = await snapshotBridgeDetachedSupervisor({ env });
  assert.equal(snapshot.installed, false);
  assert.equal(await describeBridgeDetachedSupervisor({ snapshot }), null);
  assert.deepEqual(await disableBridgeDetachedSupervisor({ snapshot, listen: null, env }), { removed: false, stopped: false });
});
