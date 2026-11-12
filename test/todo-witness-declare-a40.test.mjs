// a40: a member declares one task's witness row; compile runs once every ready task is declared.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refusal(root, args) {
  const result = run(root, args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should refuse\n${result.stdout}`);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a40-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, 'src', `${name}.js`), `export const ${name} = 1;\n`);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q', 'R'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })),
    hard_dependencies: [{ from: { task_id: 'P' }, to: { task_id: 'R' } }],
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const declare = (taskId, ...flags) => ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags];

test('each member declares their own row; compile waits for every ready task, then runs', async (context) => {
  const root = await fixture(context);
  const first = success(root, declare('P', '--owns', 'src/a.js', '--reads', 'src/c.js'));
  assert.equal(first.schema, 'lattice.todo_witness_declare_result.v1');
  assert.deepEqual([first.compiled, first.waiting_for, first.compile], [false, ['Q'], null]);
  assert.deepEqual([first.owns, first.reads, first.writes], [['src/a.js'], ['src/c.js'], []]);
  const second = success(root, declare('Q', '--owns', 'src/b.js', '--json'));
  assert.deepEqual([second.compiled, second.waiting_for], [true, []]);
  assert.equal(second.compile.outcome, 'compiled');
  assert.equal(second.compile.conflict_count, 0);
  // P's row survived Q's declaration, and R (not ready, undeclared) was not written as an empty row.
  const template = success(root, ['todo', 'independence', 'witness', 'scaffold', '--template', '--plan', 'dev']);
  assert.deepEqual(template.tasks.P.owns, ['src/a.js']);
  assert.deepEqual(template.tasks.R, { owns: [], reads: [], writes: [] });
  const projection = success(root, ['todo', 'independence', '--plan', 'dev', '--json']);
  assert.equal(projection.coverage, 'verified');
  // Redeclaring one row replaces only that row; a shared write becomes a conflict.
  const third = success(root, declare('Q', '--owns', 'src/b.js', '--writes', 'src/a.js'));
  assert.equal(third.compile.conflict_count, 1);
});

test('declare refuses an unknown or finished task before writing', async (context) => {
  const root = await fixture(context);
  assert.equal(refusal(root, declare('Z', '--owns', 'src/a.js')).message, 'task_not_found');
  success(root, ['todo', 'retire', '--plan', 'dev', '--task', 'Q', '--reason', 'gone']);
  assert.equal(refusal(root, declare('Q', '--owns', 'src/b.js')).message, 'witness_declare_task_finished');
  // With Q retired, P is the only ready task: declaring it compiles at once.
  assert.equal(success(root, declare('P', '--owns', 'src/a.js')).compiled, true);
});

test('todo add accepts --json as a no-op like every write', async (context) => {
  const root = await fixture(context);
  assert.equal(success(root, ['todo', 'add', '--plan', 'dev', '--task', 'S', '--title', 'S', '--phase', 'p',
    '--design-memo', 'NO_PLAN', '--json'])
    .task_id, 'S');
});

test('declare-without-git: on a Store root with no commit the row is recorded and the enforced task starts', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-unborn-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })),
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', 'enforced', '--reason', 'gates']);
  // Undeclared still refuses (gate 1); declaring records the row without observing or compiling.
  assert.equal(refusal(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']).message, 'enforced_witness_undeclared');
  success(root, declare('Q', '--owns', 'src/b.js'));
  const declared = success(root, declare('P', '--owns', 'src/a.js'));
  assert.deepEqual([declared.compiled, declared.waiting_for, declared.observation], [false, [], 'unavailable']);
  assert.match(declared.next_action, /lattice todo start --plan dev --task P/u);
  const started = success(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']);
  assert.equal(started.advisory.coverage, 'declared_unobserved');
  assert.equal(started.advisory.guidance.code, 'independence_declared_unobserved');
});

test('declare-hint-knows-order: the hint offers start only for a ready task and names what a waiting one waits on', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-unborn-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })),
    hard_dependencies: [{ from: { task_id: 'P' }, to: { task_id: 'Q' } }],
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'dev', '--set', 'enforced', '--reason', 'gates']);
  const waiting = success(root, declare('Q', '--owns', 'src/b.js'));
  assert.doesNotMatch(waiting.next_action, /todo start --plan dev --task Q/u);
  assert.match(waiting.next_action, /Q cannot start yet: it waits on dev\/P \(pending\)\./u);
  // The hinted start would have been refused; it still is.
  assert.equal(refusal(root, ['todo', 'start', '--plan', 'dev', '--task', 'Q']).detail.cause, 'predecessor_unfinished');
  const ready = success(root, declare('P', '--owns', 'src/a.js'));
  assert.match(ready.next_action, /The declared task can start: `lattice todo start --plan dev --task P`\./u);
  success(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']);
  assert.match(success(root, declare('P', '--owns', 'src/a.js')).next_action, /P is already in-progress; no start is needed\./u);
});
