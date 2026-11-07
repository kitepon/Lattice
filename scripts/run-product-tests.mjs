import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// URL.pathnameはWindowsで"/C:/..."となりpath.resolveが"C:\C:\..."を作るため、fileURLToPathで変換する。
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const testRoot = path.join(repoRoot, 'test');

// CI runs core on every supported OS. Profiles remain for short local reproductions.
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

export function productTestEnvironment(parentEnv = process.env, { configDir = null } = {}) {
  // product gateはsuite単位ですでに全CPU並列である。各integration fixtureが
  // sensor init用WASM poolまで最大8本prewarmするとnested oversubscriptionになり、
  // Windowsで複数の子processが0xC0000005になった。sensor自身の並列契約は
  // 独立したtest:sensor gateが検証するため、このharness内だけsingle-workerにする。
  // runnerは利用者の本物のHOMEで走る。送信を有効にした端末でも、試験がその設定を拾ってBugHubへ送らない。
  const env = { ...parentEnv, LATTICE_DASHBOARD_AUTOSTART: '0',
    LATTICE_SENSOR_PARSE_WORKERS: '1', LATTICE_RUNTIME_ERROR_REPORTING: '0' };
  delete env.FORCE_COLOR;
  for (const name of HOST_CONFIG_ENV) delete env[name];
  // 名乗りの無いTodo操作は、端末の識別子を設定の置き場へ作る（ADR 0197）。試験がそれを利用者の本物の
  // `~/.lattice`へ作らないよう、runごとの一時の置き場を渡す。親の値は本物を指すので引き継がない。
  if (configDir === null) delete env.LATTICE_CONFIG_DIR;
  else env.LATTICE_CONFIG_DIR = configDir;
  return env;
}

export function productTestConcurrency(parallelism = availableParallelism()) {
  // 各suiteはCLI・sensor・managed workerを子processとしてさらに起動する。
  // 10 suite同時のMac CIではworker停止窓を越えるほどprocessが競合し、
  // hold・io-sentinel・報告送信の3試験が失敗した。対象3 suiteは4並列で通過。
  return Math.min(parallelism, 4);
}

export function selectProductTests(allTests, profile = 'core') {
  if (profile === 'core') return allTests;
  const selected = nativeTestProfiles[profile];
  if (selected === undefined) throw new Error(`unknown product test profile: ${profile}`);
  const missing = selected.filter((relative) => !allTests.includes(relative));
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
  const profile = requestedProfile();
  const productTests = selectProductTests(allTests, profile);
  process.stdout.write(`Current product gate (${profile}): ${productTests.length} suites\n\n`);
  const configDir = await mkdtemp(path.join(tmpdir(), 'lattice-product-tests-config-'));
  let result;
  try {
    result = spawnSync(
      process.execPath,
      ['--test', `--test-concurrency=${productTestConcurrency()}`,
        ...productTests.map((relative) => path.join('test', relative))],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit',
        env: productTestEnvironment(process.env, { configDir }) },
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runProductTests();
