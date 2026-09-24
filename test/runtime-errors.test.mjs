import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  acknowledgeRuntimeErrors,
  compactRuntimeErrors,
  defaultFactoryReporterConfigPath,
  recordRuntimeError,
  runtimeErrorsStatePath,
  runtimeCollectionEnabled,
  runtimeErrorsDiagnostics,
  runtimeErrorsSnapshot,
  setRuntimeErrorStatus,
} from '../src/runtime-errors.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'lattice.mjs');

const VALID_CONFIG = {
  schema_version: '1.0',
  host: { id: 'test-host', profile: 'mac' },
  collection: { enabled: true },
  reporting: { enabled: false },
};

async function makeWorkspace(config = VALID_CONFIG) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-'));
  const configPath = path.join(root, 'config', 'factory-reporter.json');
  const storePath = path.join(root, 'state', 'runtime-errors.json');
  if (config !== null) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config));
  }
  return { root, configPath, storePath, options: { configPath, storePath, version: '0.1.0' } };
}

test('config欠落・malformed・disabledでは収集せずstateへ一切触れない', async () => {
  const missing = await makeWorkspace(null);
  try {
    assert.equal(runtimeCollectionEnabled(process.env, missing.configPath), false);
    assert.deepEqual(recordRuntimeError('LATTICE.CLI_INTERNAL_FAILED', missing.options), { status: 'disabled' });
    const snapshot = runtimeErrorsSnapshot(0, 256, missing.options);
    assert.equal(snapshot.diagnostics.collection, 'disabled');
    assert.equal(snapshot.diagnostics.status, 'not_applicable');
    assert.equal(runtimeErrorsDiagnostics(missing.options).status, 'not_applicable');
    assert.equal(existsSync(path.dirname(missing.storePath)), false);
  } finally {
    await rm(missing.root, { recursive: true, force: true });
  }

  for (const broken of [
    { ...VALID_CONFIG, collection: { enabled: false } },
    { ...VALID_CONFIG, extra: 1 },
    { ...VALID_CONFIG, reporting: { enabled: true } },
  ]) {
    const workspace = await makeWorkspace(broken);
    try {
      assert.deepEqual(recordRuntimeError('LATTICE.CLI_INTERNAL_FAILED', workspace.options), { status: 'disabled' });
      assert.equal(existsSync(path.dirname(workspace.storePath)), false);
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
});

test('同一原因はfingerprint集約でcount/last_seen/sequenceと発生版が進む', async () => {
  const workspace = await makeWorkspace();
  try {
    const first = recordRuntimeError('LATTICE.RUN_STORE_IO_FAILED', { ...workspace.options, now: '2026-07-18T00:00:00.000Z' });
    const second = recordRuntimeError('LATTICE.RUN_STORE_IO_FAILED', { ...workspace.options, version: '0.2.0', now: '2026-07-18T00:01:00.000Z' });
    assert.equal(first.status, 'recorded');
    assert.equal(first.fingerprint, second.fingerprint);
    const snapshot = runtimeErrorsSnapshot(0, 256, workspace.options);
    assert.equal(snapshot.runtime_errors.length, 1);
    assert.equal(snapshot.runtime_errors[0].occurrence_count, 2);
    assert.equal(snapshot.runtime_errors[0].product_version, '0.2.0');
    assert.equal(snapshot.runtime_errors[0].message_template, 'Lattice run store IO failed');
    assert.equal(snapshot.cursor.high_watermark, 2);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('cursor窓・ack・resolve/reopen・compactの意味論を固定する', async () => {
  const workspace = await makeWorkspace();
  try {
    recordRuntimeError('LATTICE.RUN_STORE_IO_FAILED', { ...workspace.options, now: '2026-06-01T00:00:00.000Z' });
    recordRuntimeError('LATTICE.MCP_SERVER_FAILED', { ...workspace.options, now: '2026-06-01T00:01:00.000Z' });

    const windowed = runtimeErrorsSnapshot(1, 256, workspace.options);
    assert.equal(windowed.runtime_errors.length, 1);
    assert.equal(windowed.runtime_errors[0].error_code, 'LATTICE.MCP_SERVER_FAILED');

    const acked = acknowledgeRuntimeErrors(2, workspace.options);
    assert.equal(acked.cursor.acknowledged_through, 2);
    assert.equal(acked.diagnostics.pending_count, 0);

    const fingerprint = windowed.runtime_errors[0].fingerprint;
    const resolved = setRuntimeErrorStatus(fingerprint, 'resolved', { ...workspace.options, now: '2026-06-02T00:00:00.000Z' });
    assert.equal(resolved.resolutions.length, 1);
    const reopened = setRuntimeErrorStatus(fingerprint, 'open', { ...workspace.options, now: '2026-06-02T00:10:00.000Z' });
    assert.equal(reopened.resolutions.length, 0);
    setRuntimeErrorStatus(fingerprint, 'resolved', { ...workspace.options, now: '2026-06-03T00:00:00.000Z' });
    acknowledgeRuntimeErrors(5, workspace.options);

    // resolve済み＋ack済みでも30日未満はcompactで消えない
    const early = compactRuntimeErrors({ ...workspace.options, now: '2026-06-10T00:00:00.000Z' });
    assert.equal(early.diagnostics.total_count, 2);
    // 30日超はresolvedだけがcompactされ、openは残る
    const late = compactRuntimeErrors({ ...workspace.options, now: '2026-07-10T00:00:01.000Z' });
    assert.equal(late.diagnostics.total_count, 1);
    const remaining = runtimeErrorsSnapshot(0, 256, workspace.options).runtime_errors;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].error_code, 'LATTICE.RUN_STORE_IO_FAILED');

    assert.throws(() => runtimeErrorsSnapshot(99, 256, workspace.options), /invalid_cursor/);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('store改ざん・symlinkはfail closedし、未知codeを拒否する', async () => {
  const workspace = await makeWorkspace();
  try {
    recordRuntimeError('LATTICE.CLI_INTERNAL_FAILED', workspace.options);
    await writeFile(workspace.storePath, '{"schema":"lattice.runtime_errors.v1"}', { mode: 0o600 });
    assert.throws(() => runtimeErrorsSnapshot(0, 256, workspace.options), /state_invalid/);
    assert.equal(runtimeErrorsDiagnostics(workspace.options).status, 'unavailable');

    await rm(workspace.storePath);
    await writeFile(`${workspace.storePath}.real`, '', { mode: 0o600 });
    await symlink(`${workspace.storePath}.real`, workspace.storePath);
    assert.throws(() => recordRuntimeError('LATTICE.CLI_INTERNAL_FAILED', workspace.options), /store_unsafe/);

    assert.throws(() => recordRuntimeError('LATTICE.UNKNOWN', workspace.options), /unknown_runtime_code/);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('CLI runtime-errorsはsnapshot/ack/diagnosticsをJSON 1行で返しusage違反はexit 2', async () => {
  const workspace = await makeWorkspace();
  try {
    const env = {
      ...process.env,
      HOME: workspace.root,
      XDG_CONFIG_HOME: path.join(workspace.root, 'xdg-config'),
      XDG_STATE_HOME: path.join(workspace.root, 'xdg-state'),
    };
    await mkdir(path.join(workspace.root, 'xdg-config', 'dotagents'), { recursive: true });
    await writeFile(path.join(workspace.root, 'xdg-config', 'dotagents', 'factory-reporter.json'), JSON.stringify(VALID_CONFIG));

    const snapshot = await execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '16', '--json'], { env });
    const parsed = JSON.parse(snapshot.stdout.trim());
    assert.equal(parsed.schema, 'lattice.runtime_errors.v1');
    assert.equal(parsed.product, 'lattice');
    assert.equal(parsed.diagnostics.collection, 'enabled');

    const ack = await execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'ack', '0', '--json'], { env });
    assert.equal(JSON.parse(ack.stdout.trim()).cursor.acknowledged_through, 0);

    const diagnostics = await execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'diagnostics', '--json'], { env });
    assert.equal(JSON.parse(diagnostics.stdout.trim()).schema, 'lattice.runtime_error_diagnostics.v1');

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'snapshot'], { env }),
      (error) => error.code === 2,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'ack', 'abc', '--json'], { env }),
      (error) => error.code === 2,
    );

    // resolve／reopen／compactも同じJSON 1行契約で応える。出荷しているのに
    // CLIから一度も走らせていないコマンドを残さない。
    const recorded = recordRuntimeError('LATTICE.RUN_STORE_IO_FAILED', {
      version: '0.1.0',
      configPath: defaultFactoryReporterConfigPath(env),
      storePath: runtimeErrorsStatePath(env),
      now: '2026-07-27T00:00:00.000Z',
    });
    assert.equal(typeof recorded.fingerprint, 'string');
    const fingerprint = recorded.fingerprint;
    const resolved = await execFileAsync(process.execPath,
      [cliPath, 'runtime-errors', 'resolve', fingerprint, '--json'], { env });
    assert.equal(typeof JSON.parse(resolved.stdout.trim()).schema, 'string');

    const reopened = await execFileAsync(process.execPath,
      [cliPath, 'runtime-errors', 'reopen', fingerprint, '--json'], { env });
    assert.equal(typeof JSON.parse(reopened.stdout.trim()).schema, 'string');

    const compacted = await execFileAsync(process.execPath,
      [cliPath, 'runtime-errors', 'compact', '--json'], { env });
    assert.equal(typeof JSON.parse(compacted.stdout.trim()).schema, 'string');

    // fingerprintの形が違えばtyped errorで落ちる。黙って成功扱いしない。
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'resolve', 'nope', '--json'], { env }),
      (error) => error.code === 1,
    );

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, 'runtime-errors', 'compact', 'extra', '--json'], { env }),
      (error) => error.code === 2,
    );
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test('一時fileはwrite失敗後に残置しない', async () => {
  const workspace = await makeWorkspace();
  try {
    recordRuntimeError('LATTICE.CLI_INTERNAL_FAILED', workspace.options);
    const entries = readdirSync(path.dirname(workspace.storePath)).filter((name) => name.startsWith('.runtime-errors-'));
    assert.deepEqual(entries, []);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});
