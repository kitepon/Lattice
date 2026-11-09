import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');

function run(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      LATTICE_SENSOR_ALLOW_UNSAFE_NODE: '1',
    },
  });
}

test('lattice sensor init/syncは同梱sensorだけでtyped resultを返す', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'lattice-sensor-cli-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'fixture.mjs'), 'export function fixture() { return 1; }\n');

  for (const command of ['init', 'sync']) {
    const result = run(['sensor', command, '.', '--json'], repo);
    assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload, {
      schema: 'lattice.sensor_command_result.v1',
      provider: 'lattice',
      sensor_owner: 'lattice',
      sensor_version: '0.7.3-lattice.1',
      command,
      status: 'ok',
    });
  }
});

test('lattice sensorは未知commandをtyped usage errorで拒否する', () => {
  const result = run(['sensor', 'unknown', '--json'], ROOT);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'USAGE');
});

test('lattice sensor syncは無いpathをokにせず名指す(a29)', () => {
  const result = run(['sensor', 'sync', 'no-such-dir-a29'], ROOT);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.deepEqual([error.code, error.detail.path], ['LATTICE_SENSOR_PATH_MISSING', 'no-such-dir-a29']);
});

test('lattice sensor syncは未初期化をtyped errorとnext actionで返す', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'lattice-sensor-uninitialized-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, 'fixture.mjs'), 'export const fixture = true;\n');

  const result = run(['sensor', 'sync', '.', '--json'], repo);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'LATTICE_SENSOR_NOT_INITIALIZED');
  assert.equal(error.detail.exit_code, 1);
  assert.match(error.detail.stderr, /not initialized/u);
  assert.equal(error.detail.next_action, 'lattice sensor init . --json');
});

test('公開packageは独立sensor CLIを公開せずLattice Sensorをprivate実装へ固定する', async () => {
  const rootPackage = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const sensorPackage = JSON.parse(await readFile(path.join(ROOT, 'sensor', 'package.json'), 'utf8'));

  assert.equal(rootPackage.files.includes('sensor/dist'), true);
  assert.equal(rootPackage.files.includes('!sensor/dist/bin/lattice-sensor.*'), true);
  assert.equal(rootPackage.files.includes('sensor/dist/bin/lattice-sensor.js'), true);
  assert.equal(sensorPackage.private, true);
  assert.equal(Object.hasOwn(sensorPackage, 'bin'), false);
  assert.equal(Object.hasOwn(sensorPackage.scripts, 'cli'), false);
  assert.equal(Object.hasOwn(sensorPackage.scripts, 'build:private-runtime'), false);
  assert.doesNotMatch(sensorPackage.scripts.build, /chmodSync/u);
  assert.match(sensorPackage.scripts.build, /tsc/u);
});
