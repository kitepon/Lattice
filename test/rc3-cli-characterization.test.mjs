import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };

// RC3-B characterizationをRC3-DでADR 0044 Decision 8のexit契約へ意図的に更新し、
// ADR 0052で`doctor --json`を退役へ更新した: `--version`だけが不変で、
// doctorを含む未知commandの拒否はusage違反としてexit 2
// （stdout汚染なし・stderr 1行diagnostic）になる。
// `plan compile`／`plan verify`のexact引数付き実挙動はtest/integration/
// rc3-plan-cli.integration.mjsが検証する。引数を欠く形・未実装surfaceは
// 引き続きfail closedで拒否される。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

const REJECTED_SURFACE = Object.freeze([
  ['plan', 'create', '--schema'],
  ['plan', 'compile'],
  ['plan', 'verify'],
  ['plan', 'compile', '--request'],
  ['plan', 'verify', '--request', 'req.json'],
  ['plan', 'compile', '--request', 'req.json', 'extra'],
  ['run', 'start'],
  ['run', 'observe'],
  ['run', 'status'],
  ['event', 'verify'],
]);

const MALFORMED_INPUTS = Object.freeze([
  [],
  ['frobnicate'],
  ['--version', 'extra'],
  // bare `status` implies --json since a20 (seat walkthrough 2026-11-10); a flagged extra word still refuses.
  ['status', '--json', 'extra'],
  ['doctor'],
  ['doctor', '--json'],
  ['doctor', '--json', 'extra'],
  ['--json', 'doctor'],
]);

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  return result;
}

function assertRejected(args) {
  const result = runCli(args);
  const received = args.length === 0 ? '(none)' : args.join(' ');
  assert.equal(result.status, 2, received);
  assert.equal(result.stdout, '', received);
  const error = JSON.parse(result.stderr);
  assert.deepEqual([error.schema, error.code, error.message, error.detail.next_action],
    ['lattice.cli_error.v2', 'USAGE', `unsupported command or arguments: ${received}`, 'lattice --help']);
}

test('--versionはpackage versionだけをstdoutへ返しexit 0で終わる', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${packageJson.version}\n`);
  assert.equal(result.stderr, '');
});


test('引数を欠くplan surfaceと未実装surfaceはusage違反exit 2で拒否される', () => {
  for (const args of REJECTED_SURFACE) {
    assertRejected(args);
  }
});

// u05: plan createの引数違反は、usage文ではなく欄・規則・直し方をcli_error.v2で返す（exit 2は同じ）。
test('引数を欠くplan createはexit 2で--inputを名指すcli_error.v2を返す', () => {
  for (const args of [['plan', 'create'], ['plan', 'create', '--input']]) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.code, 'INVALID_ARGUMENTS');
    assert.equal(payload.detail.pointer, '--input');
    assert.equal(payload.detail.rule, 'flag_missing');
    assert.deepEqual(payload.detail.arguments, args);
  }
});

test('引数なし・未知command・過剰引数・引数順不正はusage違反exit 2で拒否される', () => {
  for (const args of MALFORMED_INPUTS) {
    assertRejected(args);
  }
});
