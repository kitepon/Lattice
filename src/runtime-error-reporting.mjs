import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';

import {
  REPORTING_CONFIG_SCHEMA,
  acknowledgeRuntimeErrors,
  ensureSafeDir,
  ensureSafeFile,
  readRuntimeErrorReportingConfig,
  replaceStoreFile,
  runtimeErrorCollectionSupported,
  runtimeErrorReportingConfigPath,
  runtimeErrorReportingEnabled,
  runtimeErrorsDiagnostics,
  runtimeErrorsSnapshot,
  runtimeErrorsStatePath,
  validReportingSigner,
  validReportingUrl,
} from './runtime-errors.mjs';

/**
 * runtime error記録を、Lattice自身がBugHubの製品報告の受け口へ送る（ADR 0193・0197）。
 *
 * - 既定では通信しない。端末で`runtime-errors reporting enable`を打ち、署名者（`--key-id`と署名commandの
 *   argv）を設定した端末だけが送る。どちらかが欠ければ、networkへ触れない。
 * - 秘密は端末に無い。署名の鍵は認証仲介の中だけにある。Latticeは「ts + LF + 本文SHA-256のhex」を
 *   署名者commandへ渡し、返る生r‖s（ES256）を`Authorization: BugHub-ES256`に付ける。
 * - 受領済みにするのは、200・`accepted: true`・`report_id`一致・応答のES256署名がBugHubの応答用公開鍵で
 *   合うことがそろった時だけ。そろわなければ「届いたか不明」として記録を未受領のまま残し、後から今の累計を送り直す。
 * - 署名できなければ送らない。記録は残り、届かなかった送信と同じく後から送り直す。
 * - 送るのは`runtime-errors snapshot`が出す項目だけ。message本文・path・引数・stackは記録に無い。
 * - `reporting verify`は、記録を載せない空の報告を1通送って、署名者・署名・受け口までの経路を確かめる。
 *   受け口は受領を記録するだけで、issueも通知も動かない。storeの記録と受領の印には触れない。
 */

const REPORT_SCHEMA_VERSION = '1.0';
const RESULT_SCHEMA = 'lattice.runtime_error_report_result.v1';
const STATUS_SCHEMA = 'lattice.runtime_error_reporting_status.v1';
const DELIVERY_SCHEMA = 'lattice.runtime_error_delivery.v1';
const PRODUCT_ID = 'lattice';
// BugHubの製品報告の受け口（LAN内。製品共通の1本）。設定の`url`で差し替えられる。
const DEFAULT_INTAKE_URL = 'http://192.168.1.2:39310/api/products/v1/runtime-errors';
// BugHubの応答用公開鍵（ES256）。BugHubの応答署名はこの鍵でだけ確かめる。鍵が替わる時は新版を出す。
const BUGHUB_RESPONSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEX+kilvDhn190l4Z+iR5J4KusmOSJ
ZVBQjMaLGOshDFzUwB7IxiJsgLMpQzOdoEWM21DCBpL1QyY1COU2cmuE1g==
-----END PUBLIC KEY-----
`;
const SIGNER_TIMEOUT_MS = 30_000;
const SIGNER_OUTPUT_MAX_BYTES = 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const REPORT_MAX_BYTES = 512 * 1024;
const REPORT_MAX_RECORDS = 256;
// BugHubは端末×製品ごとに1分に1回まで受ける。届かなかった同じ中身の送り直しは1時間に1回まで。
const MIN_ATTEMPT_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 60 * 60_000;
const REJECTION_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OUTCOMES = Object.freeze(['delivered', 'nothing_pending', 'disabled', 'unsupported', 'signer_missing',
  'signer_refused', 'signer_failed', 'throttled', 'rejected', 'unconfirmed', 'store_unavailable']);

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 署名者へ渡す文字列: `ts + "\n" + SHA-256(送るバイト列)の16進`。末尾に改行は付けない。 */
export function reportSigningText(ts, bodyBytes) {
  return `${ts}\n${sha256Hex(bodyBytes)}`;
}

/** 生r‖s（64バイト）か、そのbase64（パディングあり）を、64バイトへ直す。 */
function signatureBytes(output) {
  if (output.length === 64) return output;
  const text = output.toString('utf8').trim();
  return /^[A-Za-z0-9+/]{86}==$/.test(text) ? Buffer.from(text, 'base64') : null;
}

/** 応答の署名: BugHubの応答用公開鍵で`report_id + "\n" + received_at`へのES256署名を確かめる。別の機器が返した200を受領済みにしない。 */
export function receiptSignatureValid(publicKeyPem, reportId, receivedAt, sig) {
  if (typeof receivedAt !== 'string' || typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  try {
    return verify('sha256', Buffer.from(`${reportId}\n${receivedAt}`, 'utf8'),
      { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

/**
 * 署名者commandを走らせて署名を得る。入力は、storeの（本人だけの）folderに置いたfileから標準入力へ渡す
 * ——pipeでは、Windowsのsshが固まる。入力fileは必ず消す。exit 1は断られた、それ以外・時間切れ・起動できない
 * ・形の違う出力は失敗。結果に署名者の出力は載せない。
 */
async function signWithSigner(signer, signingText, options) {
  const env = options.env ?? process.env;
  const dir = dirname(options.storePath ?? runtimeErrorsStatePath(env));
  const input = join(dir, `.signer-input-${process.pid}-${randomBytes(6).toString('hex')}`);
  let fd = null;
  try {
    ensureSafeDir(dir);
    writeFileSync(input, signingText, { mode: 0o600, flag: 'wx' });
    fd = openSync(input, 'r');
  } catch {
    if (fd !== null) closeSync(fd);
    rmSync(input, { force: true });
    return { outcome: 'signer_failed', reason: 'input_not_written' };
  }
  try {
    const run = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(signer.command[0], signer.command.slice(1), { cwd: signer.cwd ?? undefined,
          stdio: [fd, 'pipe', 'ignore'], windowsHide: true });
      } catch {
        resolve({ reason: 'spawn_failed' });
        return;
      }
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ reason: 'timeout' }); }, options.signerTimeoutMs ?? SIGNER_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size <= SIGNER_OUTPUT_MAX_BYTES) chunks.push(chunk);
      });
      child.once('error', () => { clearTimeout(timer); resolve({ reason: 'spawn_failed' }); });
      child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout: size > SIGNER_OUTPUT_MAX_BYTES ? null : Buffer.concat(chunks) }); });
    });
    if (run.code === 1) return { outcome: 'signer_refused', reason: 'signer_refused' };
    if (run.code !== 0) return { outcome: 'signer_failed', reason: run.reason ?? 'signer_exit' };
    const sig = run.stdout === null ? null : signatureBytes(run.stdout);
    return sig === null ? { outcome: 'signer_failed', reason: 'signature_malformed' } : { sig };
  } finally {
    closeSync(fd);
    rmSync(input, { force: true });
  }
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
    replaceStoreFile(temporary, path);
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
  const signer = supported ? readRuntimeErrorReportingConfig(options)?.signer ?? null : null;
  const diagnostics = runtimeErrorsDiagnostics(options);
  const delivery = supported ? readDelivery(options) : emptyDelivery();
  return {
    schema: STATUS_SCHEMA,
    reporting: !supported ? 'unsupported' : enabled ? 'enabled' : 'disabled',
    signer: signer === null ? 'missing' : 'configured',
    key_id: signer?.key_id ?? null,
    collection: diagnostics.collection,
    store_status: diagnostics.status,
    pending_count: diagnostics.pending_count,
    last_attempt_at: delivery.last_attempt_at,
    last_outcome: delivery.last_outcome,
  };
}

/**
 * 送信の設定をLattice自身のfileへ書く。dotagentsの設定は読みも書きもしない。
 * `change.signer`・`change.url`を渡した時だけ署名者・宛先を置き換え、渡さなければ今の設定を引き継ぐ。
 */
export function setRuntimeErrorReporting(enabled, options = {}, change = {}) {
  if (typeof enabled !== 'boolean') throw Error('invalid_enabled');
  if (!runtimeErrorCollectionSupported(options)) throw Error('reporting_unsupported');
  if (change.signer !== undefined && !validReportingSigner(change.signer)) throw Error('invalid_signer');
  if (change.url !== undefined && !validReportingUrl(change.url)) throw Error('invalid_url');
  const env = options.env ?? process.env;
  const path = options.reportingConfigPath ?? runtimeErrorReportingConfigPath(env);
  const current = readRuntimeErrorReportingConfig({ ...options, reportingConfigPath: path });
  const signer = change.signer ?? current?.signer ?? null;
  const url = change.url ?? current?.url ?? null;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (lstatSync(path).isSymbolicLink()) throw Error('config_unsafe');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.runtime-error-reporting-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const config = { schema: REPORTING_CONFIG_SCHEMA, enabled, ...(signer && { signer }), ...(url && { url }) };
    writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
    replaceStoreFile(temporary, path);
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
 * 報告を1通、署名して送り、受領を確かめる。`accepted`を返すのは、200・`accepted: true`・`report_id`一致・
 * 応答のES256署名一致がそろった時だけ。署名できなければ送らない。戻り値に署名・key_id・宛先は入れない。
 */
async function sendReport(config, snapshot, options) {
  const now = nowMs(options);
  const ts = Math.floor(now / 1000);
  // `observed_at`は、載せる記録のどの時刻よりも前にしない（BugHubは観測より後の記録を断る）。秒へ切り捨てると、
  // 記録と同じ1秒の中で送った時に記録より前へずれる。`ts`とは同じ時刻から作り、差はBugHubの許す幅（10分）に収まる。
  const observed = Math.max(now, ...snapshot.runtime_errors.map((record) => Date.parse(record.last_seen)),
    ...snapshot.resolutions.map((resolution) => Date.parse(resolution.resolved_at)));
  const report = buildRuntimeErrorReport({ snapshot, version: options.version ?? 'unknown',
    reportId: options.reportId ?? randomUUID(), observedAt: new Date(observed).toISOString() });
  const bodyBytes = Buffer.from(JSON.stringify(report), 'utf8');
  if (bodyBytes.length > REPORT_MAX_BYTES) return { outcome: 'too_large', reason: 'report_too_large', http_status: null };

  const signed = await signWithSigner(config.signer, reportSigningText(ts, bodyBytes), options);
  if (signed.sig === undefined) return { outcome: signed.outcome, reason: signed.reason, http_status: null };

  const response = await post(new URL(options.url ?? config.url ?? DEFAULT_INTAKE_URL), {
    'Content-Type': 'application/json',
    'Content-Length': String(bodyBytes.length),
    Authorization: `BugHub-ES256 key_id=${config.signer.key_id}, ts=${ts}, sig=${signed.sig.toString('base64')}`,
  }, bodyBytes, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  if (response.status === null) return { outcome: 'unconfirmed', reason: response.reason, http_status: null };
  const body = parseJson(response.body);
  if (response.status === 200) {
    if (body === null || body.accepted !== true || body.report_id !== report.report_id
      || body.sig_alg !== 'ES256'
      || !receiptSignatureValid(options.responseKeyPem ?? BUGHUB_RESPONSE_PUBLIC_KEY, report.report_id, body.received_at, body.sig)) {
      return { outcome: 'unconfirmed', reason: 'receipt_not_verified', http_status: 200 };
    }
    return { outcome: 'accepted', reason: null, http_status: 200 };
  }
  const code = typeof body?.error === 'string' && REJECTION_CODE.test(body.error) ? body.error : 'unrecognized_response';
  return { outcome: response.status >= 500 ? 'unconfirmed' : 'rejected', reason: code, http_status: response.status };
}

/**
 * 未受領の記録を1回送る。`options.auto`の時だけ送る時機の制限を見る（手で打った`report`は見ない
 * ——多すぎればBugHubが429で断る）。戻り値に秘密・key_id・宛先は入れない。
 */
export async function reportRuntimeErrors(options = {}) {
  if (!runtimeErrorCollectionSupported(options)) return result('unsupported');
  if (!runtimeErrorReportingEnabled(options)) return result('disabled');
  const config = readRuntimeErrorReportingConfig(options);
  if (!config?.signer) return result('signer_missing');

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

  const finish = (outcome, extra = {}) => {
    try {
      writeDelivery(options, { schema: DELIVERY_SCHEMA, last_attempt_at: new Date(nowMs(options)).toISOString(),
        last_outcome: outcome, attempted_through: pending.cursor.high_watermark });
    } catch { /* 送信の結果は返す。時機の記録だけが残らない。 */ }
    return result(outcome, { sent, acknowledged_through: pending.cursor.acknowledged_through, ...extra });
  };

  const answer = await sendReport(config, pending, options);
  if (answer.outcome === 'too_large') return result('rejected', { reason: 'report_too_large', sent });
  if (answer.outcome !== 'accepted') return finish(answer.outcome, { reason: answer.reason, http_status: answer.http_status });
  try {
    const acknowledged = acknowledgeRuntimeErrors(pending.cursor.next, options);
    return finish('delivered', { http_status: 200, acknowledged_through: acknowledged.cursor.acknowledged_through });
  } catch {
    // 届いているが受領済みを残せなかった。次の送信が同じ累計を送り直す（BugHubは二重に数えない）。
    return finish('unconfirmed', { reason: 'ack_not_recorded', http_status: 200 });
  }
}

/**
 * 記録を載せない空の報告を1通送り、署名者・署名・受け口までの経路を確かめる（`reporting verify`）。
 * 送る条件は`report`と同じで、送信を有効にしていない端末と署名者の無い端末はnetworkへ触れない。
 * storeの記録・受領の印・送る時機の記録には触れない。受け口は端末×製品ごとに1分に1回まで受けるので、
 * 直前に送っていれば429で断られる。
 */
export async function verifyRuntimeErrorReporting(options = {}) {
  if (!runtimeErrorCollectionSupported(options)) return result('unsupported');
  if (!runtimeErrorReportingEnabled(options)) return result('disabled');
  const config = readRuntimeErrorReportingConfig(options);
  if (!config?.signer) return result('signer_missing');
  const answer = await sendReport(config, { runtime_errors: [], resolutions: [] }, options);
  if (answer.outcome === 'accepted') return result('verified', { http_status: 200 });
  return result(answer.outcome, { reason: answer.reason, http_status: answer.http_status });
}

/**
 * 自動送信の入口が、子processを起こす前に見る軽い判定。設定が無い端末（外の利用者）では、
 * 設定fileの有無を1回見るだけで終わる。署名者commandは、送る時だけ走らせる——毎回のCLI実行には載せない。
 */
export function runtimeErrorAutoReportDue(options = {}) {
  if (!runtimeErrorReportingEnabled(options)) return false;
  try {
    const diagnostics = runtimeErrorsDiagnostics(options);
    if (diagnostics.status !== 'ready' || diagnostics.pending_count === 0) return false;
    if (throttleReason(options, readDelivery(options), diagnostics.high_watermark) !== null) return false;
    return readRuntimeErrorReportingConfig(options)?.signer != null;
  } catch {
    return false;
  }
}
