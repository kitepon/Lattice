import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';

// 削除済みcwdはPOSIXでだけ作れる（Windowsは使用中のディレクトリを消せない）。
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lattice.mjs');

async function makeCollectingEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lattice-cwd-gone-'));
  const configDir = path.join(root, 'xdg-config', 'dotagents');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(configDir, 'factory-reporter.json'), JSON.stringify({
    schema_version: '1.0',
    host: { id: 'test-host', profile: 'mac' },
    collection: { enabled: true },
    reporting: { enabled: false },
  }), { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
  };
  return { root, env, storePath: path.join(root, 'xdg-state', 'lattice', 'runtime-errors.json') };
}

// cwdを作ってから消し、そこでCLIを起動する（閉じたworktreeに残ったshellと同じ状態）。
function runInDeletedCwd(env, args) {
  return spawnSync('sh', ['-c', 'dir=$(mktemp -d) && cd "$dir" && rmdir "$dir" && exec "$@"', 'sh',
    process.execPath, cliPath, ...args], { encoding: 'utf8', env });
}

test('削除済みcwdからのcommandは内部故障にせずCWD_UNAVAILABLEのtyped errorで返し、観測しない', async () => {
  const { root, env, storePath } = await makeCollectingEnv();
  try {
    // run系（以前はLATTICE.CLI_INTERNAL_FAILEDとして観測された）、todo・status（以前は生のstackで落ちた）。
    for (const args of [['run', 'list', '--json'], ['todo', 'status', '--json'], ['status', '--json']]) {
      const result = runInDeletedCwd(env, args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      const lines = result.stderr.trim().split('\n');
      assert.equal(lines.length, 1, result.stderr);
      const error = JSON.parse(lines[0]);
      assert.equal(error.schema, 'lattice.cli_error.v2');
      assert.equal(error.code, 'CWD_UNAVAILABLE');
    }
    assert.equal(existsSync(storePath), false, '呼び出し環境の不備を内部故障として記録しない');

    // cwdを読まないsurfaceは、消えたcwdからでもそのまま動く。
    const snapshot = runInDeletedCwd(env, ['runtime-errors', 'diagnostics', '--json']);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.equal(JSON.parse(snapshot.stdout.trim()).schema, 'lattice.runtime_error_diagnostics.v1');
    const version = runInDeletedCwd(env, ['--version']);
    assert.equal(version.status, 0, version.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
