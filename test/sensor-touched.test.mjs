import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseUnifiedZeroDiff, touchedFunctions } from '../src/sensor-touched.mjs';
import { runSensorCli } from '../src/sensor-cli.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const A1 = [
  "import fs from 'node:fs';", '', 'export function alpha() {', '  return 1;', '}', '',
  'export class Bar {', '  baz() {', '    return 2;', '  }', '  qux() {', '    return 3;', '  }', '}', '',
].join('\n');

async function history(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'lattice-touched-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  await writeFile(path.join(repo, 'a.mjs'), A1);
  await writeFile(path.join(repo, 'notes.txt'), 'one\n');
  await writeFile(path.join(repo, 'old.mjs'), 'export function gone() { return 1; }\n');
  await writeFile(path.join(repo, 'mv.mjs'), 'export function stay() { return 1; }\n');
  await writeFile(path.join(repo, 'mid.mjs'), 'export function f1() {\n  return 1;\n}\n\nexport function f2() {\n  return 2;\n}\n\nexport function f3() {\n  return 3;\n}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'c1');
  const c1 = git(repo, 'rev-parse', 'HEAD');

  const lines = A1.split('\n');
  lines[0] = "import fsp from 'node:fs/promises';"; // top-level, in no symbol
  lines.splice(2, 4); // alpha and its blank line: a whole function deleted
  const edited = lines.join('\n').replace('return 2;', 'return 22;') + 'export function gamma() {\n  return 5;\n}\n';
  await writeFile(path.join(repo, 'a.mjs'), edited);
  await writeFile(path.join(repo, 'notes.txt'), 'one\ntwo\n');
  await writeFile(path.join(repo, 'mid.mjs'), 'export function f1() {\n  return 1;\n}\n\nexport function f3() {\n  return 3;\n}\n'); // f2 deleted alone
  git(repo, 'rm', '--quiet', 'old.mjs');
  git(repo, 'mv', 'mv.mjs', 'moved.mjs');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'c2');
  const c2 = git(repo, 'rev-parse', 'HEAD');
  return { repo, c1, c2 };
}

const summarize = (result) => ({
  touched: result.touched.map((s) => `${s.path}#${s.symbol}:${s.start_line}-${s.end_line}`).sort(),
  unattributed: result.unattributed.map((u) => `${u.path}:${u.reason}`).sort(),
});
const EXPECTED = {
  touched: ['a.mjs#Bar.baz:4-6', 'a.mjs#gamma:11-13'],
  unattributed: ['a.mjs:outside_any_symbol', 'mid.mjs:deleted_outside_any_symbol', 'moved.mjs:renamed', 'notes.txt:file_not_indexed', 'old.mjs:file_deleted'],
};

test('a6: parseUnifiedZeroDiff reads paths, statuses and hunks, and ignores hunk content that looks like a header', () => {
  const files = parseUnifiedZeroDiff([
    'diff --git a/x.sql b/x.sql', 'index 1..2 100644', '--- a/x.sql', '+++ b/x.sql', '@@ -3,2 +3 @@', '--- removed sql comment', '-b', '+c',
    'diff --git a/new.js b/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/new.js', '@@ -0,0 +1,2 @@', '+a', '+b',
    'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    'diff --git a/a.js b/b.js', 'similarity index 100%', 'rename from a.js', 'rename to b.js', '',
  ].join('\n'));
  assert.deepEqual(files.map((f) => [f.path, f.status, f.hunks.length]),
    [['x.sql', 'modified', 1], ['new.js', 'added', 1], ['gone.js', 'deleted', 1], ['b.js', 'renamed', 0]]);
  assert.deepEqual(files[0].hunks[0], { old_start: 3, old_count: 2, new_start: 3, new_count: 1 });
  assert.equal(files[3].old_path, 'a.js');
});

test('a6: hunks map to the innermost symbols; what no symbol holds is returned, never dropped (maintained index)', async (t) => {
  const { repo, c1, c2 } = await history(t);
  const result = await touchedFunctions({ repoRoot: repo, from: c1, to: c2 });
  assert.equal(result.to_sha, c2);
  assert.deepEqual(summarize(result), EXPECTED);
  assert.deepEqual(result.unattributed.find((u) => u.reason === 'deleted_outside_any_symbol').old_range, [5, 8], 'the deleted lines are named');
});

test('a6: a range that does not end at HEAD, or a dirty tree, is answered from a disposable worktree of the range end', async (t) => {
  const { repo, c1, c2 } = await history(t);
  await writeFile(path.join(repo, 'a.mjs'), `${A1}// later\n`);
  git(repo, 'commit', '--quiet', '-am', 'c3');
  await writeFile(path.join(repo, 'a.mjs'), 'uncommitted\n');
  const result = await touchedFunctions({ repoRoot: repo, from: c1, to: c2 });
  assert.deepEqual(summarize(result), EXPECTED);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
});

test('a6: lattice sensor touched prints the typed result and refuses an unknown ref', async (t) => {
  const { repo, c1, c2 } = await history(t);
  const capture = () => { let text = ''; return { stream: { write: (chunk) => { text += chunk; } }, text: () => text }; };
  const run = async (argv) => {
    const stdout = capture(); const stderr = capture();
    return { status: await runSensorCli({ argv, stdout: stdout.stream, stderr: stderr.stream }), stdout: stdout.text(), stderr: stderr.text() };
  };
  const ok = await run(['touched', c1, c2, '--path', repo, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).schema, 'lattice.sensor_touched_result.v1');
  assert.deepEqual(summarize(JSON.parse(ok.stdout)), EXPECTED);
  const bin = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/lattice.mjs'), 'sensor', 'touched', c1, c2, '--path', repo],
    { encoding: 'utf8', env: { ...process.env, LATTICE_SENSOR_ALLOW_UNSAFE_NODE: '1' } });
  assert.equal(bin.status, 0, bin.stderr);
  assert.deepEqual(summarize(JSON.parse(bin.stdout)), EXPECTED, 'the bin implies --json');
  const bad = await run(['touched', 'no-such-ref', '--path', repo, '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, 'LATTICE_SENSOR_TOUCHED_GIT_FAILED');
  assert.equal((await run(['touched', '--json'])).status, 2);
});
