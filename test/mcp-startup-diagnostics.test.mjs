import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordRuntimeError } from '../src/runtime-errors.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));

// Exercise the shipped bin and real recorder in a separate process. Only the
// sensor entry is replaced, so each startup boundary can fail deterministically
// without opening an MCP connection or changing an installed host's state.
async function fixture(t, sensorSource, enabled = true, seedOld = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-mcp-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const copies = [
    'bin/lattice-mcp.mjs', 'src/node-version-guard.mjs',
    'sensor/package.json', 'sensor/dist/bin/node-version-check.js', 'src/runtime-errors.mjs',
    'src/cli-command-kind.mjs', 'src/cli-failure-class.mjs', 'src/windows-owner-only.mjs',
  ];
  for (const file of copies) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(REPO, file), path.join(root, file));
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: packageJson.version }));
  await writeFile(path.join(root, 'sensor/dist/index.js'), sensorSource);
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  await mkdir(path.join(configHome, 'dotagents'), { recursive: true });
  await writeFile(path.join(configHome, 'dotagents/factory-reporter.json'), JSON.stringify({
    schema_version: '1.0', host: { id: 'mcp-fixture', profile: 'server' },
    collection: { enabled }, reporting: { enabled: false },
  }));
  const storePath = path.join(stateHome, 'lattice/runtime-errors.json');
  let oldRecord;
  if (seedOld) {
    for (let i = 0; i < 4; i++) recordRuntimeError('LATTICE.MCP_SERVER_FAILED', {
      configPath: path.join(configHome, 'dotagents/factory-reporter.json'),
      reportingConfigPath: path.join(configHome, 'no-reporting.json'), storePath, version: '0.0.0',
      safeContext: { command_kind: 'other', error_kind: 'Error', cause_code: 'none' },
    });
    oldRecord = JSON.parse(await readFile(storePath, 'utf8')).records[0];
  }
  const env = {
    ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'local'),
    XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome,
    LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_SENSOR_ALLOW_UNSAFE_NODE: '1',
  };
  const result = spawnSync(process.execPath, [path.join(root, 'bin/lattice-mcp.mjs'), '--path', root], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.deepEqual(error, {
    schema: 'lattice.cli_error.v2', code: 'MCP_STARTUP_FAILED', message: 'fixture-private-detail',
  });
  return { root, storePath, oldRecord };
}

for (const [stage, source] of [
  ['import', 'throw new Error("fixture-private-detail");'],
  ['construct', 'exports.MCPServer = class { constructor() { throw new Error("fixture-private-detail"); } };'],
  ['start', 'exports.MCPServer = class { async start() { throw new Error("fixture-private-detail"); } };'],
]) {
  test(`MCP ${stage} failure records package version and exact stage without private details`, async (t) => {
    const { root, storePath } = await fixture(t, source);
    const raw = await readFile(storePath, 'utf8');
    const store = JSON.parse(raw);
    assert.equal(store.records.length, 1);
    const record = store.records[0];
    assert.equal(record.product_version, packageJson.version);
    assert.equal(record.error_code, 'LATTICE.MCP_SERVER_FAILED');
    assert.deepEqual(record.safe_context, { command_kind: `mcp.${stage}`, error_kind: 'Error', cause_code: 'none' });
    assert.equal(record.count, 1);
    assert.equal(record.status, 'open');
    assert.equal(record.severity, 'high');
    assert.equal(raw.includes('fixture-private-detail'), false);
    assert.equal(raw.includes(root), false);
  });
}

test('MCP failure with collection disabled creates no runtime error store', async (t) => {
  const { storePath } = await fixture(t, 'throw new Error("fixture-private-detail");', false);
  assert.equal(existsSync(storePath), false);
});

test('new MCP stage keeps the existing generic open record unchanged', async (t) => {
  const { storePath, oldRecord } = await fixture(t,
    'exports.MCPServer = class { async start() { throw new Error("fixture-private-detail"); } };', true, true);
  const { records } = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(records.length, 2);
  assert.equal(oldRecord.fingerprint, 'b61efc6e9b3509703d7e7224988925cd3d8fb9442256f7f54aef659a733bc354');
  assert.equal(oldRecord.count, 4);
  assert.equal(oldRecord.status, 'open');
  assert.deepEqual(records.find((record) => record.fingerprint === oldRecord.fingerprint), oldRecord);
  assert.equal(records.find((record) => record.safe_context.command_kind === 'mcp.start').product_version, packageJson.version);
});
