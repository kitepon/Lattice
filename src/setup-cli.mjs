import { access, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHooksCli, resolveStableNodePath } from './hooks-cli.mjs';
import { SETUP_HOSTS, hostPaths } from './setup-hosts.mjs';
import { mcpEntry, parseSetupConfig, readSetupFile, updateMcpConfig, writeSetupFile, setupError } from './setup-config.mjs';
import { probeSetupMcp } from './setup-mcp-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const usage = 'lattice setup [status] [--host claude|codex|grok|cursor|all] [--json]';
const typed = (error) => ({ state: 'failed', code: error.code ?? 'SETUP_FAILED', message: error.message });

async function hookResult(host, options, statusOnly) {
  if (host === 'grok') return { state: 'unsupported', code: 'HOST_FEATURE_UNSUPPORTED', message: 'Grokの製品hookは未対応です' };
  if (options.platform === 'win32') return { state: 'unsupported', code: 'HOST_PLATFORM_UNSUPPORTED', message: 'Windows nativeの製品hookは未対応です' };
  const invoke = async (command) => {
    let output = '';
    const exit = await runHooksCli({ argv: [command, '--host', host], env: options.env,
      platform: options.platform, source: options.hookSource, stdout: { write: (text) => { output += text; } } });
    return { exit, result: JSON.parse(output) };
  };
  if (!statusOnly) {
    const installed = await invoke('install');
    if (installed.exit !== 0) return { ...installed.result, state: 'failed' };
  }
  const status = await invoke('status');
  return { ...status.result, state: status.exit === 0 && status.result.state === 'wired' ? 'verified' : 'failed' };
}

async function configureHost(host, options, statusOnly) {
  const paths = hostPaths(host, options.env);
  const result = { host, mcp: null, hooks: null };
  try {
    const before = await readSetupFile(paths.mcp);
    const existing = mcpEntry(before.text, paths.format);
    const previousArgs = existing?.args ?? [];
    if (!Array.isArray(previousArgs) || previousArgs.some((arg) => typeof arg !== 'string')) {
      throw setupError('CONFIG_INVALID', 'MCP引数は文字列配列である必要があります');
    }
    // 配布入口を交換し、利用者が指定した --path 等の引数は保持する。
    const hasScript = /(?:^|[\\/])lattice-mcp\.mjs$/u.test(previousArgs[0] ?? '');
    const preservedArgs = hasScript ? previousArgs.slice(1) : previousArgs;
    const desired = { command: await resolveStableNodePath(options.execPath, { platform: options.platform }),
      args: [options.mcpBin, ...preservedArgs] };
    await access(options.mcpBin);
    let action = 'unchanged';
    if (!statusOnly) action = await writeSetupFile(paths.mcp, before, updateMcpConfig(before.text, paths.format, desired));
    const saved = (await readSetupFile(paths.mcp)).text;
    const entry = mcpEntry(saved, paths.format);
    if (!entry || entry.command !== desired.command || JSON.stringify(entry.args) !== JSON.stringify(desired.args)) {
      throw setupError('MCP_REGISTRATION_DRIFT', 'MCP登録が現在のLattice実行体と一致しません');
    }
    const disabledNames = host === 'grok' ? parseSetupConfig(saved, paths.format).value.disabled_mcp_servers : [];
    if (entry.enabled === false || entry.disabled === true || (Array.isArray(disabledNames) && disabledNames.includes('lattice'))) {
      result.mcp = { state: 'disabled', code: 'USER_DISABLED', config_path: paths.mcp, action };
    } else {
      result.mcp = { ...await options.probe(entry, { env: options.env }), config_path: paths.mcp, action };
    }
  } catch (error) { result.mcp = { ...typed(error), config_path: paths.mcp }; }
  try {
    if (!statusOnly && host !== 'grok' && options.platform !== 'win32') await mkdir(paths.directory, { recursive: true });
    result.hooks = await hookResult(host, options, statusOnly);
  } catch (error) { result.hooks = typed(error); }
  return result;
}

export async function runSetupCli({ argv, stdout, env = process.env, platform = process.platform,
  execPath = process.execPath, mcpBin = path.join(root, 'bin/lattice-mcp.mjs'),
  hookSource = { execPath, binPath: path.join(root, 'bin/lattice.mjs') }, probe = probeSetupMcp }) {
  let statusOnly = false;
  let selection;
  const args = [...argv];
  if (args[0] === 'status') { statusOnly = true; args.shift(); }
  if (args.at(-1) === '--json') args.pop();
  if (args.length === 2 && args[0] === '--host' && [...SETUP_HOSTS, 'all'].includes(args[1])) selection = args[1];
  else if (args.length !== 0) {
    stdout.write(`${JSON.stringify({ schema: 'lattice.setup_error.v1', code: 'USAGE', message: usage })}\n`);
    return 2;
  }
  let hosts = selection && selection !== 'all' ? [selection] : SETUP_HOSTS;
  if (!selection) {
    const detected = [];
    for (const host of hosts) {
      const paths = hostPaths(host, env);
      try { await access(paths.directory); detected.push(host); } catch (error) {
        if (error.code !== 'ENOENT') { detected.push(host); continue; }
        if (host === 'claude') {
          try { if ((await readSetupFile(paths.mcp)).exists) detected.push(host); }
          catch { detected.push(host); }
        }
      }
    }
    hosts = detected;
  }
  const options = { env, platform, execPath, mcpBin, hookSource, probe };
  const results = [];
  for (const host of hosts) {
    const paths = hostPaths(host, env);
    let lock;
    const lockPath = path.join(paths.directory, '.lattice-setup.lock');
    try {
      if (!statusOnly) {
        await mkdir(paths.directory, { recursive: true });
        if (!(await lstat(paths.directory)).isDirectory()) throw setupError('CONFIG_PATH_UNSUPPORTED', 'AI設定directoryが通常directoryではありません');
        try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
          if (error.code === 'EEXIST') throw setupError('SETUP_BUSY', '同じAI設定へのLattice setupが実行中です');
          throw error;
        }
      }
      results.push(await configureHost(host, options, statusOnly));
    } catch (error) { results.push({ host, mcp: typed(error), hooks: typed(error) }); }
    finally { if (lock) { await lock.close(); await unlink(lockPath); } }
  }
  const features = results.flatMap((host) => [host.mcp, host.hooks]);
  const state = !hosts.length || features.some((feature) => feature.state === 'failed') ? 'failed'
    : features.every((feature) => feature.state === 'verified') ? 'ready' : 'partial';
  stdout.write(`${JSON.stringify({ schema: 'lattice.setup_result.v1', operation: statusOnly ? 'status' : 'setup',
    platform, state, ...(hosts.length ? {} : { code: 'HOST_NOT_PRESENT' }), hosts: results })}\n`);
  return state === 'ready' ? 0 : 1;
}
