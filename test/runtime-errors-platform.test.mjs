import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// `runtime-errors.test.mjs`はWindowsで全件skipする。この試験はどのOSでも走り、そのOSで実際に
// CLIが返す答えを確かめる——Windowsは`unsupported`、ほかは設定に従う。
const execFileAsync = promisify(execFile);
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');
const windows = process.platform === 'win32';
const VALID_CONFIG = {
  schema_version: '1.0',
  host: { id: 'test-host', profile: windows ? 'windows-native' : 'linux' },
  collection: { enabled: true },
  reporting: { enabled: false },
};

async function runJson(args, env) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'runtime-errors', ...args, '--json'], { env });
  return JSON.parse(stdout.trim());
}

test('CLIは収集に対応しないOSでunsupported、対応するOSでは設定どおりに答える', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-rterr-platform-'));
  try {
    const env = { ...process.env, HOME: root, USERPROFILE: root,
      XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_STATE_HOME: path.join(root, 'xdg-state') };

    // 設定が無い時: 対応するOSは`disabled`、対応しないOSは`unsupported`。
    const inactive = windows ? 'unsupported' : 'disabled';
    const bare = await runJson(['snapshot'], env);
    assert.deepEqual(bare.diagnostics,
      { collection: inactive, status: 'not_applicable', total_count: 0, pending_count: 0, truncated: false });
    assert.equal((await runJson(['diagnostics'], env)).collection, inactive);

    // 設定が有効な時: 対応しないOSは、それでも`unsupported`のまま記録を作らない。
    await mkdir(path.join(root, 'xdg-config', 'dotagents'), { recursive: true });
    await writeFile(path.join(root, 'xdg-config', 'dotagents', 'factory-reporter.json'), JSON.stringify(VALID_CONFIG));
    const configured = await runJson(['snapshot'], env);
    assert.equal(configured.diagnostics.collection, windows ? 'unsupported' : 'enabled');
    assert.equal(configured.diagnostics.status, windows ? 'not_applicable' : 'ready');
    assert.deepEqual(configured.cursor, { high_watermark: 0, acknowledged_through: 0, next: 0 });
    assert.deepEqual(configured.runtime_errors, []);
    assert.deepEqual(configured.resolutions, []);
    assert.deepEqual(Object.keys(configured.diagnostics),
      ['collection', 'status', 'total_count', 'pending_count', 'truncated']);
    if (windows) assert.equal(existsSync(path.join(root, 'xdg-state', 'lattice')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
