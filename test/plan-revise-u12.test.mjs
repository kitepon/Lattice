// u12: 作成者が書いた手順の改訂は、進行中・完了済みでも受け付ける（carry pre-checkなし）。
// 軽量路のphase移行規則、履歴note、公開後のnote失敗の報告を確かめる。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compileLightPhaseMigration, planRevisionHistoryNotes } from '../src/plan-revise.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });

function desired(ids, mutate = (value) => value) {
  return mutate({
    schema: 'lattice.plan_create_input.v5', project_id: 'example', plan_key: 'work', plan_version: 'v1',
    actor: { host: 'fixture', session: 'fixture', agent: 'fixture' }, recorded_at: '2026-11-08T00:00:00.000Z',
    tasks: ids.map((task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
      done_condition: null, narrative_ref: null, narrative_anchor: null, parent_task_id: null,
      compile_binding: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] });
}
const decision = (task_id, policy, reason = `explicit ${policy}`) => ({ task_id, policy, reason });
function run(root, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_TODO_ACTOR_HOST: 'fixture',
      LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture', ...env } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-revise-u12-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# proof\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(desired(['a', 'b', 'c'])));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'a', '--evidence', 'evidence.md']);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  return root;
}
async function revise(root, input, args = []) {
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(input));
  return run(root, ['plan', 'revise', '--input', 'revise.json', ...args, '--json']);
}
const notes = (root) => success(root, ['todo', 'note', 'list', '--plan', 'work', '--json']);
const bodies = (list) => list.notes.map(({ body }) => body);

test('carry keeps done and in-progress state through title, done_condition and edge changes, and records notes', async (context) => {
  const root = await fixture(context);
  const input = {
    schema: 'lattice.plan_revise_input.v1',
    desired: desired(['a', 'b', 'd'], (value) => {
      value.tasks[0].title = '改題した完了済み';
      value.tasks[0].done_condition = '新しい終了条件';
      // done済みaが未完のdを先行に持つ。doneは保たれ、bのdoneはdが終わるまで拒否される。
      value.tasks[1].design_memo = '書き換えた設計メモ';
      value.hard_dependencies = [{ from: ref('d'), to: ref('a') }, { from: ref('d'), to: ref('b') }];
      return value;
    }),
    continuity: [decision('a', 'carry', '完了済みの文面を直す'), decision('b', 'carry', '進行中の依存を足す'),
      decision('c', 'retire', '不要になった')],
  };
  const result = await revise(root, input);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const successor = JSON.parse(result.stdout);
  const from = 'v1';
  const to = successor.plan_version;
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']).state.status, 'done');
  const shownB = success(root, ['todo', 'show', '--plan', 'work', '--task', 'b', '--json']);
  assert.equal(shownB.state.status, 'in-progress');
  const refusedDone = run(root, ['todo', 'done', '--plan', 'work', '--task', 'b', '--evidence', 'evidence.md']);
  assert.notEqual(refusedDone.status, 0);
  assert.equal(JSON.parse(refusedDone.stderr).detail.reason, 'invalid_done_transition');

  const aNotes = bodies(success(root, ['todo', 'note', 'list', '--plan', 'work', '--task', 'a', '--json']));
  assert.ok(aNotes.includes(
    `plan revise ${from}→${to} a: 完了済みの文面を直す\nchanged: title, done_condition, incoming_hard_dependencies`), aNotes.join('|'));
  const bNotes = bodies(success(root, ['todo', 'note', 'list', '--plan', 'work', '--task', 'b', '--json']));
  assert.ok(bNotes.includes(
    `plan revise ${from}→${to} b: 進行中の依存を足す\nchanged: design_memo, incoming_hard_dependencies`), bNotes.join('|'));
  assert.ok(bodies(notes(root)).includes(`plan revise ${from}→${to} c: 不要になった`));
});

test('a sorted/duplicated equal v5 desired set is plan_revise_unchanged', async (context) => {
  const root = await fixture(context);
  const base = desired(['a', 'b', 'c'], (value) => {
    value.hard_dependencies = [{ from: ref('a'), to: ref('b') }];
    return value;
  });
  const carry = ['a', 'b', 'c'].map((id) => decision(id, 'carry'));
  const first = await revise(root, { schema: 'lattice.plan_revise_input.v1', desired: base, continuity: carry });
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(JSON.parse(first.stdout).schema, 'lattice.plan_revise_result.v1');
  const shuffled = structuredClone(base);
  shuffled.hard_dependencies = [...base.hard_dependencies, ...base.hard_dependencies];
  const second = await revise(root, { schema: 'lattice.plan_revise_input.v1', desired: shuffled, continuity: carry });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.equal(JSON.parse(second.stdout).schema, 'lattice.plan_revise_unchanged.v1');
});

test('v4 desired on a v8 plan keeps each task done_condition', async (context) => {
  const root = await fixture(context);
  const carry = ['a', 'b', 'c'].map((id) => decision(id, 'carry'));
  const withCondition = desired(['a', 'b', 'c'], (value) => { value.tasks[1].done_condition = '残す条件'; return value; });
  assert.equal((await revise(root, { schema: 'lattice.plan_revise_input.v1', desired: withCondition,
    continuity: carry })).status, 0);
  const v4 = desired(['a', 'b', 'c'], (value) => {
    value.schema = 'lattice.plan_create_input.v4';
    for (const task of value.tasks) delete task.done_condition;
    return value;
  });
  const result = await revise(root, { schema: 'lattice.plan_revise_input.v1', desired: v4, continuity: carry });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).schema, 'lattice.plan_revise_unchanged.v1');
});

test('dry-run appends no history note', async (context) => {
  const root = await fixture(context);
  const input = { schema: 'lattice.plan_revise_input.v1',
    desired: desired(['a', 'b', 'c'], (value) => { value.tasks[0].title = '改題'; return value; }),
    continuity: ['a', 'b', 'c'].map((id) => decision(id, 'carry')) };
  assert.equal((await revise(root, input, ['--dry-run'])).status, 0);
  assert.deepEqual(notes(root).notes, []);
});

test('a note failure after publication reports revision_applied, pending notes and exact commands', async (context) => {
  const root = await fixture(context);
  const noteDir = path.join(root, '.lattice/todo/notes/work');
  await mkdir(noteDir, { recursive: true });
  await writeFile(path.join(noteDir, 'plan-active.jsonl'), 'not json\n');
  const input = { schema: 'lattice.plan_revise_input.v1',
    desired: desired(['a', 'b'], (value) => { value.tasks[0].title = '改題'; return value; }),
    continuity: [decision('a', 'carry', "it's changed"), decision('b', 'carry'), decision('c', 'retire', '不要')] };
  const failed = await revise(root, input);
  assert.notEqual(failed.status, 0);
  const error = JSON.parse(failed.stderr);
  assert.equal(error.detail.revision_applied, true);
  assert.match(error.detail.plan_version, /^rev-/u);
  assert.equal(error.detail.pending_history_notes.length, 1);
  assert.equal(error.detail.pending_history_notes[0].task_id, 'c');
  assert.match(error.detail.pending_history_notes[0].body, /^plan revise v1→rev-[0-9a-f]+ c: 不要$/u);
  assert.match(error.detail.pending_history_note_commands[0],
    /^lattice todo note --plan work --message 'plan revise v1→rev-[0-9a-f]+ c: 不要'$/u);
  // 先に書けたtask noteは再実行対象に入らない。
  const lines = (await readFile(path.join(noteDir, 'active.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].task_id, 'a');
  assert.match(lines[0].body, /a: it's changed\nchanged: title$/u);
});

test('a v5 desired revises a v7 plan into plan v8', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-revise-u12-v7-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const v4 = desired(['a', 'b'], (value) => {
    value.schema = 'lattice.plan_create_input.v4';
    for (const task of value.tasks) delete task.done_condition;
    return value;
  });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(v4));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(success(root, ['plan', 'show', 'work', '--json']).plan_schema, 'lattice.todo_plan.v7');
  const v5 = desired(['a', 'b'], (value) => { value.tasks[0].done_condition = '条件'; return value; });
  const result = await revise(root, { schema: 'lattice.plan_revise_input.v1', desired: v5,
    continuity: ['a', 'b'].map((id) => decision(id, 'carry')) });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const shown = success(root, ['plan', 'show', 'work', '--json']);
  assert.equal(shown.plan_schema, 'lattice.todo_plan.v8');
});

// --- pure rules -----------------------------------------------------------

const phase = (phase_id, extra = {}) => ({ phase_id, title: phase_id, gate_policy: 'heavy',
  predecessor_phase_ids: [], required_evidence_slots: ['proof'], ...extra });
const plannedTask = (task_id, phase_id) => ({ task_id, phase_id });
const migration = (rows) => rows.map(([id, state_policy]) => ({ from_task_id: id,
  to_task_id: state_policy === 'removed' ? 'removed' : id, state_policy }));
const carry = 'carry_reconciled_metadata';

test('phase migration: carry unless the definition changed or an unfinished task arrives', () => {
  const previous = { tasks: [plannedTask('a', 'p'), plannedTask('b', 'p'), plannedTask('x', 'q')],
    phases: [phase('p'), phase('q')] };
  const states = new Map([['a', 'done'], ['b', 'in-progress'], ['x', 'pending']]);
  const plan = (tasks, phases) => ({ tasks, phases });
  const policyOf = (rows) => Object.fromEntries(rows.map((row) => [row.to_phase_id, row.state_policy]));
  // 文面だけの変更・task失う: 持ち越し
  assert.deepEqual(policyOf(compileLightPhaseMigration(previous,
    plan([plannedTask('a', 'p'), plannedTask('x', 'q')], previous.phases),
    migration([['a', carry], ['b', 'removed'], ['x', carry]]), states)), { p: 'carry', q: 'carry' });
  // 新規(pending)taskを迎えるphaseはreset
  assert.equal(policyOf(compileLightPhaseMigration(previous,
    plan([...previous.tasks, plannedTask('n', 'q')], previous.phases),
    migration([['a', carry], ['b', carry], ['x', carry]]), states)).q, 'reset');
  // 完了済みtaskだけを迎えるphaseは持ち越し（aがqへ移る）
  assert.deepEqual(policyOf(compileLightPhaseMigration(previous,
    plan([plannedTask('a', 'q'), plannedTask('b', 'p'), plannedTask('x', 'q')], previous.phases),
    migration([['a', carry], ['b', carry], ['x', carry]]), states)), { p: 'carry', q: 'carry' });
  // 進行中taskを迎えるphaseはreset
  assert.equal(policyOf(compileLightPhaseMigration(previous,
    plan([plannedTask('a', 'p'), plannedTask('b', 'q'), plannedTask('x', 'q')], previous.phases),
    migration([['a', carry], ['b', carry], ['x', carry]]), states)).q, 'reset');
  // resetするtaskを含むphaseはreset
  assert.equal(policyOf(compileLightPhaseMigration(previous, plan(previous.tasks, previous.phases),
    migration([['a', carry], ['b', 'reset_pending'], ['x', carry]]), states)).p, 'reset');
  // phase定義の変更はreset、削除はremoved、新phaseはreset
  const redefined = compileLightPhaseMigration(previous, plan(previous.tasks.slice(0, 2).concat([plannedTask('x', 'r')]),
    [phase('p', { title: 'renamed' }), phase('r')]), migration([['a', carry], ['b', carry], ['x', carry]]), states);
  assert.deepEqual(redefined, [
    { from_phase_id: 'p', to_phase_id: 'p', state_policy: 'reset' },
    { from_phase_id: 'q', to_phase_id: 'removed', state_policy: 'removed' },
    { from_phase_id: null, to_phase_id: 'r', state_policy: 'reset' }]);
});

test('history notes list only changed carried tasks and removed tasks, with the exact changed fields', () => {
  const task = (id, extra = {}) => ({ task_id: id, title: id, lane: 'main', design_memo: 'm',
    done_condition: null, narrative_ref: null, parent_task_id: null, phase_id: 'p', ...extra });
  const plan = (version, tasks, extra = {}) => ({ plan_key: 'k', plan_version: version, tasks,
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], ...extra });
  const edge = { from: { project_id: 'x', plan_key: 'k', task_id: 'a' }, to: { project_id: 'x', plan_key: 'k', task_id: 'b' } };
  const join = { id: 'j', after: [edge.from], before: edge.to };
  const result = planRevisionHistoryNotes({
    previousPlan: plan('v1', [task('a'), task('b'), task('c'), task('d')]),
    successorPlan: plan('v2', [task('a', { lane: 'other', phase_id: 'q' }), task('b'), task('c'),
      task('d', { done_condition: '条件' })], { hard_dependencies: [edge], joins: [join] }),
    continuity: [decision('d', 'carry', 'r4'), decision('c', 'reset', 'r3'),
      decision('b', 'carry', 'r2'), decision('a', 'carry', 'r1'), decision('e', 'retire', 'r5')],
  });
  assert.deepEqual(result, [
    { scope: 'task', task_id: 'a', body: 'plan revise v1→v2 a: r1\nchanged: lane, phase_id, outgoing_hard_dependencies, join_memberships' },
    { scope: 'task', task_id: 'b', body: 'plan revise v1→v2 b: r2\nchanged: incoming_hard_dependencies, join_memberships' },
    { scope: 'task', task_id: 'd', body: 'plan revise v1→v2 d: r4\nchanged: done_condition' },
    { scope: 'plan', task_id: 'e', body: 'plan revise v1→v2 e: r5' }]);
});

test('planSeed emits v8 for v5 input or a v8 predecessor and inherits unwritten done_condition', async () => {
  const { planSeed } = await import('../src/plan-backchain.mjs');
  const v5 = desired(['a', 'b'], (value) => { value.tasks[0].done_condition = '条件'; return value; });
  assert.equal(planSeed(v5, null).schema, 'lattice.todo_plan.v8');
  const v4 = desired(['a', 'b', 'n'], (value) => {
    value.schema = 'lattice.plan_create_input.v4';
    for (const task of value.tasks) delete task.done_condition;
    return value;
  });
  assert.equal(planSeed(v4, null).schema, 'lattice.todo_plan.v7');
  assert.equal(Object.hasOwn(planSeed(v4, null).tasks[0], 'done_condition'), false);
  const predecessor = { schema: 'lattice.todo_plan.v8', tasks: [
    { task_id: 'a', done_condition: '残す' }, { task_id: 'b', done_condition: null }] };
  const seed = planSeed(v4, 'd'.repeat(64), predecessor);
  assert.equal(seed.schema, 'lattice.todo_plan.v8');
  assert.deepEqual(seed.tasks.map((task) => task.done_condition), ['残す', null, null]);
});
