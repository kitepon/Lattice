import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBridgeHubDelivery, ensureProjectDashboardDelivery,
  reportProjectDashboardDelivery } from '../src/dashboard-delivery.mjs';

const config = { enabled: true, listen: { address: '127.0.0.1', port: 55000 },
  hub: { url: 'http://hub.example/' } };
const heartbeat = async () => ({ state: 'accepted', result: {
  schema: 'lattice.bridge_hub_registration_result.v2', registered: ['movie'], rejected: [],
} });
const page = '<html><title>Lattice — movie 依存工程図</title></html>';
const deliveredFetch = async (url) => String(url).endsWith('/projects/')
  ? new Response(JSON.stringify([{ project_id: 'movie', status: 'online' }]),
    { headers: { 'content-type': 'application/json' } })
  : new Response(page, { headers: { 'content-type': 'text/html' } });

test('公開設定が欠落していても自動公開せず、端末内のみと復旧入口を返す', async () => {
  let recovered = false;
  const result = await ensureProjectDashboardDelivery({ projectId: 'movie',
    readConfig: async () => null, recover: async () => { recovered = true; } });
  assert.equal(result.state, 'local_only');
  assert.equal(result.reason, 'bridge_unconfigured');
  assert.match(result.next_action, /bridge setup/);
  assert.equal(recovered, false);
});

test('有効な接続は復旧してから対象projectの配信を確認する', async () => {
  const order = [];
  let current = config;
  const updated = { ...config, listen: { address: '127.0.0.2', port: 55001 } };
  const result = await ensureProjectDashboardDelivery({ projectId: 'movie',
    readConfig: async () => current,
    recover: async () => { order.push('recover'); current = updated; },
    verify: async ({ projectId, config: effective }) => {
      assert.equal(effective, updated);
      order.push(projectId); return { state: 'hub_delivered' }; } });
  assert.deepEqual(order, ['recover', 'movie']);
  assert.equal(result.state, 'hub_delivered');
});

test('公開配信の失敗は保存操作と独立したstderrの結果に残る', async () => {
  let stderr = '';
  const result = await reportProjectDashboardDelivery({ projectId: 'movie', env: {},
    stderr: { write: (text) => { stderr += text; } },
    ensureDelivery: async () => { throw Object.assign(new Error('通信不能'), { code: 'ECONNREFUSED' }); } });
  assert.equal(result.state, 'failed');
  assert.equal(JSON.parse(stderr).reason, 'ECONNREFUSED');
});

test('登録受理だけで成功せず、hub一覧と実際の工程HTMLを確認する', async () => {
  const result = await verifyBridgeHubDelivery({ config, heartbeat, fetchImpl: deliveredFetch });
  assert.equal(result.state, 'hub_delivered');
  assert.deepEqual(result.project_ids, ['movie']);
});

test('HTTP 200でも登録契約でない応答は公開成功にしない', async () => {
  await assert.rejects(verifyBridgeHubDelivery({ config,
    heartbeat: async () => ({ state: 'accepted', result: {} }), fetchImpl: deliveredFetch }),
  { code: 'BRIDGE_HUB_DELIVERY_UNCONFIRMED' });
});

test('非表示・offline・中継不能・別ページを工程の配信成功にしない', async () => {
  for (const fetchImpl of [
    async () => new Response('[]'),
    async () => new Response(JSON.stringify([{ project_id: 'movie', status: 'offline' }])),
    async (url) => String(url).endsWith('/projects/') ? deliveredFetch(url) : new Response('', { status: 503 }),
    async (url) => String(url).endsWith('/projects/') ? deliveredFetch(url)
      : new Response('<title>ログイン</title>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(verifyBridgeHubDelivery({ config, heartbeat, fetchImpl }),
      { code: 'BRIDGE_HUB_DELIVERY_UNCONFIRMED' });
  }
});

test('一部拒否を端末全体の成功にしないが、受理済みの対象projectは確認できる', async () => {
  const partial = async () => ({ state: 'partial', result: {
    schema: 'lattice.bridge_hub_registration_result.v2', registered: ['movie'],
    rejected: [{ project_id: 'other' }],
  } });
  await assert.rejects(verifyBridgeHubDelivery({ config, heartbeat: partial, fetchImpl: deliveredFetch }),
    { code: 'BRIDGE_HUB_DELIVERY_UNCONFIRMED' });
  assert.equal((await verifyBridgeHubDelivery({ config, heartbeat: partial,
    projectId: 'movie', fetchImpl: deliveredFetch })).state, 'hub_delivered');
});

test('reportのcatchは配信3段階のsubreasonを落とさず、任意detailは保存しない', async () => {
  const cases = [
    { heartbeat: async () => ({ state: 'unreachable' }), fetchImpl: deliveredFetch,
      stage: 'heartbeat_registration', subreason: 'unreachable' },
    { heartbeat, fetchImpl: async () => new Response('', { status: 503 }),
      stage: 'hub_listing', subreason: 'hub_listing_unavailable' },
    { heartbeat, fetchImpl: async (url) => String(url).endsWith('/projects/')
      ? deliveredFetch(url) : new Response('', { status: 503 }),
    stage: 'project_route', subreason: 'project_unreachable' },
  ];
  for (const entry of cases) {
    const result = await reportProjectDashboardDelivery({ projectId: 'movie', env: {},
      ensureDelivery: () => verifyBridgeHubDelivery({ config, ...entry }) });
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'BRIDGE_HUB_DELIVERY_UNCONFIRMED');
    assert.deepEqual(result.failure, { stage: entry.stage, subreason: entry.subreason });
  }
  const result = await reportProjectDashboardDelivery({ projectId: 'movie', env: {},
    ensureDelivery: async () => { throw Object.assign(new Error('secret-marker'), {
      code: 'BRIDGE_HUB_DELIVERY_UNCONFIRMED', detail: { reason: 'secret-marker', token: 'secret-marker' },
    }); } });
  assert.deepEqual(result.failure, { stage: 'unknown', subreason: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /secret-marker/u);
});
