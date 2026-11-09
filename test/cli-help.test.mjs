import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  return result;
}

test('root helpは標準入口とnamespaceをstdoutへ表示する', () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = runCli(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.match(result.stdout, /^Usage: lattice <command> \[options\]\n/u);
    assert.match(result.stdout, /todo <command>/u);
    assert.match(result.stdout, /--version/u);
  }
});

test('公開namespace helpは正規構文をstore非依存で表示する', () => {
  const expected = new Map([
    ['plan', /create --input <file>/u],
    ['run', /start --request <request\.json> --executor <adapter>/u],
    ['event', /event verify/u],
    ['todo', /show --plan <key> --task <id> --json/u],
    ['sensor', /sensor <init\|sync>/u],
    ['factory-diagnostics', /factory-diagnostics --json/u],
    ['runtime-errors', /snapshot \[--after-cursor <n>\]/u],
    ['bridge', /setup --listen <IP>/u],
  ]);
  for (const [namespace, pattern] of expected) {
    for (const args of [[namespace, '--help'], [namespace, '-h'], ['help', namespace]]) {
      const result = runCli(args);
      assert.equal(result.status, 0, args.join(' '));
      assert.equal(result.stderr, '', args.join(' '));
      assert.match(result.stdout, pattern, args.join(' '));
    }
  }
});

test('未知namespace helpは従来どおりusage違反として拒否する', () => {
  const result = runCli(['help', 'unknown']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'lattice: unsupported command or arguments: help unknown\n');
});

test('run helpはpull runの生成からintake完了までを公開する', () => {
  const patterns = [
    /start --selection pull --id <id> --plan <key> --equipment detached-worktree/u,
    /intake --run \.lattice\/runs\/<id> --task <task_id>/u,
    /intake attach --run \.lattice\/runs\/<id> --task <task_id> --input <worker\.json>/u,
    /intake intervention --run \.lattice\/runs\/<id> --task <task_id>/u,
    /intake accept --run \.lattice\/runs\/<id> --task <task_id>/u,
    /landing --run \.lattice\/runs\/<id>/u,
  ];
  for (const args of [['run', '--help'], ['run', '-h'], ['help', 'run']]) {
    const result = runCli(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    for (const pattern of patterns) assert.match(result.stdout, pattern, args.join(' '));
  }
});

test('todo helpは構造opt-inからrealization・finalization・独立dashboard面まで案内する', () => {
  const result = runCli(['todo', '--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const pattern of [
    /structure --schema --json/u,
    /structure input --plan <key> --input <file> --dry-run --json/u,
    /consistent時だけplanへimmutableに有効化/u,
    /taskを閉じる。/u,
    /監査と構造finalizationは残作業/u,
    /structure realize --plan <key> --task <id> --input <file>/u,
    /--planned/u,
    /--realized <actual-structure\.json>/u,
    /identity・HEAD・履歴鎖・digest/u,
    /fresh consistentだけterminal受理/u,
    /工程図と別の構造検査面/u,
  ]) assert.match(result.stdout, pattern);
});

test('公開subcommand helpは正規構文をstore非依存で表示する', () => {
  const cases = [
    [['todo', 'show', '--help'], /show --plan <key> --task <id> --json/u],
    [['todo', 'note', '--help'], /--message <text>\|--input <file>/u],
    [['help', 'todo', 'note', 'list'], /note list --plan <key> \[--task <id>\] --json/u],
    [['todo', 'reopen', '--help'], /--override-reason <text>/u],
    [['todo', 'phase', 'accept', '-h'], /--input <file>/u],
    [['help', 'todo', 'done'], /--evidence <file>/u],
    [['help', 'run', 'abandon'], /--reason <reason>/u],
    [['run', 'start', '--help'], /--selection pull --id <id> --plan <key>/u],
    [['run', 'intake', '--help'], /--task <task_id>/u],
    [['run', 'intake', 'release', '--help'], /intake release --run/u],
    [['run', 'intake', 'attach', '--help'], /--input <worker\.json>/u],
    [['run', 'intake', 'intervention', '--help'], /--task <task_id>/u],
    [['run', 'intake', 'accept', '--help'], /--task <task_id>/u],
    [['todo', 'retract', '--help'], /--reason <text>/u],
    [['run', 'adapter', 'register', '--help'], /--schema --json/u],
    [['help', 'run', 'adapter', 'list'], /adapter list --json/u],
    [['bridge', 'setup', '--help'], /--listen <IP>/u],
  ];
  for (const [args, pattern] of cases) {
    const result = runCli(args);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
    assert.match(result.stdout, /^Usage: lattice /u);
    assert.match(result.stdout, pattern, args.join(' '));
  }
});

test('todo dependency helpはconnectとdisconnectの両方を示し、todo helpは矛盾する説明を持たない（a19）', () => {
  const dependency = runCli(['todo', 'dependency', '--help']);
  assert.equal(dependency.status, 0);
  assert.match(dependency.stdout, /lattice todo dependency connect --from-plan/u);
  assert.match(dependency.stdout, /lattice todo dependency disconnect --from-plan/u);

  const { stdout: help } = runCli(['todo', '--help']);
  // 未宣言・失効でもstartは止まらず助言になる（u03）。拒否すると述べる文は残さない。
  assert.doesNotMatch(help, /対象工程が未宣言・失効なら todo start は拒否する/u);
  assert.match(help, /todo start は止まらず、助言として返る/u);
  assert.doesNotMatch(help, /空store初期化専用/u);
  assert.doesNotMatch(help, /不正なら拒否する/u);
  assert.match(help, /LATTICE_SEAT_ID/u);
});
