import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';

import { cliCommandKind } from '../src/cli-command-kind.mjs';
import {
  recordRuntimeError,
  runtimeErrorSafeContext,
  runtimeErrorsSnapshot,
} from '../src/runtime-errors.mjs';

// runtime error storeはPOSIX専用（Windows nativeはstore_unsafeでfail closed）。
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');
const VALID_CONFIG = {
  schema_version: '1.0',
  host: { id: 'test-host', profile: 'mac' },
  collection: { enabled: true },
  reporting: { enabled: false },
};
const CLI_FAILED = 'LATTICE.CLI_INTERNAL_FAILED';
const CLI_PARTS = ['lattice', 'cli', CLI_FAILED, 'Lattice CLI crashed outside the typed error contract'];
// dotagentsのadapterが再計算して照合する式。実装を呼ばず、契約の文面どおりにここで組む。
const sha256 = (parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-context-'));
  const configPath = path.join(root, 'config', 'factory-reporter.json');
  const storePath = path.join(root, 'state', 'runtime-errors.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(VALID_CONFIG));
  const reportingConfigPath = path.join(root, 'config', 'runtime-error-reporting.json');
  return { root, storePath, options: { configPath, storePath, reportingConfigPath, version: '0.72.0' } };
}

test('分類は固定語彙だけを通し、語彙に無い値はother／noneへ落とす', () => {
  assert.deepEqual(runtimeErrorSafeContext(), { command_kind: 'other', error_kind: 'other', cause_code: 'none' });
  assert.deepEqual(
    runtimeErrorSafeContext({ commandKind: 'run.list',
      error: Object.assign(new Error('ENOENT: /Users/someone/secret'), { code: 'ENOENT' }) }),
    { command_kind: 'run.list', error_kind: 'Error', cause_code: 'ENOENT' },
  );
  assert.equal(runtimeErrorSafeContext({ error: new TypeError('x') }).error_kind, 'TypeError');
  assert.equal(runtimeErrorSafeContext({
    error: Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }) }).cause_code, 'ERR_MODULE_NOT_FOUND');
  class PrivateDetailError extends Error {}
  for (const [input, expected] of [
    [{ commandKind: '/Users/someone/repo' }, { command_kind: 'other' }],
    [{ commandKind: 'run.list.extra' }, { command_kind: 'other' }],
    [{ commandKind: `run.${'a'.repeat(60)}` }, { command_kind: 'other' }],
    [{ error: new PrivateDetailError('x') }, { error_kind: 'other' }],
    [{ error: Object.assign(new Error('x'), { code: 'DASHBOARD_REGISTRY_BUSY' }) }, { cause_code: 'none' }],
    [{ error: Object.assign(new Error('x'), { code: 'user@example.com' }) }, { cause_code: 'none' }],
    [{ error: Object.assign(new Error('x'), { code: 42 }) }, { cause_code: 'none' }],
  ]) {
    const context = runtimeErrorSafeContext(input);
    for (const [key, value] of Object.entries(expected)) assert.equal(context[key], value, JSON.stringify(input));
  }
});

test('落ちた面は一覧に在る語だけで表し、引数の値を載せない', () => {
  assert.equal(cliCommandKind(['run', 'list', '--json']), 'run.list');
  assert.equal(cliCommandKind(['run', 'activate', '--run', '.lattice/runs/secret-name']), 'run.activate');
  assert.equal(cliCommandKind(['plan', 'compile', '--request', '/abs/path.json']), 'plan.compile');
  assert.equal(cliCommandKind(['event', 'verify', '--run', 'x']), 'event.verify');
  assert.equal(cliCommandKind(['run', 'not-a-command']), 'run');
  assert.equal(cliCommandKind(['run']), 'run');
  assert.equal(cliCommandKind(['/abs/path']), 'other');
  assert.equal(cliCommandKind([]), 'other');
  assert.equal(cliCommandKind(['todo', 'start', 'T1'], { todo: ['start'] }), 'todo.start');
});

test('分類つきの記録は7要素の式でfingerprintを決め、原因が違えば別の記録になる', async () => {
  const workspace = await makeWorkspace();
  try {
    const listContext = { command_kind: 'run.list', error_kind: 'Error', cause_code: 'ENOENT' };
    const startContext = { command_kind: 'todo.start', error_kind: 'TypeError', cause_code: 'none' };
    const first = recordRuntimeError(CLI_FAILED, { ...workspace.options, safeContext: listContext });
    recordRuntimeError(CLI_FAILED, { ...workspace.options, safeContext: listContext });
    const second = recordRuntimeError(CLI_FAILED, { ...workspace.options, safeContext: startContext });
    // 分類を渡さない呼び出しも、3つのキーをそろえて埋める。
    const bare = recordRuntimeError(CLI_FAILED, workspace.options);

    assert.equal(first.fingerprint, sha256([...CLI_PARTS, 'run.list', 'Error', 'ENOENT']));
    assert.equal(second.fingerprint, sha256([...CLI_PARTS, 'todo.start', 'TypeError', 'none']));
    assert.equal(bare.fingerprint, sha256([...CLI_PARTS, 'other', 'other', 'none']));

    const snapshot = runtimeErrorsSnapshot(0, 256, workspace.options);
    assert.deepEqual(snapshot.runtime_errors.map((record) => [record.occurrence_count, record.safe_context]), [
      [2, listContext],
      [1, startContext],
      [1, { command_kind: 'other', error_kind: 'other', cause_code: 'none' }],
    ]);
    for (const record of snapshot.runtime_errors) {
      assert.deepEqual(Object.keys(record.safe_context), ['command_kind', 'error_kind', 'cause_code']);
    }

    // 語彙の外・キーの欠けは記録しない（fingerprintを一意に決められない）。
    for (const broken of [
      { command_kind: 'run.list', error_kind: 'Error' },
      { ...listContext, extra: 'x' },
      { ...listContext, command_kind: '/abs/path' },
      { ...listContext, error_kind: 'PrivateDetailError' },
      { ...listContext, cause_code: 'DASHBOARD_REGISTRY_BUSY' },
    ]) {
      assert.throws(() => recordRuntimeError(CLI_FAILED, { ...workspace.options, safeContext: broken }),
        /invalid_safe_context/, JSON.stringify(broken));
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('旧記録（分類無し）は旧い式のまま読み書きでき、新しい発生は別の記録へ入る', async () => {
  const workspace = await makeWorkspace();
  try {
    const legacyFingerprint = sha256(CLI_PARTS);
    await mkdir(path.dirname(workspace.storePath), { recursive: true, mode: 0o700 });
    await writeFile(workspace.storePath, `${JSON.stringify({
      schema: 'lattice.runtime_errors.v1', next_sequence: 2, acknowledged_through: 0,
      records: [{
        product: 'lattice', product_version: '0.71.0', component: 'cli', error_code: CLI_FAILED,
        message_template: 'Lattice CLI crashed outside the typed error contract', severity: 'high',
        fingerprint: legacyFingerprint, count: 26,
        first_seen: '2026-07-28T04:05:14.770Z', last_seen: '2026-10-03T02:44:16.086Z',
        state_schema_version: '1.0', os: 'darwin', arch: 'arm64', status: 'open',
        resolved_at: null, reason_code: null, sequence: 1,
      }],
    })}\n`, { mode: 0o600 });

    const context = { command_kind: 'run.list', error_kind: 'Error', cause_code: 'ENOENT' };
    recordRuntimeError(CLI_FAILED, { ...workspace.options, safeContext: context });

    const snapshot = runtimeErrorsSnapshot(0, 256, workspace.options);
    assert.equal(snapshot.runtime_errors.length, 2);
    const [legacy, fresh] = snapshot.runtime_errors;
    assert.equal(legacy.fingerprint, legacyFingerprint);
    assert.equal(legacy.occurrence_count, 26);
    assert.equal(Object.hasOwn(legacy, 'safe_context'), false);
    assert.equal(fresh.fingerprint, sha256([...CLI_PARTS, 'run.list', 'Error', 'ENOENT']));
    assert.deepEqual(fresh.safe_context, context);

    const stored = JSON.parse(await readFile(workspace.storePath, 'utf8'));
    assert.equal(Object.hasOwn(stored.records[0], 'safe_context'), false);
    assert.deepEqual(stored.records[1].safe_context, context);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('CLIがtyped契約の外で落ちると、面と例外の分類つきで記録する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-context-cli-'));
  try {
    const configDir = path.join(root, 'xdg-config', 'dotagents');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(configDir, 'factory-reporter.json'), JSON.stringify(VALID_CONFIG), { mode: 0o600 });
    const env = { ...process.env, NO_COLOR: '1', HOME: root, LATTICE_DASHBOARD_AUTOSTART: '0',
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_STATE_HOME: path.join(root, 'xdg-state') };
    // `.lattice`がdirectoryでなくfileのrepo。todo storeの読取がENOTDIRで落ち、typed分岐に乗らない。
    // （この入力がtyped errorへ直されたら、別の「契約外で落ちる入力」へ差し替える。）
    const repo = path.join(root, 'repo');
    await mkdir(repo);
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    await writeFile(path.join(repo, '.lattice'), 'not a directory\n');

    const failed = spawnSync(process.execPath, [cliPath, 'todo', 'status', '--json'],
      { cwd: repo, encoding: 'utf8', env });
    assert.equal(failed.status, 1, failed.stderr);
    assert.equal(JSON.parse(failed.stderr.trim().split('\n').at(-1)).code, 'INTERNAL_FAILURE');

    const snapshot = spawnSync(process.execPath, [cliPath, 'runtime-errors', 'snapshot', '--json'],
      { cwd: repo, encoding: 'utf8', env });
    assert.equal(snapshot.status, 0, snapshot.stderr);
    const { runtime_errors: records } = JSON.parse(snapshot.stdout.trim());
    assert.equal(records.length, 1);
    assert.equal(records[0].error_code, CLI_FAILED);
    assert.deepEqual(records[0].safe_context,
      { command_kind: 'todo.status', error_kind: 'Error', cause_code: 'ENOTDIR' });
    assert.equal(records[0].fingerprint, sha256([...CLI_PARTS, 'todo.status', 'Error', 'ENOTDIR']));
    // 記録のどこにも、repoの場所や例外の本文が入らない。
    assert.equal(snapshot.stdout.includes(root), false);
    assert.equal(snapshot.stdout.includes('not a directory'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
