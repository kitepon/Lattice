import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSetupCli } from '../src/setup-cli.mjs';
import { hostPaths } from '../src/setup-hosts.mjs';
import { updateMcpConfig, mcpEntry, parseSetupConfig } from '../src/setup-config.mjs';
import { renderCliHelp } from '../src/cli-help.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lattice-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env: { HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, 'state') } };
}

async function invoke(env, argv, options = {}) {
  let output = '';
  const exit = await runSetupCli({ argv, env, platform: process.platform,
    stdout: { write: (text) => { output += text; } },
    probe: async () => ({ state: 'verified', tool_count: 8 }), ...options });
  return { exit, value: JSON.parse(output) };
}

test('Grokの設定先指定と名前による無効化を尊重する', async (t) => {
  const { home, env } = await fixture(t);
  env.GROK_HOME = path.join(home, 'custom-grok');
  await mkdir(env.GROK_HOME);
  const target = path.join(env.GROK_HOME, 'config.toml');
  await writeFile(target, 'disabled_mcp_servers = ["lattice"]\n[mcp_servers.lattice]\ncommand = "lattice-mcp"\n');
  let calls = 0;
  for (const argv of [['--host', 'grok'], ['status', '--host', 'grok']]) {
    const result = await invoke(env, argv, { probe: async () => { calls += 1; return { state: 'verified' }; } });
    assert.equal(result.value.hosts[0].mcp.config_path, target);
    assert.equal(result.value.hosts[0].mcp.state, 'disabled');
    assert.equal(result.exit, 1);
  }
  assert.equal(calls, 0);
  assert.deepEqual(parseSetupConfig(await readFile(target, 'utf8'), 'toml').value.disabled_mcp_servers, ['lattice']);
});

test('setupとsetup statusのhelpが公開される', () => {
  assert.match(renderCliHelp(['setup', '--help']), /MCP接続確認/u);
  assert.match(renderCliHelp(['setup', 'status', '--help']), /setup status/u);
});

test('4 AIの初回・再実行・診断が設定と他登録を保持する', async (t) => {
  const { env } = await fixture(t);
  for (const host of ['claude', 'codex', 'grok', 'cursor']) {
    const paths = hostPaths(host, env);
    await mkdir(paths.directory, { recursive: true });
    const initial = paths.format === 'json' ? '{\n // 利用者の注記\n "mcpServers": {"other": {"command":"other"}}, "user": true\n}\n'
      : '# 利用者の注記\nuser = true\n[mcp_servers.other]\ncommand = "other"\n';
    await writeFile(paths.mcp, initial, { mode: 0o640 });
    const hook = host === 'cursor' ? { version: 1, hooks: { beforeSubmitPrompt: [{ command: 'factory lattice-gantt' }] } }
      : { hooks: { UserPromptSubmit: [{ matcher: 'user', hooks: [{ type: 'command', command: 'factory lattice-gantt' }] }] } };
    if (host !== 'grok') await writeFile(paths.hooks, JSON.stringify(hook));
    const first = await invoke(env, ['--host', host, '--json']);
    assert.equal(first.value.hosts[0].mcp.state, 'verified');
    const unsupported = host === 'grok' || process.platform === 'win32';
    assert.equal(first.value.hosts[0].hooks.state, unsupported ? 'unsupported' : 'verified');
    assert.equal(first.exit, unsupported ? 1 : 0);
    const written = await readFile(paths.mcp, 'utf8');
    assert.match(written, /利用者の注記/u);
    const parsed = parseSetupConfig(written, paths.format).value;
    assert.equal(parsed.user, true);
    assert.equal(parsed[paths.format === 'json' ? 'mcpServers' : 'mcp_servers'].other.command, 'other');
    if (process.platform !== 'win32') assert.equal((await stat(paths.mcp)).mode & 0o777, 0o640);
    if (host !== 'grok') assert.match(await readFile(paths.hooks, 'utf8'), /factory lattice-gantt/u);
    const second = await invoke(env, ['--host', host, '--json']);
    assert.equal(second.value.hosts[0].mcp.action, 'unchanged');
    assert.equal(await readFile(paths.mcp, 'utf8'), written);
    const diagnosis = await invoke(env, ['status', '--host', host, '--json']);
    assert.equal(diagnosis.value.hosts[0].mcp.state, 'verified');
  }
});

test('Windows未対応hookがMCPの登録・読戻しを妨げない', async (t) => {
  const { env } = await fixture(t);
  const result = await invoke(env, ['--host', 'all', '--json'], { platform: 'win32' });
  assert.equal(result.exit, 1);
  assert.equal(result.value.state, 'partial');
  for (const host of result.value.hosts) {
    assert.equal(host.mcp.state, 'verified');
    assert.equal(host.hooks.state, 'unsupported');
    assert.equal(host.hooks.code, host.host === 'grok' ? 'HOST_FEATURE_UNSUPPORTED' : 'HOST_PLATFORM_UNSUPPORTED');
  }
});

test('更新は起動値だけを置換し利用者設定を保持する', () => {
  const desired = { command: '/new/node', args: ['/new/lattice-mcp.mjs'] };
  for (const text of [
    '[mcp_servers."lattice"]\ncommand = "old" # 起動\nargs = [\n "old",\n]\nenabled = false\n[mcp_servers.lattice.env]\nUSER_VALUE="keep"\n',
    'mcp_servers = { lattice = { command="old", args=["old"], enabled=false, env={USER_VALUE="keep"} } }',
    'mcp_servers.lattice.command="old"\nmcp_servers.lattice.args=["old"]\nmcp_servers.lattice.enabled=false\nmcp_servers.lattice.env.USER_VALUE="keep"\n',
  ]) {
    const after = updateMcpConfig(text, 'toml', desired);
    assert.deepEqual(mcpEntry(after, 'toml'), { ...desired, enabled: false, env: { USER_VALUE: 'keep' } });
    assert.equal(updateMcpConfig(after, 'toml', desired), after);
  }
});

test('旧npm入口と更新前scriptのproject引数を保持し二重追加しない', async (t) => {
  const { env, home } = await fixture(t);
  const paths = hostPaths('cursor', env);
  await mkdir(paths.directory);
  for (const entry of [{ command: 'lattice-mcp', args: ['--path', home] },
    { command: 'node', args: ['/previous/bin/lattice-mcp.mjs', '--path', home] }]) {
    await writeFile(paths.mcp, JSON.stringify({ mcpServers: { lattice: entry } }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await invoke(env, ['--host', 'cursor']);
      assert.equal(result.value.hosts[0].mcp.state, 'verified');
      const after = mcpEntry(await readFile(paths.mcp, 'utf8'), 'json');
      assert.deepEqual(after.args.slice(1), ['--path', home]);
    }
  }
});

test('破損・重複設定は変更しない', () => {
  for (const [text, format] of [['{ nope', 'json'], ['{"mcpServers":{},"mcpServers":{}}', 'json'],
    ['[mcp_servers.lattice]\ncommand = "a"\ncommand = "b"', 'toml']]) {
    assert.throws(() => updateMcpConfig(text, format, { command: 'node', args: [] }), { code: 'CONFIG_INVALID' });
  }
});

test('Windows既存設定のUTF-8 BOMを保持する', () => {
  for (const [text, format] of [['\uFEFF{"user":true}', 'json'], ['\uFEFFuser=true\n', 'toml']]) {
    const updated = updateMcpConfig(text, format, { command: 'node', args: ['lattice-mcp.mjs'] });
    assert.equal(updated[0], '\uFEFF');
    assert.equal(parseSetupConfig(updated, format).value.user, true);
    assert.equal(mcpEntry(updated, format).command, 'node');
  }
});

test('利用者の無効化を保持しMCPを起動しない', async (t) => {
  const { env } = await fixture(t);
  const paths = hostPaths('codex', env);
  await mkdir(paths.directory);
  await writeFile(paths.mcp, '[mcp_servers.lattice]\ncommand="old"\nenabled=false\n');
  const result = await invoke(env, ['--host', 'codex'], { probe: async () => { assert.fail('無効化されたMCPを起動した'); } });
  assert.equal(result.value.hosts[0].mcp.state, 'disabled');
  assert.equal(result.value.state, 'partial');
});

test('設定競合と接続失敗は成功へ丸めない', async (t) => {
  const { env } = await fixture(t);
  const paths = hostPaths('claude', env);
  await mkdir(paths.directory);
  const original = '{"mcpServers":{"lattice":{"url":"https://example.test/mcp"}}}';
  await writeFile(paths.mcp, original);
  const conflict = await invoke(env, ['--host', 'claude']);
  assert.equal(conflict.value.hosts[0].mcp.code, 'MCP_REGISTRATION_CONFLICT');
  assert.equal(await readFile(paths.mcp, 'utf8'), original);
  const failed = await invoke(env, ['--host', 'cursor'], { probe: async () => { throw Object.assign(new Error('接続失敗'), { code: 'MCP_TIMEOUT' }); } });
  assert.equal(failed.exit, 1);
  assert.equal(failed.value.hosts[0].mcp.code, 'MCP_TIMEOUT');
});

test('明示hostで新規作成、host省略で既存だけを検出する', async (t) => {
  const { env } = await fixture(t);
  assert.equal((await invoke(env, ['--json'])).value.code, 'HOST_NOT_PRESENT');
  await invoke(env, ['--host', 'claude']);
  assert.deepEqual((await invoke(env, ['--json'])).value.hosts.map((host) => host.host), ['claude']);
  assert.equal((await invoke(env, ['--host', 'unknown'])).exit, 2);
  assert.equal((await invoke(env, ['--host', 'codex', '--host', 'claude'])).exit, 2);
});

test('CODEX_HOMEとClaude設定先をMCP・hookで共有する', { skip: process.platform === 'win32' }, async (t) => {
  const { env, home } = await fixture(t);
  env.CODEX_HOME = path.join(home, 'custom codex');
  env.CLAUDE_CONFIG_DIR = path.join(home, 'custom claude');
  for (const host of ['codex', 'claude']) {
    const result = await invoke(env, ['--host', host]);
    const paths = hostPaths(host, env);
    assert.equal(result.value.hosts[0].hooks.config_path, paths.hooks);
    assert.equal(result.value.hosts[0].mcp.config_path, paths.mcp);
    assert.equal(result.value.hosts[0].hooks.state, 'verified');
  }
});

test('同じAIへのsetup競合は共有設定を変更しない', async (t) => {
  const { env } = await fixture(t);
  const paths = hostPaths('claude', env);
  await mkdir(paths.directory);
  await writeFile(path.join(paths.directory, '.lattice-setup.lock'), '');
  const result = await invoke(env, ['--host', 'claude']);
  assert.equal(result.value.hosts[0].mcp.code, 'SETUP_BUSY');
});
