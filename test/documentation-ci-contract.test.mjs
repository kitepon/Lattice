import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('Markdown-only変更は製品所有の文書gateを必ず実行する', async () => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const caller = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const verifier = await readFile(path.join(repoRoot, 'scripts/verify-docs.mjs'), 'utf8');
  const reusable = await readFile(
    path.join(repoRoot, '.github/workflows/product-full-ci.yml'),
    'utf8',
  );

  assert.equal(
    packageJson.scripts?.['check:docs'],
    'node scripts/verify-docs.mjs && node scripts/verify-packed-markdown.mjs && node --test test/documentation-ci-contract.test.mjs test/markdown-link-targets.test.mjs',
  );
  for (const dependency of ['unified', 'remark-parse', 'remark-gfm']) {
    assert.equal(typeof packageJson.dependencies?.[dependency], 'string');
  }
  assert.equal(typeof packageJson.devDependencies?.['micromark-util-decode-string'], 'string');
  assert.match(caller, /uses:\s+\.\/\.github\/workflows\/product-full-ci\.yml/u);
  assert.match(
    caller,
    /documentation-command:\s+npm ci --ignore-scripts --no-audit --no-fund && npm run check:docs/u,
  );
  assert.doesNotMatch(caller, /kitepon\/dotagents\/\.github\/workflows/u);
  assert.match(
    reusable,
    /if:\s+steps\.changes\.outputs\.product_change == 'false' && inputs\.documentation-command != ''/u,
  );
  assert.match(reusable, /run:\s+\$\{\{ inputs\.documentation-command \}\}/u);
  assert.match(verifier, /listProductDocumentation\(ROOT\)/u);
  assert.match(verifier, /product Markdown files including root evidence\/docs archive\/evidence/u);
  assert.match(verifier, /immutable raw\/artifact snapshots excluded/u);
  assert.doesNotMatch(verifier, /entry\.name === 'archive'|entry\.name === 'evidence'/u);
  const packedVerifier = await readFile(
    path.join(repoRoot, 'scripts/verify-packed-markdown.mjs'),
    'utf8',
  );
  assert.match(packedVerifier, /'pack', '--dry-run', '--ignore-scripts', '--json'/u);
  assert.match(packedVerifier, /packed Markdown closure/u);
  assert.match(packedVerifier, /missingPackedMarkdownTargets/u);
});

test('windows-nativeの全commandはPowerShell 7だけで実行する', async () => {
  const reusable = await readFile(
    path.join(repoRoot, '.github/workflows/product-full-ci.yml'),
    'utf8',
  );
  const windowsSteps = [...reusable.matchAll(
    /if:\s+[^\n]*matrix\.environment == 'windows-native'[\s\S]*?(?=\n      - name:|$)/gu,
  )];

  assert.equal(windowsSteps.length, 3);
  for (const step of windowsSteps) assert.match(step[0], /shell:\s+pwsh/u);
  assert.doesNotMatch(reusable, /(?:bash|cmd|powershell)(?:\.exe)?[^\n]*\{0\}/iu);
});

test('工場CIは現役runnerの3環境だけを要求する', async () => {
  const caller = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const reusable = await readFile(
    path.join(repoRoot, '.github/workflows/product-full-ci.yml'),
    'utf8',
  );

  // 退役したlabelを要求すると、jobはrunner待ちのまま24時間で打ち切られる（2026-09 実被弾）。
  assert.match(caller, /options:\s+\[all, macos-native, linux-workstation, windows-native\]/u);
  assert.ok(reusable.includes(`'["macos-native","linux-workstation","windows-native"]'`));
  for (const source of [caller, reusable]) assert.doesNotMatch(source, /linux-native|wsl2/u);
});
