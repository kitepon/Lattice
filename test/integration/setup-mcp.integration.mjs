import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSetupCli } from '../../src/setup-cli.mjs';

test('setupが実配布MCPを起動し初回・再実行・診断で公開toolを読戻す', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'lattice-setup-live-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_STATE_HOME: path.join(home, 'state') };
  for (const argv of [['--host', 'claude', '--json'], ['--host', 'claude', '--json'], ['status', '--host', 'claude', '--json']]) {
    let output = '';
    const exit = await runSetupCli({ argv, env, stdout: { write: (text) => { output += text; } } });
    const result = JSON.parse(output);
    assert.equal(result.hosts[0].mcp.state, 'verified', output);
    assert.ok(result.hosts[0].mcp.tool_count > 0);
    assert.equal(exit, process.platform === 'win32' ? 1 : 0, output);
  }
});
