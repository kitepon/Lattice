import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBridgeCli } from '../src/bridge-cli.mjs';
import { BRIDGE_CONFIG_SCHEMA, configureBridge } from '../src/bridge-config.mjs';
import { bridgeRuntimeController, startBridgeServer } from '../src/bridge-server.mjs';

// 実機で起きた形: 設定アドレスがホストから消え、同一subnetの別アドレスだけが残る。
// configureBridgeは実際にportを予約するため、設定側は必ずbind可能なアドレスを使い、
// 「アドレスが消えた」状況はinterfaces注入で作る。
const LIVE = '127.0.0.1';
const NEIGHBOUR = '127.0.0.2';
const OFF_SUBNET = { lo0: [{ address: '10.8.0.5', internal: false }] };
const MOVED = { lo0: [{ address: NEIGHBOUR, internal: false }] };
const UNCHANGED = { lo0: [{ address: LIVE, internal: false }] };

function upstreamServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LIVE, port: 0 }, () => resolve(server));
  });
}
const close = (server) => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

async function envFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-bridge-rebind-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { LATTICE_CONFIG_DIR: root, LATTICE_DASHBOARD_RUNTIME_DIR: path.join(root, 'dashboard') };
}

function collector() {
  const chunks = [];
  return { write: (value) => chunks.push(value), text: () => chunks.join('') };
}

async function statusOf(env, { interfaces, probe }) {
  const stdout = collector();
  const stderr = collector();
  const code = await runBridgeCli({ argv: ['status', '--json'], stdout, stderr, env, interfaces, probe });
  assert.equal(code, 0, stderr.text());
  return JSON.parse(stdout.text());
}

async function configured(env, allowedHosts = []) {
  return configureBridge({ env, address: LIVE, upstream: { mode: 'dashboard_descriptor' }, allowedHosts });
}

test('設定アドレスがホストから消えるとstatusがrebindableと到達不能を報告する', async (context) => {
  const env = await envFixture(context);
  const config = await configured(env, ['lattice.kitepon.dev']);

  const status = await statusOf(env, { interfaces: MOVED, probe: async () => false });

  assert.equal(status.schema, 'lattice.bridge_cli_result.v4');
  // HOMEを持たないこのfixtureではLaunchAgentを読めない。読めないことを
  // 「常駐設定は正常」へ丸めず、typed codeのまま報告する。
  assert.equal(status.persistence.state, 'unreadable');
  assert.equal(status.persistence.error, process.platform === 'win32'
    ? 'BRIDGE_STARTUP_FOLDER_APPDATA_INVALID' : 'BRIDGE_LAUNCH_AGENT_HOME_INVALID');
  assert.equal(status.enabled, true, '設定は有効なまま');
  assert.equal(status.listen.address, LIVE, '設定の意図は保持する');
  assert.equal(status.listen_state, 'rebindable');
  assert.deepEqual(status.effective_listen, { address: NEIGHBOUR, port: config.listen.port });
  assert.deepEqual(status.listen_candidates, [NEIGHBOUR]);
  assert.equal(status.reachable, false);
  assert.equal(status.liveness_reason, 'configured_address_absent_rebound_within_subnet');
});

test('同一subnetに代替が無ければabsentとして報告し到達可能とは言わない', async (context) => {
  const env = await envFixture(context);
  await configured(env);

  const status = await statusOf(env, {
    interfaces: OFF_SUBNET,
    probe: async () => { throw new Error('probe must not run without an effective address'); },
  });

  assert.equal(status.listen_state, 'absent');
  assert.equal(status.effective_listen, null);
  assert.equal(status.reachable, false);
  assert.equal(status.liveness_reason, 'configured_address_absent_from_host');
});

test('アドレスが健在でlistenerが応答すればreachableになる', async (context) => {
  const env = await envFixture(context);
  const config = await configured(env);

  const status = await statusOf(env, { interfaces: UNCHANGED, probe: async () => true });

  assert.equal(status.listen_state, 'present');
  assert.deepEqual(status.effective_listen, { address: LIVE, port: config.listen.port });
  assert.equal(status.reachable, true);
  assert.equal(status.liveness_reason, null);
});

test('アドレスは健在でもlistenerが応答しなければreachable=falseで理由が付く', async (context) => {
  const env = await envFixture(context);
  await configured(env);

  const status = await statusOf(env, { interfaces: UNCHANGED, probe: async () => false });

  assert.equal(status.listen_state, 'present');
  assert.equal(status.reachable, false);
  assert.equal(status.liveness_reason, 'listener_not_accepting');
});

test('未設定なら liveness は unconfigured で probe を走らせない', async (context) => {
  const env = await envFixture(context);
  const status = await statusOf(env, {
    interfaces: UNCHANGED,
    probe: async () => { throw new Error('probe must not run when unconfigured'); },
  });
  assert.equal(status.configured, false);
  assert.equal(status.listen_state, 'unconfigured');
  assert.equal(status.reachable, null);
});

test('serverは同一subnetの現アドレスへ再bindし、その宛先のHostを受理する', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  context.after(() => close(upstream));

  // 設定は 127.0.0.9（このホストには無い）。同一/24に 127.0.0.1 が生きている。
  const config = Object.freeze({
    schema: BRIDGE_CONFIG_SCHEMA, enabled: true,
    listen: Object.freeze({ address: '127.0.0.9', port: 0 }),
    allowed_hosts: ['127.0.0.9'],
    upstream: Object.freeze({ mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }),
    updated_at: '2026-07-25T00:00:00.000Z',
  });
  const instanceToken = 'c'.repeat(64);
  const bridge = await startBridgeServer({ config, env, interfaces: UNCHANGED, instanceToken });
  context.after(() => bridge.close());

  assert.equal(bridge.configured_address, '127.0.0.9');
  assert.equal(bridge.address, LIVE, '同一subnetの生きたアドレスへ再bindする');
  assert.equal(bridge.rebound, true);

  const response = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: LIVE, port: bridge.port, path: '/',
      headers: { host: `${LIVE}:${bridge.port}` } }, (incoming) => {
      let text = '';
      incoming.on('data', (chunk) => { text += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, text }));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(response.status, 200, `再bind先のHostが許可されていない: ${response.text}`);
  const health = await fetch(`http://${LIVE}:${bridge.port}/__lattice/bridge-health`, {
    headers: { 'x-lattice-bridge-instance-token': instanceToken },
  });
  assert.deepEqual((await health.json()).address, LIVE,
    'attested healthは設定済みの消えたIPではなく実bindingを返す');
});

test('設定アドレスが完全に消えたserver起動はtypedに失敗しfallbackしない', async (context) => {
  const env = await envFixture(context);
  const config = Object.freeze({
    schema: BRIDGE_CONFIG_SCHEMA, enabled: true,
    listen: Object.freeze({ address: '192.168.55.10', port: 0 }),
    allowed_hosts: ['192.168.55.10'],
    upstream: Object.freeze({ mode: 'dashboard_descriptor' }),
    updated_at: '2026-07-25T00:00:00.000Z',
  });
  await assert.rejects(
    startBridgeServer({ config, env, interfaces: OFF_SUBNET }),
    (error) => error?.code === 'BRIDGE_LISTEN_ADDRESS_ABSENT',
  );
});

test('新しいbindingを張った時にupstreamを自己登録する', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  const config = await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  const registered = [];
  const reported = [];
  const controller = bridgeRuntimeController({ env,
    register: async ({ port }) => {
      registered.push(port);
      return { schema: 'lattice.bridge_registrar_result.v1', state: 'updated', port,
        host: 'main-server', remote: { changed: true }, detail: null };
    },
    report: (line) => reported.push(line) });
  context.after(() => controller.close());

  await controller.reconcile();
  assert.deepEqual(registered, [config.listen.port]);
  assert.equal(reported.length, 1);
  assert.match(reported[0], /"state":"updated"/u);

  // 同じ設定の再reconcileはbindingを作り直さないので、登録も繰り返さない。
  await controller.reconcile();
  assert.deepEqual(registered, [config.listen.port]);
});

test('登録が失敗してもbridgeは動き続け、失敗は握り潰さない', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  const reported = [];
  const controller = bridgeRuntimeController({ env,
    register: async () => { throw new Error('ssh: no route to host'); },
    report: (line) => reported.push(line) });
  context.after(() => controller.close());

  const binding = await controller.reconcile();
  assert.notEqual(binding, null, '登録失敗でbridgeを落とさない');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /"state":"failed"/u);
  assert.match(reported[0], /no route to host/u);
});

test('registrar未設定なら何も報告しない', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  const reported = [];
  const controller = bridgeRuntimeController({ env,
    register: async ({ port }) => ({ schema: 'lattice.bridge_registrar_result.v1',
      state: 'not_configured', port, host: null, remote: null, detail: null }),
    report: (line) => reported.push(line) });
  context.after(() => controller.close());

  await controller.reconcile();
  assert.deepEqual(reported, []);
});

// 実機で落ちた形: 設定は1バイトも変わらないのにDHCPのlease変更で待受アドレスが
// ホストから消え、死んだアドレスの上にsocketだけが residual した。設定のfingerprintしか
// 見ていなかったreconcileはこれを素通りし、公開siteが502のまま誰も気付かなかった。
test('設定が変わらなくても待受アドレスがホストから消えればreconcileが検知する', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  let interfaces = UNCHANGED;
  const controller = bridgeRuntimeController({ env,
    register: async ({ port }) => ({ schema: 'lattice.bridge_registrar_result.v1',
      state: 'updated', port, host: 'main-server', remote: { changed: true }, detail: null }),
    report: () => {},
    readInterfaces: () => interfaces });
  context.after(() => controller.close());

  assert.notEqual(await controller.reconcile(), null, '健在なアドレスではbindできる');

  // 設定には触れない。ホストの下からアドレスだけが消える。
  interfaces = OFF_SUBNET;
  await assert.rejects(
    controller.reconcile(),
    (error) => error?.code === 'BRIDGE_LISTEN_ADDRESS_ABSENT',
    '消失を素通りせず、fallbackもせずtypedに失敗する',
  );
});

test('ホストが動かない限りreconcileは再bindも再登録もしない', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  const registered = [];
  const controller = bridgeRuntimeController({ env,
    register: async ({ port }) => {
      registered.push(port);
      return { schema: 'lattice.bridge_registrar_result.v1', state: 'updated', port,
        host: 'main-server', remote: { changed: true }, detail: null };
    },
    report: () => {},
    readInterfaces: () => UNCHANGED });
  context.after(() => controller.close());

  const first = await controller.reconcile();
  const second = await controller.reconcile();
  const third = await controller.reconcile();

  assert.equal(first, second, '静かなpassでbindingを作り直さない');
  assert.equal(second, third);
  assert.equal(registered.length, 1, '毎passでreverse proxyへ登録し直さない');
});

test('アドレスが戻ればbindingを張り直して登録もやり直す', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  let interfaces = UNCHANGED;
  const registered = [];
  const controller = bridgeRuntimeController({ env,
    register: async ({ port }) => {
      registered.push(port);
      return { schema: 'lattice.bridge_registrar_result.v1', state: 'updated', port,
        host: 'main-server', remote: { changed: true }, detail: null };
    },
    report: () => {},
    readInterfaces: () => interfaces });
  context.after(() => controller.close());

  await controller.reconcile();
  assert.equal(registered.length, 1);

  // daemonは失敗時に公開traffic をfail-closedにする。その後アドレスが戻る。
  interfaces = OFF_SUBNET;
  await assert.rejects(controller.reconcile(), (error) => error?.code === 'BRIDGE_LISTEN_ADDRESS_ABSENT');
  await controller.close();

  interfaces = UNCHANGED;
  assert.notEqual(await controller.reconcile(), null, '復帰でbindingを張り直す');
  assert.equal(registered.length, 2, '新しいbindingは必ずreverse proxyへ知らせ直す');
});

test('reconcileは同じ設定のbindingを作り直さない', async (context) => {
  const env = await envFixture(context);
  const upstream = await upstreamServer((request, response) => { response.end('ok'); });
  context.after(() => close(upstream));
  await configureBridge({ env, address: LIVE,
    upstream: { mode: 'url', url: `http://${LIVE}:${upstream.address().port}/` }, allowedHosts: [] });

  const controller = bridgeRuntimeController({ env });
  context.after(() => controller.close());
  const first = await controller.reconcile();
  const second = await controller.reconcile();
  assert.equal(first, second, 'reconcileはbindingを再利用する');
});
