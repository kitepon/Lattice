import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  receiptSignatureValid,
  reportRuntimeErrors,
  reportSigningText,
  runtimeErrorAutoReportDue,
  runtimeErrorReportingStatus,
  setRuntimeErrorReporting,
  verifyRuntimeErrorReporting,
} from '../src/runtime-error-reporting.mjs';

const windows = process.platform === 'win32';
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');
const CLI_FAILED = 'LATTICE.CLI_INTERNAL_FAILED';
const KEY_ID = 'test-host.lattice.es256-00000001';
const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
// 試験用の鍵。製品の鍵は署名者（偽の認証仲介）だけが持ち、応答の鍵はBugHubの代わりの受け口が持つ。
const productKeys = pair();
const responseKeys = pair();
const pem = (key, type) => key.export({ type, format: 'pem' });
const productPublicPem = pem(productKeys.publicKey, 'spki');
const responsePublicPem = pem(responseKeys.publicKey, 'spki');
const signRaw = (privateKey, text) => sign('sha256', Buffer.from(text, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });

// 偽の署名者。入力を標準入力から読み（fileか、pipeか、cwdはどこかを記録）、modeに従って答える。
const FAKE_SIGNER = `import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, fstatSync, readFileSync } from 'node:fs';
const [keyPath, mode, logPath] = process.argv.slice(2);
const input = readFileSync(0);
appendFileSync(logPath, JSON.stringify({ input: input.toString('utf8'), cwd: process.cwd(), stdinIsFile: fstatSync(0).isFile() }) + '\\n');
if (mode === 'refuse') process.exit(1);
if (mode === 'fail') process.exit(2);
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const raw = sign('sha256', input, { key: createPrivateKey(readFileSync(keyPath)), dsaEncoding: 'ieee-p1363' });
  if (mode === 'raw') process.stdout.write(raw);
  else if (mode === 'garbage') process.stdout.write('not a signature\\n');
  else process.stdout.write(raw.toString('base64') + '\\n');
}
`;

nodeTest('署名の入力は契約どおり、応答の署名はBugHubの応答用公開鍵でだけ確かめる', () => {
  const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}');
  assert.equal(body.length, 205);
  assert.equal(createHash('sha256').update(body).digest('hex'), '6a8ae99ecebde0f6d50b8e8d5273604c6e02c3df150645bd96de0e79d7710b2f');
  assert.equal(reportSigningText('1790000000', body), '1790000000\n6a8ae99ecebde0f6d50b8e8d5273604c6e02c3df150645bd96de0e79d7710b2f');

  const reportId = '00000000-0000-4000-8000-000000000001';
  const receivedAt = '2026-09-21T14:13:21.000Z';
  const sig = signRaw(responseKeys.privateKey, `${reportId}\n${receivedAt}`).toString('base64');
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, receivedAt, sig), true);
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, '2026-09-21T14:13:22.000Z', sig), false);
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, receivedAt, 'not-base64'), false);
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, receivedAt, 'f'.repeat(64)), false);
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, undefined, sig), false);
  // 別の鍵（たとえば製品の鍵）で署名した応答は、受領にしない。
  assert.equal(receiptSignatureValid(productPublicPem, reportId, receivedAt, sig), false);
  assert.equal(receiptSignatureValid(responsePublicPem, reportId, receivedAt,
    signRaw(productKeys.privateKey, `${reportId}\n${receivedAt}`).toString('base64')), false);
});

nodeTest('収集に対応しないOSでは、送信も対象外と答え、設定を書かない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-report-win-'));
  try {
    const options = { platform: 'freebsd', reportingConfigPath: path.join(root, 'reporting.json'),
      storePath: path.join(root, 'state', 'runtime-errors.json') };
    assert.equal((await reportRuntimeErrors(options)).outcome, 'unsupported');
    assert.equal(runtimeErrorReportingStatus(options).reporting, 'unsupported');
    assert.throws(() => setRuntimeErrorReporting(true, options), /reporting_unsupported/);
    assert.equal(runtimeErrorAutoReportDue(options), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** 受け口の代わり。届いた要求を溜め、BugHub-ES256の署名を製品の公開鍵で確かめ、`respond`が返す応答をそのまま返す。 */
async function startIntake(respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const entry = { method: request.method, url: request.url, headers: request.headers, bytes,
        body: JSON.parse(bytes.toString('utf8')) };
      const header = /^BugHub-ES256 key_id=([^,]+), ts=(\d+), sig=([A-Za-z0-9+/]{86}==)$/.exec(request.headers.authorization ?? '');
      entry.authValid = header !== null && header[1] === KEY_ID
        && verify('sha256', Buffer.from(reportSigningText(header[2], bytes), 'utf8'),
          { key: createPublicKey(productPublicPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(header[3], 'base64'));
      requests.push(entry);
      const answer = entry.authValid ? respond(entry, requests.length) : { status: 401, body: { error: 'unauthorized' } };
      if (answer === null) return; // 応答しない（時間切れの試験）
      // 署名受領の試験を、同期store確認の間にidleになるsocketの再利用から切り離す。
      // 実HTTPは通すが、fixtureの接続寿命を成功条件へ混ぜない。
      response.writeHead(answer.status, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}/api/products/v1/runtime-errors`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const receiptBody = (reportId, extra = {}, privateKey = responseKeys.privateKey) => {
  const receivedAt = '2026-10-03T09:00:01.000Z';
  return { accepted: true, report_id: reportId, duplicate: false, received_at: receivedAt,
    sig: signRaw(privateKey, `${reportId}\n${receivedAt}`).toString('base64'), sig_alg: 'ES256', ...extra };
};
const signedReceipt = (entry, extra = {}) => ({ status: 200, body: receiptBody(entry.body.report_id, extra) });

const deliveryDetails = (answer, intake) =>
  `outcome=${answer.outcome} reason=${answer.reason} http_status=${answer.http_status} requests=${intake.requests.length}`;

/** 署名者の設定。mode: ok（base64）・raw・refuse（exit 1）・fail（exit 2）・garbage・hang。 */
const signerFor = (root, mode) => ({ key_id: KEY_ID, cwd: path.join(root, 'signer-cwd'),
  command: [process.execPath, path.join(root, 'fake-signer.mjs'), path.join(root, 'product.key'), mode, path.join(root, 'signer.log')] });

async function makeWorkspace(intakeUrl, { enabled = true, signer = true, mode = 'ok' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-report-'));
  await mkdir(path.join(root, 'signer-cwd'));
  await writeFile(path.join(root, 'fake-signer.mjs'), FAKE_SIGNER);
  await writeFile(path.join(root, 'product.key'), pem(productKeys.privateKey, 'pkcs8'), { mode: 0o600 });
  const reportingConfigPath = path.join(root, 'config', 'runtime-error-reporting.json');
  const options = { reportingConfigPath, version: '0.74.0', responseKeyPem: responsePublicPem, signerTimeoutMs: 5000,
    configPath: path.join(root, 'config', 'factory-reporter.json'),
    storePath: path.join(root, 'state', 'runtime-errors.json') };
  if (enabled) setRuntimeErrorReporting(true, options, signer ? { signer: signerFor(root, mode), url: intakeUrl } : { url: intakeUrl });
  const signerLog = async () => (await readFile(path.join(root, 'signer.log'), 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const useMode = (next) => setRuntimeErrorReporting(true, options, { signer: signerFor(root, next) });
  return { root, options, signerLog, useMode };
}

const fail = (options, commandKind, code) => recordRuntimeError(CLI_FAILED, { ...options,
  safeContext: runtimeErrorSafeContext({ commandKind, error: Object.assign(new Error('x'), { code }) }) });

nodeTest('既定では通信しない: 送信を有効にしていない端末と、署名者の無い端末は送らない', async () => {
  const intake = await startIntake(signedReceipt);
  const disabled = await makeWorkspace(intake.url, { enabled: false });
  const noSigner = await makeWorkspace(intake.url, { signer: false });
  try {
    // 送信が無効で工場の設定も無ければ、収集そのものが無効で、記録も作らない。
    assert.deepEqual(recordRuntimeError(CLI_FAILED, disabled.options), { status: 'disabled' });
    assert.equal((await reportRuntimeErrors(disabled.options)).outcome, 'disabled');
    assert.equal(runtimeErrorAutoReportDue(disabled.options), false);

    // 送信を有効にすると収集も有効になる（dotagentsの設定は要らない）。署名者が無ければ送らない。
    fail(noSigner.options, 'run.list', 'ENOENT');
    assert.equal(runtimeErrorsDiagnostics(noSigner.options).collection, 'enabled');
    assert.equal((await reportRuntimeErrors(noSigner.options)).outcome, 'signer_missing');
    assert.equal(runtimeErrorAutoReportDue(noSigner.options), false);
    assert.deepEqual([runtimeErrorReportingStatus(noSigner.options).signer, runtimeErrorReportingStatus(noSigner.options).key_id],
      ['missing', null]);
    assert.equal(intake.requests.length, 0);
    assert.deepEqual(await noSigner.signerLog(), []);
  } finally {
    await intake.close();
    await rm(disabled.root, { recursive: true, force: true });
    await rm(noSigner.root, { recursive: true, force: true });
  }
});

nodeTest('署名者の設定: 形の違う署名者は受けず、無効にしても署名者を引き継ぐ', async () => {
  const workspace = await makeWorkspace('http://127.0.0.1:9/x', { enabled: false });
  try {
    const signer = signerFor(workspace.root, 'ok');
    for (const broken of [{ ...signer, key_id: 'has space' }, { ...signer, command: [] }, { ...signer, command: [''] },
      { ...signer, cwd: 7 }, { key_id: KEY_ID, command: signer.command }, { ...signer, extra: 1 }]) {
      assert.throws(() => setRuntimeErrorReporting(true, workspace.options, { signer: broken }), /invalid_signer/, JSON.stringify(broken));
    }
    assert.throws(() => setRuntimeErrorReporting(true, workspace.options, { url: 'ftp://192.168.1.2/x' }), /invalid_url/);
    assert.throws(() => setRuntimeErrorReporting(true, workspace.options, { url: 'http://u:p@192.168.1.2/x' }), /invalid_url/);

    const enabled = setRuntimeErrorReporting(true, workspace.options, { signer });
    assert.deepEqual([enabled.reporting, enabled.signer, enabled.key_id], ['enabled', 'configured', KEY_ID]);
    // 署名者を渡さない`enable`・`disable`は、今の署名者を消さない。
    assert.equal(setRuntimeErrorReporting(false, workspace.options).signer, 'configured');
    assert.deepEqual([setRuntimeErrorReporting(true, workspace.options).signer, runtimeErrorReportingStatus(workspace.options).reporting],
      ['configured', 'enabled']);
    assert.deepEqual(JSON.parse(await readFile(workspace.options.reportingConfigPath, 'utf8')),
      { schema: 'lattice.runtime_error_reporting_config.v1', enabled: true, signer });
    // 設定fileに秘密は無い。署名者のcommandとkey_idだけ。
    assert.equal((await readFile(workspace.options.reportingConfigPath, 'utf8')).includes('PRIVATE'), false);

    // 手で壊した署名者は、無いものとして読む（送らない）。
    await writeFile(workspace.options.reportingConfigPath, JSON.stringify({ schema: 'lattice.runtime_error_reporting_config.v1',
      enabled: true, signer: { ...signer, command: 'ssh' } }));
    assert.deepEqual([runtimeErrorReportingStatus(workspace.options).reporting, runtimeErrorReportingStatus(workspace.options).signer],
      ['enabled', 'missing']);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('署名者が署名できなければ送らず、記録は残り、届かなかった送信と同じく後から送り直す', async () => {
  const intake = await startIntake(signedReceipt);
  const workspace = await makeWorkspace(intake.url);
  const at = (minutes) => ({ ...workspace.options, auto: true,
    now: new Date(Date.parse('2026-10-03T09:00:00.000Z') + minutes * 60_000).toISOString() });
  try {
    fail(workspace.options, 'run.list', 'ENOENT');
    const results = [];
    for (const [mode, options] of [['refuse', {}], ['fail', {}], ['garbage', {}], ['hang', { signerTimeoutMs: 400 }]]) {
      workspace.useMode(mode);
      const result = await reportRuntimeErrors({ ...workspace.options, ...options, now: '2026-10-03T08:00:00.000Z' });
      results.push([result.outcome, result.reason, result.http_status]);
    }
    assert.deepEqual(results, [
      ['signer_refused', 'signer_refused', null],
      ['signer_failed', 'signer_exit', null],
      ['signer_failed', 'signature_malformed', null],
      ['signer_failed', 'timeout', null],
    ]);
    // 受け口へは1回も送らず、記録は未受領のまま。入力fileは、どの終わり方でも残らない。
    assert.equal(intake.requests.length, 0);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).pending_count, 1);
    assert.deepEqual((await readdir(path.dirname(workspace.options.storePath))).filter((name) => name.startsWith('.signer-input')), []);

    // 署名できなかった試みも、送る時機の制限に数える（失敗した送信と同じ）。
    workspace.useMode('ok');
    assert.equal((await reportRuntimeErrors(at(0))).outcome, 'delivered');
    fail(workspace.options, 'todo.status', 'ENOTDIR');
    workspace.useMode('fail');
    const failedAuto = await reportRuntimeErrors(at(2));
    assert.deepEqual([failedAuto.outcome, runtimeErrorReportingStatus(workspace.options).last_outcome], ['signer_failed', 'signer_failed']);
    assert.equal((await reportRuntimeErrors(at(2.5))).reason, 'attempted_within_a_minute');
    assert.equal((await reportRuntimeErrors(at(30))).reason, 'same_report_retried_within_an_hour');
    // 署名者が戻れば、1時間後に今の累計が届き、受領済みになる。
    workspace.useMode('ok');
    const retried = await reportRuntimeErrors(at(63));
    assert.deepEqual([retried.outcome, retried.sent.runtime_errors], ['delivered', 1]);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).pending_count, 0);
    assert.equal(intake.requests.length, 2);
  } finally {
    await intake.close();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

nodeTest('署名の入力は、storeのfolderに置いたfileから標準入力で渡す。cwdは設定どおり、署名は本文へ合う', async () => {
  const intake = await startIntake(signedReceipt);
  const workspace = await makeWorkspace(intake.url);
  try {
    fail(workspace.options, 'run.list', 'ENOENT');
    for (const mode of ['ok', 'raw']) {
      workspace.useMode(mode);
      assert.equal((await reportRuntimeErrors(workspace.options)).outcome, 'delivered', mode);
      fail(workspace.options, `run.${mode}`, 'ENOENT');
    }
    const [first, second] = await workspace.signerLog();
    assert.equal(first.stdinIsFile && second.stdinIsFile, true);
    assert.equal(await realpath(first.cwd), await realpath(path.join(workspace.root, 'signer-cwd')));
    // base64でも生の64バイトでも受け、どちらも受け口の検証を通る（受け口は署名を製品の公開鍵で確かめる）。
    for (const [index, entry] of [first, second].entries()) {
      const request = intake.requests[index];
      const ts = /ts=(\d+)/.exec(request.headers.authorization)[1];
      assert.equal(entry.input, reportSigningText(ts, request.bytes));
      assert.equal(request.authValid, true);
    }
    assert.deepEqual((await readdir(path.dirname(workspace.options.storePath))).filter((name) => name.startsWith('.signer-input')), []);
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
    assert.equal(delivered.outcome, 'delivered', deliveryDetails(delivered, intake));
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
    assert.match(request.headers.authorization, new RegExp(`^BugHub-ES256 key_id=${KEY_ID}, ts=${ts}, sig=[A-Za-z0-9+/]{86}==$`));
    assert.equal(request.authValid, true);
    assert.equal(request.bytes.toString('utf8').includes('PRIVATE'), false);

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
    assert.deepEqual([resolved.outcome, resolved.sent], ['delivered', { runtime_errors: 0, resolutions: 1 }],
      deliveryDetails(resolved, intake));
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
  const noSigner = await makeWorkspace(intake.url, { signer: false });
  try {
    // 送信を有効にしていない端末と、署名者の無い端末は、確かめる時もnetworkへ触れない。
    assert.equal((await verifyRuntimeErrorReporting(disabled.options)).outcome, 'disabled');
    assert.equal((await verifyRuntimeErrorReporting(noSigner.options)).outcome, 'signer_missing');
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
    assert.match(request.headers.authorization, new RegExp(`^BugHub-ES256 key_id=${KEY_ID}, ts=${ts}, sig=[A-Za-z0-9+/]{86}==$`));
    assert.equal(request.authValid, true);
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
    for (const item of [workspace, disabled, noSigner]) await rm(item.root, { recursive: true, force: true });
  }
});

nodeTest('受領を確かめられない応答では受領済みにせず、後から今の累計を送り直す', async () => {
  const answers = [
    (entry) => ({ status: 200, body: { accepted: true, report_id: entry.body.report_id, received_at: '2026-10-03T09:00:01.000Z', sig: 'f'.repeat(64), sig_alg: 'ES256' } }),
    () => signedReceipt({ body: { report_id: '00000000-0000-4000-8000-000000000009' } }),
    (entry) => signedReceipt(entry, { accepted: false }),
    (entry) => ({ status: 200, body: receiptBody(entry.body.report_id, {}, productKeys.privateKey) }),
    (entry) => signedReceipt(entry, { sig_alg: undefined }),
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

nodeTest('自動送信は1分に1回まで、同じ中身の送り直しは1時間に1回まで', async (context) => {
  // 送信制限は、受け口へ届かなかった試行にも適用する。実HTTPの到達件数は試行数を表さない。
  // この試験では通信境界だけを置き換え、503応答と不達timeoutの両方で同じ時機の制限を確かめる。
  for (const failure of ['unavailable', 'timeout']) {
    let accept = false;
    const attempts = [];
    context.mock.method(http, 'request', (_url, _options, onResponse) => {
      const request = new EventEmitter();
      request.destroy = () => request;
      request.end = (bytes) => {
        const entry = { body: JSON.parse(bytes.toString('utf8')) };
        attempts.push(entry);
        queueMicrotask(() => {
          if (!accept && failure === 'timeout') { request.emit('timeout'); return; }
          const answer = accept ? signedReceipt(entry) : { status: 503, body: { error: 'unavailable' } };
          const response = new EventEmitter();
          response.statusCode = answer.status;
          onResponse(response);
          response.emit('data', Buffer.from(JSON.stringify(answer.body)));
          response.emit('end');
        });
        return request;
      };
      return request;
    });
    const workspace = await makeWorkspace('http://127.0.0.1:9/api/products/v1/runtime-errors');
    const at = (minutes) => ({ ...workspace.options, auto: true, now: new Date(Date.parse('2026-10-03T09:00:00.000Z') + minutes * 60_000).toISOString() });
    try {
      fail(workspace.options, 'run.list', 'ENOENT');
      const first = await reportRuntimeErrors(at(0));
      assert.deepEqual([first.outcome, first.reason], ['unconfirmed', failure]);
      assert.deepEqual([(await reportRuntimeErrors(at(0.5))).outcome, (await reportRuntimeErrors(at(0.5))).reason],
        ['throttled', 'attempted_within_a_minute']);
      assert.equal((await reportRuntimeErrors(at(30))).reason, 'same_report_retried_within_an_hour');
      assert.equal(runtimeErrorAutoReportDue(at(30)), false);
      assert.equal(attempts.length, 1);

      // 新しい記録が増えたら、1時間を待たずに送る。
      fail(workspace.options, 'todo.status', 'ENOTDIR');
      assert.equal(runtimeErrorAutoReportDue(at(31)), true);
      const changed = await reportRuntimeErrors(at(31));
      assert.deepEqual([changed.outcome, changed.reason], ['unconfirmed', failure]);
      assert.equal((await reportRuntimeErrors(at(60))).outcome, 'throttled');

      // 1時間たてば、同じ中身でも送り直す。受領されれば未受領は無くなる。
      accept = true;
      const delivered = await reportRuntimeErrors(at(92));
      assert.deepEqual([delivered.outcome, delivered.sent.runtime_errors], ['delivered', 2]);
      assert.equal(runtimeErrorAutoReportDue(at(200)), false);
      assert.equal(attempts.length, 3);
      assert.equal(new Set(attempts.map((entry) => entry.body.report_id)).size, 3);
      // 手で打った送信は時機の制限を見ない。
      fail(workspace.options, 'run.status', 'EACCES');
      assert.equal((await reportRuntimeErrors({ ...workspace.options, now: at(92.1).now })).outcome, 'delivered');
      assert.equal(attempts.length, 4);
    } finally {
      context.mock.restoreAll();
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
});

nodeTest('CLI: 署名者を設定して有効にした端末では、故障を記録した直後に切り離した子processが署名して送る', async () => {
  const intake = await startIntake(signedReceipt);
  const workspace = await makeWorkspace(intake.url, { enabled: false });
  const { root } = workspace;
  try {
    const env = { ...process.env, NO_COLOR: '1', HOME: root, LATTICE_DASHBOARD_AUTOSTART: '0',
      USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(root, '.config'), XDG_STATE_HOME: path.join(root, 'xdg-state') };
    delete env.LATTICE_RUNTIME_ERROR_REPORTING;
    const configFile = path.join(root, '.config', 'lattice', 'runtime-error-reporting.json');
    const cli = (args, cwd = root) => spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', env });
    // 受け口はこのprocessの中にあるので、通信するcommandは待ち合わせる形で起こす（spawnSyncでは応答を返せない）。
    const cliAsync = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, env });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.once('error', reject).once('close', (status) => resolve({ status, stdout }));
    });
    const json = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));

    // 既定は無効。有効にする前は、故障しても記録も通信もしない。
    assert.equal(json(cli(['runtime-errors', 'reporting', 'status', '--json'])).reporting, 'disabled');
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    await writeFile(path.join(repo, '.lattice'), 'not a directory\n');
    assert.equal(cli(['todo', 'status', '--json'], repo).status, 1);
    assert.equal(json(cli(['runtime-errors', 'diagnostics', '--json'])).collection, 'disabled');

    // 署名者を設定せずに有効にしても、署名者が無ければ送らない。
    const bare = json(cli(['runtime-errors', 'reporting', 'enable', '--json']));
    assert.deepEqual([bare.reporting, bare.signer, bare.key_id, bare.collection], ['enabled', 'missing', null, 'enabled']);
    assert.equal((await readFile(configFile, 'utf8')).trim(), '{"schema":"lattice.runtime_error_reporting_config.v1","enabled":true}');
    // key-idと署名者のargvは対。片方だけ・知らない旗は使い方の誤り。
    for (const args of [['--key-id', KEY_ID], ['--', 'ssh'], ['--signer-cwd', root], ['--bogus', '1', '--key-id', KEY_ID, '--', 'ssh']]) {
      assert.equal(cli(['runtime-errors', 'reporting', 'enable', ...args, '--json']).status, 2, args.join(' '));
    }
    const nothing = cli(['runtime-errors', 'report', '--json']);
    assert.deepEqual([nothing.status, json(nothing).outcome], [1, 'signer_missing']);

    const { signer } = JSON.parse(JSON.stringify({ signer: signerFor(root, 'ok') }));
    const enabled = json(cli(['runtime-errors', 'reporting', 'enable', '--key-id', KEY_ID, '--signer-cwd', signer.cwd,
      '--url', intake.url, '--', ...signer.command, '--json']));
    assert.deepEqual([enabled.reporting, enabled.signer, enabled.key_id, enabled.collection], ['enabled', 'configured', KEY_ID, 'enabled']);
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')),
      { schema: 'lattice.runtime_error_reporting_config.v1', enabled: true, signer, url: intake.url });
    assert.equal(intake.requests.length, 0);

    // 故障を1件起こす。CLIは送信を待たずに返り、子processが署名して届ける。
    // Windowsでは、この入力は契約内のerrorで返り記録にならない（`lstat`がENOTDIRでなくENOENTを返す）。
    // 記録だけ同じ分類で直に作り、次のCLI実行が子processを起こすことを確かめる。
    if (windows) {
      fail({ env }, 'todo.status', 'ENOTDIR');
      assert.equal(cli(['runtime-errors', 'diagnostics', '--json']).status, 0);
    } else {
      const failed = cli(['todo', 'status', '--json'], repo);
      assert.equal(failed.status, 1, failed.stderr);
    }
    // このprocessの受け口が返す応答は、BugHubの応答用の鍵では署名されていない。製品に組み込んだ鍵で確かめて
    // 受領にしないことが、ここで分かる（受領まで進む経路は、鍵を差し替えられる上の試験が持つ）。
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline
      && json(cli(['runtime-errors', 'reporting', 'status', '--json'])).last_outcome !== 'unconfirmed') {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const status = json(cli(['runtime-errors', 'reporting', 'status', '--json']));
    assert.deepEqual([status.last_outcome, status.pending_count], ['unconfirmed', 1]);
    assert.equal(intake.requests.length, 1);
    assert.equal(intake.requests[0].authValid, true);
    assert.deepEqual(intake.requests[0].body.runtime_errors[0].safe_context,
      { command_kind: 'todo.status', error_kind: 'Error', cause_code: 'ENOTDIR' });

    // 手で打つ送信: 同じ署名者で署名して送り、受領を確かめられなければexit 1。
    const manual = await cliAsync(['runtime-errors', 'report', '--json']);
    assert.deepEqual([manual.status, json(manual).outcome, json(manual).reason], [1, 'unconfirmed', 'receipt_not_verified']);
    assert.equal(intake.requests.length, 2);

    // 経路の確認: 空の報告を1通、署名して送る。
    const verify = await cliAsync(['runtime-errors', 'reporting', 'verify', '--json']);
    assert.deepEqual([verify.status, json(verify).outcome], [1, 'unconfirmed']);
    assert.equal(intake.requests.length, 3);
    assert.deepEqual([intake.requests[2].body.runtime_errors, intake.requests[2].body.resolutions], [[], []]);
    assert.equal(intake.requests.every((request) => request.authValid), true);
    const calls = await workspace.signerLog();
    assert.equal(calls.length, 3);
    assert.equal(calls.every((call) => call.stdinIsFile), true);

    // 無効に戻せば、送信も確認もnetworkへ触れない。署名者の設定は残る。
    const off = json(cli(['runtime-errors', 'reporting', 'disable', '--json']));
    assert.deepEqual([off.reporting, off.signer], ['disabled', 'configured']);
    const noReport = cli(['runtime-errors', 'report', '--json']);
    assert.deepEqual([noReport.status, json(noReport).outcome], [1, 'disabled']);
    const noVerify = cli(['runtime-errors', 'reporting', 'verify', '--json']);
    assert.deepEqual([noVerify.status, json(noVerify).outcome], [1, 'disabled']);
    assert.equal(intake.requests.length, 3);
  } finally {
    await intake.close();
    await rm(root, { recursive: true, force: true });
  }
});
