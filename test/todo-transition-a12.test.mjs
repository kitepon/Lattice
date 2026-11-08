// a12: order/state refusals use TODO_TRANSITION_REFUSED and name the blocker; a transition the
// task is already in succeeds with `unchanged: true` and no event; verify lists uncommitted evidence.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });

function run(root, args, agent = 'fixture') {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent } });
}
function success(root, args, agent) {
  const result = run(root, args, agent);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refused(root, args, agent) {
  const result = run(root, args, agent);
  assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}`);
  return JSON.parse(result.stderr);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a12-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# proof\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
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
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const journalLength = async (root) => {
  const manifest = JSON.parse(await readFile(path.join(root, '.lattice/todo/manifest.json'), 'utf8'));
  return (await readFile(path.join(root, manifest.members[0].journal_ref), 'utf8')).trim().split('\n').length;
};
const task = (name) => ['--plan', 'work', '--task', name];

test('an unfinished predecessor refusal names it and is not STORE_INCONSISTENT', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')]);
  const error = refused(root, ['todo', 'start', ...task('b')]);
  assert.equal(error.code, 'TODO_TRANSITION_REFUSED');
  assert.equal(error.detail.reason, 'invalid_start_transition');
  assert.equal(error.detail.cause, 'predecessor_unfinished');
  assert.deepEqual(error.detail.blocking_tasks, [{ plan_key: 'work', task_id: 'a', status: 'in-progress' }]);
  assert.match(error.detail.next_action, /work\/a \(in-progress\).*lattice todo show --plan work --task a --json/u);
  assert.equal(refused(root, ['todo', 'block', ...task('b'), '--reason', 'x']).detail.reason, 'invalid_block_transition');
});

test('repeated start, done, block and unblock succeed unchanged without an event', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')]);
  let length = await journalLength(root);
  const again = success(root, ['todo', 'start', ...task('a')]);
  assert.equal(again.unchanged, true);
  assert.equal(again.status, 'in-progress');
  // Another seat's in-progress task is not a repeat: still refused, nothing written.
  assert.equal(refused(root, ['todo', 'start', ...task('a')], 'other').detail.cause, 'task_state');
  assert.equal(success(root, ['todo', 'unblock', ...task('a')]).unchanged, true);
  assert.equal(await journalLength(root), length);
  success(root, ['todo', 'block', ...task('a'), '--reason', 'waiting']);
  length = await journalLength(root);
  const blocked = success(root, ['todo', 'block', ...task('a'), '--reason', 'waiting']);
  assert.deepEqual([blocked.unchanged, blocked.status, blocked.kind], [true, 'blocked', 'block']);
  assert.equal(await journalLength(root), length);
  success(root, ['todo', 'unblock', ...task('a')]);
  success(root, ['todo', 'done', ...task('a'), '--evidence', 'evidence.md']);
  length = await journalLength(root);
  const done = success(root, ['todo', 'done', ...task('a'), '--message', 'again']);
  assert.deepEqual([done.unchanged, done.status, done.kind], [true, 'done', 'done']);
  assert.equal(await journalLength(root), length);
});

test('verify lists message evidence waiting for a commit instead of refusing', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')]);
  success(root, ['todo', 'done', ...task('a'), '--message', 'checked by hand']);
  const result = success(root, ['todo', 'verify', '--json']);
  assert.equal(result.schema, 'lattice.todo_verify_result.v4');
  assert.equal(result.uncommitted_evidence.length, 1);
  const [item] = result.uncommitted_evidence;
  assert.deepEqual([item.plan_key, item.task_id], ['work', 'a']);
  assert.match(item.next_action, /^Commit \.lattice\/todo\/evidence\//u);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'store'], { cwd: root });
  assert.deepEqual(success(root, ['todo', 'verify', '--json']).uncommitted_evidence, []);
});
