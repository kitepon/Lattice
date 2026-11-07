import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Boundary checks for docs/architecture/dfd-ci-macos-runtime.md. The installer itself refuses to run
// outside darwin-arm64, and its verify step requires the pinned Node version, so the fake runtimes
// exec this (CI-provided) Node.
const supported = process.platform === 'darwin' && process.arch === 'arm64' && process.versions.node === '24.22.0';
const script = fileURLToPath(new URL('../scripts/ci-macos-node-runtime.sh', import.meta.url));
const sha = '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5';
const identity = `v24.22.0-${sha.slice(0, 16)}`;
const marker = `version=24.22.0 sha256=${sha} uid=${process.getuid?.()}\n`;

async function fixture(t) {
  const work = await mkdtemp(path.join(tmpdir(), 'lattice-macos-runtime-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const base = path.join(work, 'base');
  const stubs = path.join(work, 'stubs');
  await mkdir(base);
  await mkdir(stubs);
  await writeFile(path.join(stubs, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
  const run = () => {
    const output = path.join(work, 'github-output');
    const result = spawnSync('bash', [script, base], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TOOL_CACHE: path.join(work, 'tool-cache'),
        PATH: `${stubs}:${process.env.PATH}` },
    });
    return { ...result, output };
  };
  return { work, base, run };
}

async function generation(dir, { complete = true, markerText = marker, node = 'real' } = {}) {
  await mkdir(path.join(dir, 'bin'), { recursive: true, mode: 0o755 });
  const body = node === 'real' ? `#!/bin/sh\nexec "${process.execPath}" "$@"\n` : '#!/bin/sh\necho 0.0.0\n';
  await writeFile(path.join(dir, 'bin', 'node'), body, { mode: 0o755 });
  if (complete) await writeFile(path.join(dir, '.lattice-complete'), markerText);
}

async function root(base, name = 'lattice-node') {
  const dir = path.join(base, name);
  await mkdir(path.join(dir, identity), { recursive: true });
  await chmod(dir, 0o755);
  return path.join(dir, identity);
}

async function snapshot(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name)).sort();
}

const selectedDirectory = async (output) => (await readFile(output, 'utf8')).match(/^directory=(.*)$/mu)?.[1];

test('legacy tree is never selected and stays untouched', { skip: !supported }, async (t) => {
  const { work, run } = await fixture(t);
  const legacy = path.join(work, 'tool-cache', 'lattice-node', 'v24.22.0');
  await generation(legacy, { complete: false });
  const before = await snapshot(legacy);
  const result = run();
  assert.notEqual(result.status, 0, 'with no generation and no download the job must fail, not use legacy');
  assert.deepEqual(await snapshot(legacy), before);
});

test('squatted roots are skipped untouched and the next sibling root is created', { skip: !supported }, async (t) => {
  const { work, base, run } = await fixture(t);
  const elsewhere = path.join(work, 'elsewhere');
  await generation(path.join(elsewhere, identity, 'g1'));
  await symlink(elsewhere, path.join(base, 'lattice-node'));
  const writable = path.join(base, 'lattice-node.2');
  await generation(path.join(writable, identity, 'g1'));
  await chmod(writable, 0o777);
  const before = [await snapshot(elsewhere), await snapshot(writable)];
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`reserved ${base}/lattice-node\\.3/${identity}/g1`, 'u'));
  assert.ok((await lstat(path.join(base, 'lattice-node'))).isSymbolicLink());
  assert.equal((await lstat(writable)).mode & 0o777, 0o777);
  assert.deepEqual([await snapshot(elsewhere), await snapshot(writable)], before);
});

test('unpublished g1 is skipped untouched and complete g2 is reused', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { complete: false });
  await generation(path.join(dir, 'g2'));
  const before = await snapshot(dir);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await selectedDirectory(result.output), path.join(dir, 'g2'));
  assert.deepEqual(JSON.parse(result.stdout).generation, 'g2');
  assert.deepEqual(await snapshot(dir), before);
});

test('complete generations with a mismatched marker or failed verify are skipped untouched', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { markerText: marker.replace(sha, '0'.repeat(64)) });
  await generation(path.join(dir, 'g2'), { node: 'wrong' });
  await generation(path.join(dir, 'g3'));
  const before = await snapshot(dir);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await selectedDirectory(result.output), path.join(dir, 'g3'));
  assert.deepEqual(await snapshot(dir), before);
});

test('build failure removes only its own reservation, numbered after the existing one', { skip: !supported }, async (t) => {
  const { base, run } = await fixture(t);
  const dir = await root(base);
  await generation(path.join(dir, 'g1'), { complete: false });
  const before = await snapshot(dir);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`reserved ${dir}/g2`, 'u'));
  assert.deepEqual(await snapshot(dir), before);
});
