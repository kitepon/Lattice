import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { READ_ONLY_COMMAND_KINDS } from '../src/cli-command-kind.mjs';
import { cliFailureClass } from '../src/cli-failure-class.mjs';
import {
  observeEscapedCliFailure,
  runtimeErrorSafeContext,
  runtimeErrorsSnapshot,
} from '../src/runtime-errors.mjs';

// ADR 0196: 契約の外へ漏れた例外を、取消・通信の失敗・それ以外に分け、通信の失敗の重大度を面で決める。

const VALID_CONFIG = {
  schema_version: '1.0',
  host: { id: 'test-host', profile: 'linux' },
  collection: { enabled: true },
  reporting: { enabled: false },
};
const INTERNAL = 'LATTICE.CLI_INTERNAL_FAILED';
const TRANSPORT = 'LATTICE.CLI_TRANSPORT_UNHANDLED';
const TRANSPORT_PARTS = ['lattice', 'cli', TRANSPORT,
  'Lattice CLI let a communication failure escape the typed error contract'];
const sha256 = (parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-transport-'));
  const configPath = path.join(root, 'config', 'factory-reporter.json');
  const storePath = path.join(root, 'state', 'runtime-errors.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(VALID_CONFIG));
  const reportingConfigPath = path.join(root, 'config', 'runtime-error-reporting.json');
  return { root, storePath, options: { configPath, storePath, reportingConfigPath } };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

/** 誰も待ち受けていないport。開いて閉じた直後の番号を使う。 */
async function closedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

const rejection = async (promise) => {
  try { await promise; } catch (error) { return error; }
  throw new assert.AssertionError({ message: '失敗するはずの通信が成功した' });
};

test('本物の通信の失敗・時間切れ・取消を見分ける', async () => {
  // 接続を断られたfetch。TypeError（`fetch failed`）で届き、通信のcodeは`cause`の側にある。
  const refused = await rejection(fetch(`http://127.0.0.1:${await closedPort()}/`));
  assert.equal(refused instanceof TypeError, true);
  assert.equal(cliFailureClass(refused), 'transport');
  assert.deepEqual(runtimeErrorSafeContext({ commandKind: 'todo.status', error: refused }),
    { command_kind: 'todo.status', error_kind: 'TypeError', cause_code: 'ECONNREFUSED' });

  // 接続は受けるが応答しない相手。`AbortSignal.timeout`の時間切れと、呼び出し元の取消。
  const sockets = new Set();
  const silent = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); });
  const port = await listen(silent);
  try {
    const timedOut = await rejection(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) }));
    assert.equal(cliFailureClass(timedOut), 'transport');
    assert.equal(runtimeErrorSafeContext({ error: timedOut }).cause_code, 'none');

    const controller = new AbortController();
    const pending = rejection(fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal }));
    controller.abort();
    assert.equal(cliFailureClass(await pending), 'cancelled');
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(silent);
  }

  // socketを直に使う面の失敗は、例外そのものがcodeを持つ。
  const socketError = await new Promise((resolve) => {
    closedPort().then((closed) => net.createConnection({ host: '127.0.0.1', port: closed }).once('error', resolve));
  });
  assert.equal(cliFailureClass(socketError), 'transport');
});

test('通信でない例外は内部故障のまま', () => {
  for (const error of [
    new Error('x'),
    new TypeError('x'),
    Object.assign(new Error('x'), { code: 'ENOENT' }),
    Object.assign(new Error('x'), { code: 'ENOTDIR' }),
    // 端末内のportの取り合いは、通信の失敗に数えない。
    Object.assign(new Error('x'), { code: 'EADDRINUSE' }),
    // 子processとのpipeでも起きる。
    Object.assign(new Error('x'), { code: 'EPIPE' }),
    Object.assign(new Error('x'), { code: 'DASHBOARD_REGISTRY_BUSY' }),
    null,
    undefined,
    'text',
  ]) assert.equal(cliFailureClass(error), 'internal', String(error?.code ?? error));
});

test('漏れた通信の失敗は別の記録になり、重大度は落ちた面で決まる', async () => {
  const workspace = await makeWorkspace();
  try {
    const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const observe = (commandKind, error) => observeEscapedCliFailure({
      error, commandKind, version: '0.77.0', ...workspace.options });

    // 何も書き換えない面: その1回が止まっただけ。
    for (const commandKind of READ_ONLY_COMMAND_KINDS) observe(commandKind, reset());
    // 書き換える面と、分からない面: 結果が分からないので下げない。
    observe('todo.start', reset());
    observe('other', reset());
    // 通信でない例外は、どの面でも内部故障。
    observe('todo.status', new Error('x'));

    const { runtime_errors: records } = runtimeErrorsSnapshot(0, 256, workspace.options);
    assert.deepEqual(records.map((record) => [record.error_code, record.safe_context.command_kind, record.severity]), [
      ...[...READ_ONLY_COMMAND_KINDS].map((commandKind) => [TRANSPORT, commandKind, 'warn']),
      [TRANSPORT, 'todo.start', 'high'],
      [TRANSPORT, 'other', 'high'],
      [INTERNAL, 'todo.status', 'high'],
    ]);
    for (const record of records.filter((entry) => entry.error_code === TRANSPORT)) {
      assert.equal(record.component, 'cli');
      assert.equal(record.message_template, TRANSPORT_PARTS[3]);
      assert.equal(record.fingerprint,
        sha256([...TRANSPORT_PARTS, record.safe_context.command_kind, 'Error', 'ECONNRESET']));
      // 送る項目は増えていない。
      assert.deepEqual(Object.keys(record), ['product_version', 'error_code', 'component', 'status', 'severity',
        'fingerprint', 'message_template', 'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version',
        'safe_context']);
    }

    // 同じ面・同じ原因は同じ記録へ集まり、重大度は変わらない。
    observe('todo.status', reset());
    const again = runtimeErrorsSnapshot(0, 256, workspace.options).runtime_errors
      .find((record) => record.error_code === TRANSPORT && record.safe_context.command_kind === 'todo.status');
    assert.equal(again.occurrence_count, 2);
    assert.equal(again.severity, 'warn');
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('取消は記録しない', async () => {
  const workspace = await makeWorkspace();
  try {
    const controller = new AbortController();
    controller.abort();
    for (const error of [
      controller.signal.reason,
      Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }),
      new TypeError('fetch failed', { cause: controller.signal.reason }),
    ]) {
      assert.equal(cliFailureClass(error), 'cancelled');
      observeEscapedCliFailure({ error, commandKind: 'todo.start', version: '0.77.0', ...workspace.options });
    }
    assert.deepEqual(runtimeErrorsSnapshot(0, 256, workspace.options).runtime_errors, []);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('面と合わない重大度の記録は読まない', async () => {
  const workspace = await makeWorkspace();
  try {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    for (const commandKind of ['todo.status', 'todo.start']) {
      observeEscapedCliFailure({ error: reset, commandKind, version: '0.77.0', ...workspace.options });
    }
    const original = await readFile(workspace.storePath, 'utf8');
    for (const [from, to] of [['"severity":"warn"', '"severity":"high"'], ['"severity":"high"', '"severity":"warn"']]) {
      assert.equal(original.includes(from), true);
      await writeFile(workspace.storePath, original.replace(from, to), { mode: 0o600 });
      assert.throws(() => runtimeErrorsSnapshot(0, 256, workspace.options), /state_invalid/);
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});
