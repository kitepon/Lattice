// a36: phase gate refusals, a reopen by another seat and a seat's own anonymous start each name
// the state and a next command that passes.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });
const BASE = { NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0' };

function env(home, extra) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LATTICE_')));
  return { ...clean, ...BASE, HOME: home, USERPROFILE: home, USER: 'quo', LOGNAME: 'quo', ...extra };
}
const seat = (agent) => ({ LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent });
function run(root, args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: env(path.join(root, '.home'), extra) });
}
function success(root, args, extra = seat('fixture')) {
  const result = run(root, args, extra);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refused(root, args, extra = seat('fixture')) {
  const result = run(root, args, extra);
  assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stderr);
}
/** Run the backticked command in a next_action, with `<...>` placeholders filled. */
function follow(root, nextAction, pattern, extra) {
  const command = nextAction.match(pattern)?.[1];
  assert.ok(command, nextAction);
  const args = command.replace(/^lattice /u, '').replace(/<file>/gu, 'audit.md').replace(/<text>/gu, 'a36').split(' ');
  return success(root, args, extra);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a36-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '--quiet');
  git('config', 'user.email', 'a36@example.invalid');
  git('config', 'user.name', 'a36');
  const input = { schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-11-08T00:00:00.000Z',
    tasks: ['a', 'b'].map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      done_condition: null, narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [{ from: ref('a'), to: ref('b') }], joins: [], phase_accept_dependencies: [],
    input_digest: '' };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(input));
  await writeFile(path.join(root, 'audit.md'), '# audit\n');
  git('add', 'audit.md');
  git('commit', '--quiet', '-m', 'audit');
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const task = (id) => ['--plan', 'work', '--task', id];
const finish = (root, id, extra) => {
  success(root, ['todo', 'start', ...task(id)], extra);
  success(root, ['todo', 'done', ...task(id), '--message', `${id} done`], extra);
};

test('phase review and close-unaudited outside gate_ready name the phase state and a passing command', async (context) => {
  const root = await fixture(context);
  const early = refused(root, ['todo', 'phase', 'review', '--plan', 'work', '--phase', 'p', '--reason', 'r']);
  assert.equal(early.code, 'TODO_TRANSITION_REFUSED');
  assert.deepEqual([early.detail.rule, early.detail.phase_status], ['phase_gate_not_ready', 'active']);
  assert.match(early.detail.next_action, /lattice todo status --json/u);

  finish(root, 'a');
  finish(root, 'b');
  success(root, ['todo', 'phase', 'review', '--plan', 'work', '--phase', 'p', '--reason', 'r']);
  const late = refused(root, ['todo', 'phase', 'close-unaudited', '--plan', 'work', '--phase', 'p', '--reason', 'r']);
  assert.equal(late.code, 'TODO_TRANSITION_REFUSED');
  assert.equal(late.detail.phase_status, 'reviewing');
  assert.match(late.detail.next_action, /phase accept --plan work --phase p --evidence <file>/u);

  const [phase] = success(root, ['todo', 'phase', 'status', '--plan', 'work']).phases;
  assert.match(phase.guidance, /phase accept --plan work --phase p --evidence <file>/u);
  const [pending] = success(root, ['todo', 'status', '--json']).audit_pending;
  assert.deepEqual(pending.next_commands, [
    'lattice todo phase accept --plan work --phase p --evidence <file>',
    'lattice todo phase reject --plan work --phase p --reason <text> --evidence <file>',
  ]);
  assert.equal(follow(root, late.detail.next_action, /`(lattice todo phase accept [^`]+)`/u).status, 'accepted');
});

// retract-anyone (supersedes the a36 holder hint): a reopened task is unstarted; any seat redoes it with a start.
test('a reopen returns the task to unstarted and names the start that redoes it', async (context) => {
  const root = await fixture(context);
  finish(root, 'a', seat('other-seat'));
  const reopened = success(root, ['todo', 'reopen', ...task('a'), '--reason', 'found bug'], seat('walk-seat'));
  assert.equal(reopened.status, 'pending');
  const moved = follow(root, reopened.next_action, /`(lattice todo start [^`]+)`/u, seat('walk-seat'));
  assert.equal(moved.status, 'in-progress');
  const own = success(root, ['session-context', '--json'], seat('walk-seat')).turn.own;
  assert.deepEqual(own.map(({ task_id: id }) => id), ['a']);
});

test("a seat's start over its own anonymous start says so and gives the one-time fix", async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')], {});
  const named = refused(root, ['todo', 'start', ...task('a')], { LATTICE_SEAT_ID: 'seat-a' });
  assert.equal(named.detail.started_by, 'quo');
  assert.match(named.detail.next_action, /without LATTICE_SEAT_ID/u);
  follow(root, named.detail.next_action, /`(lattice todo retract [^`]+)`/u, {});
  assert.equal(success(root, ['todo', 'start', ...task('a')], { LATTICE_SEAT_ID: 'seat-a' }).status, 'in-progress');
  // A start held by a different named seat keeps the other-seat wording.
  const other = refused(root, ['todo', 'start', ...task('a')], { LATTICE_SEAT_ID: 'seat-b' });
  assert.match(other.detail.next_action, /under seat 'seat-a'.*--rebind/u);
});
