import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  REPORTING_CONFIG_SCHEMA,
  acknowledgeRuntimeErrors,
  ensureSafeDir,
  ensureSafeFile,
  runtimeErrorCollectionSupported,
  runtimeErrorReportingConfigPath,
  runtimeErrorReportingEnabled,
  runtimeErrorsDiagnostics,
  runtimeErrorsSnapshot,
  runtimeErrorsStatePath,
} from './runtime-errors.mjs';

/**
 * runtime error記録を、Lattice自身がBugHubの製品報告の受け口へ送る（ADR 0193）。
 *
 * - 既定では通信しない。端末で`runtime-errors reporting enable`を打ち、BugHubの持ち主が合鍵のfileを
 *   置いた端末だけが送る。どちらかが欠ければ、networkへ触れない。
 * - 秘密は通信に載せない。本文のSHA-256と時刻へのHMAC-SHA256署名だけを`Authorization`に付ける。
 * - 受領済みにするのは、200・`accepted: true`・`report_id`一致・応答の署名一致がそろった時だけ。
 *   そろわなければ「届いたか不明」として記録を未受領のまま残し、後から今の累計を送り直す。
 * - 送るのは`runtime-errors snapshot`が出す項目だけ。message本文・path・引数・stackは記録に無い。
 */

const REPORT_SCHEMA_VERSION = '1.0';
const RESULT_SCHEMA = 'lattice.runtime_error_report_result.v1';
const STATUS_SCHEMA = 'lattice.runtime_error_reporting_status.v1';
const DELIVERY_SCHEMA = 'lattice.runtime_error_delivery.v1';
const PRODUCT_ID = 'lattice';
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REPORT_MAX_BYTES = 512 * 1024;
const REPORT_MAX_RECORDS = 256;
// BugHubは端末×製品ごとに1分に1回まで受ける。届かなかった同じ中身の送り直しは1時間に1回まで。
const MIN_ATTEMPT_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 60 * 60_000;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REJECTION_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOMES = Object.freeze(['delivered', 'nothing_pending', 'disabled', 'unsupported', 'credential_missing',
  'credential_unsafe', 'throttled', 'rejected', 'unconfirmed', 'store_unavailable']);

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function productCredentialPath(env = process.env) {
  return join(env.HOME || homedir(), '.config', 'bughub', 'product-credentials', `${PRODUCT_ID}.json`);
}

/**
 * 合鍵のfileを読む。BugHubの持ち主が置く形（本人所有・0600・symlinkでない）以外は使わない。
 * 秘密は戻り値の中だけに留め、結果や記録へ写さない。
 */
export function readProductCredential(options = {}) {
  const path = options.credentialPath ?? productCredentialPath(options.env ?? process.env);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unsafe', reason: 'unreadable' };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return { status: 'unsafe', reason: 'not_regular_file' };
  if ((stats.mode & 0o777) !== 0o600) return { status: 'unsafe', reason: 'mode_not_0600' };
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return { status: 'unsafe', reason: 'owner_mismatch' };
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'unsafe', reason: 'not_json' };
  }
  if (!plain(value) || !exact(value, ['url', 'key_id', 'secret'])
    || typeof value.url !== 'string' || typeof value.key_id !== 'string' || typeof value.secret !== 'string'
    || !KEY_ID.test(value.key_id) || value.secret.length < 16 || value.secret.length > 1024) {
    return { status: 'unsafe', reason: 'invalid_shape' };
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    return { status: 'unsafe', reason: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    return { status: 'unsafe', reason: 'invalid_url' };
  }
  return { status: 'ok', credential: { url, keyId: value.key_id, secret: value.secret } };
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hmacHex = (secret, text) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(text, 'utf8').digest('hex');

/** `sig = HMAC-SHA256(secret, ts + "\n" + SHA-256(送るバイト列の16進))`。秘密は文字列のままUTF-8で鍵にする。 */
export function signReport(secret, ts, bodyBytes) {
  return hmacHex(secret, `${ts}\n${sha256Hex(bodyBytes)}`);
}

/** 応答の署名: `HMAC-SHA256(secret, report_id + "\n" + received_at)`。別の機器が返した200を受領済みにしない。 */
export function receiptSignatureMatches(secret, reportId, receivedAt, sig) {
  if (typeof receivedAt !== 'string' || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(hmacHex(secret, `${reportId}\n${receivedAt}`), 'hex');
  return timingSafeEqual(expected, Buffer.from(sig, 'hex'));
}

/** snapshotの未受領分から、受け口へ送る本文を組む。項目はsnapshotが出すものをそのまま載せる。 */
export function buildRuntimeErrorReport({ snapshot, version, reportId, observedAt }) {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_id: reportId,
    product_id: PRODUCT_ID,
    installed_version: version,
    observed_at: observedAt,
    runtime_errors: snapshot.runtime_errors,
    resolutions: snapshot.resolutions,
  };
}

function deliveryStatePath(options) {
  const env = options.env ?? process.env;
  return join(dirname(options.storePath ?? runtimeErrorsStatePath(env)), 'runtime-errors-delivery.json');
}

const emptyDelivery = () => ({ schema: DELIVERY_SCHEMA, last_attempt_at: null, last_outcome: null, attempted_through: 0 });

function readDelivery(options) {
  const path = deliveryStatePath(options);
  if (!existsSync(path)) return emptyDelivery();
  try {
    ensureSafeFile(path);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!plain(value) || !exact(value, ['schema', 'last_attempt_at', 'last_outcome', 'attempted_through'])
      || value.schema !== DELIVERY_SCHEMA
      || (value.last_attempt_at !== null && !Number.isFinite(Date.parse(value.last_attempt_at)))
      || (value.last_outcome !== null && !OUTCOMES.includes(value.last_outcome))
      || !Number.isSafeInteger(value.attempted_through) || value.attempted_through < 0) return emptyDelivery();
    return value;
  } catch {
    return emptyDelivery();
  }
}

function writeDelivery(options, state) {
  const path = deliveryStatePath(options);
  ensureSafeDir(dirname(path));
  const temporary = join(dirname(path), `.runtime-errors-delivery-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const nowMs = (options) => (options.now ? new Date(options.now).valueOf() : Date.now());

/**
 * 自動送信してよい時機か。故障を記録した直後・解決を打った直後・以後のCLI実行が呼ぶ。
 * 未受領が無い、直前の試みから1分未満、同じ中身の送り直しが1時間未満、のどれかなら送らない。
 */
function throttleReason(options, delivery, highWatermark) {
  if (delivery.last_attempt_at === null) return null;
  const elapsed = nowMs(options) - Date.parse(delivery.last_attempt_at);
  if (elapsed < MIN_ATTEMPT_INTERVAL_MS) return 'attempted_within_a_minute';
  if (delivery.last_outcome !== 'delivered' && delivery.attempted_through === highWatermark
    && elapsed < RETRY_INTERVAL_MS) return 'same_report_retried_within_an_hour';
  return null;
}

export function runtimeErrorReportingStatus(options = {}) {
  const supported = runtimeErrorCollectionSupported(options);
  const enabled = runtimeErrorReportingEnabled(options);
  const credential = supported ? readProductCredential(options) : { status: 'missing' };
  const diagnostics = runtimeErrorsDiagnostics(options);
  const delivery = supported ? readDelivery(options) : emptyDelivery();
  return {
    schema: STATUS_SCHEMA,
    reporting: !supported ? 'unsupported' : enabled ? 'enabled' : 'disabled',
    credential: credential.status === 'ok' ? 'present' : credential.status,
    credential_reason: credential.status === 'unsafe' ? credential.reason : null,
    collection: diagnostics.collection,
    store_status: diagnostics.status,
    pending_count: diagnostics.pending_count,
    last_attempt_at: delivery.last_attempt_at,
    last_outcome: delivery.last_outcome,
  };
}

/** 送信の設定をLattice自身のfileへ書く。dotagentsの設定は読みも書きもしない。 */
export function setRuntimeErrorReporting(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw Error('invalid_enabled');
  if (!runtimeErrorCollectionSupported(options)) throw Error('reporting_unsupported');
  const env = options.env ?? process.env;
  const path = options.reportingConfigPath ?? runtimeErrorReportingConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(path).isSymbolicLink()) throw Error('config_unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.runtime-error-reporting-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ schema: REPORTING_CONFIG_SCHEMA, enabled })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return runtimeErrorReportingStatus(options);
}

function post(url, headers, bodyBytes, timeoutMs) {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, { method: 'POST', headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_MAX_BYTES) { request.destroy(); resolve({ status: null, reason: 'response_too_large' }); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', () => resolve({ status: null, reason: 'response_error' }));
    });
    request.on('timeout', () => { request.destroy(); resolve({ status: null, reason: 'timeout' }); });
    request.on('error', () => resolve({ status: null, reason: 'network_error' }));
    request.end(bodyBytes);
  });
}

const result = (outcome, extra = {}) => ({
  schema: RESULT_SCHEMA, outcome, reason: null, http_status: null,
  sent: { runtime_errors: 0, resolutions: 0 }, acknowledged_through: null, ...extra,
});

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return plain(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 未受領の記録を1回送る。`options.auto`の時だけ送る時機の制限を見る（手で打った`report`は見ない
 * ——多すぎればBugHubが429で断る）。戻り値に秘密・key_id・宛先は入れない。
 */
export async function reportRuntimeErrors(options = {}) {
  if (!runtimeErrorCollectionSupported(options)) return result('unsupported');
  if (!runtimeErrorReportingEnabled(options)) return result('disabled');
  const credential = readProductCredential(options);
  if (credential.status === 'missing') return result('credential_missing');
  if (credential.status !== 'ok') return result('credential_unsafe', { reason: credential.reason });

  let pending;
  let delivery;
  try {
    const diagnostics = runtimeErrorsDiagnostics(options);
    if (diagnostics.status !== 'ready') return result('store_unavailable');
    pending = runtimeErrorsSnapshot(diagnostics.acknowledged_through, REPORT_MAX_RECORDS, options);
    delivery = readDelivery(options);
  } catch {
    return result('store_unavailable');
  }
  const sent = { runtime_errors: pending.runtime_errors.length, resolutions: pending.resolutions.length };
  if (sent.runtime_errors + sent.resolutions === 0) {
    return result('nothing_pending', { acknowledged_through: pending.cursor.acknowledged_through });
  }
  if (options.auto === true) {
    const reason = throttleReason(options, delivery, pending.cursor.high_watermark);
    if (reason !== null) return result('throttled', { reason });
  }

  // `ts`と`observed_at`は同じ時刻から作る（BugHubは10分より離れた組を断る）。
  const ts = Math.floor(nowMs(options) / 1000);
  const report = buildRuntimeErrorReport({ snapshot: pending, version: options.version ?? 'unknown',
    reportId: options.reportId ?? randomUUID(), observedAt: new Date(ts * 1000).toISOString() });
  const bodyBytes = Buffer.from(JSON.stringify(report), 'utf8');
  if (bodyBytes.length > REPORT_MAX_BYTES) return result('rejected', { reason: 'report_too_large', sent });

  const finish = (outcome, extra = {}) => {
    try {
      writeDelivery(options, { schema: DELIVERY_SCHEMA, last_attempt_at: new Date(nowMs(options)).toISOString(),
        last_outcome: outcome, attempted_through: pending.cursor.high_watermark });
    } catch { /* 送信の結果は返す。時機の記録だけが残らない。 */ }
    return result(outcome, { sent, acknowledged_through: pending.cursor.acknowledged_through, ...extra });
  };

  const { credential: { url, keyId, secret } } = credential;
  const response = await post(url, {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBytes.length),
    Authorization: `BugHub-HMAC-SHA256 key_id=${keyId}, ts=${ts}, sig=${signReport(secret, String(ts), bodyBytes)}`,
  }, bodyBytes, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  if (response.status === null) return finish('unconfirmed', { reason: response.reason });
  const body = parseJson(response.body);
  if (response.status === 200) {
    if (body === null || body.accepted !== true || body.report_id !== report.report_id
      || !receiptSignatureMatches(secret, report.report_id, body.received_at, body.sig)) {
      return finish('unconfirmed', { reason: 'receipt_not_verified', http_status: 200 });
    }
    try {
      const acknowledged = acknowledgeRuntimeErrors(pending.cursor.next, options);
      return finish('delivered', { http_status: 200, acknowledged_through: acknowledged.cursor.acknowledged_through });
    } catch {
      // 届いているが受領済みを残せなかった。次の送信が同じ累計を送り直す（BugHubは二重に数えない）。
      return finish('unconfirmed', { reason: 'ack_not_recorded', http_status: 200 });
    }
  }
  const code = typeof body?.error === 'string' && REJECTION_CODE.test(body.error) ? body.error : 'unrecognized_response';
  if (response.status >= 500) return finish('unconfirmed', { reason: code, http_status: response.status });
  return finish('rejected', { reason: code, http_status: response.status });
}

/**
 * 自動送信の入口が、子processを起こす前に見る軽い判定。設定が無い端末（外の利用者）では、
 * 設定fileの有無を1回見るだけで終わる。
 */
export function runtimeErrorAutoReportDue(options = {}) {
  if (!runtimeErrorReportingEnabled(options)) return false;
  if (readProductCredential(options).status !== 'ok') return false;
  try {
    const diagnostics = runtimeErrorsDiagnostics(options);
    if (diagnostics.status !== 'ready' || diagnostics.pending_count === 0) return false;
    return throttleReason(options, readDelivery(options), diagnostics.high_watermark) === null;
  } catch {
    return false;
  }
}
