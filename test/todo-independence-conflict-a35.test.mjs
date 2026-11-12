// a35: two works that write one file conflict (patent claim 4), and a revision, a reopened task and a
// retired task each get a way on that works.

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

function planInput(taskIds) {
  return { schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'cf',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-11-10T00:00:00.000Z',
    tasks: taskIds.map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      done_condition: null, narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '' };
}

async function compileWitness(context, boundaries) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a35-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(root, 'src', `${name}.js`), `export const ${name} = 1;\n`);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  const input = planInput(['P', 'Q']);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'independence', 'mode', '--plan', 'cf', '--set', 'witness', '--reason', 'a35']);
  const draft = success(root, ['todo', 'independence', 'witness', 'scaffold', '--template', '--plan', 'cf']);
  Object.assign(draft, { capacity: { executors: 2 } });
  for (const [taskId, boundary] of Object.entries(boundaries)) Object.assign(draft.tasks[taskId], boundary);
  await writeFile(path.join(root, 'draft.json'), JSON.stringify(draft));
  const { witness_ref: witnessRef } = success(root,
    ['todo', 'independence', 'witness', 'scaffold', '--plan', 'cf', '--input', 'draft.json']);
  const compiled = success(root, ['todo', 'independence', 'compile', '--plan', 'cf', '--input', witnessRef]);
  return { root, compiled, projection: success(root, ['todo', 'independence', '--plan', 'cf', '--json']) };
}

const writesC = { writes: ['src/c.js'] };
const ownsAndWritesC = { owns: ['src/c.js'], writes: ['src/c.js'] };

for (const [label, left, right] of [
  ['both own and write src/c.js', ownsAndWritesC, ownsAndWritesC],
  ['both write src/c.js without owns', writesC, writesC],
  ['one owns and writes src/c.js, the other only writes it', ownsAndWritesC, writesC],
]) {
  test(`${label}: a conflict, and P and Q are not parallel`, async (context) => {
    const { compiled, projection } = await compileWitness(context, { P: left, Q: right });
    assert.equal(compiled.conflict_count, 1, JSON.stringify(compiled));
    assert.equal(projection.coverage, 'verified');
    assert.equal(projection.frontier.parallel_groups.some(({ task_ids: ids }) => ids.length > 1), false,
      JSON.stringify(projection.frontier));
    assert.deepEqual(projection.frontier.serialize_pairs.map(({ task_ids: ids, type }) => [ids, type]),
      [[['P', 'Q'], 'conflict']]);
  });
}

test('owning and writing disjoint files stays parallel', async (context) => {
  const { compiled } = await compileWitness(context, {
    P: { owns: ['src/a.js'], writes: ['src/a.js'] }, Q: { owns: ['src/b.js'], writes: ['src/b.js'] } });
  assert.equal(compiled.conflict_count, 0, JSON.stringify(compiled));
});

// a35 item 2: a revision that adds a task keeps the plan's coordination mode, and the way on names the
// new task and starts from a template that keeps the recorded declarations.
test('after a revision adds U: mode kept, refusal points at the template, template keeps P and Q', async (context) => {
  const { root } = await compileWitness(context, {
    P: { owns: ['src/a.js'], writes: ['src/a.js'] }, Q: { reads: ['src/b.js'], writes: ['src/c.js'] } });
  const desired = planInput(['P', 'Q', 'U']);
  delete desired.input_digest;
  await writeFile(path.join(root, 'revise.json'), JSON.stringify({ schema: 'lattice.plan_revise_input.v1', desired,
    continuity: ['P', 'Q'].map((task_id) => ({ task_id, policy: 'carry', reason: 'kept' })) }));
  success(root, ['plan', 'revise', '--input', 'revise.json', '--json']);

  const projection = success(root, ['todo', 'independence', '--plan', 'cf', '--json']);
  assert.notEqual(projection.guidance?.code, 'coordination_mode_undeclared', JSON.stringify(projection.guidance));
  const status = success(root, ['todo', 'status', '--json']);
  assert.deepEqual(status.coordination.map(({ plan_key: key, mode }) => [key, mode]), [['cf', 'witness']]);

  const refusal = run(root, ['todo', 'independence', 'compile', '--plan', 'cf', '--input', '.lattice/todo/witness/cf.json']);
  assert.equal(refusal.status, 1, refusal.stdout);
  const { code, detail } = JSON.parse(refusal.stderr);
  assert.deepEqual([code, detail.missing_task_ids], ['INDEPENDENCE_READY_UNDECLARED', ['U']]);
  assert.match(detail.next_action, /Declare U .*scaffold --template --plan cf/u);

  const template = success(root, ['todo', 'independence', 'witness', 'scaffold', '--template', '--plan', 'cf']);
  assert.deepEqual(template.capacity, { executors: 2 });
  assert.deepEqual(template.tasks, {
    P: { owns: ['src/a.js'], reads: [], writes: [] },
    Q: { owns: [], reads: ['src/b.js'], writes: ['src/c.js'] },
    U: { owns: [], reads: [], writes: [] },
  });
  template.tasks.U.writes = ['src/b.js'];
  await writeFile(path.join(root, 'draft2.json'), JSON.stringify(template));
  const { witness_ref: witnessRef } = success(root,
    ['todo', 'independence', 'witness', 'scaffold', '--plan', 'cf', '--input', 'draft2.json']);
  const compiled = success(root, ['todo', 'independence', 'compile', '--plan', 'cf', '--input', witnessRef]);
  assert.equal(compiled.conflict_count, 1, JSON.stringify(compiled));
});

async function lifecyclePlan(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a35-life-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(planInput(['a', 'b', 'c'])));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const on = (taskId) => ['--plan', 'cf', '--task', taskId];
function refusal(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stderr);
}

// retract-anyone (supersedes a35 item 4): a reopened task is unstarted; an open task offers done or retract.
test('a reopened task is unstarted; an open task is pointed at done or retract; retract is in todo --help', async (context) => {
  const root = await lifecyclePlan(context);
  success(root, ['todo', 'start', ...on('a')]);
  success(root, ['todo', 'done', ...on('a')]);
  const reopened = success(root, ['todo', 'reopen', ...on('a'), '--reason', 'found bug']);
  assert.equal(reopened.status, 'pending');
  assert.match(reopened.next_action, /unstarted again; redo it with `lattice todo start --plan cf --task a`/u);

  const again = refusal(root, ['todo', 'reopen', ...on('a'), '--reason', 'again']);
  assert.deepEqual([again.code, again.detail.status], ['TODO_TRANSITION_REFUSED', 'pending']);
  assert.match(again.detail.next_action, /It has not started: run `lattice todo start --plan cf --task a`/u);

  success(root, ['todo', 'start', ...on('b')]);
  const started = refusal(root, ['todo', 'reopen', ...on('b'), '--reason', 'x']);
  assert.match(started.detail.next_action, /return it to unstarted with `lattice todo retract --plan cf --task b --reason <text>`/u);

  const help = run(root, ['todo', '--help']);
  assert.match(help.stdout + help.stderr, /^ {2}retract --plan <key> --task <id> --reason <text>$/mu);
});

// a35 item 6: done on a retired task says it is retired instead of sending the seat to a start that refuses.
test('done on a retired task names the retirement and a way that works', async (context) => {
  const root = await lifecyclePlan(context);
  success(root, ['todo', 'retire', ...on('c'), '--reason', 'not needed']);
  const done = refusal(root, ['todo', 'done', ...on('c')]);
  assert.deepEqual([done.code, done.detail.status], ['TODO_TRANSITION_REFUSED', 'retired']);
  assert.match(done.detail.next_action, /cf\/c is retired, which is permanent.*lattice plan revise --input <file>/u);
  assert.doesNotMatch(done.detail.next_action, /todo start/u);
});
