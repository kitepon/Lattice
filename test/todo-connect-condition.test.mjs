// 前工程 (`todo predecessor`) and 他条件に接続 (`todo connect condition`) refuse each other's targets;
// every connect condition write is idempotent. docs/architecture/dfd-connect.md
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const SRC = path.resolve(import.meta.dirname, '../src');

function run(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a',
      LATTICE_CHARTS_ROOT: '', ...extra } });
}

/** Two charts, alpha (plan a: P, S) and beta (plan b: R, Q), under one charts root. */
async function charts(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-connect-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CHARTS_ROOT: root };
  const ok = (chart, args) => {
    const result = run(path.join(root, chart), args, env);
    assert.equal(result.status, 0, `${chart}: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return { ...JSON.parse(result.stdout), stderr: result.stderr };
  };
  const refused = (chart, args, status = 1) => {
    const result = run(path.join(root, chart), args, env);
    assert.equal(result.status, status, `${chart}: ${args.join(' ')} should exit ${status}\n${result.stdout}`);
    return JSON.parse(result.stderr);
  };
  for (const [chart, planKey, tasks] of [['alpha', 'a', ['P', 'S']], ['beta', 'b', ['R', 'Q']]]) {
    const dir = path.join(root, chart);
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({
      schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
      tasks: tasks.map((id) => ({ task_id: id, title: id, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
      hard_dependencies: [],
    }));
    ok(chart, ['plan', 'create', '--input', 'plan.json']);
  }
  return { ok, refused };
}

const predecessor = (operation, after) => ['todo', 'predecessor', operation, '--plan', 'b', '--task', 'R', '--after', after, '--reason', 'R uses it'];
const condition = (operation, to, last = ['--reason', 'R uses it']) => ['todo', 'connect', 'condition', operation, '--plan', 'b', '--task', 'R', '--to', to, ...last];

test('前工程 takes only a task on this chart; another chart or a schedule is refused and names connect condition add', async (context) => {
  const { ok, refused } = await charts(context);
  for (const after of ['alpha/a/P', 'task:alpha/a/P', 'schedule:ci-1']) {
    const failure = refused('beta', predecessor('add', after));
    assert.deepEqual([failure.schema, failure.code, failure.detail.reason], ['lattice.cli_error.v2', 'CONNECTION_INVALID', 'predecessor_target_not_same_chart']);
    assert.match(failure.detail.next_action, /todo connect condition add --plan b --task R --to /u);
  }
  // This chart's task is a 前工程: add, repeat (unchanged), remove.
  assert.equal(ok('beta', predecessor('add', 'b/Q')).from.task_id, 'Q');
  assert.equal(ok('beta', predecessor('add', 'b/Q')).unchanged, true);
  assert.equal(ok('beta', predecessor('remove', 'b/Q')).operation, 'disconnect');
  // A malformed target is an argument error.
  const malformed = refused('beta', predecessor('add', 'not a ref'), 2);
  assert.deepEqual([malformed.code, malformed.detail.pointer], ['INVALID_ARGUMENTS', '--after']);
});

test('他条件に接続 takes only another chart or a schedule; a task on this chart is refused and names predecessor add', async (context) => {
  const { refused } = await charts(context);
  const same = refused('beta', condition('add', 'task:beta/b/Q'));
  assert.deepEqual([same.code, same.detail.reason], ['CONNECTION_INVALID', 'condition_target_same_chart']);
  assert.match(same.detail.next_action, /todo predecessor add --plan b --task R --after b\/Q /u);
  const removed = refused('beta', condition('remove', 'task:beta/b/Q'));
  assert.match(removed.detail.next_action, /todo predecessor remove /u);
  for (const to of ['alpha/a/P', 'task:alpha/a', 'schedule:', 'schedule:has space', 'anything']) {
    const malformed = refused('beta', condition('add', to), 2);
    assert.deepEqual([malformed.code, malformed.detail.pointer], ['INVALID_ARGUMENTS', '--to'], to);
  }
  assert.equal(refused('beta', ['todo', 'connect', 'condition', 'add', '--plan', 'b', '--task', 'NOPE', '--to', 'task:alpha/a/P', '--reason', 'x']).detail.reason, 'task_not_found');
  assert.equal(refused('beta', ['todo', 'connect', 'condition', 'frobnicate'], 2).detail.rule, 'subcommand_unknown');
});

test('connect condition to a task on another chart is idempotent; resolve is only for a schedule; a never-added target is not found', async (context) => {
  const { ok, refused } = await charts(context);
  const to = 'task:alpha/a/P';
  assert.equal(ok('beta', condition('add', to)).from.task_id, 'P');
  assert.equal(ok('beta', condition('add', to)).unchanged, true);
  const resolve = refused('beta', condition('resolve', to, ['--message', 'done']));
  assert.deepEqual([resolve.code, resolve.detail.reason], ['CONNECTION_INVALID', 'condition_task_target_settles_itself']);
  assert.equal(ok('beta', condition('remove', to)).schema, 'lattice.todo_dependency_disconnect_result.v1');
  assert.equal(ok('beta', condition('remove', to)).unchanged, true);
  const never = refused('beta', condition('remove', 'task:alpha/a/S'));
  assert.deepEqual([never.code, never.detail.reason], ['CONNECTION_INVALID', 'connection_not_found']);
  assert.match(never.detail.next_action, /todo connect condition add --plan b --task R --to task:alpha\/a\/S /u);
});

test('dependency connect|disconnect still work for one minor version and say which command replaces them', async (context) => {
  const { ok } = await charts(context);
  const same = ok('beta', ['todo', 'dependency', 'connect', '--from-plan', 'b', '--from-task', 'Q', '--to-plan', 'b', '--to-task', 'R', '--reason', 'x']);
  assert.equal(JSON.parse(same.stderr).use, 'lattice todo predecessor add --plan b --task R --after b/Q --reason <text>');
  const other = ok('beta', ['todo', 'dependency', 'connect', '--from-project', 'alpha', '--from-plan', 'a', '--from-task', 'P', '--to-plan', 'b', '--to-task', 'R', '--reason', 'x']);
  assert.equal(JSON.parse(other.stderr).use, 'lattice todo connect condition add --plan b --task R --to task:alpha/a/P --reason <text>');
  assert.equal(JSON.parse(other.stderr).schema, 'lattice.todo_command_retired.v1');
});

test('block says what to use first: predecessor add (前工程) or connect condition add (他条件に接続)', async (context) => {
  const { ok } = await charts(context);
  ok('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']);
  const blocked = ok('beta', ['todo', 'block', '--plan', 'b', '--task', 'R', '--reason', 'x']);
  assert.match(blocked.next_action, /todo predecessor add.*todo connect condition add.*ブロックは最後の手段/u);
});

// The schedule 接続 needs the Store's connection events (b1); skipped until they exist.
const storeHasConnections = (await readFile(path.join(SRC, 'todo-contracts.mjs'), 'utf8')).includes('connection_added');
test('connect condition to a schedule: add, repeat, resolve, repeat, remove are idempotent and the task cannot start while open', { skip: !storeHasConnections && 'Store b1 (connection events) not merged' }, async (context) => {
  const { ok, refused } = await charts(context);
  const to = 'schedule:ci-run-1';
  const added = ok('beta', condition('add', to));
  assert.equal(added.schema, 'lattice.todo_connection_result.v1');
  assert.equal(ok('beta', condition('add', to)).unchanged, true);
  const start = refused('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']);
  assert.equal(start.detail.cause, 'connection_open');
  assert.equal(ok('beta', condition('resolve', to, ['--message', 'CI green'])).operation, 'resolve');
  const again = ok('beta', condition('resolve', to, ['--message', 'second evidence']));
  assert.equal(again.unchanged, true);
  assert.equal(ok('beta', condition('remove', to)).unchanged, true);
  assert.equal(ok('beta', condition('add', 'schedule:other')).operation, 'add');
  assert.equal(ok('beta', condition('remove', 'schedule:other')).operation, 'remove');
  assert.equal(ok('beta', condition('remove', 'schedule:other')).unchanged, true);
  assert.equal(refused('beta', condition('remove', 'schedule:never')).detail.reason, 'connection_not_found');
  assert.equal(refused('beta', condition('resolve', 'schedule:never', ['--message', 'x'])).detail.reason, 'connection_not_found');
});
