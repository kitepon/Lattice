import { BridgeConfigError, readBridgeConfig } from './bridge-config.mjs';
import { createBridgeHubHeartbeatController } from './bridge-hub-heartbeat.mjs';

// 配信結果は全OS共通。常駐の復旧はbridge CLIがOS固有の入口へ委ねる。

const SCHEMA = 'lattice.dashboard_delivery.v1';
const SETUP = 'lattice bridge setup --listen <IP> --dashboard --hub <URL> --json';
const FAILURE_STAGES = new Map([
  ...['heartbeat_missing', 'heartbeat_invalid', 'unreachable', 'rejected', 'skipped_no_dashboard',
    'skipped_no_projects', 'project_not_registered'].map((reason) => [reason, 'heartbeat_registration']),
  ...['hub_listing_unavailable', 'project_not_visible'].map((reason) => [reason, 'hub_listing']),
  ...['project_unreachable', 'project_response_invalid'].map((reason) => [reason, 'project_route']),
]);

function receipt(state, reason, projectIds = [], urls = [], nextAction = null) {
  return { schema: SCHEMA, state, reason, project_ids: projectIds, urls, next_action: nextAction };
}

function unconfirmed(reason, projectIds = []) {
  return new BridgeConfigError('BRIDGE_HUB_DELIVERY_UNCONFIRMED',
    '工程の公開配信を確認できません。接続設定は保存済みです。', {
      reason, stage: FAILURE_STAGES.get(reason), project_ids: projectIds,
      next_action: 'lattice todo dashboard ensure --json',
    });
}

/** 登録の受付、一覧への掲載、工程HTMLの中継を同じ呼出しで確認する。 */
export async function verifyBridgeHubDelivery({ config, env = process.env, projectId = null,
  heartbeat = async () => createBridgeHubHeartbeatController({ env }).tick({ config }),
  fetchImpl = fetch, timeoutMs = 5_000 } = {}) {
  if (config.hub === null) return receipt('bridge_only', 'hub_unconfigured', [], [], SETUP);
  const delivered = await heartbeat();
  const result = delivered?.result;
  const registered = result?.registered;
  if (!['accepted', 'partial'].includes(delivered?.state)
    || result?.schema !== 'lattice.bridge_hub_registration_result.v2'
    || !Array.isArray(registered) || !registered.every((id) => typeof id === 'string')
    || !Array.isArray(result.rejected)) {
    throw unconfirmed(FAILURE_STAGES.has(delivered?.state) ? delivered.state
      : delivered?.state == null ? 'heartbeat_missing' : 'heartbeat_invalid');
  }
  const projectIds = projectId === null ? registered : [projectId];
  if (projectIds.length === 0 || projectIds.some((id) => !registered.includes(id))
    || (projectId === null && result.rejected.length > 0)) {
    throw unconfirmed('project_not_registered', projectIds);
  }
  const request = (url, accept) => fetchImpl(url, { redirect: 'error',
    headers: { accept }, signal: AbortSignal.timeout(timeoutMs) });
  let listing;
  try {
    const response = await request(new URL('projects/', config.hub.url), 'application/json');
    if (response.status !== 200) throw unconfirmed('hub_listing_unavailable', projectIds);
    listing = await response.json();
  } catch (error) {
    if (error?.code === 'BRIDGE_HUB_DELIVERY_UNCONFIRMED') throw error;
    throw unconfirmed('hub_listing_unavailable', projectIds);
  }
  if (!Array.isArray(listing) || projectIds.some((id) =>
    !listing.some((entry) => entry.project_id === id && entry.status === 'online'))) {
    throw unconfirmed('project_not_visible', projectIds);
  }
  const urls = [];
  for (const id of projectIds) {
    const url = new URL(`projects/${encodeURIComponent(id)}/`, config.hub.url);
    try {
      const response = await request(url, 'text/html');
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) {
        throw unconfirmed('project_unreachable', [id]);
      }
      const html = await response.text();
      if (!/<title>Lattice — [^<]+依存工程図<\/title>/u.test(html)) {
        throw unconfirmed('project_response_invalid', [id]);
      }
    } catch (error) {
      if (error?.code === 'BRIDGE_HUB_DELIVERY_UNCONFIRMED') throw error;
      throw unconfirmed('project_unreachable', [id]);
    }
    urls.push(url.href);
  }
  return receipt('hub_delivered', null, projectIds, urls);
}

export async function ensureProjectDashboardDelivery({ projectId, env = process.env,
  readConfig = readBridgeConfig, verify = verifyBridgeHubDelivery,
  recover = async (options) => {
    const { recoverConfiguredBridge } = await import('./bridge-cli.mjs');
    await recoverConfiguredBridge(options);
  } } = {}) {
  const config = await readConfig({ env });
  if (config === null || !config.enabled) {
    return receipt('local_only', config === null ? 'bridge_unconfigured' : 'bridge_disabled',
      [projectId], [], SETUP);
  }
  await recover({ config, env });
  return verify({ config: await readConfig({ env }), env, projectId });
}

/** stdoutの工程契約を変えず、保存と配信の結果を別のtyped receiptで伝える。 */
export async function reportProjectDashboardDelivery({ projectId, env, stderr,
  ensureDelivery = ensureProjectDashboardDelivery }) {
  let delivery;
  try { delivery = await ensureDelivery({ projectId, env }); }
  catch (error) {
    // 外部境界の故障だけを配信失敗へ写す。内部の型・実装不整合は隠さない。
    if (typeof error?.code !== 'string') throw error;
    delivery = receipt('failed', error.code, [projectId], [],
      error.detail?.next_action ?? 'lattice bridge status --json');
    const subreason = error.detail?.reason;
    delivery.failure = error.code === 'BRIDGE_HUB_DELIVERY_UNCONFIRMED' && FAILURE_STAGES.has(subreason)
      ? { stage: FAILURE_STAGES.get(subreason), subreason }
      : { stage: 'unknown', subreason: 'unavailable' };
  }
  stderr?.write(`${JSON.stringify(delivery)}\n`);
  return delivery;
}
