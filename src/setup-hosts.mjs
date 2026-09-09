import path from 'node:path';
import os from 'node:os';

export const SETUP_HOSTS = ['claude', 'codex', 'grok', 'cursor'];

export function hostPaths(host, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const directory = path.resolve((host === 'claude' ? env.CLAUDE_CONFIG_DIR : null)
    || (host === 'codex' ? env.CODEX_HOME : null)
    || (host === 'grok' ? env.GROK_HOME : null) || path.join(home, `.${host}`));
  return { directory, format: ['codex', 'grok'].includes(host) ? 'toml' : 'json',
    mcp: host === 'claude' ? path.join(env.CLAUDE_CONFIG_DIR ? directory : home, '.claude.json')
      : path.join(directory, ['codex', 'grok'].includes(host) ? 'config.toml' : 'mcp.json'),
    hooks: path.join(directory, host === 'claude' ? 'settings.json' : 'hooks.json') };
}
