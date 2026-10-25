import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildFactoryDiagnostics, validateFactoryDiagnostics } from '../src/factory-diagnostics.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'lattice.mjs');

test('本repoではoverall okの正規schemaを返しexact keyで検証が通る', async () => {
  const diagnostics = await buildFactoryDiagnostics();
  assert.equal(diagnostics.schema, 'lattice.native_factory_diagnostics.v1');
  assert.equal(diagnostics.product, 'lattice');
  assert.equal(diagnostics.overall, 'ok');
  assert.deepEqual(
    diagnostics.checks.map((entry) => entry.id),
    ['package_version', 'node_runtime', 'cli_surface', 'mcp_entry', 'sensor_attribution'],
  );
  const nodeRuntime = diagnostics.checks.find(({ id }) => id === 'node_runtime');
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(nodeRuntime.detail, `${process.version} satisfies engines.node ${packageJson.engines.node}`);
  const belowFloor = await buildFactoryDiagnostics({ nodeVersion: 'v22.12.99' });
  assert.equal(belowFloor.checks.find(({ id }) => id === 'node_runtime').status, 'failed');
  assert.equal(belowFloor.checks.find(({ id }) => id === 'node_runtime').detail,
    `v22.12.99 does not satisfy engines.node ${packageJson.engines.node}`);
  for (const nodeVersion of ['v24.2.0', 'v24.20.0', 'v24.21.99', 'v25.1.0', 'v26.0.0', 'v26.9.99']) {
    const result = await buildFactoryDiagnostics({ nodeVersion });
    assert.equal(result.checks.find(({ id }) => id === 'node_runtime').status, 'failed', nodeVersion);
  }
  for (const nodeVersion of ['v22.13.0', 'v24.1.99', 'v24.22.0', 'v26.10.0']) {
    const result = await buildFactoryDiagnostics({ nodeVersion });
    assert.equal(result.checks.find(({ id }) => id === 'node_runtime').status, 'ok', nodeVersion);
  }
  assert.equal(validateFactoryDiagnostics(diagnostics), true);
});

test('CLI factory-diagnostics --jsonはstdout 1行JSONとexit 0を返す', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'factory-diagnostics', '--json']);
  const lines = stdout.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(validateFactoryDiagnostics(parsed), true);
  assert.equal(parsed.overall, 'ok');
});

test('特殊文字を含むrootでもruntime CLIをfile URLとしてloadする', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'lattice#url-regression-'));
  try {
    await mkdir(path.join(fixtureRoot, 'src'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'bin'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'sensor'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      version: '1.2.3', engines: { node: '>=22.13 <25 || >=26' },
    }));
    await writeFile(path.join(fixtureRoot, 'src', 'runtime-cli.mjs'), 'export function runRuntimeCli() {}\n');
    await writeFile(path.join(fixtureRoot, 'bin', 'lattice-mcp.mjs'), 'export {};\n');
    await writeFile(path.join(fixtureRoot, 'sensor', 'LICENSE'), 'MIT\n');
    await writeFile(path.join(fixtureRoot, 'sensor', 'NOTICE'), 'attribution\n');

    const diagnostics = await buildFactoryDiagnostics({ rootDir: fixtureRoot });
    assert.equal(diagnostics.overall, 'ok');
    assert.equal(diagnostics.checks.find(({ id }) => id === 'cli_surface').status, 'ok');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('壊れたrootでは該当checkがfailedになりoverall failedとexit 1へ落ちる（fail closed）', async () => {
  const brokenRoot = await mkdtemp(path.join(os.tmpdir(), 'lattice-diag-'));
  try {
    await mkdir(path.join(brokenRoot, 'bin'), { recursive: true });
    await writeFile(path.join(brokenRoot, 'package.json'), JSON.stringify({
      version: '0.0.0-unknown', engines: { node: '>=22.13 || <25' },
    }));
    const diagnostics = await buildFactoryDiagnostics({ rootDir: brokenRoot });
    assert.equal(diagnostics.overall, 'failed');
    assert.equal(diagnostics.version, '0.0.0-unknown');
    const byId = new Map(diagnostics.checks.map((entry) => [entry.id, entry.status]));
    assert.equal(byId.get('package_version'), 'failed');
    assert.equal(byId.get('node_runtime'), 'failed');
    assert.equal(byId.get('cli_surface'), 'failed');
    assert.equal(byId.get('mcp_entry'), 'failed');
    assert.equal(byId.get('sensor_attribution'), 'failed');
    assert.equal(validateFactoryDiagnostics(diagnostics), true);
  } finally {
    await rm(brokenRoot, { recursive: true, force: true });
  }
});

test('validateはoverallとchecksの矛盾・未知key・過大detailを拒否する', async () => {
  const diagnostics = await buildFactoryDiagnostics();
  assert.equal(validateFactoryDiagnostics({ ...diagnostics, overall: 'failed' }), false);
  assert.equal(validateFactoryDiagnostics({ ...diagnostics, extra: true }), false);
  const [first, ...rest] = diagnostics.checks;
  assert.equal(
    validateFactoryDiagnostics({ ...diagnostics, checks: [{ ...first, detail: 'x'.repeat(257) }, ...rest] }),
    false,
  );
  assert.equal(validateFactoryDiagnostics({ ...diagnostics, checks: [...rest, first] }), false);
});
