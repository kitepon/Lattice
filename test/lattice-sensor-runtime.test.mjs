import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join(ROOT, 'test', 'lattice-sensor-runtime.test.mjs');
const RETIRED_NAME = ['code', 'graph'].join('');

async function filesBelow(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(target));
    else if (entry.isFile() && /\.(?:mjs|js|ts|json|sh|md|toml)$/u.test(entry.name)) output.push(target);
  }
  return output;
}

test('公開runtimeと正規testは廃止済み外部CLIを実行しない', async () => {
  const violations = [];
  const patterns = [
    new RegExp(`(?:spawn|spawnSync|execFile|execFileSync)\\s*\\(\\s*['"]${RETIRED_NAME}['"]`, 'u'),
    new RegExp(`\\brun\\s*\\(\\s*['"]${RETIRED_NAME}['"]`, 'u'),
    new RegExp(`\\bnpx\\s+@colbymchenry/${RETIRED_NAME}\\b`, 'u'),
  ];
  for (const root of ['src', 'bin', 'test', 'sensor/dist']) {
    for (const file of await filesBelow(path.join(ROOT, root))) {
      if (file === SELF) continue;
      const source = await readFile(file, 'utf8');
      if (patterns.some((pattern) => pattern.test(source))) {
        violations.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('同梱sensorはprivateなLattice所有packageで独立binを持たない', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'sensor', 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@quolu/lattice-sensor');
  assert.equal(manifest.private, true);
  assert.equal(Object.hasOwn(manifest, 'bin'), false);
  const rootLock = await readFile(path.join(ROOT, 'package-lock.json'), 'utf8');
  assert.equal(rootLock.toLowerCase().includes(RETIRED_NAME), false);
  const sensorLock = await readFile(path.join(ROOT, 'sensor', 'package-lock.json'), 'utf8');
  assert.equal(sensorLock.toLowerCase().includes(RETIRED_NAME), false);
  await assert.rejects(readdir(path.join(ROOT, 'sensor', 'dist', 'installer')));
  await assert.rejects(readdir(path.join(ROOT, 'sensor', 'dist', 'upgrade')));
  await assert.rejects(readFile(path.join(ROOT, 'sensor', 'dist', 'bin', 'uninstall.js')));
});

test('現行実行・配布・test・active contract面へ廃止名を再混入させない', async () => {
  const roots = [
    'src', 'bin', 'scripts', 'test',
    'sensor/src', 'sensor/scripts', 'sensor/docs',
  ];
  // upstream追従の境界層だけは廃止名を名指しできる。sensor/の由来である
  // CodeGraphとのpath対応・repo URLを扱うのが仕事であり、名を伏せると
  // 写像が書けない。境界の正本はsensor/UPSTREAM.jsonで、ここはその読者。
  // この4ファイル以外への再混入は引き続き違反である。
  const upstreamBoundary = new Set([
    'scripts/upstream-sync.mjs',
    'scripts/upstream-check.mjs',
    'scripts/upstream-rename.mjs',
    'test/upstream-sync.test.mjs',
  ]);
  const violations = [];
  for (const root of roots) {
    for (const file of await filesBelow(path.join(ROOT, root))) {
      if (file === SELF) continue;
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      if (upstreamBoundary.has(relative)) continue;
      const source = await readFile(file, 'utf8');
      if (relative.toLowerCase().includes(RETIRED_NAME)
        || source.toLowerCase().includes(RETIRED_NAME)) violations.push(relative);
    }
  }
  for (const relative of [
    'AGENTS.md', 'README.md', 'package.json', 'sensor/package.json', 'sensor/README.md',
    'docs/00_product-contract.md', 'docs/01_integration-package.md',
    'docs/06_design-spec.md', 'lattice-sensor.json',
  ]) {
    const source = await readFile(path.join(ROOT, relative), 'utf8');
    if (source.toLowerCase().includes(RETIRED_NAME)) violations.push(relative);
  }
  assert.deepEqual(violations.sort(), []);
});
