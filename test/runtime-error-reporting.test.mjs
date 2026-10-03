import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  recordRuntimeError,
  runtimeErrorSafeContext,
  runtimeErrorsDiagnostics,
  runtimeErrorsSnapshot,
  setRuntimeErrorStatus,
} from '../src/runtime-errors.mjs';
import {
  productCredentialPath,
  receiptSignatureMatches,
  reportRuntimeErrors,
  runtimeErrorAutoReportDue,
  runtimeErrorReportingStatus,
  setRuntimeErrorReporting,
  signReport,
  verifyRuntimeErrorReporting,
} from '../src/runtime-error-reporting.mjs';
import { restrictWindowsDirToOwner, windowsSelfSid } from '../src/windows-owner-only.mjs';

const windows = process.platform === 'win32';
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');
const CLI_FAILED = 'LATTICE.CLI_INTERNAL_FAILED';
const SECRET = 'bughub-test-secret-do-not-use-0123456789abcdef';
const KEY_ID = 'test-host:lattice.1';
const hmac = (text) => createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(text, 'utf8').digest('hex');

nodeTest('署名と応答の署名は、BugHubの契約の試験値と一致する', () => {
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}');
  assert.equal(body.length, 205);
  assert.equal(createHash('sha256').update(body).digest('hex'), '6a8ae99ecebde0f6d50b8e8d5273604c6e02c3df150645bd96de0e79d7710b2f');
  assert.equal(signReport(SECRET, '1790000000', body), 'e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a');
  const reportId = '00000000-0000-4000-8000-000000000001';
  const receivedAt = '2026-09-21T14:13:21.000Z';
  const sig = 'cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb';
  assert.equal(receiptSignatureMatches(SECRET, reportId, receivedAt, sig), true);
  assert.equal(receiptSignatureMatches(SECRET, reportId, '2026-09-21T14:13:22.000Z', sig), false);
  assert.equal(receiptSignatureMatches(SECRET, reportId, receivedAt, 'not-hex'), false);
  assert.equal(receiptSignatureMatches(SECRET, reportId, undefined, sig), false);
});

nodeTest('収集に対応しないOSでは、送信も対象外と答え、設定を書かない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-report-win-'));
  try {
    const options = { platform: 'freebsd', reportingConfigPath: path.join(root, 'reporting.json'),
      credentialPath: path.join(root, 'lattice.json'), storePath: path.join(root, 'state', 'runtime-errors.json') };
    assert.equal((await reportRuntimeErrors(options)).outcome, 'unsupported');
    assert.equal(runtimeErrorReportingStatus(options).reporting, 'unsupported');
    assert.throws(() => setRuntimeErrorReporting(true, options), /reporting_unsupported/);
    assert.equal(runtimeErrorAutoReportDue(options), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** 受け口の代わり。届いた要求を溜め、`respond`が返す応答をそのまま返す。 */
async function startIntake(respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const entry = { method: request.method, url: request.url, headers: request.headers, bytes,
        body: JSON.parse(bytes.toString('utf8')) };
      requests.push(entry);
      const answer = respond(entry, requests.length);
      if (answer === null) return; // 応答しない（時間切れの試験）
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/api/products/v1/runtime-errors`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const signedReceipt = (entry, extra = {}) => {
  const receivedAt = '2026-10-03T09:00:01.000Z';
  return { status: 200, body: { accepted: true, report_id: entry.body.report_id, duplicate: false,
    received_at: receivedAt, sig: hmac(`${entry.body.report_id}\n${receivedAt}`), ...extra } };
};

/** BugHubの持ち主が合鍵を置く形で置く: POSIXは0600、Windowsは本人・SYSTEM・Administratorsだけのフォルダの中。 */
async function placeCredential(credentialPath, content) {
  await mkdir(path.dirname(credentialPath), { recursive: true });
  if (windows) restrictWindowsDirToOwner(path.dirname(credentialPath), windowsSelfSid());
  await writeFile(credentialPath, JSON.stringify(content), { mode: 0o600 });
}

async function makeWorkspace(intakeUrl, { enabled = true, credential = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-report-'));
  const reportingConfigPath = path.join(root, 'config', 'runtime-error-reporting.json');
  const credentialPath = path.join(root, 'credentials', 'lattice.json');
  const options = { reportingConfigPath, credentialPath, version: '0.74.0',
    configPath: path.join(root, 'config', 'factory-reporter.json'),
    storePath: path.join(root, 'state', 'runtime-errors.json') };
  if (enabled) setRuntimeErrorReporting(true, options);
  if (credential) await placeCredential(credentialPath, { url: intakeUrl, key_id: KEY_ID, secret: SECRET });
  return { root, options, credentialPath };
}

const fail = (options, commandKind, code) => recordRuntimeError(CLI_FAILED, { ...options,
  safeContext: runtimeErrorSafeContext({ commandKind, error: Object.assign(new Error('x'), { code }) }) });

nodeTest('既定では通信しない: 送信を有効にしていない端末と、合鍵の無い端末は送らない', async () => {
  const intake = await startIntake(signedReceipt);
  const disabled = await makeWorkspace(intake.url, { enabled: false });
  const noCredential = await makeWorkspace(intake.url, { credential: false });
  try {
    // 送信が無効で工場の設定も無ければ、収集そのものが無効で、記録も作らない。
    assert.deepEqual(recordRuntimeError(CLI_FAILED, disabled.options), { status: 'disabled' });
    assert.equal((await reportRuntimeErrors(disabled.options)).outcome, 'disabled');
    assert.equal(runtimeErrorAutoReportDue(disabled.options), false);

    // 送信を有効にすると収集も有効になる（dotagentsの設定は要らない）。合鍵が無ければ送らない。
    fail(noCredential.options, 'run.list', 'ENOENT');
    assert.equal(runtimeErrorsDiagnostics(noCredential.options).collection, 'enabled');
    assert.equal((await reportRuntimeErrors(noCredential.options)).outcome, 'credential_missing');
    assert.equal(runtimeErrorAutoReportDue(noCredential.options), false);
    assert.equal(runtimeErrorReportingStatus(noCredential.options).credential, 'missing');
    assert.equal(intake.requests.length, 0);
  } finally {
    await intake.close();
    await rm(disabled.root, { recursive: true, force: true });
    await rm(noCredential.root, { recursive: true, force: true });
  }
});

nodeTest('合鍵のfileは、本人だけが読める形（POSIXは本人所有・0600）でsymlinkでないものだけを使う', async () => {
  const intake = await startIntake(signedReceipt);
  const workspace = await makeWorkspace(intake.url);
  try {
    fail(workspace.options, 'run.list', 'ENOENT');
    // 他のaccountが読める形にする: POSIXはmodeを広げ、WindowsはUsers（S-1-5-32-545）へ読み取りを足す。
    const icacls = (...args) => assert.equal(spawnSync('icacls', [workspace.credentialPath, ...args]).status, 0);
    if (windows) icacls('/grant', '*S-1-5-32-545:R');
    else await chmod(workspace.credentialPath, 0o644);
    assert.deepEqual([(await reportRuntimeErrors(workspace.options)).outcome,
      runtimeErrorReportingStatus(workspace.options).credential_reason],
    ['credential_unsafe', windows ? 'acl_not_owner_only' : 'mode_not_0600']);
    assert.equal(runtimeErrorAutoReportDue(workspace.options), false);

    if (windows) icacls('/remove', '*S-1-5-32-545');
    else await chmod(workspace.credentialPath, 0o600);
    assert.equal(runtimeErrorReportingStatus(workspace.options).credential, 'present');
    const linked = path.join(workspace.root, 'credentials', 'linked.json');
    // Windowsは、権限の無いaccountにsymlinkを作らせない。作れた時だけ確かめる。
    const made = await symlink(workspace.credentialPath, linked).then(() => true,
      (error) => { if (!windows || error.code !== 'EPERM') throw error; return false; });
    if (made) assert.equal((await reportRuntimeErrors({ ...workspace.options, credentialPath: linked })).reason, 'not_regular_file');

    for (const broken of [
      { url: intake.url, key_id: KEY_ID, secret: 'short' },
      { url: intake.url, key_id: 'has space', secret: SECRET },
      { url: 'ftp://192.168.1.2/x', key_id: KEY_ID, secret: SECRET },
      { url: intake.url, key_id: KEY_ID, secret: SECRET, extra: 1 },
    ]) {
      await writeFile(workspace.credentialPath, JSON.stringify(broken), { mode: 0o600 });
      assert.equal((await reportRuntimeErrors(workspace.options)).outcome, 'credential_unsafe', JSON.stringify(Object.keys(broken)));
    }
    assert.equal(intake.requests.length, 0);
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('未受領の記録を署名つきで送り、署名つきの受領でだけ受領済みにする', async () => {
  const intake = await startIntake(signedReceipt);
  const workspace = await makeWorkspace(intake.url);
  try {
    // 記録は送る時刻より前に起きている（BugHubは、観測より後の時刻の記録を断る）。
    const earlier = { ...workspace.options, now: '2026-10-03T08:59:58.000Z' };
    fail(earlier, 'todo.status', 'ENOTDIR');
    fail(earlier, 'run.list', 'ENOENT');
    assert.equal(runtimeErrorAutoReportDue(workspace.options), true);

    const now = '2026-10-03T09:00:00.000Z';
    const delivered = await reportRuntimeErrors({ ...workspace.options, now });
    assert.equal(delivered.outcome, 'delivered');
    assert.deepEqual(delivered.sent, { runtime_errors: 2, resolutions: 0 });
    assert.equal(delivered.acknowledged_through, 2);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).pending_count, 0);

    assert.equal(intake.requests.length, 1);
    const [request] = intake.requests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/products/v1/runtime-errors');
    assert.equal(request.headers['content-type'], 'application/json');
    // 秘密は載せない。載るのは、送ったバイト列と時刻への署名だけ。
    const ts = String(Date.parse(now) / 1000);
    assert.equal(request.headers.authorization,
      `BugHub-HMAC-SHA256 key_id=${KEY_ID}, ts=${ts}, sig=${signReport(SECRET, ts, request.bytes)}`);
    assert.equal(request.bytes.toString('utf8').includes(SECRET), false);

    // 本文は契約の7項目だけ。端末名・path・例外の本文は入らない。
    assert.deepEqual(Object.keys(request.body), ['schema_version', 'report_id', 'product_id', 'installed_version',
      'observed_at', 'runtime_errors', 'resolutions']);
    assert.equal(request.body.schema_version, '1.0');
    assert.equal(request.body.product_id, 'lattice');
    assert.equal(request.body.installed_version, '0.74.0');
    assert.equal(request.body.observed_at, now);
    assert.match(request.body.report_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(request.body.runtime_errors, runtimeErrorsSnapshot(0, 256, workspace.options).runtime_errors);
    assert.deepEqual(request.body.runtime_errors[0].safe_context,
      { command_kind: 'todo.status', error_kind: 'Error', cause_code: 'ENOTDIR' });
    assert.equal(request.bytes.toString('utf8').includes(workspace.root), false);
    assert.equal(JSON.stringify(delivered).includes(KEY_ID), false);

    // 送るものが無ければ通信しない。
    assert.equal((await reportRuntimeErrors(workspace.options)).outcome, 'nothing_pending');
    assert.equal(intake.requests.length, 1);

    // 解決は、解決の記録として届く。
    const fingerprint = request.body.runtime_errors[0].fingerprint;
    setRuntimeErrorStatus(fingerprint, 'resolved', workspace.options);
    const resolved = await reportRuntimeErrors(workspace.options);
    assert.deepEqual([resolved.outcome, resolved.sent], ['delivered', { runtime_errors: 0, resolutions: 1 }]);
    assert.deepEqual(Object.keys(intake.requests[1].body.resolutions[0]), ['fingerprint', 'resolved_at', 'reason_code']);
    assert.equal(intake.requests[1].body.resolutions[0].fingerprint, fingerprint);
    assert.notEqual(intake.requests[1].body.report_id, request.body.report_id);
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

/** BugHubの検査と同じ規則: 記録の時刻が`observed_at`より後なら422で断る。 */
const strictIntake = (entry) => {
  const observed = Date.parse(entry.body.observed_at);
  const late = [...entry.body.runtime_errors.map((record) => record.last_seen),
    ...entry.body.resolutions.map((resolution) => resolution.resolved_at)].some((time) => Date.parse(time) > observed);
  return late ? { status: 422, body: { error: 'invalid_report' } } : signedReceipt(entry);
};

nodeTest('observed_atは載せる記録の時刻より前にならない: 記録と同じ1秒の中で送っても受領される', async () => {
  const intake = await startIntake(strictIntake);
  const workspace = await makeWorkspace(intake.url);
  const at = (now) => ({ ...workspace.options, now });
  try {
    // 故障の直後（同じ秒の50ms後）に送る。秒へ切り捨てた`observed_at`は記録より前になり、断られていた。
    fail(at('2026-10-03T12:22:47.900Z'), 'todo.status', 'ENOTDIR');
    const first = await reportRuntimeErrors(at('2026-10-03T12:22:47.950Z'));
    assert.deepEqual([first.outcome, first.http_status], ['delivered', 200]);
    assert.equal(intake.requests[0].body.observed_at, '2026-10-03T12:22:47.950Z');
    // 署名の時刻は秒のまま。`observed_at`との差は1秒に満たない。
    assert.match(intake.requests[0].headers.authorization, / ts=1791030167, /);

    // 解決を打った直後も同じ。
    const fingerprint = intake.requests[0].body.runtime_errors[0].fingerprint;
    setRuntimeErrorStatus(fingerprint, 'resolved', at('2026-10-03T12:22:48.921Z'));
    const second = await reportRuntimeErrors(at('2026-10-03T12:22:48.990Z'));
    assert.deepEqual([second.outcome, second.sent], ['delivered', { runtime_errors: 0, resolutions: 1 }]);
    assert.equal(intake.requests[1].body.observed_at, '2026-10-03T12:22:48.990Z');

    // 端末の時計が少し戻った時: 記録の時刻のほうが後なら、`observed_at`をその時刻まで進める。
    fail(at('2026-10-03T12:23:10.500Z'), 'run.list', 'ENOENT');
    const third = await reportRuntimeErrors(at('2026-10-03T12:23:09.000Z'));
    assert.equal(third.outcome, 'delivered');
    assert.equal(intake.requests[2].body.observed_at, '2026-10-03T12:23:10.500Z');
    assert.equal(runtimeErrorsDiagnostics(workspace.options).pending_count, 0);
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('reporting verify: 空の報告を1通送って経路を確かめ、記録と受領の印には触れない', async () => {
  const answers = [signedReceipt, () => ({ status: 429, body: { error: 'rate_limited' } }),
    (entry) => ({ ...signedReceipt(entry), body: { ...signedReceipt(entry).body, sig: 'f'.repeat(64) } })];
  const intake = await startIntake((entry, count) => answers[count - 1](entry));
  const workspace = await makeWorkspace(intake.url);
  const disabled = await makeWorkspace(intake.url, { enabled: false });
  const noCredential = await makeWorkspace(intake.url, { credential: false });
  try {
    // 送信を有効にしていない端末と、合鍵の無い端末は、確かめる時もnetworkへ触れない。
    assert.equal((await verifyRuntimeErrorReporting(disabled.options)).outcome, 'disabled');
    assert.equal((await verifyRuntimeErrorReporting(noCredential.options)).outcome, 'credential_missing');
    assert.equal((await verifyRuntimeErrorReporting({ ...workspace.options, platform: 'freebsd' })).outcome, 'unsupported');
    assert.equal(intake.requests.length, 0);

    // 未受領の記録があっても、載せるのは空の配列だけ。
    fail(workspace.options, 'run.list', 'ENOENT');
    const before = [runtimeErrorsDiagnostics(workspace.options), runtimeErrorReportingStatus(workspace.options)];
    const now = '2026-10-03T12:30:00.250Z';
    const verified = await verifyRuntimeErrorReporting({ ...workspace.options, now });
    assert.deepEqual([verified.outcome, verified.http_status, verified.sent], ['verified', 200, { runtime_errors: 0, resolutions: 0 }]);
    const [request] = intake.requests;
    assert.deepEqual([request.body.runtime_errors, request.body.resolutions, request.body.observed_at], [[], [], now]);
    assert.deepEqual(Object.keys(request.body), ['schema_version', 'report_id', 'product_id', 'installed_version',
      'observed_at', 'runtime_errors', 'resolutions']);
    const ts = String(Math.floor(Date.parse(now) / 1000));
    assert.equal(request.headers.authorization,
      `BugHub-HMAC-SHA256 key_id=${KEY_ID}, ts=${ts}, sig=${signReport(SECRET, ts, request.bytes)}`);
    assert.equal(JSON.stringify(verified).includes(KEY_ID), false);
    // 記録・受領の印・送る時機の記録は、確かめる前と同じ。
    assert.deepEqual([runtimeErrorsDiagnostics(workspace.options), runtimeErrorReportingStatus(workspace.options)], before);
    assert.equal(before[0].pending_count, 1);

    // 受け口が断った時と、受領の署名が合わない時は、確かめられたとは答えない。
    const limited = await verifyRuntimeErrorReporting(workspace.options);
    assert.deepEqual([limited.outcome, limited.reason, limited.http_status], ['rejected', 'rate_limited', 429]);
    const forged = await verifyRuntimeErrorReporting(workspace.options);
    assert.deepEqual([forged.outcome, forged.reason], ['unconfirmed', 'receipt_not_verified']);
  } finally {
    await intake.close();
    for (const item of [workspace, disabled, noCredential]) await rm(item.root, { recursive: true, force: true });
  }
});

nodeTest('受領を確かめられない応答では受領済みにせず、後から今の累計を送り直す', async () => {
  const answers = [
    (entry) => ({ status: 200, body: { accepted: true, report_id: entry.body.report_id, received_at: '2026-10-03T09:00:01.000Z', sig: 'f'.repeat(64) } }),
    (entry) => signedReceipt({ body: { report_id: '00000000-0000-4000-8000-000000000009' } }),
    (entry) => signedReceipt(entry, { accepted: false }),
    () => ({ status: 503, body: { error: 'unavailable' } }),
    () => ({ status: 401, body: { error: 'unauthorized' } }),
    () => ({ status: 422, body: { error: 'invalid_report', violations: [{ code: 'x', at: '/y' }] } }),
    () => ({ status: 429, body: { error: 'rate_limited' } }),
    () => ({ status: 418, body: { error: 'Not A Code!' } }),
    () => null,
  ];
  const intake = await startIntake((entry, count) => answers[count - 1](entry));
  const workspace = await makeWorkspace(intake.url);
  try {
    fail(workspace.options, 'run.list', 'ENOENT');
    const outcomes = [];
    for (let index = 0; index < answers.length; index += 1) {
      const result = await reportRuntimeErrors({ ...workspace.options, timeoutMs: 300 });
      outcomes.push([result.outcome, result.reason, result.http_status]);
    }
    assert.deepEqual(outcomes, [
      ['unconfirmed', 'receipt_not_verified', 200],
      ['unconfirmed', 'receipt_not_verified', 200],
      ['unconfirmed', 'receipt_not_verified', 200],
      ['unconfirmed', 'unavailable', 503],
      ['rejected', 'unauthorized', 401],
      ['rejected', 'invalid_report', 422],
      ['rejected', 'rate_limited', 429],
      ['rejected', 'unrecognized_response', 418],
      ['unconfirmed', 'timeout', null],
    ]);
    // どの応答でも、記録は未受領のまま残る。
    assert.equal(runtimeErrorsDiagnostics(workspace.options).pending_count, 1);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).acknowledged_through, 0);
    assert.equal(runtimeErrorReportingStatus(workspace.options).last_outcome, 'unconfirmed');
    // 送り直しは毎回新しいreport_idで、その時点の累計を送る。
    assert.equal(new Set(intake.requests.map((request) => request.body.report_id)).size, answers.length);
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('自動送信は1分に1回まで、同じ中身の送り直しは1時間に1回まで', async () => {
  let accept = false;
  const intake = await startIntake((entry) => (accept ? signedReceipt(entry) : { status: 503, body: { error: 'unavailable' } }));
  const workspace = await makeWorkspace(intake.url);
  const at = (minutes) => ({ ...workspace.options, auto: true, now: new Date(Date.parse('2026-10-03T09:00:00.000Z') + minutes * 60_000).toISOString() });
  try {
    fail(workspace.options, 'run.list', 'ENOENT');
    assert.equal((await reportRuntimeErrors(at(0))).outcome, 'unconfirmed');
    assert.deepEqual([(await reportRuntimeErrors(at(0.5))).outcome, (await reportRuntimeErrors(at(0.5))).reason],
      ['throttled', 'attempted_within_a_minute']);
    assert.equal((await reportRuntimeErrors(at(30))).reason, 'same_report_retried_within_an_hour');
    assert.equal(runtimeErrorAutoReportDue(at(30)), false);
    assert.equal(intake.requests.length, 1);

    // 新しい記録が増えたら、1時間を待たずに送る。
    fail(workspace.options, 'todo.status', 'ENOTDIR');
    assert.equal(runtimeErrorAutoReportDue(at(31)), true);
    assert.equal((await reportRuntimeErrors(at(31))).outcome, 'unconfirmed');
    assert.equal((await reportRuntimeErrors(at(60))).outcome, 'throttled');

    // 1時間たてば、同じ中身でも送り直す。受領されれば未受領は無くなる。
    accept = true;
    const delivered = await reportRuntimeErrors(at(92));
    assert.deepEqual([delivered.outcome, delivered.sent.runtime_errors], ['delivered', 2]);
    assert.equal(runtimeErrorAutoReportDue(at(200)), false);
    assert.equal(intake.requests.length, 3);
    // 手で打った送信は時機の制限を見ない。
    fail(workspace.options, 'run.status', 'EACCES');
    assert.equal((await reportRuntimeErrors({ ...workspace.options, now: at(92.1).now })).outcome, 'delivered');
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('CLI: 送信を有効にした端末では、故障を記録した直後に切り離した子processが送る', async () => {
  const intake = await startIntake(signedReceipt);
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-report-cli-'));
  try {
    const env = { ...process.env, NO_COLOR: '1', HOME: root, LATTICE_DASHBOARD_AUTOSTART: '0',
      USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(root, '.config'), XDG_STATE_HOME: path.join(root, 'xdg-state') };
    delete env.LATTICE_RUNTIME_ERROR_REPORTING;
    const cli = (args, cwd = root) => spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
    const json = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));

    // 既定は無効。有効にする前は、故障しても記録も通信もしない。
    assert.equal(json(cli(['runtime-errors', 'reporting', 'status', '--json'])).reporting, 'disabled');
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    await writeFile(path.join(repo, '.lattice'), 'not a directory\n');
    assert.equal(cli(['todo', 'status', '--json'], repo).status, 1);
    assert.equal(json(cli(['runtime-errors', 'diagnostics', '--json'])).collection, 'disabled');

    // 合鍵はBugHubの契約の置き場へ置く（Windowsは`%LOCALAPPDATA%\bughub\product-credentials\`）。
    await placeCredential(productCredentialPath(env), { url: intake.url, key_id: KEY_ID, secret: SECRET });
    const enabled = json(cli(['runtime-errors', 'reporting', 'enable', '--json']));
    assert.deepEqual([enabled.reporting, enabled.credential, enabled.collection], ['enabled', 'present', 'enabled']);
    assert.equal((await readFile(path.join(root, '.config', 'lattice', 'runtime-error-reporting.json'), 'utf8')).trim(),
      '{"schema":"lattice.runtime_error_reporting_config.v1","enabled":true}');
    assert.equal(intake.requests.length, 0);

    // 故障を1件起こす。CLIは送信を待たずに返り、子processが届ける。
    // Windowsでは、この入力は契約内のerrorで返り記録にならない（`lstat`がENOTDIRでなくENOENTを返す）。
    // 記録だけ同じ分類で直に作り、次のCLI実行が子processを起こすことを確かめる。
    if (windows) {
      fail({ env }, 'todo.status', 'ENOTDIR');
      assert.equal(cli(['runtime-errors', 'diagnostics', '--json']).status, 0);
    } else {
      const failed = cli(['todo', 'status', '--json'], repo);
      assert.equal(failed.status, 1, failed.stderr);
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline
      && json(cli(['runtime-errors', 'reporting', 'status', '--json'])).last_outcome !== 'delivered') {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const status = json(cli(['runtime-errors', 'reporting', 'status', '--json']));
    assert.deepEqual([status.last_outcome, status.pending_count], ['delivered', 0]);
    assert.equal(intake.requests.length, 1);
    assert.deepEqual(intake.requests[0].body.runtime_errors[0].safe_context,
      { command_kind: 'todo.status', error_kind: 'Error', cause_code: 'ENOTDIR' });

    // 手で打つ送信: 送るものが無ければ通信せずexit 0。
    const manual = cli(['runtime-errors', 'report', '--json']);
    assert.deepEqual([manual.status, json(manual).outcome], [0, 'nothing_pending']);
    assert.equal(intake.requests.length, 1);

    // 経路の確認: 空の報告を1通送り、受領まで確かめられればexit 0。
    // このprocessが受け口を兼ねるので、応答を返せるよう、待ち合わせる形でCLIを起こす。
    const verify = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'runtime-errors', 'reporting', 'verify', '--json'], { cwd: root, env });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.once('error', reject).once('close', (status) => resolve({ status, stdout }));
    });
    assert.deepEqual([verify.status, json(verify).outcome], [0, 'verified']);
    assert.equal(intake.requests.length, 2);
    assert.deepEqual([intake.requests[1].body.runtime_errors, intake.requests[1].body.resolutions], [[], []]);

    // 無効に戻せば、送信も確認もnetworkへ触れない。
    assert.equal(json(cli(['runtime-errors', 'reporting', 'disable', '--json'])).reporting, 'disabled');
    const off = cli(['runtime-errors', 'report', '--json']);
    assert.deepEqual([off.status, json(off).outcome], [1, 'disabled']);
    const verifyOff = cli(['runtime-errors', 'reporting', 'verify', '--json']);
    assert.deepEqual([verifyOff.status, json(verifyOff).outcome], [1, 'disabled']);
    assert.equal(intake.requests.length, 2);
  } finally {
    await intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
