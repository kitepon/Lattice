import { readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// URL.pathnameはWindowsで"/C:/..."となりpath.resolveが"C:\C:\..."を作るため、fileURLToPathで変換する。
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const testRoot = path.join(repoRoot, 'test');

// These suites replay immutable RC1/RC2 research artifacts. They remain available
// for historical forensics, but cannot decide the current Lattice product gate.
const retiredArtifactReplaySuites = new Set([
  // RC1期のcontrol compilerはproduct経路から到達しない（check:reachabilityが宣言済み）。
  // これらは固定commitのtreeを再生する記録であり、shallow cloneではそのrefが無いので
  // 環境によっては再生できない。製品の判定に使わない。
  'integration/control-compiler.integration.mjs',
  'integration/control-portability.integration.mjs',
  'control-compiler.test.mjs',
  'integration/rc1-v4-campaign.integration.mjs',
  'integration/rc2-sensor-artifact-scope.integration.mjs',
  'integration/rc3-actual-dogfood.integration.mjs',
  'integration/rc3-event-store-scope.integration.mjs',
  'integration/seam-transform.integration.mjs',
  'integration/treatment-recompile.integration.mjs',
  'rc1-black-box-oracle.test.mjs',
  'rc1-comparison.test.mjs',
  'rc1-evidence-bundle.test.mjs',
  'rc1-v4-campaign.test.mjs',
  'rc1-v4-characterization.test.mjs',
  'rc1-v5-behavior-evidence.test.mjs',
  'rc1-v5-campaign.test.mjs',
  'rc1-v6-behavior-evidence.test.mjs',
  'rc1-v6-campaign.test.mjs',
  'rc1-v6-causal-binding.test.mjs',
  'rc1-v6-measurement.test.mjs',
  'rc2-artifact-version-witness.test.mjs',
  'rc2-campaign.test.mjs',
  'rc2-rc1-transfer-front-end.test.mjs',
  'rc2-v6-compatibility.test.mjs',
  'rc3-compatibility.test.mjs',
  'seam-transform.test.mjs',
  'treatment-compiler.test.mjs',
  'treatment-runner.test.mjs',
]);

// CIはcoreを全対象OSへ同時投入する。個別profileは、特定OSのfocused再現を
// ローカルで短く回すためだけに残す。
export const nativeTestProfiles = Object.freeze({
  linux: Object.freeze([
    'bridge-daemon.test.mjs',
    'hooks-cli.test.mjs',
    'project-cli.test.mjs',
    'todo-store.test.mjs',
  ]),
  macos: Object.freeze([
    'bridge-executable.test.mjs',
    'bridge-launch-agent.test.mjs',
    'project-cli.test.mjs',
    'runtime-conflict-cli.test.mjs',
  ]),
  windows: Object.freeze([
    'bridge-config.test.mjs',
    'bridge-executable.test.mjs',
    'bridge-startup-folder.test.mjs',
    'project-cli.test.mjs',
    'todo-store.test.mjs',
  ]),
  wsl2: Object.freeze([
    'hooks-cli.test.mjs',
    'project-cli.test.mjs',
    'todo-store.test.mjs',
  ]),
});

async function collectTests(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTests(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(relative);
    }
  }
  return files;
}

// 端末の本物のhost設定の置き場を指す変数（`src/setup-hosts.mjs`が読む）。試験は一時のHOMEを渡すが、
// これらが残っていると、CLIはHOMEでなくそちらを使い、利用者の本物の設定を書き換える。
export const HOST_CONFIG_ENV = Object.freeze(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']);

export function productTestEnvironment(parentEnv = process.env) {
  // product gateはsuite単位ですでに全CPU並列である。各integration fixtureが
  // sensor init用WASM poolまで最大8本prewarmするとnested oversubscriptionになり、
  // Windowsで複数の子processが0xC0000005になった。sensor自身の並列契約は
  // 独立したtest:sensor gateが検証するため、このharness内だけsingle-workerにする。
  // runnerは利用者の本物のHOMEで走る。送信を有効にした端末でも、試験がその設定を拾ってBugHubへ送らない。
  const env = { ...parentEnv, LATTICE_DASHBOARD_AUTOSTART: '0',
    LATTICE_SENSOR_PARSE_WORKERS: '1', LATTICE_RUNTIME_ERROR_REPORTING: '0' };
  delete env.FORCE_COLOR;
  for (const name of HOST_CONFIG_ENV) delete env[name];
  return env;
}

export function productTestConcurrency(parallelism = availableParallelism()) {
  return parallelism;
}

export function selectProductTests(allTests, profile = 'core') {
  const productTests = allTests.filter((relative) => !retiredArtifactReplaySuites.has(relative));
  if (profile === 'core') return productTests;
  const selected = nativeTestProfiles[profile];
  if (selected === undefined) throw new Error(`unknown product test profile: ${profile}`);
  const missing = selected.filter((relative) => !productTests.includes(relative));
  if (missing.length > 0) {
    throw new Error(`product test profile ${profile} references missing suites: ${missing.join(', ')}`);
  }
  return [...selected];
}

function requestedProfile(argv = process.argv.slice(2)) {
  const profileArguments = argv.filter((value) => value.startsWith('--profile='));
  if (profileArguments.length > 1 || argv.some((value) => !value.startsWith('--profile='))) {
    throw new Error('usage: run-product-tests.mjs [--profile=core|linux|macos|windows|wsl2]');
  }
  return profileArguments[0]?.slice('--profile='.length) || 'core';
}

async function runProductTests() {
  const allTests = (await collectTests(testRoot)).sort();
  const missingRetired = [...retiredArtifactReplaySuites]
    .filter((relative) => !allTests.includes(relative));
  if (missingRetired.length > 0) {
    throw new Error(`retired artifact replay suite list drifted: ${missingRetired.join(', ')}`);
  }

  const profile = requestedProfile();
  const productTests = selectProductTests(allTests, profile);
  process.stdout.write([
    `Current product gate (${profile}): ${productTests.length} suites`,
    `Retired immutable artifact replay (not used for product verdict): ${retiredArtifactReplaySuites.size} suites`,
    ...[...retiredArtifactReplaySuites].sort().map((relative) => `  - test/${relative}`),
    '',
  ].join('\n'));

  const result = spawnSync(
    process.execPath,
    ['--test', `--test-concurrency=${productTestConcurrency()}`,
      ...productTests.map((relative) => path.join('test', relative))],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit',
      env: productTestEnvironment() },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runProductTests();
