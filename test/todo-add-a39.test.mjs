import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoStore } from '../src/todo-store.mjs';

// a39 (BellTeam trial, 0.85.5): add one task without resending the plan; plan show carries
// design_memo; plan revise takes --plan like every todo write.
const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args, agent = 'fixture') {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_TODO_ACTOR_HOST: 'fixture',
      LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent } });
}
function success(root, args, agent) {
  const result = run(root, args, agent);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refusal(root, args) {
  const result = run(root, args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should refuse\n${result.stdout}`);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-add-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'work',
    phases: [{ phase_id: 'p1', title: 'one' }],
    tasks: [
      { task_id: 'a', title: 'A', phase_id: 'p1', design_memo: 'memo a', done_condition: 'a ok' },
      { task_id: 'b', title: 'B', phase_id: 'p1', design_memo: 'NO_PLAN' },
      { task_id: 'c', title: 'C', phase_id: 'p1', design_memo: 'NO_PLAN' },
    ],
    hard_dependencies: [{ from: { task_id: 'a' }, to: { task_id: 'b' } }],
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const readWork = async (root) => (await readTodoStore({ repoRoot: root }))
  .members.find(({ plan }) => plan.plan_key === 'work');

test('todo add adds one task with edges and carries every other task state', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'a', '--message', 'done']);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  const result = success(root, ['todo', 'add', '--plan', 'work', '--task', 'd', '--title', 'D',
    '--phase', 'p1', '--design-memo', 'memo d', '--done-condition', 'd ok',
    '--after', 'a,b', '--before', 'c', '--reason', 'found in review']);
  assert.equal(result.schema, 'lattice.todo_task_add_result.v1');
  assert.deepEqual([result.task_id, result.after, result.before], ['d', ['a', 'b'], ['c']]);
  assert.deepEqual(result.rebound_task_ids, ['b']);
  const member = await readWork(root);
  assert.equal(result.plan_version, member.plan.plan_version);
  const status = Object.fromEntries(member.tasks.map(({ task_id: id, status: s }) => [id, s]));
  assert.deepEqual(status, { a: 'done', b: 'in-progress', c: 'pending', d: 'pending' });
  const shown = success(root, ['plan', 'show', 'work', '--json']);
  const d = shown.tasks.find(({ task_id: id }) => id === 'd');
  assert.deepEqual([d.design_memo, d.done_condition, d.phase_id], ['memo d', 'd ok', 'p1']);
  assert.equal(shown.tasks.find(({ task_id: id }) => id === 'a').design_memo, 'memo a');
  assert.deepEqual(shown.hard_dependencies.map(({ from, to }) => `${from.task_id}>${to.task_id}`).sort(),
    ['a>b', 'a>d', 'b>d', 'd>c']);
  assert.match(JSON.stringify(success(root, ['todo', 'note', 'list', '--plan', 'work', '--json'])),
    /todo add d: found in review/u);
});

// perf-rebind (2026-11-14): every carried in-progress task is rebound after one todo add, by its own start actor.
test('todo add rebinds several in-progress tasks of different seats in one pass', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a'], 'seat-1');
  success(root, ['todo', 'add', '--plan', 'work', '--task', 'e', '--title', 'E', '--phase', 'p1',
    '--design-memo', 'NO_PLAN'], 'seat-2');
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'c'], 'seat-2');
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'e'], 'seat-3');
  const result = success(root, ['todo', 'add', '--plan', 'work', '--task', 'd', '--title', 'D',
    '--phase', 'p1', '--design-memo', 'NO_PLAN'], 'seat-4');
  assert.deepEqual([...result.rebound_task_ids].sort(), ['a', 'c', 'e']);
  const member = await readWork(root);
  const status = Object.fromEntries(member.tasks.map(({ task_id: id, status: s }) => [id, s]));
  assert.deepEqual(status, { a: 'in-progress', b: 'pending', c: 'in-progress', d: 'pending', e: 'in-progress' });
  const rebinds = member.journal.events.filter(({ kind, payload }) => kind === 'start' && payload.start_mode === 'rebind');
  assert.deepEqual(rebinds.map(({ task_id: id, actor, plan_version: version }) => [id, actor.agent, version])
    .sort(), [['a', 'seat-1', member.plan.plan_version], ['c', 'seat-2', member.plan.plan_version],
    ['e', 'seat-3', member.plan.plan_version]]);
});

test('todo add refuses an existing id or an unknown edge end before writing', async (context) => {
  const root = await fixture(context);
  const version = (await readWork(root)).plan.plan_version;
  const exists = refusal(root, ['todo', 'add', '--plan', 'work', '--task', 'b', '--title', 'B2', '--phase', 'p1',
    '--design-memo', 'NO_PLAN']);
  assert.equal(exists.message, 'todo_add_task_exists');
  const unknown = refusal(root, ['todo', 'add', '--plan', 'work', '--task', 'e', '--title', 'E',
    '--phase', 'p1', '--design-memo', 'NO_PLAN', '--after', 'zz']);
  assert.equal(unknown.message, 'dependency_task_not_found');
  assert.equal((await readWork(root)).plan.plan_version, version);
});

test('todo retire closes one task without touching the others', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  const version = (await readWork(root)).plan.plan_version;
  success(root, ['todo', 'retire', '--plan', 'work', '--task', 'c', '--reason', 'not needed']);
  const member = await readWork(root);
  assert.equal(member.plan.plan_version, version);
  const status = Object.fromEntries(member.tasks.map(({ task_id: id, status: s }) => [id, s]));
  assert.deepEqual(status, { a: 'in-progress', b: 'pending', c: 'retired' });
});

test('plan revise --plan fills a missing plan_key and refuses another one', async (context) => {
  const root = await fixture(context);
  const shown = success(root, ['plan', 'show', 'work', '--json']);
  const tasks = shown.tasks.map(({ task_id, title, lane, phase_id, done_condition, design_memo }) => (
    { task_id, title, lane, phase_id, done_condition, design_memo }));
  tasks[1].title = 'B renamed';
  const plan = { schema: 'lattice.plan_create_input.v5', phases: shown.phases.map(({ phase_id, title }) => ({ phase_id, title })),
    tasks, hard_dependencies: shown.hard_dependencies };
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(plan));
  // A filled key that names no active plan gets the existing plan_not_active guidance.
  assert.equal(refusal(root, ['plan', 'revise', '--plan', 'other', '--input', 'revise.json']).message,
    'plan_not_active');
  const result = success(root, ['plan', 'revise', '--plan', 'work', '--input', 'revise.json', '--json']);
  assert.equal(result.plan_key, 'work');
  assert.equal((await readWork(root)).plan.tasks.find(({ task_id: id }) => id === 'b').title, 'B renamed');
  await writeFile(path.join(root, 'revise.json'), JSON.stringify({ ...plan, plan_key: 'other' }));
  assert.match(JSON.stringify(refusal(root, ['plan', 'revise', '--plan', 'work', '--input', 'revise.json'])),
    /plan_revise_plan_key_mismatch/u);
});

test('todo phase status accepts --json like the other reads', async (context) => {
  const root = await fixture(context);
  assert.deepEqual(success(root, ['todo', 'phase', 'status', '--plan', 'work', '--json']),
    success(root, ['todo', 'phase', 'status', '--plan', 'work']));
});
