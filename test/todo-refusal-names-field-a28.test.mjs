// a28: deeper refusals name the missing flag and a route that works (reopen override, read commands,
// command groups), and connecting an existing edge succeeds unchanged like other same-state writes.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });

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
function refused(root, args, status = 1) {
  const result = run(root, args);
  assert.equal(result.status, status, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stderr);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a28-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const input = { schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-11-08T00:00:00.000Z',
    tasks: ['a', 'b', 'c'].map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      done_condition: null, narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [{ from: ref('a'), to: ref('b') }], joins: [], phase_accept_dependencies: [],
    input_digest: '' };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const task = (name) => ['--plan', 'work', '--task', name];
const edge = (from, to) => ['--from-plan', 'work', '--from-task', from, '--to-plan', 'work', '--to-task', to];

test('reopen with a started successor names it and the --override-reason route', async (context) => {
  const root = await fixture(context);
  for (const name of ['a', 'b']) {
    success(root, ['todo', 'start', ...task(name)]);
    success(root, ['todo', 'done', ...task(name)]);
  }
  const error = refused(root, ['todo', 'reopen', ...task('a'), '--reason', 'redo']);
  assert.equal(error.detail.reason, 'reopen_has_started_successor');
  assert.deepEqual(error.detail.started_successors, [{ plan_key: 'work', task_id: 'b', status: 'done' }]);
  assert.match(error.detail.next_action,
    /work\/b \(done\) already left pending.*`lattice todo reopen --plan work --task a --reason <text> --override-reason <text>`/u);
  assert.doesNotMatch(error.detail.next_action, /split/u);
  assert.equal(success(root, ['todo', 'reopen', ...task('a'), '--reason', 'redo', '--override-reason', 'b stays']).status,
    'in-progress');
});

test('phase accept/reject/reopen, evidence promote and independence compile name the missing flag', async (context) => {
  const root = await fixture(context);
  const cases = [
    [['phase', 'accept', '--plan', 'work', '--phase', 'p'], '--evidence',
      'lattice todo phase accept --plan work --phase p --evidence <file>'],
    [['phase', 'reject', '--plan', 'work', '--phase', 'p', '--evidence', 'e.md'], '--reason',
      'lattice todo phase reject --plan work --phase p --evidence e.md --reason <text>'],
    [['phase', 'reopen', '--plan', 'work', '--phase', 'p'], '--reason',
      'lattice todo phase reopen --plan work --phase p --reason <text>'],
    [['evidence', 'promote', '--plan', 'work', '--task', 'a'], '--evidence',
      'lattice todo evidence promote --plan work --task a --evidence <file>'],
    [['independence', 'compile', '--plan', 'work'], '--input',
      'lattice todo independence compile --plan work --input <file>'],
  ];
  for (const [args, pointer, command] of cases) {
    const error = refused(root, ['todo', ...args], 2);
    assert.deepEqual([error.detail.pointer, error.detail.rule], [pointer, 'flag_missing'], args.join(' '));
    assert.ok(error.detail.next_action.includes(command), error.detail.next_action);
  }
});

test('reads take --json as optional and name a flag that does not apply; groups name their subcommands', async (context) => {
  const root = await fixture(context);
  assert.equal(success(root, ['todo', 'show', '--task', 'a', '--plan', 'work']).task.task_id, 'a');
  assert.equal(success(root, ['todo', 'note', 'list', '--plan', 'work']).plan_key, 'work');
  success(root, ['todo', 'structure', '--plan', 'work']);

  const noTask = refused(root, ['todo', 'show', '--plan', 'work'], 2);
  assert.deepEqual([noTask.detail.pointer, noTask.detail.rule], ['--task', 'flag_missing']);
  assert.match(noTask.detail.next_action, /lattice plan show work --json/u);

  const status = refused(root, ['todo', 'status', '--plan', 'work'], 2);
  assert.deepEqual([status.detail.pointer, status.detail.rule], ['--plan', 'flag_unknown']);
  assert.match(status.detail.next_action, /does not apply to `lattice todo status` \(it takes --json\).*lattice plan show work --json/u);

  const bare = refused(root, ['todo'], 2);
  assert.equal(bare.detail.rule, 'subcommand_missing');
  assert.ok(bare.detail.available_commands.includes('status'));
  assert.match(bare.detail.next_action, /lattice todo status --json/u);

  const dependency = refused(root, ['todo', 'dependency'], 2);
  assert.deepEqual(dependency.detail.available_subcommands, ['connect', 'disconnect']);
  assert.match(dependency.detail.next_action, /lattice todo dependency connect --from-plan <from-plan>/u);
  const phase = refused(root, ['todo', 'phase', 'nope', '--plan', 'work'], 2);
  assert.deepEqual([phase.detail.pointer, phase.detail.rule], ['nope', 'subcommand_unknown']);
  assert.match(phase.detail.next_action, /lattice todo phase review --plan work --phase <phase> --reason <text>/u);
});

test('connecting an existing edge succeeds unchanged and names it', async (context) => {
  const root = await fixture(context);
  const existing = success(root, ['todo', 'dependency', 'connect', ...edge('a', 'b'), '--reason', 'again']);
  assert.equal(existing.unchanged, true);
  assert.match(existing.next_action, /work\/a -> work\/b already exists; nothing was recorded/u);
  success(root, ['todo', 'dependency', 'connect', ...edge('b', 'c'), '--reason', 'c needs b']);
  const again = success(root, ['todo', 'dependency', 'connect', ...edge('b', 'c'), '--reason', 'c needs b']);
  assert.deepEqual([again.unchanged, again.to.task_id], [true, 'c']);
});
