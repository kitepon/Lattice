import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bridgeDetachedSupervisorPaths, describeBridgeDetachedSupervisor, disableBridgeDetachedSupervisor,
  installBridgeDetachedSupervisor, restoreBridgeDetachedSupervisor, snapshotBridgeDetachedSupervisor,
} from '../src/bridge-detached-supervisor.mjs';

// The real supervisor is exercised on this seat by `lattice bridge reconfigure`;
// here a stand-in child plays its one observable role: it lives until SIGTERM
// and its pid is in the pidfile, so stop/replace/remove can be asserted.
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-detached-'));
  const children = [];
  context.after(async () => {
    for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  });
  const calls = [];
  const launch = ({ nodePath, supervisorPath, descriptorPath }) => {
    calls.push({ nodePath, supervisorPath, descriptorPath });
    const child = spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    children.push(child);
    const descriptor = JSON.parse(require_sync(descriptorPath));
    return writeFile(descriptor.pidPath, String(child.pid));
  };
  return { env: { LATTICE_CONFIG_DIR: path.join(root, 'config') }, calls, children, launch };
}
import { readFileSync } from 'node:fs';
function require_sync(ref) { return readFileSync(ref, 'utf8'); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settled = () => new Promise((resolve) => setTimeout(resolve, 100));
const config = { enabled: true, listen: { address: '127.0.0.1', port: 58_771 }, updated_at: '2026-11-07T00:00:00.000Z' };
const noWait = async () => {};

test('installはdescriptorを書いてsupervisorをdetached起動し、describeが実行対象と実在を返す', async (context) => {
  const { env, calls, launch } = await fixture(context);
  let ready;
  await installBridgeDetachedSupervisor({ config, env, launch, waitStopped: noWait,
    waitReady: async (value) => { ready = value; return { pid: 1 }; } });
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

test('再installは旧supervisorをSIGTERMで止めてから差し替え、disableは止めてfileを除き、restoreが戻す', async (context) => {
  const { env, children, launch } = await fixture(context);
  const waitReady = async () => ({ pid: 1 });
  await installBridgeDetachedSupervisor({ config, env, launch, waitReady, waitStopped: noWait });
  await settled();
  const first = children[0].pid;
  assert.equal(alive(first), true);
  await installBridgeDetachedSupervisor({ config, env, launch, waitReady, waitStopped: noWait });
  await settled();
  assert.equal(alive(first), false);
  assert.equal(alive(children[1].pid), true);
  const snapshot = await snapshotBridgeDetachedSupervisor({ env });
  const refs = bridgeDetachedSupervisorPaths(env);
  assert.deepEqual(await disableBridgeDetachedSupervisor({ snapshot, listen: null, env, waitStopped: noWait }),
    { removed: true, stopped: true });
  await settled();
  assert.equal(alive(children[1].pid), false);
  assert.equal((await snapshotBridgeDetachedSupervisor({ env })).installed, false);
  assert.equal(await describeBridgeDetachedSupervisor({ snapshot: await snapshotBridgeDetachedSupervisor({ env }) }), null);
  await restoreBridgeDetachedSupervisor({ snapshot, env, launch, waitStopped: noWait });
  await settled();
  assert.equal(await readFile(refs.descriptor, 'utf8'), snapshot.descriptorContent);
  assert.equal(alive(children[2].pid), true);
  assert.deepEqual(await disableBridgeDetachedSupervisor({ snapshot: await snapshotBridgeDetachedSupervisor({ env }),
    listen: null, env, waitStopped: noWait }), { removed: true, stopped: true });
});

test('未installのsnapshotはdescribeでnull、disableは何も止めずremoved=false', async (context) => {
  const { env } = await fixture(context);
  const snapshot = await snapshotBridgeDetachedSupervisor({ env });
  assert.equal(snapshot.installed, false);
  assert.equal(await describeBridgeDetachedSupervisor({ snapshot }), null);
  assert.deepEqual(await disableBridgeDetachedSupervisor({ snapshot, listen: null, env }), { removed: false, stopped: false });
});
