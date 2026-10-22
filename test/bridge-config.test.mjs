import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  BridgeConfigError,
  configureBridge,
  disableBridge,
  readBridgeConfig,
} from '../src/bridge-config.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { LATTICE_CONFIG_DIR: root } };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('bridgeは未設定なら無効でsocketもconfigも作らない', async (context) => {
  const { root, env } = await fixture(context);
  assert.equal(await readBridgeConfig({ env }), null);
  assert.deepEqual(await rm(path.join(root, 'bridge.json')).catch((error) => error.code), 'ENOENT');
});

test('auto portは高番帯をactual exclusive bindして0600で永続化し再設定で再利用する', async (context) => {
  const { root, env } = await fixture(context);
  let listened = false;
  const createCandidateServer = () => {
    const server = createServer();
    server.once('listening', () => { listened = true; });
    return server;
  };
  const first = await configureBridge({ address: '127.0.0.1', env, choosePort: () => 58_731,
    createCandidateServer, now: () => new Date('2026-07-21T12:00:00.000Z') });
  assert.equal(listened, true);
  assert.equal(first.listen.port, 58_731);
  assert.ok(first.listen.port >= BRIDGE_PORT_MIN && first.listen.port <= BRIDGE_PORT_MAX);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(root, 'bridge.json'))).mode & 0o777, 0o600);
  }
  const second = await configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'http://127.0.0.1:4318' },
    createCandidateServer: () => { throw new Error('unchanged binding must not probe'); } });
  assert.equal(second.listen.port, first.listen.port);
  assert.deepEqual(second.upstream, { mode: 'url', url: 'http://127.0.0.1:4318/' });
  assert.deepEqual(await readBridgeConfig({ env }), second);
});

test('occupied auto candidateは同じportを再試行せず別portをactual bindする', async (context) => {
  const { env } = await fixture(context);
  const occupied = createServer();
  await listen(occupied, 58_732);
  context.after(() => close(occupied));
  const values = [58_732, 58_732, 58_733];
  const config = await configureBridge({ address: '127.0.0.1', env,
    choosePort: () => values.shift() ?? 58_733 });
  assert.equal(config.listen.port, 58_733);
});

test('明示auto reconfigureは旧portを固定せず新しいexclusive bindを選べる', async (context) => {
  const { env } = await fixture(context);
  const first = await configureBridge({ address: '127.0.0.1', port: 58_748, env });
  const changed = await configureBridge({ address: '127.0.0.1', port: null, env,
    reuseCurrentPort: false, choosePort: () => 58_749 });
  assert.equal(first.listen.port, 58_748);
  assert.equal(changed.listen.port, 58_749);
});

test('occupied explicit portはtyped failureになり旧configを維持する', async (context) => {
  const { env } = await fixture(context);
  const original = await configureBridge({ address: '127.0.0.1', port: 58_734, env });
  const occupied = createServer();
  await listen(occupied, 58_735);
  context.after(() => close(occupied));
  await assert.rejects(configureBridge({ address: '127.0.0.1', port: 58_735, env }),
    (error) => error instanceof BridgeConfigError && error.code === 'BRIDGE_PORT_UNAVAILABLE');
  assert.deepEqual(await readBridgeConfig({ env }), original);
});

test('concurrent setupはlockで直列化し一つの選択portを共有する', async (context) => {
  const { env } = await fixture(context);
  let candidate = 58_736;
  const [left, right] = await Promise.all([
    configureBridge({ address: '127.0.0.1', env, choosePort: () => candidate++ }),
    configureBridge({ address: '127.0.0.1', env, choosePort: () => candidate++ }),
  ]);
  assert.equal(left.listen.port, right.listen.port);
});

test('disableは選択値を保持しenabledだけ落とす', async (context) => {
  const { env } = await fixture(context);
  const active = await configureBridge({ address: '127.0.0.1', env });
  const disabled = await disableBridge({ env });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.listen, active.listen);
  assert.deepEqual(disabled.upstream, active.upstream);
});

test('invalid listen/upstream/config modeはtyped failでsilent defaultしない', async (context) => {
  const { root, env } = await fixture(context);
  await assert.rejects(configureBridge({ env }),
    (error) => error.code === 'BRIDGE_LISTEN_INVALID');
  await assert.rejects(configureBridge({ address: 'localhost', env }),
    (error) => error.code === 'BRIDGE_LISTEN_INVALID');
  await assert.rejects(configureBridge({ address: '127.0.0.1', port: 4318, env }),
    (error) => error.code === 'BRIDGE_PORT_INVALID');
  await assert.rejects(configureBridge({ address: '127.0.0.1', env,
    upstream: { mode: 'url', url: 'file:///tmp/no' } }),
  (error) => error.code === 'BRIDGE_UPSTREAM_INVALID');
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, 'bridge.json'), '{}\n', { mode: 0o644 });
    await chmod(path.join(root, 'bridge.json'), 0o644);
    await assert.rejects(readBridgeConfig({ env }), (error) => error.code === 'BRIDGE_CONFIG_MODE_INVALID');
    assert.equal(JSON.parse(await readFile(path.join(root, 'bridge.json'), 'utf8')).schema, undefined);
  }
});

test('hubは既定nullで、明示URLを渡すと正規化して永続化する', async (context) => {
  const { env } = await fixture(context);
  const noHub = await configureBridge({ address: '127.0.0.1', env });
  assert.equal(noHub.hub, null);
  const withHub = await configureBridge({ address: '127.0.0.1', env,
    hub: { url: 'http://192.168.1.2:8080' } });
  assert.deepEqual(withHub.hub, { url: 'http://192.168.1.2:8080/' });
  assert.deepEqual((await readBridgeConfig({ env })).hub, { url: 'http://192.168.1.2:8080/' });
});

test('hub追加前に書かれたbridge.json（hub key無し）はhub:nullとして読める', async (context) => {
  const { root, env } = await fixture(context);
  const legacy = { schema: 'lattice.bridge_config.v1', enabled: true,
    listen: { address: '127.0.0.1', port: 58_751 }, allowed_hosts: ['127.0.0.1'],
    upstream: { mode: 'dashboard_descriptor' }, updated_at: '2026-07-01T00:00:00.000Z' };
  const file = path.join(root, 'bridge.json');
  await writeFile(file, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  const read = await readBridgeConfig({ env });
  assert.equal(read.hub, null);
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.hub, undefined, 'reading must not silently rewrite the legacy file on disk');
});

test('invalid hub URLはtyped failでBRIDGE_HUB_URL_INVALIDになる', async (context) => {
  const { env } = await fixture(context);
  await assert.rejects(configureBridge({ address: '127.0.0.1', env,
    hub: { url: 'file:///tmp/no' } }),
  (error) => error.code === 'BRIDGE_HUB_URL_INVALID');
  await assert.rejects(configureBridge({ address: '127.0.0.1', env,
    hub: { url: 'http://192.168.1.2:8080', extra: true } }),
  (error) => error.code === 'BRIDGE_HUB_URL_INVALID');
});

test('config JSONはduplicate keyを拒否する', async (context) => {
  const { root, env } = await fixture(context);
  await writeFile(path.join(root, 'bridge.json'),
    '{"schema":"lattice.bridge_config.v1","schema":"lattice.bridge_config.v1","enabled":false,"listen":{"address":"127.0.0.1","port":58747},"upstream":{"mode":"dashboard_descriptor"},"updated_at":"2026-07-21T12:00:00.000Z"}\n',
    { mode: 0o600 });
  await assert.rejects(readBridgeConfig({ env }), (error) => error.code === 'BRIDGE_CONFIG_INVALID');
});
