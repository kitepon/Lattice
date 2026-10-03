import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink,
  utimes, writeFile, rename,
} from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeTest, { after, before } from 'node:test';
import { HOST_CONFIG_ENV } from '../scripts/run-product-tests.mjs';
import { resolveStableNodePath, runHooksCli } from '../src/hooks-cli.mjs';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const SURFACE_CHECK = path.join(REPO_ROOT, 'scripts', 'verify-cli-surface.mjs');
const REAL_HOME_SETTINGS = path.join(process.env.HOME, '.claude', 'settings.json');
const REAL_HOME_CURSOR_HOOKS = path.join(process.env.HOME, '.cursor', 'hooks.json');
const INFO = 'INFO: このrepoにはLattice sensor index（.lattice/sensor/）があります。コード構造の調査はsensor入口（MCP: lattice_sensor_explore 等／CLI: lattice sensor）を優先できます。';
const hash = (value) => createHash('sha256').update(value).digest('hex');

let suiteRoot;
let suiteHome;
let suiteState;
let suiteConfig;
let realHomeBefore;
let realCursorBefore;

async function snapshotFile(target) {
  try {
    const info = await lstat(target, { bigint: true });
    return { exists: true, mtimeNs: info.mtimeNs, bytes: await readFile(target) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

before(async () => {
  // Guardだけが実HOMEをread-only観測する。CLIへは一度も渡さない。
  realHomeBefore = await snapshotFile(REAL_HOME_SETTINGS);
  realCursorBefore = await snapshotFile(REAL_HOME_CURSOR_HOOKS);
  suiteRoot = await mkdtemp(path.join(tmpdir(), 'lattice-hooks-suite-'));
  suiteHome = path.join(suiteRoot, 'home');
  suiteState = path.join(suiteRoot, 'xdg-state');
  suiteConfig = path.join(suiteRoot, 'xdg-config');
  await Promise.all([
    mkdir(suiteHome, { recursive: true, mode: 0o700 }),
    mkdir(suiteState, { recursive: true, mode: 0o700 }),
    mkdir(suiteConfig, { recursive: true, mode: 0o700 }),
  ]);
});

after(async () => {
  const realHomeAfter = await snapshotFile(REAL_HOME_SETTINGS);
  assert.equal(realHomeAfter.exists, realHomeBefore.exists,
    '実HOMEのClaude settings.jsonの存在状態を変えてはならない');
  if (realHomeBefore.exists) {
    assert.equal(realHomeAfter.mtimeNs, realHomeBefore.mtimeNs,
      '実HOMEのClaude settings.jsonのmtimeを変えてはならない');
    assert.deepEqual(realHomeAfter.bytes, realHomeBefore.bytes,
      '実HOMEのClaude settings.jsonのbytesを変えてはならない');
  }
  const realCursorAfter = await snapshotFile(REAL_HOME_CURSOR_HOOKS);
  assert.equal(realCursorAfter.exists, realCursorBefore.exists,
    '実HOMEのCursor hooks.jsonの存在状態を変えてはならない');
  if (realCursorBefore.exists) {
    assert.equal(realCursorAfter.mtimeNs, realCursorBefore.mtimeNs,
      '実HOMEのCursor hooks.jsonのmtimeを変えてはならない');
    assert.deepEqual(realCursorAfter.bytes, realCursorBefore.bytes,
      '実HOMEのCursor hooks.jsonのbytesを変えてはならない');
  }
  await rm(suiteRoot, { recursive: true, force: true });
});

function isolatedEnv({ home = suiteHome, stateHome = suiteState, configHome = suiteConfig,
  extraEnv = {} } = {}) {
  // 端末の本物のhost設定の置き場を指す変数は渡さない。残っていると、CLIは下のHOMEでなくそちらを使い、
  // 利用者の本物の設定を書き換える。
  const inherited = { ...process.env };
  for (const name of HOST_CONFIG_ENV) delete inherited[name];
  const env = {
    ...inherited,
    ...extraEnv,
    HOME: home,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: configHome,
    NO_COLOR: '1',
    LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  delete env.FORCE_COLOR;
  return env;
}

function runCli(args, { cwd = REPO_ROOT, home, stateHome, configHome, input, extraEnv } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv({ home, stateHome, configHome, extraEnv }),
    input,
  });
  assert.equal(result.error, undefined);
  return result;
}

async function runCliAsync(args, { cwd = REPO_ROOT, home, stateHome, configHome, input,
  extraEnv } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: isolatedEnv({ home, stateHome, configHome, extraEnv }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function hooksFixture(context, host, { config, git = false, createHost = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-hooks-cli-'));
  const home = path.join(root, 'home');
  const stateHome = path.join(root, 'xdg-state');
  const configHome = path.join(root, 'xdg-config');
  const configPath = host === 'claude'
    ? path.join(home, '.claude', 'settings.json')
    : host === 'cursor'
      ? path.join(home, '.cursor', 'hooks.json')
      : path.join(home, '.codex', 'hooks.json');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(stateHome, { recursive: true, mode: 0o700 }),
    mkdir(configHome, { recursive: true, mode: 0o700 }),
  ]);
  if (createHost) await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (config !== undefined) await writeFile(configPath, config, { mode: 0o600 });
  if (git) {
    const initialized = spawnSync('git', ['init', '--quiet'], {
      cwd: root, env: isolatedEnv({ home, stateHome, configHome }), encoding: 'utf8',
    });
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, stateHome, configHome, configPath };
}

function options(fixture, extra = {}) {
  return {
    cwd: fixture.root,
    home: fixture.home,
    stateHome: fixture.stateHome,
    configHome: fixture.configHome,
    ...extra,
  };
}

const FOREIGN_CLAUDE_HOOKS = JSON.stringify({
  alpha: 1,
  hooks: {
    metadata: 'keep',
    UserPromptSubmit: [{ matcher: 'all', hooks: [
      { type: 'command', command: 'other-product --observe', timeout: 9 },
    ] }],
  },
  omega: 2,
}, null, 2);
const FOREIGN_CODEX_HOOKS = JSON.stringify({
  alpha: 1,
  hooks: {
    metadata: 'keep',
    UserPromptSubmit: [{ matcher: 'all', hooks: [
      { type: 'command', command: 'other-product --observe', timeout: 9 },
    ] }],
  },
  omega: 2,
}, null, 2);
const FOREIGN_CURSOR_HOOKS = JSON.stringify({
  version: 1,
  alpha: 1,
  hooks: {
    sessionStart: [{ command: '/factory/cursor-constitution-hook', timeout: 10 }],
    beforeSubmitPrompt: [{ command: 'other-product --observe', timeout: 9 }],
  },
  omega: 2,
}, null, 2);

async function canonical(host) {
  return [await resolveStableNodePath(process.execPath), await realpath(CLI), 'hooks', 'emit', '--host', host];
}

function commandArgv(command) {
  const result = spawnSync('sh', ['-c', 'eval "set -- $HOOK_COMMAND"; printf "%s\\0" "$@"'], {
    cwd: REPO_ROOT,
    env: isolatedEnv({ extraEnv: { HOOK_COMMAND: command } }),
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const bytes = result.stdout;
  assert.equal(bytes.at(-1), 0);
  return bytes.subarray(0, -1).toString('utf8').split('\0');
}

function receiptPath(fixture, host) {
  return path.join(fixture.stateHome, 'lattice', 'hooks', 'installs', `${host}.json`);
}

function handlers(config, host = 'claude') {
  const list = config.hooks?.[host === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit'] ?? [];
  if (host === 'cursor') return list;
  return list.flatMap((wrapper) => wrapper.hooks ?? []);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

function captureStdout({ fail = false } = {}) {
  return {
    output: '',
    write(chunk, callback) {
      if (fail && callback) { callback(new Error('injected output failure')); return false; }
      this.output += String(chunk);
      callback?.();
      return true;
    },
  };
}

async function directCli(argv, fixture, {
  input = '', platform, source, spawnImpl, gitTimeoutMs, stdout = captureStdout(), extraEnv = {},
  testHooks,
} = {}) {
  const env = isolatedEnv({
    home: fixture.home, stateHome: fixture.stateHome, configHome: fixture.configHome, extraEnv,
  });
  const status = await runHooksCli({
    argv, stdout, stdin: Readable.from([input]), env, platform, source, spawnImpl, gitTimeoutMs,
    testHooks,
  });
  return { status, stdout: stdout.output };
}

test('P3 hermetic guard: 全spawnのHOME/XDGは一時dirで、実HOME settingsはsuite前後に不変である', () => {
  assert.notEqual(suiteHome, process.env.HOME);
  assert.equal(path.isAbsolute(suiteState), true);
  assert.equal(path.isAbsolute(suiteConfig), true);
  assert.notEqual(suiteState, process.env.XDG_STATE_HOME);
  assert.notEqual(suiteConfig, process.env.XDG_CONFIG_HOME);
});

test('P3 C1: hooks の未知subcommandはtyped usageとして拒否される', () => {
  const result = runCli(['hooks', 'unknown', '--host', 'claude']);
  assert.equal(result.status, 2);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['schema', 'code', 'message']);
  assert.equal(JSON.parse(result.stdout).code, 'USAGE');
  assert.equal(result.stderr, '');
});

test('P3 実CLI: Claude/Codex/Cursorのinstall/status/uninstallとemitは隔離HOMEだけを使う', async (t) => {
  for (const [host, config] of [
    ['claude', FOREIGN_CLAUDE_HOOKS],
    ['codex', FOREIGN_CODEX_HOOKS],
    ['cursor', FOREIGN_CURSOR_HOOKS],
  ]) {
    const fixture = await hooksFixture(t, host, { config, git: true });
    const installed = runCli(['hooks', 'install', '--host', host], options(fixture));
    assert.equal(installed.status, 0, installed.stdout);
    const status = runCli(['hooks', 'status', '--host', host], options(fixture));
    assert.equal(status.status, 0, status.stdout);
    assert.equal(JSON.parse(status.stdout).state, 'wired');
    const removed = runCli(['hooks', 'uninstall', '--host', host], options(fixture));
    assert.equal(removed.status, 0, removed.stdout);
    await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
    const emitted = runCli(['hooks', 'emit', '--host', host], options(fixture, {
      input: JSON.stringify({ session_id: `s-${host}`, cwd: fixture.root }),
    }));
    assert.equal(emitted.status, 0);
    if (host === 'claude') assert.equal(emitted.stdout, `${INFO}\n`);
    else if (host === 'cursor') assert.equal(JSON.parse(emitted.stdout).additional_context, INFO);
    else assert.equal(JSON.parse(emitted.stdout).hookSpecificOutput.additionalContext, INFO);
  }
});

// C1: 4 subcommand と --host 構文の公開surface（emitも位置引数を許さない）。
test('P3 C1: install/status/uninstall/emit は --host claude|codex|cursor のみを受理し、emit位置引数をusage拒否する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  assert.equal(runCli(['hooks', 'install', '--host', 'claude'], options(fixture)).status, 0);
  assert.equal(runCli(['hooks', 'status', '--host', 'claude'], options(fixture)).status, 0);
  assert.equal(runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture)).status, 0);
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, {
    input: '{}', extraEnv: { LATTICE_HOOKS: 'off' },
  })).status, 0);
  const cursor = await hooksFixture(t, 'cursor', { config: '{}' });
  assert.equal(runCli(['hooks', 'install', '--host', 'cursor'], options(cursor)).status, 0);
  for (const bad of [
    ['hooks', 'emit', 'claude'], ['hooks', 'emit', '--host', 'other'],
    ['hooks', 'install', 'claude'], ['hooks', 'status', '--host'],
  ]) {
    const result = runCli(bad, options(fixture));
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, 'USAGE');
  }
});

// C1: 4 subcommandはhelp 3層とCLI surface COMMANDSにも同時に現れる。
test('P3 C1: hooks namespace/subcommand helpとCLI surface COMMANDSは4 subcommandの同一構文を公開する', () => {
  assert.match(runCli(['--help']).stdout, /hooks <command>/u);
  const namespace = runCli(['hooks', '--help']).stdout;
  assert.match(namespace, /<install\|status\|uninstall\|emit> --host <claude\|codex\|cursor>/u);
  for (const command of ['install', 'status', 'uninstall', 'emit']) {
    assert.match(runCli(['hooks', command, '--help']).stdout,
      new RegExp(`hooks ${command} --host <claude\\|codex\\|cursor>`, 'u'));
  }
  const surface = spawnSync(process.execPath, [SURFACE_CHECK], {
    cwd: REPO_ROOT, encoding: 'utf8', env: isolatedEnv(),
  });
  assert.equal(surface.status, 0, `${surface.stdout}\n${surface.stderr}`);
  assert.deepEqual(JSON.parse(surface.stdout.slice(0, surface.stdout.lastIndexOf('\ncli surface verified')))
    .unexercised, []);
});

// C2: canonical argv は絶対node・絶対realpath mjs・hooks emit --host <host> の完全列である。
test('P3 C2: install は Claude のcanonical commandを絶対node/絶対mjs/hooks emit --host claude で1件だけ書く', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  assert.equal(runCli(['hooks', 'install', '--host', 'claude'], options(fixture)).status, 0);
  const self = handlers(await readJson(fixture.configPath))
    .filter((item) => commandArgv(item.command).includes('hooks'));
  assert.equal(self.length, 1);
  assert.deepEqual(commandArgv(self[0].command), await canonical('claude'));
  assert.deepEqual(self[0], { type: 'command', command: self[0].command, timeout: 5 });
  assert.equal(path.isAbsolute((await canonical('claude'))[0]), true);
  assert.equal(path.isAbsolute((await canonical('claude'))[1]), true);
});

test('P3 C2: Homebrew Cellarの版付きNodeは同一実体を指す安定symlinkへ正規化する', async () => {
  const cellar = '/opt/homebrew/Cellar/node/26.5.1/bin/node';
  const stable = '/opt/homebrew/bin/node';
  const resolved = '/opt/homebrew/Cellar/node/26.5.1/bin/node';
  const accessImpl = async (target) => {
    if (![cellar, stable].includes(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const realpathImpl = async (target) => {
    if (target === cellar || target === stable) return resolved;
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.equal(await resolveStableNodePath(cellar, {
    platform: 'darwin', accessImpl, realpathImpl,
  }), stable);
  assert.equal(await resolveStableNodePath(cellar, {
    platform: 'linux', accessImpl, realpathImpl,
  }), cellar);
});

test('P3 C2: Homebrew安定symlinkが別実体ならCellarのNodeを維持する', async () => {
  const cellar = '/usr/local/Cellar/node@22/22.18.0/bin/node';
  const stable = '/usr/local/bin/node';
  const optStable = '/usr/local/opt/node@22/bin/node';
  const accessImpl = async (target) => {
    if (![cellar, stable, optStable].includes(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const realpathImpl = async (target) => {
    if (target === cellar) return cellar;
    if (target === stable || target === optStable) return '/usr/local/Cellar/node/26.5.1/bin/node';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.equal(await resolveStableNodePath(cellar, {
    platform: 'darwin', accessImpl, realpathImpl,
  }), cellar);
});

// C2: canonical argv は絶対node・絶対realpath mjs・hooks emit --host <host> の完全列である。
test('P3 C2: install は Codex のcanonical commandを絶対node/絶対mjs/hooks emit --host codex で1件だけ書く', async (t) => {
  const fixture = await hooksFixture(t, 'codex', { config: FOREIGN_CODEX_HOOKS });
  assert.equal(runCli(['hooks', 'install', '--host', 'codex'], options(fixture)).status, 0);
  const self = handlers(await readJson(fixture.configPath))
    .filter((item) => commandArgv(item.command).includes('hooks'));
  assert.equal(self.length, 1);
  assert.deepEqual(commandArgv(self[0].command), await canonical('codex'));
  assert.deepEqual(self, [{
    type: 'command', command: self[0].command, timeout: 5,
    async: false, statusMessage: null,
  }]);
});

test('P3 C2: install は Cursor のcanonical commandを beforeSubmitPrompt のflat {command,timeout} で1件だけ書く', async (t) => {
  const fixture = await hooksFixture(t, 'cursor', { config: FOREIGN_CURSOR_HOOKS });
  assert.equal(runCli(['hooks', 'install', '--host', 'cursor'], options(fixture)).status, 0);
  const value = await readJson(fixture.configPath);
  assert.equal(value.version, 1);
  assert.deepEqual(value.hooks.sessionStart, [
    { command: '/factory/cursor-constitution-hook', timeout: 10 },
  ]);
  const self = handlers(value, 'cursor').filter((item) => commandArgv(item.command).includes('hooks'));
  assert.equal(self.length, 1);
  assert.deepEqual(commandArgv(self[0].command), await canonical('cursor'));
  assert.deepEqual(self[0], { command: self[0].command, timeout: 5 });
  assert.equal(Object.hasOwn(self[0], 'type'), false);
  assert.equal(Array.isArray(value.hooks.beforeSubmitPrompt), true);
  assert.equal(value.hooks.beforeSubmitPrompt.some((item) => Array.isArray(item?.hooks)), false);
});

// C2: identityはinstall receipt照合だけであり、pendingはconfig実体との照合後に回復する。
test('P3 C2: receiptの現canonical・過去argv完全一致だけを自identityとして照合しbasename類推をしない', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  assert.equal(runCli(['hooks', 'install', '--host', 'claude'], options(fixture)).status, 0);
  const old = ['/old/node', '/old/lattice.mjs', 'hooks', 'emit', '--host', 'claude'];
  const oldCommand = "'/old/node' '/old/lattice.mjs' 'hooks' 'emit' '--host' 'claude'";
  const missing = ['/missing/node', '/missing/lattice.mjs', 'hooks', 'emit', '--host', 'claude'];
  const receipt = await readJson(receiptPath(fixture, 'claude'));
  receipt.entries.push({ argv: old, status: 'pending', operation_id: 'applied' });
  receipt.entries.push({ argv: missing, status: 'pending', operation_id: 'not-applied' });
  await writeFile(receiptPath(fixture, 'claude'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  const config = await readJson(fixture.configPath);
  config.hooks.UserPromptSubmit.push({ hooks: [
    { type: 'command', command: oldCommand, timeout: 5 },
    { type: 'command', command: `${oldCommand} --extra`, timeout: 5 },
  ] });
  await writeFile(fixture.configPath, `${JSON.stringify(config)}\n`);
  assert.equal(runCli(['hooks', 'status', '--host', 'claude'], options(fixture)).status, 0);
  const recovered = await readJson(receiptPath(fixture, 'claude'));
  assert.equal(recovered.entries.some((entry) => entry.operation_id === 'applied'
    && entry.status === 'committed'), true);
  assert.equal(recovered.entries.some((entry) => entry.operation_id === 'not-applied'), false);
  assert.equal(runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture)).status, 0);
  const remaining = handlers(await readJson(fixture.configPath));
  assert.deepEqual(remaining.map((item) => item.command), [`${oldCommand} --extra`]);
});

// C2: 除去単位はinner handlerで、同じwrapperの他handlerとmetadataを保持する。
test('P3 C2: self handler除去はinner handler単位でwrapper内のforeign handlerとmetadataを保持する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  const config = await readJson(fixture.configPath);
  const self = config.hooks.UserPromptSubmit.pop().hooks[0];
  config.hooks.UserPromptSubmit.push({ matcher: 'keep-me', hooks: [
    { type: 'command', command: 'foreign --keep', timeout: 19 }, self,
  ] });
  await writeFile(fixture.configPath, `${JSON.stringify(config)}\n`);
  const removed = runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture));
  assert.equal(JSON.parse(removed.stdout).removed_count, 1);
  assert.deepEqual((await readJson(fixture.configPath)).hooks.UserPromptSubmit,
    [{ matcher: 'keep-me', hooks: [{ type: 'command', command: 'foreign --keep', timeout: 19 }] }]);
});

// C2: receiptにないemit形handlerはforeign_candidateとしてstatusのdriftで可視化し、receipt symlinkは拒否する。
test('P3 C2: receiptにない hooks emit --host handlerはforeign_candidateとして可視化し削除しない', async (t) => {
  const candidate = "'/copied/node' '/copied/lattice.mjs' hooks emit --host claude";
  const config = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
    { type: 'command', command: candidate, timeout: 5 },
  ] }] } });
  const fixture = await hooksFixture(t, 'claude', { config });
  const statusResult = runCli(['hooks', 'status', '--host', 'claude'], options(fixture));
  assert.equal(statusResult.status, 0);
  const statusValue = JSON.parse(statusResult.stdout);
  assert.deepEqual(commandArgv(statusValue.canonical_command), await canonical('claude'));
  assert.deepEqual({ ...statusValue, canonical_command: '<checked-by-sh>' }, {
    schema: 'lattice.hooks_status_result.v1', host: 'claude', config_path: fixture.configPath,
    state: 'drift', canonical_command: '<checked-by-sh>',
    matched_handler_count: 0, foreign_candidate_count: 1, executable_ok: true,
    next_action: 'lattice hooks install --host claude',
  });
  assert.equal(JSON.parse(runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture)).stdout)
    .removed_count, 0);
  assert.equal(handlers(await readJson(fixture.configPath))[0].command, candidate);

  const installs = path.dirname(receiptPath(fixture, 'claude'));
  await mkdir(installs, { recursive: true, mode: 0o700 });
  const outside = path.join(fixture.root, 'outside-receipt');
  await writeFile(outside, 'do-not-touch', { mode: 0o600 });
  await symlink(outside, receiptPath(fixture, 'claude'));
  const unsafe = runCli(['hooks', 'status', '--host', 'claude'], options(fixture));
  assert.equal(unsafe.status, 1);
  assert.equal(JSON.parse(unsafe.stdout).state, 'unreadable');
  assert.equal(await readFile(outside, 'utf8'), 'do-not-touch');
});

// C2: Codex handlerはtimeoutを使い、timeoutSecは契約外である。
test('P3 C2 negative: Codex handlerは timeout: 5 を持ち timeoutSec を一切書かない', async (t) => {
  const fixture = await hooksFixture(t, 'codex', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'codex'], options(fixture));
  const value = await readJson(fixture.configPath);
  assert.equal(JSON.stringify(value).includes('timeoutSec'), false);
  assert.equal(handlers(value).at(-1).timeout, 5);
  assert.deepEqual(Object.keys(handlers(value).at(-1)),
    ['type', 'command', 'timeout', 'async', 'statusMessage']);
});

// C2: POSIX以外はHOST_PLATFORM_UNSUPPORTED、canonical解決不能はINSTALL_SOURCE_UNRESOLVEDで拒否する。
test('P3 C2 negative: 非POSIXは HOST_PLATFORM_UNSUPPORTED、canonical解決不能は INSTALL_SOURCE_UNRESOLVED を返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  const windows = await directCli(['install', '--host', 'claude'], fixture, { platform: 'win32' });
  assert.equal(windows.status, 1);
  assert.equal(JSON.parse(windows.stdout).code, 'HOST_PLATFORM_UNSUPPORTED');
  const windowsEmit = await directCli(['emit', '--host', 'claude'], fixture, { platform: 'win32' });
  assert.equal(windowsEmit.status, 1);
  assert.equal(JSON.parse(windowsEmit.stdout).code, 'HOST_PLATFORM_UNSUPPORTED');
  const unresolved = await directCli(['install', '--host', 'claude'], fixture, {
    source: { execPath: 'node', binPath: '/missing/lattice.mjs' },
  });
  assert.equal(unresolved.status, 1);
  assert.equal(JSON.parse(unresolved.stdout).code, 'INSTALL_SOURCE_UNRESOLVED');
  assert.equal(await readFile(fixture.configPath, 'utf8'), '{}');
});

test('P4 F2: apostrophe入りcanonical commandは実shでargv往復し、install/status/uninstallが冪等である', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  const sourceDirectory = path.join(fixture.root, "source with ' apostrophe");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  const execPath = path.join(sourceDirectory, "node'copy");
  const scriptPath = path.join(sourceDirectory, "lattice'script.mjs");
  await Promise.all([
    writeFile(execPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
    writeFile(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 }),
  ]);
  await Promise.all([chmod(execPath, 0o700), chmod(scriptPath, 0o700)]);
  const source = { execPath, binPath: scriptPath };
  const installed = await directCli(['install', '--host', 'claude'], fixture, { source });
  assert.equal(installed.status, 0, installed.stdout);
  const command = handlers(await readJson(fixture.configPath)).at(-1).command;
  assert.deepEqual(commandArgv(command), [execPath, await realpath(scriptPath),
    'hooks', 'emit', '--host', 'claude']);
  const statusResult = await directCli(['status', '--host', 'claude'], fixture, { source });
  assert.equal(statusResult.status, 0);
  assert.equal(JSON.parse(statusResult.stdout).state, 'wired');
  const second = await directCli(['install', '--host', 'claude'], fixture, { source });
  assert.equal(JSON.parse(second.stdout).state, 'already_wired');
  const removed = await directCli(['uninstall', '--host', 'claude'], fixture, { source });
  assert.equal(JSON.parse(removed.stdout).removed_count, 1);

  for (const unsafe of [`${execPath}\nother`, `${execPath}\0other`]) {
    const rejected = await directCli(['install', '--host', 'claude'], fixture, {
      source: { execPath: unsafe, binPath: scriptPath },
    });
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).code, 'INSTALL_SOURCE_UNRESOLVED');
  }
});

test('P4 F3: dquote内backslashはPOSIX規則でtokenizeし、receipt不一致entryを誤削除しない', async (t) => {
  const trickyArg = '/tmp/a\\q$`"\\z';
  const trickyCommand = '"/tmp/a\\q\\$\\`\\"\\\\z" "/old/lattice.mjs" hooks emit --host claude';
  const oldTail = ['/old/lattice.mjs', 'hooks', 'emit', '--host', 'claude'];
  assert.deepEqual(commandArgv(trickyCommand), [trickyArg, ...oldTail]);
  const fixture = await hooksFixture(t, 'claude', { config: JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: trickyCommand, timeout: 5 },
    ] }] },
  }) });
  const target = receiptPath(fixture, 'claude');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const receipt = (argv) => JSON.stringify({
    schema: 'lattice.hooks_install_receipt.v1',
    entries: [{ argv, status: 'committed', operation_id: 'old' }],
  });
  await writeFile(target, receipt(['/tmp/aq$`"\\z', ...oldTail]), { mode: 0o600 });
  const before = await readFile(fixture.configPath);
  const preserved = runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture));
  assert.equal(JSON.parse(preserved.stdout).removed_count, 0);
  assert.deepEqual(await readFile(fixture.configPath), before);

  await writeFile(target, receipt([trickyArg, ...oldTail]), { mode: 0o600 });
  const removed = runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture));
  assert.equal(JSON.parse(removed.stdout).removed_count, 1);
  assert.deepEqual(handlers(await readJson(fixture.configPath)), []);
});

test('P4 F6: pending receipt回復はlock取得後にconfigを再読してcommitted化する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  const old = ['/old/node', '/old/lattice.mjs', 'hooks', 'emit', '--host', 'claude'];
  const oldCommand = "'/old/node' '/old/lattice.mjs' hooks emit --host claude";
  const target = receiptPath(fixture, 'claude');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify({
    schema: 'lattice.hooks_install_receipt.v1',
    entries: [{ argv: old, status: 'pending', operation_id: 'locked-recovery' }],
  }), { mode: 0o600 });
  let lockObserved = 0;
  const result = await directCli(['status', '--host', 'claude'], fixture, {
    testHooks: {
      afterReceiptLock: async ({ configTarget }) => {
        lockObserved += 1;
        await writeFile(configTarget, JSON.stringify({
          hooks: { UserPromptSubmit: [{ hooks: [
            { type: 'command', command: oldCommand, timeout: 5 },
          ] }] },
        }));
      },
    },
  });
  assert.equal(result.status, 0);
  assert.equal(lockObserved, 1);
  const recovered = await readJson(target);
  assert.equal(recovered.entries[0].status, 'committed');
  assert.equal(JSON.parse(result.stdout).matched_handler_count, 1);
});

// C3-1: host home dir不在はHOST_NOT_PRESENT exit 1で、dirを作らない。
// 試験を起こした端末が`CODEX_HOME`等を持っていても、CLIへ渡すのは試験のHOMEだけである。
// 2026-10-03: `CODEX_HOME`を持つ端末でこの試験を走らせ、共有の本物のCodex hooks.jsonを書き換えた。
test('試験のCLIは、端末のCODEX_HOME・CLAUDE_CONFIG_DIR・GROK_HOMEが指す本物の設定へ触れない', async (t) => {
  const decoy = await mkdtemp(path.join(tmpdir(), 'lattice-hooks-decoy-'));
  t.after(() => rm(decoy, { recursive: true, force: true }));
  const saved = Object.fromEntries(HOST_CONFIG_ENV.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  // 本物の代わりのフォルダを指させる。中へ設定を置き、試験の後も1 byteも変わっていないことを見る。
  const decoyHooks = path.join(decoy, 'hooks.json');
  const decoySettings = path.join(decoy, 'settings.json');
  await writeFile(decoyHooks, FOREIGN_CODEX_HOOKS, { mode: 0o600 });
  await writeFile(decoySettings, '{}\n', { mode: 0o600 });
  for (const name of HOST_CONFIG_ENV) process.env[name] = decoy;
  const before = [await snapshotFile(decoyHooks), await snapshotFile(decoySettings)];

  for (const host of ['codex', 'claude']) {
    const fixture = await hooksFixture(t, host, { config: host === 'codex' ? FOREIGN_CODEX_HOOKS : '{}\n' });
    assert.equal(runCli(['hooks', 'install', '--host', host], options(fixture)).status, 0, host);
    assert.equal(handlers(await readJson(fixture.configPath))
      .filter((item) => commandArgv(item.command).includes('hooks')).length, 1, host);
    assert.equal(runCli(['hooks', 'uninstall', '--host', host], options(fixture)).status, 0, host);
  }

  assert.deepEqual([await snapshotFile(decoyHooks), await snapshotFile(decoySettings)], before);
  assert.deepEqual((await readdir(decoy)).sort(), ['hooks.json', 'settings.json']);
});

test('P3 C3-1: host home dir不在は HOST_NOT_PRESENT exit 1、設定dirを作らずに終了する', async (t) => {
  for (const host of ['claude', 'codex', 'cursor']) {
    const fixture = await hooksFixture(t, host, { createHost: false });
    const result = runCli(['hooks', 'install', '--host', host], options(fixture));
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'HOST_NOT_PRESENT');
    await assert.rejects(lstat(path.dirname(fixture.configPath)), { code: 'ENOENT' });
  }
});

// C3-2: 設定file symlinkはCONFIG_SYMLINK_UNSUPPORTED exit 1で、一切書かない。
test('P3 C3-2: Claude/Codex設定symlinkは CONFIG_SYMLINK_UNSUPPORTED exit 1、一切書かない', async (t) => {
  for (const host of ['claude', 'codex', 'cursor']) {
    const fixture = await hooksFixture(t, host);
    const outside = path.join(fixture.root, `${host}-outside`);
    await writeFile(outside, 'outside-bytes');
    await symlink(outside, fixture.configPath);
    const result = runCli(['hooks', 'install', '--host', host], options(fixture));
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).code, 'CONFIG_SYMLINK_UNSUPPORTED');
    assert.equal(await readFile(outside, 'utf8'), 'outside-bytes');
  }
});

// C3-3: 不正JSONはCONFIG_UNREADABLE exit 1で、一切書かない。
test('P3 C3-3: 不正JSON設定は CONFIG_UNREADABLE exit 1、一切書かない', async (t) => {
  const bytes = Buffer.from('{"broken":');
  const fixture = await hooksFixture(t, 'claude', { config: bytes });
  const before = await stat(fixture.configPath);
  const result = runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'CONFIG_UNREADABLE');
  assert.deepEqual(await readFile(fixture.configPath), bytes);
  assert.equal((await stat(fixture.configPath)).mtimeMs, before.mtimeMs);
});

// C3-4: prestateはexisted/mode/bytesを記録し、不在fileはexisted:falseの空object開始である。
test('P3 C3-4: prestateは existed/mode/bytes を記録し不在設定は existed:false と空objectから開始する', async (t) => {
  const fixture = await hooksFixture(t, 'claude');
  const result = runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(Object.keys(await readJson(fixture.configPath)), ['hooks']);
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.dirname(fixture.configPath)))
    .filter((name) => name.includes('bak-lattice-hooks')), []);
});

// C3-5: backupはO_EXCL 0600・fsync規律・成功物直近5世代保持で、失敗時当回分を回収する。
test('P3 C3-5: backupは O_EXCL/0600/fsync/親dir fsync、成功物5世代保持、commit前失敗物回収を満たす', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  for (let index = 0; index < 7; index += 1) {
    const command = index % 2 === 0 ? 'install' : 'uninstall';
    const result = runCli(['hooks', command, '--host', 'claude'], options(fixture));
    assert.equal(result.status, 0, result.stdout);
  }
  const names = await readdir(path.dirname(fixture.configPath));
  const backups = names.filter((name) => name.includes('.bak-lattice-hooks-'));
  const displaced = names.filter((name) => name.includes('.pre-lattice-hooks-'));
  assert.equal(backups.length, 5);
  assert.equal(displaced.length, 5);
  for (const name of [...backups, ...displaced]) {
    const info = await lstat(path.join(path.dirname(fixture.configPath), name));
    assert.equal(info.isFile(), true);
    assert.equal(info.mode & 0o777, 0o600);
    JSON.parse(await readFile(path.join(path.dirname(fixture.configPath), name), 'utf8'));
  }

  const before = await readFile(fixture.configPath);
  await chmod(path.dirname(fixture.configPath), 0o500);
  t.after(() => chmod(path.dirname(fixture.configPath), 0o700).catch(() => {}));
  const failed = runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture));
  await chmod(path.dirname(fixture.configPath), 0o700);
  assert.equal(failed.status, 1);
  assert.deepEqual(await readFile(fixture.configPath), before);
  assert.equal((await readdir(path.dirname(fixture.configPath)))
    .some((name) => name.includes('.tmp-lattice-hooks-')), false);
});

// C3-6: mergeはself identityのみを対象とし、foreign entry/key/順序を保持して末尾追加する。
test('P3 C3-6: foreign Claude/Codex hook同居fixtureでは他entry/key/順序を不変にしselfだけ末尾追加する', async (t) => {
  for (const [host, text] of [['claude', FOREIGN_CLAUDE_HOOKS], ['codex', FOREIGN_CODEX_HOOKS]]) {
    const fixture = await hooksFixture(t, host, { config: text });
    runCli(['hooks', 'install', '--host', host], options(fixture));
    const value = await readJson(fixture.configPath);
    assert.deepEqual(Object.keys(value), ['alpha', 'hooks', 'omega']);
    assert.equal(value.hooks.metadata, 'keep');
    assert.equal(value.hooks.UserPromptSubmit[0].matcher, 'all');
    assert.equal(value.hooks.UserPromptSubmit[0].hooks[0].command, 'other-product --observe');
    assert.deepEqual(commandArgv(value.hooks.UserPromptSubmit.at(-1).hooks[0].command),
      await canonical(host));
  }
});

test('P3 C3-6: foreign Cursor hook同居fixtureでは工場sessionStartと他keyを不変にしselfだけ末尾追加する', async (t) => {
  const fixture = await hooksFixture(t, 'cursor', { config: FOREIGN_CURSOR_HOOKS });
  runCli(['hooks', 'install', '--host', 'cursor'], options(fixture));
  const value = await readJson(fixture.configPath);
  assert.deepEqual(Object.keys(value), ['version', 'alpha', 'hooks', 'omega']);
  assert.deepEqual(value.hooks.sessionStart, [
    { command: '/factory/cursor-constitution-hook', timeout: 10 },
  ]);
  assert.equal(value.hooks.beforeSubmitPrompt[0].command, 'other-product --observe');
  assert.deepEqual(commandArgv(value.hooks.beforeSubmitPrompt.at(-1).command), await canonical('cursor'));
});

// C3-7: existed:falseはlink(tmp,target) no-clobberでcommitし、EEXISTは再読込re-mergeする。
test('P3 C3-7: 不在設定は link(tmp,target) no-clobber commitで作成しEEXISTを再読込re-mergeする', async (t) => {
  const fixture = await hooksFixture(t, 'claude');
  const [left, right] = await Promise.all([
    runCliAsync(['hooks', 'install', '--host', 'claude'], options(fixture)),
    runCliAsync(['hooks', 'install', '--host', 'claude'], options(fixture)),
  ]);
  assert.deepEqual([left.status, right.status], [0, 0], `${left.stdout}\n${right.stdout}`);
  const self = handlers(await readJson(fixture.configPath))
    .filter((item) => commandArgv(item.command).includes('hooks'));
  assert.equal(self.length, 1);
  assert.deepEqual(commandArgv(self[0].command), await canonical('claude'));
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600);
});

// C3-8: canonical既設なら無変更・backup無しでalready_wiredを返す。
test('P3 C3-8: canonical既設installは無変更・backup無し・already_wiredで冪等に成功する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  const beforeBytes = await readFile(fixture.configPath);
  const before = await stat(fixture.configPath);
  const beforeNames = await readdir(path.dirname(fixture.configPath));
  const second = runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  assert.equal(JSON.parse(second.stdout).state, 'already_wired');
  assert.deepEqual(await readFile(fixture.configPath), beforeBytes);
  assert.equal((await stat(fixture.configPath)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(path.dirname(fixture.configPath)), beforeNames);
});

// C3: 他人だけのhookが混ざるfixtureにinstall失敗を起こしても他人の設定を一切触れない。
test('P3 C3 negative: foreign-only hook同居fixtureの全失敗経路で他人の設定bytesを一切変更しない', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  const before = await readFile(fixture.configPath);
  const installs = path.dirname(receiptPath(fixture, 'claude'));
  await mkdir(installs, { recursive: true, mode: 0o700 });
  const outside = path.join(fixture.root, 'foreign-owner');
  await writeFile(outside, 'owner-bytes', { mode: 0o600 });
  await symlink(outside, receiptPath(fixture, 'claude'));
  const result = runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'INSTALL_RECEIPT_UNSAFE');
  assert.deepEqual(await readFile(fixture.configPath), before);
  assert.equal(await readFile(outside, 'utf8'), 'owner-bytes');
});

test('P4 F4-1: preimage不一致はabort後に1回だけ再読・re-mergeする', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  let checks = 0;
  const result = await directCli(['install', '--host', 'claude'], fixture, {
    testHooks: {
      beforePreimageVerify: async ({ target }) => {
        checks += 1;
        if (checks !== 1) return;
        const value = await readJson(target);
        value.concurrent_preimage = 'preserved';
        await writeFile(target, `${JSON.stringify(value)}\n`);
      },
    },
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(checks, 2);
  const value = await readJson(fixture.configPath);
  assert.equal(value.concurrent_preimage, 'preserved');
  assert.equal(handlers(value).filter((item) => commandArgv(item.command).includes('hooks')).length, 1);
});

test('P4 F4-2: displaced link後のtarget inode交換はdev/ino再検証でabortして再mergeする', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  let linkChecks = 0;
  const result = await directCli(['install', '--host', 'claude'], fixture, {
    testHooks: {
      afterDisplacedLink: async ({ target }) => {
        linkChecks += 1;
        if (linkChecks !== 1) return;
        const value = await readJson(target);
        value.concurrent_inode = 'preserved';
        const replacement = `${target}.host-replacement`;
        await writeFile(replacement, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(replacement, target);
      },
    },
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(linkChecks, 2);
  assert.equal((await readJson(fixture.configPath)).concurrent_inode, 'preserved');
});

test('P4 F4-3: rename後read-back不一致はdisplaced preimageから元bytesへ復元する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  const before = await readFile(fixture.configPath);
  let injected = false;
  const result = await directCli(['install', '--host', 'claude'], fixture, {
    testHooks: {
      beforeConfigReadBack: async ({ target }) => {
        if (injected) return;
        injected = true;
        await writeFile(target, '{"read_back":"corrupted"}\n');
      },
    },
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).code, 'CONFIG_WRITE_FAILED');
  assert.deepEqual(await readFile(fixture.configPath), before);
  const names = await readdir(path.dirname(fixture.configPath));
  assert.equal(names.filter((name) => name.includes('.bak-lattice-hooks-')).length, 1);
  assert.equal(names.filter((name) => name.includes('.pre-lattice-hooks-')).length, 1);
});

test('P4 F1/F4-4: RESTORE_FAILEDはbackup/displacedを保持しtyped detailへ両pathを返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  const before = await readFile(fixture.configPath);
  const result = await directCli(['install', '--host', 'claude'], fixture, {
    testHooks: {
      beforeConfigReadBack: async ({ target }) => {
        await writeFile(target, '{"read_back":"corrupted"}\n');
      },
      beforeRestore: async () => { throw new Error('injected restore failure'); },
    },
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stdout);
  assert.equal(error.code, 'RESTORE_FAILED');
  assert.deepEqual(Object.keys(error.detail), ['backup_path', 'displaced_path']);
  for (const artifact of [error.detail.backup_path, error.detail.displaced_path]) {
    assert.equal(path.isAbsolute(artifact), true);
    assert.deepEqual(await readFile(artifact), before);
  }
  assert.notDeepEqual(await readFile(fixture.configPath), before);
});

test('P4 F5: generation prune失敗はcommit済みinstallを成功のwarningとして返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  const result = await directCli(['install', '--host', 'claude'], fixture, {
    testHooks: {
      beforePrune: async () => { throw new Error('injected prune failure'); },
    },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema: 'lattice.hooks_install_result.v1', host: 'claude', state: 'wired',
    warning: { code: 'GENERATION_PRUNE_FAILED', message: 'injected prune failure' },
  });
  const statusResult = await directCli(['status', '--host', 'claude'], fixture);
  assert.equal(JSON.parse(statusResult.stdout).state, 'wired');
});

// C4: canonical self handler 1件かつ実行可能なnode/scriptだけがwiredである。
test('P3 C4: canonical self handlerが1件でnode/script実行可能なら status は wired を返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  const result = JSON.parse(runCli(['hooks', 'status', '--host', 'claude'], options(fixture)).stdout);
  assert.equal(result.state, 'wired');
  assert.equal(result.matched_handler_count, 1);
  assert.equal(result.foreign_candidate_count, 0);
  assert.equal(result.executable_ok, true);
  assert.equal(result.next_action, null);
});

// C4: status成功はlattice.hooks_status_result.v1のexact schema/keyを返す。
test('P3 C4: status成功は lattice.hooks_status_result.v1 のexact key/schemaを返す', async (t) => {
  const fixture = await hooksFixture(t, 'codex', { config: '{}' });
  const result = runCli(['hooks', 'status', '--host', 'codex'], options(fixture));
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, 'lattice.hooks_status_result.v1');
  assert.deepEqual(Object.keys(value), [
    'schema', 'host', 'config_path', 'state', 'canonical_command', 'matched_handler_count',
    'foreign_candidate_count', 'executable_ok', 'next_action',
  ]);
});

// C4: self handlerが複数、非canonical、foreign_candidate、旧path残存はmatched>0のdriftである。
test('P3 C4: canonical1件に旧path receipt handlerが残る場合を含め matched>0 は drift を返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  const old = ['/old/node', '/old/lattice.mjs', 'hooks', 'emit', '--host', 'claude'];
  const oldCommand = "'/old/node' '/old/lattice.mjs' 'hooks' 'emit' '--host' 'claude'";
  const receipt = await readJson(receiptPath(fixture, 'claude'));
  receipt.entries.push({ argv: old, status: 'committed', operation_id: 'old' });
  await writeFile(receiptPath(fixture, 'claude'), `${JSON.stringify(receipt)}\n`);
  const config = await readJson(fixture.configPath);
  config.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: oldCommand, timeout: 5 }] });
  await writeFile(fixture.configPath, `${JSON.stringify(config)}\n`);
  const value = JSON.parse(runCli(['hooks', 'status', '--host', 'claude'], options(fixture)).stdout);
  assert.equal(value.state, 'drift');
  assert.equal(value.matched_handler_count, 2);
});

// C4: self identityが0件ならnot_wiredである。
test('P3 C4: self identityが0件なら status は not_wired を返す', async (t) => {
  const fixture = await hooksFixture(t, 'codex', { config: FOREIGN_CODEX_HOOKS });
  const value = JSON.parse(runCli(['hooks', 'status', '--host', 'codex'], options(fixture)).stdout);
  assert.equal(value.state, 'not_wired');
  assert.equal(value.matched_handler_count, 0);
  assert.equal(value.foreign_candidate_count, 0);
});

// C4: dir/file不能、symlink、不正JSONはunreadable、非POSIXはtyped unsupportedである。
test('P3 C4: config不能/symlink/不正JSONはstatus unreadable、platform非対応はtyped errorを返す', async (t) => {
  const absentHost = await hooksFixture(t, 'claude', { createHost: false });
  const absent = runCli(['hooks', 'status', '--host', 'claude'], options(absentHost));
  assert.equal(absent.status, 1);
  assert.equal(JSON.parse(absent.stdout).state, 'unreadable');
  const invalid = await hooksFixture(t, 'claude', { config: '{bad' });
  const malformed = runCli(['hooks', 'status', '--host', 'claude'], options(invalid));
  assert.equal(malformed.status, 1);
  assert.equal(JSON.parse(malformed.stdout).state, 'unreadable');
  const linked = await hooksFixture(t, 'claude');
  const outside = path.join(linked.root, 'outside');
  await writeFile(outside, '{}');
  await symlink(outside, linked.configPath);
  const symlinked = runCli(['hooks', 'status', '--host', 'claude'], options(linked));
  assert.equal(symlinked.status, 1);
  assert.equal(JSON.parse(symlinked.stdout).state, 'unreadable');
  const windows = await directCli(['status', '--host', 'claude'], invalid, { platform: 'win32' });
  assert.equal(windows.status, 1);
  assert.equal(JSON.parse(windows.stdout).code, 'HOST_PLATFORM_UNSUPPORTED');
});

// C5: uninstallはreceipt照合したself identityだけをinner handler単位で除去する。
test('P3 C5: uninstall は receipt照合済みself handlerだけを除去しforeign handlerとmetadataを保持する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { config: FOREIGN_CLAUDE_HOOKS });
  runCli(['hooks', 'install', '--host', 'claude'], options(fixture));
  const result = runCli(['hooks', 'uninstall', '--host', 'claude'], options(fixture));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).removed_count, 1);
  assert.deepEqual(await readJson(fixture.configPath), JSON.parse(FOREIGN_CLAUDE_HOOKS));
});

// C5: file不在・handler不在はremoved_count:0のtyped成功である。
test('P3 C5: config不在またはself handler不在のuninstallは removed_count: 0 のtyped成功を返す', async (t) => {
  const absent = await hooksFixture(t, 'claude');
  const absentResult = runCli(['hooks', 'uninstall', '--host', 'claude'], options(absent));
  assert.deepEqual(JSON.parse(absentResult.stdout), {
    schema: 'lattice.hooks_uninstall_result.v1', host: 'claude', removed_count: 0,
  });
  await assert.rejects(lstat(absent.configPath), { code: 'ENOENT' });
  const foreign = await hooksFixture(t, 'codex', { config: FOREIGN_CODEX_HOOKS });
  const before = await readFile(foreign.configPath);
  const foreignResult = runCli(['hooks', 'uninstall', '--host', 'codex'], options(foreign));
  assert.equal(JSON.parse(foreignResult.stdout).removed_count, 0);
  assert.deepEqual(await readFile(foreign.configPath), before);
});

// C5: uninstallもC3-1--3,5,7のsymlink/JSON/backup/no-clobber安全則を同じく守る。
test('P3 C5: uninstallもC3のhost不在・symlink・不正JSON・backup・no-clobber安全則を守る', async (t) => {
  const fixture = await hooksFixture(t, 'codex', { config: '{}' });
  runCli(['hooks', 'install', '--host', 'codex'], options(fixture));
  const before = await readFile(fixture.configPath);
  const result = runCli(['hooks', 'uninstall', '--host', 'codex'], options(fixture));
  assert.equal(result.status, 0);
  const backups = (await readdir(path.dirname(fixture.configPath)))
    .filter((name) => name.includes('.bak-lattice-hooks-'));
  assert.equal(backups.length >= 2, true);
  const backupBytes = await Promise.all(backups.map((name) => readFile(
    path.join(path.dirname(fixture.configPath), name),
  )));
  assert.equal(backupBytes.some((bytes) => bytes.equals(before)), true);
  const invalid = await hooksFixture(t, 'claude', { config: 'not-json' });
  const invalidBytes = await readFile(invalid.configPath);
  assert.equal(runCli(['hooks', 'uninstall', '--host', 'claude'], options(invalid)).status, 1);
  assert.deepEqual(await readFile(invalid.configPath), invalidBytes);
});

// C6-1: LATTICE_HOOKS=offはstateを作らず沈黙exit 0である。
test('P3 C6-1: LATTICE_HOOKS=off はstate未作成の沈黙 exit 0 を返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { git: true });
  await rm(fixture.stateHome, { recursive: true });
  const result = runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, {
    input: '{invalid', extraEnv: { LATTICE_HOOKS: 'off' },
  }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  await assert.rejects(lstat(fixture.stateHome), { code: 'ENOENT' });
});

// C6-2: state root解決/作成不能はstdoutの1行可視診断でexit 0、symlink等を拒否する。
test('P3 C6-2: state rootのsymlink/owner/mode/作成異常は1行可視診断 exit 0で沈黙にしない', async (t) => {
  const fresh = await hooksFixture(t, 'claude');
  await rm(fresh.stateHome, { recursive: true });
  const created = runCli(['hooks', 'emit', '--host', 'claude'], options(fresh, {
    stateHome: 'relative-xdg-is-ignored', input: '{}',
  }));
  assert.equal(created.status, 0);
  assert.equal(created.stdout, '');
  assert.equal((await lstat(path.join(fresh.home, '.local', 'state', 'lattice', 'hooks'))).isDirectory(), true);

  const unsafe = await hooksFixture(t, 'claude');
  await chmod(unsafe.stateHome, 0o777);
  const modeFailure = runCli(['hooks', 'emit', '--host', 'claude'], options(unsafe, { input: '{}' }));
  assert.equal(modeFailure.status, 0);
  assert.equal(modeFailure.stdout, 'Lattice hooks: state directory unavailable\n');

  const linked = await hooksFixture(t, 'claude');
  await rm(linked.stateHome, { recursive: true });
  const outside = path.join(linked.root, 'outside-state');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, linked.stateHome);
  const symlinkFailure = runCli(['hooks', 'emit', '--host', 'claude'], options(linked, { input: '{}' }));
  assert.equal(symlinkFailure.stdout, 'Lattice hooks: state directory unavailable\n');

  const nested = await hooksFixture(t, 'claude');
  const nestedOutside = path.join(nested.root, 'nested-outside');
  await mkdir(path.join(nestedOutside, 'hooks'), { recursive: true, mode: 0o700 });
  await symlink(nestedOutside, path.join(nested.stateHome, 'lattice'));
  const nestedFailure = runCli(['hooks', 'emit', '--host', 'claude'], options(nested, { input: '{}' }));
  assert.equal(nestedFailure.stdout, 'Lattice hooks: state directory unavailable\n');
});

// C6-3: 不正stdinはerrors.logへ記録して沈黙し、log失敗は可視診断へfallbackする。
test('P3 C6-3: 64KiB超・不正JSON・session_id/cwd欠落stdinはerrors.log後沈黙、log失敗は可視化する', async (t) => {
  const fixture = await hooksFixture(t, 'claude');
  for (const input of ['x'.repeat(64 * 1024 + 1), '{bad', JSON.stringify({ session_id: 's' })]) {
    const result = runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input }));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  }
  const log = path.join(fixture.stateHome, 'lattice', 'hooks', 'errors.log');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 3);
  await unlink(log);
  const outside = path.join(fixture.root, 'outside-log');
  await writeFile(outside, 'unchanged', { mode: 0o600 });
  await symlink(outside, log);
  const fallback = runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: '{bad' }));
  assert.equal(fallback.stdout, 'Lattice hooks: cannot record invalid stdin\n');
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
});

// C6-4: 非gitのgit exit非0だけは沈黙し、spawn/timeout/I/O異常は記録と可視診断である。
test('P3 C6-4: 非gitは沈黙、git spawn失敗/timeout/I-O異常は記録と可視診断を返す', async (t) => {
  const nonGit = await hooksFixture(t, 'claude');
  const event = JSON.stringify({ session_id: 'non-git', cwd: nonGit.root });
  const silent = runCli(['hooks', 'emit', '--host', 'claude'], options(nonGit, { input: event }));
  assert.equal(silent.stdout, '');

  const spawnFailure = await hooksFixture(t, 'claude');
  const failed = runCli(['hooks', 'emit', '--host', 'claude'], options(spawnFailure, {
    input: JSON.stringify({ session_id: 'spawn-fail', cwd: spawnFailure.root }),
    extraEnv: { PATH: path.join(spawnFailure.root, 'no-such-path') },
  }));
  assert.equal(failed.stdout, 'Lattice hooks: git root lookup failed\n');
  assert.match(await readFile(path.join(spawnFailure.stateHome, 'lattice', 'hooks', 'errors.log'), 'utf8'),
    /spawn git ENOENT/u);

  const timed = await hooksFixture(t, 'claude');
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
    return child;
  };
  const timeout = await directCli(['emit', '--host', 'claude'], timed, {
    input: JSON.stringify({ session_id: 'timeout', cwd: timed.root }),
    spawnImpl: fakeSpawn,
    gitTimeoutMs: 10,
  });
  assert.equal(timeout.stdout, 'Lattice hooks: git root lookup failed\n');
});

// C6-5: sensor dirのENOENT/ENOTDIRだけは沈黙し、EACCES/EIOは記録と可視診断である。
test('P3 C6-5: sensor indexなしは沈黙、sensor判定EACCES/EIOは記録と可視診断を返す', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { git: true });
  const event = JSON.stringify({ session_id: 'sensor', cwd: fixture.root });
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: event })).stdout, '');
  const lattice = path.join(fixture.root, '.lattice');
  await mkdir(lattice, { mode: 0o700 });
  await chmod(lattice, 0o000);
  t.after(() => chmod(lattice, 0o700).catch(() => {}));
  const denied = runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: event }));
  await chmod(lattice, 0o700);
  assert.equal(denied.stdout, 'Lattice hooks: sensor index unavailable\n');
  assert.match(await readFile(path.join(fixture.stateHome, 'lattice', 'hooks', 'errors.log'), 'utf8'),
    /sensor lookup failed/u);
});

// C6-6: fresh .shownはclaimより先に沈黙し、claim EEXISTも沈黙する。stale自patternだけGCする。
test('P3 C6-6a: fresh .shown既存はclaim前に沈黙し、claim EEXISTも沈黙する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { git: true });
  await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
  const state = path.join(await realpath(fixture.stateHome), 'lattice', 'hooks');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const root = await realpath(fixture.root);
  const key = `${hash('shown-session')}.${hash(root)}`;
  await writeFile(path.join(state, `${key}.shown`), '', { mode: 0o600 });
  const event = JSON.stringify({ session_id: 'shown-session', cwd: fixture.root });
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: event })).stdout, '');
  await assert.rejects(lstat(path.join(state, `${key}.claim`)), { code: 'ENOENT' });
  await unlink(path.join(state, `${key}.shown`));
  await writeFile(path.join(state, `${key}.claim`), 'live', { mode: 0o600 });
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: event })).stdout, '');

  const staleKey = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
  const staleClaim = path.join(state, `${staleKey}.claim`);
  const staleShown = path.join(state, `${staleKey}.shown`);
  const foreign = path.join(state, 'foreign.claim');
  await Promise.all([writeFile(staleClaim, ''), writeFile(staleShown, ''), writeFile(foreign, '')]);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await Promise.all([utimes(staleClaim, old, old), utimes(staleShown, old, old), utimes(foreign, old, old)]);
  const staleEvent = JSON.stringify({ session_id: 'new-session', cwd: fixture.root });
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input: staleEvent })).stdout,
    `${INFO}\n`);
  await assert.rejects(lstat(staleClaim), { code: 'ENOENT' });
  await assert.rejects(lstat(staleShown), { code: 'ENOENT' });
  assert.equal((await lstat(foreign)).isFile(), true);
});

// C6-6: claim後も.shownを再確認し、初回表示後だけ.shown化して二度目を沈黙させる。
test('P3 C6-6b: claim後shown再確認、初回表示から.shown化、二度目沈黙の順序を守る', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { git: true });
  await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
  const input = JSON.stringify({ session_id: 'racing-session', cwd: fixture.root });
  const [left, right] = await Promise.all([
    runCliAsync(['hooks', 'emit', '--host', 'claude'], options(fixture, { input })),
    runCliAsync(['hooks', 'emit', '--host', 'claude'], options(fixture, { input })),
  ]);
  assert.equal([left.stdout, right.stdout].filter((value) => value === `${INFO}\n`).length, 1);
  assert.equal([left.stdout, right.stdout].filter((value) => value === '').length, 1);
  const state = path.join(fixture.stateHome, 'lattice', 'hooks');
  const root = await realpath(fixture.root);
  const key = `${hash('racing-session')}.${hash(root)}`;
  assert.equal((await lstat(path.join(state, `${key}.shown`))).isFile(), true);
  await assert.rejects(lstat(path.join(state, `${key}.claim`)), { code: 'ENOENT' });
  assert.equal(runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, { input })).stdout, '');

  const failedOutput = await hooksFixture(t, 'claude', { git: true });
  await mkdir(path.join(failedOutput.root, '.lattice', 'sensor'), { recursive: true });
  const failedRoot = await realpath(failedOutput.root);
  const failedKey = `${hash('output-failure')}.${hash(failedRoot)}`;
  const injected = await directCli(['emit', '--host', 'claude'], failedOutput, {
    input: JSON.stringify({ session_id: 'output-failure', cwd: failedOutput.root }),
    stdout: captureStdout({ fail: true }),
  });
  assert.equal(injected.status, 0);
  const failedState = path.join(failedOutput.stateHome, 'lattice', 'hooks');
  await assert.rejects(lstat(path.join(failedState, `${failedKey}.claim`)), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(failedState, `${failedKey}.shown`)), { code: 'ENOENT' });
});

test('P4 F4-5: output成功後のclaim rename失敗はshownを直接wx作成してclaimを回収する', async (t) => {
  const fixture = await hooksFixture(t, 'claude', { git: true });
  await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
  const root = await realpath(fixture.root);
  const key = `${hash('rename-fallback')}.${hash(root)}`;
  let checkpoint;
  const result = await directCli(['emit', '--host', 'claude'], fixture, {
    input: JSON.stringify({ session_id: 'rename-fallback', cwd: fixture.root }),
    testHooks: {
      beforeShownRename: async (paths) => {
        checkpoint = paths;
        throw new Error('injected claim rename failure');
      },
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${INFO}\n`);
  const state = path.join(await realpath(fixture.stateHome), 'lattice', 'hooks');
  assert.deepEqual(checkpoint, {
    claim: path.join(state, `${key}.claim`), shown: path.join(state, `${key}.shown`),
  });
  assert.equal((await lstat(checkpoint.shown)).isFile(), true);
  assert.equal((await stat(checkpoint.shown)).mode & 0o777, 0o600);
  await assert.rejects(lstat(checkpoint.claim), { code: 'ENOENT' });
  assert.match(await readFile(path.join(state, 'errors.log'), 'utf8'), /claim promotion failed/u);
  const second = runCli(['hooks', 'emit', '--host', 'claude'], options(fixture, {
    input: JSON.stringify({ session_id: 'rename-fallback', cwd: fixture.root }),
  }));
  assert.equal(second.stdout, '');
});

// C6: Claude出力は指定INFO文のplain 1行、CodexはASCII hookSpecificOutput envelopeである。
test('P3 C6 output: Claudeは指定INFO plain 1行、CodexはASCII hookSpecificOutput、Cursorはadditional_context envelopeを返す', async (t) => {
  for (const host of ['claude', 'codex', 'cursor']) {
    const fixture = await hooksFixture(t, host, { git: true });
    await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
    const result = runCli(['hooks', 'emit', '--host', host], options(fixture, {
      input: JSON.stringify({ session_id: `output-${host}`, cwd: fixture.root }),
    }));
    if (host === 'claude') assert.equal(result.stdout, `${INFO}\n`);
    else if (host === 'cursor') {
      assert.deepEqual(JSON.parse(result.stdout), { additional_context: INFO });
    } else {
      assert.equal(/^[\x00-\x7F]*$/u.test(result.stdout), false,
        'additionalContextの日本語だけがnon-ASCIIで、envelope keyはASCIIである');
      const value = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(value), ['hookSpecificOutput']);
      assert.deepEqual(value.hookSpecificOutput, {
        hookEventName: 'UserPromptSubmit', additionalContext: INFO,
      });
      assert.equal(/^[\x00-\x7F]+$/u.test('hookSpecificOutput hookEventName additionalContext'), true);
    }
  }
});

test('P3 C6 input: Cursor emitは conversation_id と workspace_roots[0] をsession/cwdとして受理する', async (t) => {
  const fixture = await hooksFixture(t, 'cursor', { git: true });
  await mkdir(path.join(fixture.root, '.lattice', 'sensor'), { recursive: true });
  const result = runCli(['hooks', 'emit', '--host', 'cursor'], options(fixture, {
    input: JSON.stringify({
      conversation_id: 'conv-cursor',
      workspace_roots: [fixture.root],
      prompt: 'hello',
    }),
  }));
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { additional_context: INFO });
});
