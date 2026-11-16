// b4 (ADR 0205 §1, §3): `todo start T` that writes a function an in-progress task of another lane writes adds the split task
// S (or joins the open one) and keeps T pending; everything else starts as today. The start of S carries the worker's guide.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoStore } from '../src/todo-store.mjs';
import { planSplitHold } from '../src/todo-split-start.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ENV = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' };
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: ENV });
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const TASKS = [['U', 'lane-a'], ['T', 'lane-b'], ['V', 'lane-c'], ['W', 'lane-a']];

async function repo(context, { mode = 'witness' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-b4-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n');
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: TASKS.map(([task_id, lane]) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN', lane })) }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', mode, '--reason', 'fixture']);
  return root;
}
const declare = (root, taskId, ...flags) => success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags]);
const start = (root, taskId, ...flags) => success(root, ['todo', 'start', '--plan', 'dev', '--task', taskId, ...flags]);
const member = async (root) => (await readTodoStore({ repoRoot: root })).members.find(({ plan }) => plan.plan_key === 'dev');
const status = (m, id) => m.tasks.find(({ task_id: taskId }) => taskId === id).status;

test('write x write with an in-progress task of another lane adds the split task and holds the starting task', async (context) => {
  const root = await repo(context);
  declare(root, 'U', '--owns', 'src/a.js#alpha');
  declare(root, 'T', '--owns', 'src/a.js#alpha');
  start(root, 'U');
  const held = start(root, 'T');
  assert.equal(held.schema, 'lattice.todo_start_split_result.v1');
  assert.equal(held.status, 'pending');
  assert.equal(held.splits.length, 1);
  const [split] = held.splits;
  assert.match(split.task_id, /^split-[0-9a-f]{12}$/u);
  assert.deepEqual([split.path, split.symbol, split.joined, split.members], ['src/a.js', 'alpha', false, ['T', 'U']]);
  assert.match(held.next_action, /^wait: split-/u);
  const m = await member(root);
  assert.equal(m.plan.schema, 'lattice.todo_plan.v9');
  assert.equal(status(m, 'T'), 'pending');
  assert.equal(status(m, 'U'), 'in-progress');
  const added = m.plan.tasks.find(({ task_id: id }) => id === split.task_id);
  assert.equal(added.lane, 'lane-a');
  assert.deepEqual(added.function_split.members, ['T', 'U']);
  const edges = m.plan.hard_dependencies.map(({ from, to }) => `${from.task_id}>${to.task_id}`).sort();
  assert.deepEqual(edges, [`${split.task_id}>T`, `${split.task_id}>U`]);
  // T is not startable until S is done, and U cannot close before the split it must rebase on.
  assert.notEqual(run(root, ['todo', 'start', '--plan', 'dev', '--task', 'T']).status, 0);
  assert.notEqual(run(root, ['todo', 'done', '--plan', 'dev', '--task', 'U', '--message', 'x']).status, 0);
});

test('a third lane starting on the same function joins the open split; the starting task is held', async (context) => {
  const root = await repo(context);
  for (const id of ['U', 'T', 'V']) declare(root, id, '--owns', 'src/a.js#alpha');
  start(root, 'U');
  const first = start(root, 'T').splits[0];
  const second = start(root, 'V');
  assert.deepEqual(second.splits.map(({ task_id: id, joined, members }) => [id, joined, members]), [[first.task_id, true, ['T', 'U', 'V']]]);
  const m = await member(root);
  assert.deepEqual(m.plan.tasks.find(({ task_id: id }) => id === first.task_id).function_split.members, ['T', 'U', 'V']);
  assert.equal(m.plan.tasks.filter(({ function_split: mark }) => mark).length, 1);
  assert.ok(m.plan.hard_dependencies.some(({ from, to }) => from.task_id === first.task_id && to.task_id === 'V'));
});

for (const [name, setup, expected] of [
  ['read x write is never split (D2)', (root) => { declare(root, 'U', '--owns', 'src/a.js#alpha'); declare(root, 'T', '--reads', 'src/a.js#alpha'); }, 'in-progress'],
  ['the same lane is one side', (root) => { declare(root, 'U', '--owns', 'src/a.js#alpha'); declare(root, 'W', '--owns', 'src/a.js#alpha'); }, 'in-progress'],
  ['different functions of one file do not conflict', (root) => { declare(root, 'U', '--owns', 'src/a.js#alpha'); declare(root, 'T', '--owns', 'src/a.js#beta'); }, 'in-progress'],
]) {
  test(name, async (context) => {
    const root = await repo(context);
    setup(root);
    start(root, 'U');
    const other = name.startsWith('the same lane') ? 'W' : 'T';
    const result = start(root, other);
    assert.equal(result.schema, 'lattice.todo_mutation_result.v5');
    assert.equal(status(await member(root), other), expected);
    assert.equal((await member(root)).plan.schema, 'lattice.todo_plan.v8');
  });
}

test('--override-reason and a conversation plan start as today', async (context) => {
  const root = await repo(context);
  for (const id of ['U', 'T']) declare(root, id, '--owns', 'src/a.js#alpha');
  start(root, 'U');
  assert.equal(start(root, 'T', '--override-reason', 'agreed with the other lane').schema, 'lattice.todo_mutation_result.v5');
  assert.equal((await member(root)).plan.schema, 'lattice.todo_plan.v8');
  const chat = await repo(context, { mode: 'conversation' });
  for (const id of ['U', 'T']) declare(chat, id, '--owns', 'src/a.js#alpha');
  start(chat, 'U');
  assert.equal(start(chat, 'T').schema, 'lattice.todo_mutation_result.v5');
});

test('in an enforced plan the held task never meets the gates, and the split task starts without a row and carries the guide', async (context) => {
  const root = await repo(context, { mode: 'enforced' });
  declare(root, 'U', '--owns', 'src/a.js#alpha');
  declare(root, 'T', '--owns', 'src/a.js#alpha');
  start(root, 'U');
  const held = start(root, 'T');
  assert.equal(held.schema, 'lattice.todo_start_split_result.v1');
  const [{ task_id: splitId }] = held.splits;
  const started = start(root, splitId);
  assert.equal(started.status, 'in-progress');
  assert.deepEqual(started.function_split.members, ['T', 'U']);
  assert.match(started.function_split.guide, /function-split verify --plan dev --task split-/u);
  assert.match(started.function_split.guide, /\[skip ci\]/u);
  assert.match(started.function_split.guide, /function-split decline/u);
  assert.ok('profile' in started.function_split.cut_cost && Array.isArray(started.function_split.cut_cost.reasons ?? []));
});

test('the mark survives later revisions and an author cannot write it', async (context) => {
  const root = await repo(context);
  declare(root, 'U', '--owns', 'src/a.js#alpha');
  declare(root, 'T', '--owns', 'src/a.js#alpha');
  start(root, 'U');
  const [{ task_id: splitId }] = start(root, 'T').splits;
  success(root, ['todo', 'add', '--plan', 'dev', '--task', 'later', '--title', 'later', '--phase', 'p', '--design-memo', 'NO_PLAN', '--after', 'T']);
  const m = await member(root);
  assert.deepEqual(m.plan.tasks.find(({ task_id: id }) => id === splitId).function_split.members, ['T', 'U']);
  assert.equal(m.plan.tasks.find(({ task_id: id }) => id === 'later').function_split, null);
  const authored = m.plan.tasks.map((task) => ({ task_id: task.task_id, title: task.title, phase_id: task.phase_id, design_memo: task.design_memo,
    lane: task.lane, ...(task.task_id === 'U' ? { function_split: null } : {}) }));
  await writeFile(path.join(root, 'rev.json'), JSON.stringify({ schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }], tasks: authored }));
  assert.notEqual(run(root, ['plan', 'revise', '--input', 'rev.json']).status, 0);
});

test('planSplitHold: a retired split of the same function gives the next id, and two lanes in progress on a function are left alone', () => {
  const task = (id, lane, extra = {}) => ({ task_id: id, lane, phase_id: 'p', function_split: null, ...extra });
  const plan = { plan_key: 'dev', tasks: [task('U', 'a'), task('T', 'b'), task('R', 'c'),
    task('split-x', 'a')], hard_dependencies: [] };
  const states = (map) => ({ plan, tasks: Object.entries(map).map(([task_id, status]) => ({ task_id, status })) });
  const overlap = (other, symbol = 'f') => ({ task_a: 'T', task_b: other, path: 'src/a.js', overlaps: [{
    a: { symbol, start_line: 1, end_line: 3, access: 'write' }, b: { symbol, start_line: 1, end_line: 3, access: 'write' } }] });
  const first = planSplitHold({ member: states({ U: 'in-progress', T: 'pending', R: 'pending' }), taskId: 'T', read: { open: [overlap('U')] } });
  assert.match(first.tasks[0].task_id, /^split-[0-9a-f]{12}$/u);
  plan.tasks.push(task(first.tasks[0].task_id, 'a'));
  const again = planSplitHold({ member: states({ U: 'in-progress', T: 'pending', R: 'pending' }), taskId: 'T', read: { open: [overlap('U')] } });
  assert.equal(again.tasks[0].task_id, `${first.tasks[0].task_id}-2`);
  plan.tasks.at(-1).function_split = null;
  const both = planSplitHold({ member: states({ U: 'in-progress', R: 'in-progress', T: 'pending' }), taskId: 'T', read: { open: [overlap('U'), overlap('R')] } });
  assert.equal(both, null);
});

test('b6: 分割待ち on every member of an unfinished split (the one in progress too), 関数分割 on S; none once S is closed', async (context) => {
  const root = await repo(context);
  for (const id of ['U', 'T']) declare(root, id, '--owns', 'src/a.js#alpha');
  start(root, 'U');
  const [{ task_id: splitId }] = start(root, 'T').splits;
  const labelOf = (id, list) => list.filter(({ task_id: taskId }) => taskId === id).map(({ label }) => label);
  const context1 = success(root, ['session-context']);
  assert.deepEqual(context1.labels.map(({ task_id: id, label }) => [id, label]).sort(), [['T', '分割待ち'], ['U', '分割待ち'], [splitId, '関数分割']].sort());
  assert.equal(status(await member(root), 'U'), 'in-progress', 'the label never replaces the status');
  assert.equal('labels' in context1.todo, false, 'the status projection keeps its shape');
  assert.deepEqual(success(root, ['todo', 'show', '--plan', 'dev', '--task', 'T']).labels, ['分割待ち']);
  assert.deepEqual(success(root, ['todo', 'show', '--plan', 'dev', '--task', 'U']).labels, ['分割待ち']);
  const shownSplit = success(root, ['todo', 'show', '--plan', 'dev', '--task', splitId]);
  assert.deepEqual([shownSplit.labels, shownSplit.split_record], [['関数分割'], null]);
  assert.deepEqual(labelOf('T', success(root, ['todo', 'display', 'read']).labels), ['分割待ち']);
  assert.equal('labels' in success(root, ['todo', 'status']), false);
  success(root, ['todo', 'function-split', 'decline', '--plan', 'dev', '--task', splitId, '--reason', 'no cut']);
  assert.equal('labels' in success(root, ['session-context']), false);
  assert.equal('labels' in success(root, ['todo', 'show', '--plan', 'dev', '--task', 'T']), false);
});
