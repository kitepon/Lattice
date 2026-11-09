// a23: the remaining refusals name the missing flag, the dropped value or the valid tasks and the
// next command; evidence outside the repo is refused with a text that matches plan input (a17).

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
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a23-'));
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

test('phase review/close-unaudited, split and note name the missing flag and the full command', async (context) => {
  const root = await fixture(context);
  const cases = [
    [['phase', 'review', '--plan', 'work', '--phase', 'p'], '--reason',
      'lattice todo phase review --plan work --phase p --reason <text>'],
    [['phase', 'close-unaudited', '--plan', 'work', '--phase', 'p'], '--reason',
      'lattice todo phase close-unaudited --plan work --phase p --reason <text>'],
    [['split', '--plan', 'work'], '--input', 'lattice todo split --plan work --input <file>'],
    [['note', '--plan', 'work', '--task', 'a'], '--message', 'lattice todo note --plan work --task a --message <text>'],
  ];
  for (const [args, pointer, command] of cases) {
    const error = refused(root, ['todo', ...args], 2);
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.deepEqual([error.detail.pointer, error.detail.rule], [pointer, 'flag_missing']);
    assert.ok(error.detail.next_action.includes(command), error.detail.next_action);
  }
  const both = refused(root, ['todo', 'note', ...task('a'), '--message', 'x', '--input', 'n.md'], 2);
  assert.deepEqual([both.detail.pointer, both.detail.rule], ['--input', 'flags_exclusive']);
  // Flags are read by name, in any order: the call reaches the phase gate instead of an argument refusal.
  assert.equal(refused(root, ['todo', 'phase', 'review', '--reason', 'look', '--phase', 'p', '--plan', 'work'])
    .detail.reason, 'phase_gate_not_ready');
});

test('a repeated block, retire or done names only content that differs from the record', async (context) => {
  const root = await fixture(context);
  success(root, ['todo', 'start', ...task('a')]);
  success(root, ['todo', 'block', ...task('a'), '--reason', 'wait']);
  assert.equal(success(root, ['todo', 'block', ...task('a'), '--reason', 'wait']).not_recorded, undefined);
  const block = success(root, ['todo', 'block', ...task('a'), '--reason', 'other']);
  assert.equal(block.unchanged, true);
  assert.deepEqual(block.not_recorded, ['--reason']);
  assert.match(block.next_action, /lattice todo unblock --plan work --task a`, then `lattice todo block --plan work --task a --reason <text>/u);
  success(root, ['todo', 'unblock', ...task('a')]);

  await writeFile(path.join(root, 'proof.md'), 'proof\n');
  success(root, ['todo', 'done', ...task('a'), '--evidence', 'proof.md']);
  assert.equal(success(root, ['todo', 'done', ...task('a'), '--evidence', 'proof.md']).not_recorded, undefined);
  await writeFile(path.join(root, 'proof.md'), 'changed\n');
  assert.deepEqual(success(root, ['todo', 'done', ...task('a'), '--evidence', 'proof.md']).not_recorded, ['--evidence']);

  await writeFile(path.join(root, 'proof.md'), 'proof\n');
  success(root, ['todo', 'start', ...task('c')]);
  success(root, ['todo', 'done', ...task('c'), '--message', 'ok', '--evidence', 'proof.md']);
  assert.equal(success(root, ['todo', 'done', ...task('c'), '--message', 'ok', '--evidence', 'proof.md']).not_recorded, undefined);
  assert.deepEqual(success(root, ['todo', 'done', ...task('c'), '--message', 'ok!', '--evidence', 'proof.md']).not_recorded,
    ['--message', '--evidence']);

  success(root, ['todo', 'retire', ...task('b'), '--reason', 'gone']);
  assert.equal(success(root, ['todo', 'retire', ...task('b'), '--reason', 'gone']).not_recorded, undefined);
  const retire = success(root, ['todo', 'retire', ...task('b'), '--reason', 'really gone']);
  assert.deepEqual(retire.not_recorded, ['--reason']);
  assert.match(retire.next_action, /already retired \(permanent\); --reason not recorded.*lattice todo note --plan work --task b/u);
});

test('dependency refusals name the edge or the task and a command that lists valid ones', async (context) => {
  const root = await fixture(context);
  const exists = refused(root, ['todo', 'dependency', 'connect', ...edge('a', 'b'), '--reason', 'again']);
  assert.equal(exists.code, 'DEPENDENCY_EXISTS');
  assert.equal(exists.detail.pointer, '--to-task');
  assert.match(exists.detail.next_action, /work\/a -> work\/b already exists.*lattice plan show work --json/u);

  const self = refused(root, ['todo', 'dependency', 'connect', ...edge('a', 'a'), '--reason', 'self']);
  assert.equal(self.detail.reason, 'dependency_self_reference');
  assert.equal(self.detail.pointer, '--to-task');
  assert.match(self.detail.next_action, /same task work\/a; a task cannot depend on itself.*lattice plan show work --json/u);

  const nope = refused(root, ['todo', 'dependency', 'connect', ...edge('a', 'nope'), '--reason', 'x']);
  assert.equal(nope.detail.reason, 'dependency_task_not_found');
  assert.equal(nope.detail.pointer, '--to-task');
  assert.match(nope.detail.next_action, /No task 'nope' in plan work: run `lattice plan show work --json`/u);
  assert.equal(refused(root, ['todo', 'dependency', 'connect', ...edge('nope', 'c'), '--reason', 'x']).detail.pointer,
    '--from-task');
});

test('note and test-result read a file outside the repo; evidence outside it says why it is refused', async (context) => {
  const root = await fixture(context);
  const outside = await mkdtemp(path.join(tmpdir(), 'lattice-a23-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'note.md'), 'from outside\n');
  success(root, ['todo', 'note', ...task('a'), '--input', path.join(outside, 'note.md')]);

  success(root, ['todo', 'start', ...task('a')]);
  const evidence = refused(root, ['todo', 'done', ...task('a'), '--evidence', path.join(outside, 'note.md')]);
  assert.equal(evidence.detail.reason, 'input_path_outside_repo');
  assert.match(evidence.detail.next_action, /git blob.*repo内へ写してから渡すか、本文を --message <text> で渡す/u);

  await writeFile(path.join(outside, 'result.md'), '# tests\n\n3 pass\n');
  success(root, ['todo', 'start', ...task('c')]);
  success(root, ['todo', 'done', ...task('c'), '--test-result', path.join(outside, 'result.md')]);
  assert.equal(success(root, ['todo', 'done', ...task('c'), '--test-result', path.join(outside, 'result.md')])
    .not_recorded, undefined);

  const missingPlanInput = refused(root, ['plan', 'revise', '--input', path.join(outside, 'none.json'), '--json']);
  assert.equal(missingPlanInput.detail.reason, 'input_missing');
  assert.doesNotMatch(missingPlanInput.detail.next_action, /repo内/u);
});
