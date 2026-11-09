// a18: a refusal names the missing flag, the task that causes it and the next command, with a
// code of its kind; a result that records nothing (repeated done) or changes dependents says so.

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
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a18-'));
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

test('a write without --reason names --reason and the full command', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')]);
  for (const command of ['block', 'retire', 'reopen']) {
    const error = refused(root, ['todo', command, ...task('a')], 2);
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.deepEqual([error.detail.pointer, error.detail.rule], ['--reason', 'flag_missing']);
    assert.match(error.detail.next_action, new RegExp(`lattice todo ${command} --plan work --task a --reason <text>`, 'u'));
  }
  const dependency = refused(root, ['todo', 'dependency', 'connect', ...edge('a', 'c')], 2);
  assert.equal(dependency.code, 'INVALID_ARGUMENTS');
  assert.equal(dependency.detail.pointer, '--reason');
  assert.match(dependency.detail.next_action,
    /lattice todo dependency connect --from-plan work --from-task a --to-plan work --to-task c --reason <text>/u);
  assert.ok(refused(root, ['todo', 'nope'], 2).detail.available_commands.includes('dependency'));
  // Flags are read by name, in any order.
  success(root, ['todo', 'dependency', 'connect', '--reason', 'needs a', '--to-task', 'c', '--to-plan', 'work',
    '--from-task', 'a', '--from-plan', 'work']);
});

test('start refusals name the blocker and the command that moves it on', async (context) => {
  const root = await fixture(context);
  const pending = refused(root, ['todo', 'start', ...task('b')]);
  assert.match(pending.detail.next_action, /Start work\/a \(pending\) first with `lattice todo start --plan work --task a`/u);
  success(root, ['todo', 'start', ...task('a')]);
  success(root, ['todo', 'block', ...task('a'), '--reason', 'review']);
  assert.match(refused(root, ['todo', 'start', ...task('a')]).detail.next_action,
    /blocked: run `lattice todo unblock --plan work --task a`/u);
  assert.match(refused(root, ['todo', 'start', ...task('b')]).detail.next_action,
    /Unblock work\/a \(blocked\) with `lattice todo unblock --plan work --task a`/u);
  success(root, ['todo', 'unblock', ...task('a')]);
  success(root, ['todo', 'done', ...task('a'), '--message', 'first']);
  assert.match(refused(root, ['todo', 'start', ...task('a')]).detail.next_action,
    /done: to work on it again run `lattice todo reopen --plan work --task a --reason <text>`/u);
  // A repeated done records nothing and says so.
  const again = success(root, ['todo', 'done', ...task('a'), '--message', 'second']);
  assert.equal(again.unchanged, true);
  assert.deepEqual(again.not_recorded, ['--message']);
  assert.match(again.next_action, /lattice todo note --plan work --task a --message <text>/u);
  assert.equal(success(root, ['todo', 'done', ...task('a')]).not_recorded, undefined);
});

test('a cycle, a missing edge and a retire with dependents name their tasks', async (context) => {
  const root = await fixture(context);
  const cycle = refused(root, ['todo', 'dependency', 'connect', ...edge('b', 'a'), '--reason', 'cycle']);
  assert.equal(cycle.code, 'DEPENDENCY_CYCLE');
  assert.equal(cycle.detail.reason, 'dependency_cycle');
  assert.deepEqual(cycle.detail.cycle.map(({ task_id: id }) => id).sort(), ['a', 'a', 'b']);
  assert.match(cycle.detail.next_action, /work\/b -> work\/a would close a cycle \(work\/[ab] -> work\/[ab] -> work\/[ab]\)/u);

  const missing = refused(root, ['todo', 'dependency', 'disconnect', ...edge('c', 'b'), '--reason', 'drop']);
  assert.equal(missing.code, 'DEPENDENCY_NOT_FOUND');
  assert.equal(missing.detail.reason, 'dependency_not_found');
  assert.deepEqual(missing.detail.predecessors, ['a']);
  assert.match(missing.detail.next_action, /no dependency c -> b \(b depends on a\).*lattice plan show work --json/u);

  const retired = success(root, ['todo', 'retire', ...task('a'), '--reason', 'not needed']);
  assert.deepEqual(retired.dependents, [{ plan_key: 'work', task_id: 'b', status: 'pending' }]);
  assert.match(retired.next_action, /work\/b \(pending\) no longer wait on work\/a/u);
  const shown = success(root, ['plan', 'show', 'work', '--json']);
  assert.equal(shown.tasks.find(({ task_id: id }) => id === 'b').depends_on_count, 0);
});
