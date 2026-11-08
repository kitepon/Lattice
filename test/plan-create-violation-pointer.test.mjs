// plan create の入力違反は、通否でなく「どこがどう違うか」で返す。
// pointer `/` と validation: failed だけでは、author は違反箇所を探して手戻りする。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-create-pointer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

function draft(mutate = (value) => value) {
  const task = {
    task_id: 't1', title: '仕事', lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'p1',
  };
  const value = mutate({
    schema: 'lattice.plan_create_input.v4', project_id: 'probe', plan_key: 'main',
    plan_version: 'v1', actor: { host: 'h', session: 's', agent: 'a' },
    recorded_at: new Date().toISOString(),
    tasks: [task], hard_dependencies: [], joins: [],
    phases: [{
      phase_id: 'p1', title: 'P', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'],
    }],
    phase_accept_dependencies: [], input_digest: '',
  });
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

async function reject(context, mutate) {
  const root = await workspace(context);
  await writeFile(path.join(root, 'draft.json'), `${JSON.stringify(draft(mutate))}\n`);
  const execution = spawnSync(process.execPath, [CLI, 'plan', 'create', '--input', 'draft.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.notEqual(execution.status, 0, execution.stdout);
  return JSON.parse(execution.stdout || execution.stderr).detail;
}

test('証跡slotが空のPhaseは、そのPhaseのslotをpointerで名指しする', async (context) => {
  const detail = await reject(context, (value) => {
    value.phases[0].required_evidence_slots = [];
    return value;
  });
  assert.equal(detail.reason, 'plan_create_schema_invalid');
  assert.equal(detail.pointer, '/phases/0/required_evidence_slots');
  assert.equal(detail.violation_kind, 'empty');
  assert.equal(detail.expected.min_items, 1);
});

test('同じtask_idで内容が違えば、落ちたindexと直前の値を返す', async (context) => {
  const detail = await reject(context, (value) => {
    const [task] = value.tasks;
    value.tasks = [{ ...task, task_id: 't1' }, { ...task, task_id: 't1', title: 'other' }];
    return value;
  });
  assert.equal(detail.pointer, '/tasks/1/task_id');
  assert.equal(detail.violation_kind, 'unsorted');
  assert.equal(detail.expected.greater_than, 't1');
});

test('task_idの順序違反は機械が並べ替えて受理する(u03p)', async (context) => {
  const root = await workspace(context);
  const value = draft((input) => {
    const [task] = input.tasks;
    input.tasks = [{ ...task, task_id: 't2' }, { ...task, task_id: 't1' }];
    return input;
  });
  await writeFile(path.join(root, 'draft.json'), `${JSON.stringify(value)}\n`);
  const execution = spawnSync(process.execPath, [CLI, 'plan', 'create', '--input', 'draft.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(execution.status, 0, execution.stderr);
});

test('存在しないphase_idを指すtaskは、選べるphase_idを添えて拒否する', async (context) => {
  const detail = await reject(context, (value) => {
    value.tasks[0].phase_id = 'nope';
    return value;
  });
  assert.equal(detail.pointer, '/tasks/0/phase_id');
  assert.equal(detail.violation_kind, 'unknown_reference');
  assert.deepEqual(detail.expected.one_of, ['p1']);
});

test('actorのidentifier違反は、どのfieldかまで指す', async (context) => {
  const detail = await reject(context, (value) => {
    value.actor.session = '';
    return value;
  });
  assert.equal(detail.pointer, '/actor/session');
  assert.equal(detail.violation_kind, 'identifier_invalid');
});

test('入力に無関係なkeyが混ざれば、期待するkey一覧を返す', async (context) => {
  const detail = await reject(context, (value) => ({ ...value, stray: 1 }));
  assert.equal(detail.pointer, '/');
  assert.equal(detail.violation_kind, 'unexpected_or_missing_keys');
  assert.ok(detail.actual.keys.includes('stray'));
});

test('hard dependenciesの順序違反は機械が並べ替え、循環はfieldと規則を返す', async (context) => {
  const detail = await reject(context, (value) => {
    const [task] = value.tasks;
    value.tasks = ['a', 'b', 'c'].map((task_id) => ({ ...task, task_id }));
    const ref = (task_id) => ({ project_id: value.project_id, plan_key: value.plan_key, task_id });
    value.hard_dependencies = [
      { from: ref('c'), to: ref('a') }, { from: ref('a'), to: ref('b') }, { from: ref('b'), to: ref('c') },
    ];
    return value;
  });
  assert.equal(detail.reason, 'dispatch_shape_dependency_cycle');
});
