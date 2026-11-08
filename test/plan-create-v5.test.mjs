// u12: plan_create_input.v5 = v4 + 作成者が書く終了条件`done_condition`、
// および v5 入力だけが受ける「順序に意味が無い集合」の正準化。
// 「[Store v8]」と付いたtestは、ルドミラのStore枝（lattice.todo_plan.v8登録）が要る。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { explainTodoOrder, todoSelfDigest } from '../src/todo-contracts.mjs';
import { repairAuthoringArtifact } from '../src/todo-authoring-input.mjs';
import { validatePlanCreateInput } from '../src/project-cli.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ref = (task_id) => ({ project_id: 'probe', plan_key: 'main', task_id });
const phaseRef = (phase_id) => ({ project_id: 'probe', plan_key: 'main', phase_id });

function task(task_id, extra = {}) {
  return {
    task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN', done_condition: null,
    narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null,
    phase_id: 'p1', ...extra,
  };
}

function draft(mutate = (value) => value) {
  const value = mutate({
    schema: 'lattice.plan_create_input.v5', project_id: 'probe', plan_key: 'main',
    plan_version: 'v1', actor: { host: 'h', session: 's', agent: 'a' },
    recorded_at: '2026-11-08T00:00:00.000Z',
    tasks: [task('t1'), task('t2')], hard_dependencies: [], joins: [],
    phases: [{ phase_id: 'p1', title: 'P', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'] }],
    phase_accept_dependencies: [], input_digest: '',
  });
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

function rejection(input) {
  try { validatePlanCreateInput(input); } catch (error) { return error; }
  return assert.fail('input was accepted');
}

test('v5 schema is served by --schema-version 5', () => {
  const run = spawnSync(process.execPath, [CLI, 'plan', 'create', '--schema-version', '5', '--json'],
    { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const schema = JSON.parse(run.stdout);
  assert.equal(schema.title, 'lattice.plan_create_input.v5');
  assert.deepEqual(schema.$defs.task.required.includes('done_condition'), true);
  const bare = spawnSync(process.execPath, [CLI, 'plan', 'create', '--schema', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(bare.stdout).title, 'lattice.plan_create_input.v4');
});

for (const [label, value, kind] of [
  ['blank', '   ', 'blank'],
  ['non-string', 5, 'type'],
  ['control character', 'a\u0000b', 'forbidden_control'],
  ['too large', 'x'.repeat(20_000), 'too_large'],
  ['missing key', undefined, 'type'],
]) {
  test(`v5 rejects ${label} done_condition at /tasks/<i>/done_condition`, () => {
    const input = draft((draftValue) => {
      if (value === undefined) delete draftValue.tasks[1].done_condition;
      else draftValue.tasks[1].done_condition = value;
      return draftValue;
    });
    const error = rejection(input);
    assert.equal(error.code, 'INPUT_INVALID');
    assert.equal(error.detail.pointer, '/tasks/1/done_condition');
    assert.equal(error.detail.violation_kind, kind);
  });
}

test('v5 string and null done_condition pass the text rule (shape errors come from the plan builder)', () => {
  for (const done of ['全テストが通る', null]) {
    const input = draft((value) => { value.tasks[0].done_condition = done; return value; });
    try { validatePlanCreateInput(input); } catch (error) {
      // Store v8が未登録の間はplan builderが拒否する。text規則の拒否ではないことだけを確かめる。
      assert.notEqual(error.detail?.pointer, '/tasks/0/done_condition');
    }
  }
});

test('v4 input is unchanged: done_condition is an unknown key there', () => {
  const input = draft((value) => {
    value.schema = 'lattice.plan_create_input.v4';
    value.tasks[0].done_condition = 'x';
    return value;
  });
  const error = rejection(input);
  assert.equal(error.detail.pointer, '/tasks/0');
  assert.equal(error.detail.violation_kind, 'unexpected_or_missing_keys');
});

test('v5 normalizer sorts and de-duplicates ordered-set fields into the validator canonical order', () => {
  const input = draft((value) => {
    value.tasks = [task('a'), task('b'), task('c')];
    value.hard_dependencies = [
      { from: ref('b'), to: ref('c') }, { from: ref('a'), to: ref('b') }, { from: ref('b'), to: ref('c') }];
    value.joins = [
      { id: 'z', after: [ref('b'), ref('a'), ref('a')], before: ref('c') },
      { id: 'a', after: [ref('a')], before: ref('c') },
      { id: 'a', after: [ref('a')], before: ref('c') }];
    value.phases = [
      { phase_id: 'q', title: null, gate_policy: 'heavy', predecessor_phase_ids: ['p1', 'p1'],
        required_evidence_slots: ['y', 'x', 'x'] },
      value.phases[0]];
    value.phase_accept_dependencies = [
      { from: phaseRef('q'), to: ref('a') }, { from: phaseRef('p1'), to: ref('c') },
      { from: phaseRef('p1'), to: ref('b') }, { from: phaseRef('p1'), to: ref('b') }];
    return value;
  });
  const repaired = repairAuthoringArtifact(input);
  const key = (r) => `${r.project_id}\0${r.plan_key}\0${r.task_id}`;
  assert.equal(explainTodoOrder(repaired.hard_dependencies, (e) => `${key(e.from)}\0${key(e.to)}`, '/h'), null);
  assert.equal(explainTodoOrder(repaired.joins, (j) => j.id, '/j'), null);
  assert.equal(explainTodoOrder(repaired.joins[1].after, key, '/ja'), null);
  assert.equal(explainTodoOrder(repaired.phases, (p) => p.phase_id, '/p'), null);
  assert.deepEqual(repaired.phases[1].required_evidence_slots, ['x', 'y']);
  assert.deepEqual(repaired.phases[1].predecessor_phase_ids, ['p1']);
  assert.deepEqual(repaired.hard_dependencies.map(({ from, to }) => `${from.task_id}>${to.task_id}`), ['a>b', 'b>c']);
  assert.equal(repaired.joins.length, 2);
  assert.deepEqual(repaired.phase_accept_dependencies.map(({ from, to }) => `${from.phase_id}>${to.task_id}`),
    ['p1>b', 'p1>c', 'q>a']);
  assert.deepEqual(repaired.tasks.map(({ task_id }) => task_id), ['a', 'b', 'c']);
  assert.equal(repaired.input_digest, todoSelfDigest(repaired, 'input_digest'));
  // 同じ集合の別の並びは同じ正準入力（同じdigest）になる。
  const shuffled = draft((value) => ({ ...input, hard_dependencies: [...input.hard_dependencies].reverse() }));
  assert.equal(repairAuthoringArtifact(shuffled).input_digest, repaired.input_digest);
});

test('v5 normalizer never reorders tasks and keeps same-key conflicts for the validator', () => {
  const unsortedTasks = repairAuthoringArtifact(draft((value) => {
    value.tasks = [task('t2'), task('t1')];
    return value;
  }));
  assert.deepEqual(unsortedTasks.tasks.map(({ task_id }) => task_id), ['t2', 't1']);
  assert.equal(rejection(unsortedTasks).detail.pointer, '/tasks/1/task_id');

  const conflicting = repairAuthoringArtifact(draft((value) => {
    value.joins = [
      { id: 'j', after: [ref('t1')], before: ref('t2') },
      { id: 'j', after: [ref('t2')], before: ref('t1') }];
    return value;
  }));
  assert.equal(conflicting.joins.length, 2);
});

test('v4 input is not normalized', () => {
  const v4 = draft((value) => {
    value.schema = 'lattice.plan_create_input.v4';
    for (const entry of value.tasks) delete entry.done_condition;
    value.hard_dependencies = [{ from: ref('t2'), to: ref('t1') }, { from: ref('t1'), to: ref('t2') }];
    return value;
  });
  assert.deepEqual(repairAuthoringArtifact(v4).hard_dependencies, v4.hard_dependencies);
});

async function createFromDraft(context, value) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-create-v5-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'draft.json'), `${JSON.stringify(value)}\n`);
  const run = spawnSync(process.execPath, [CLI, 'plan', 'create', '--input', 'draft.json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  return { root, run };
}

test('[Store v8] plan create v5 stores plan v8 with done_condition, sorted equal input stays canonical', async (context) => {
  const value = draft((v) => {
    v.tasks[0].done_condition = '全テストが通る';
    v.tasks[1].done_condition = null;
    v.hard_dependencies = [{ from: ref('t1'), to: ref('t2') }, { from: ref('t1'), to: ref('t2') }];
    return v;
  });
  const { root, run } = await createFromDraft(context, value);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const result = JSON.parse(run.stdout);
  const plan = JSON.parse(await readFile(path.join(root, result.plan_ref), 'utf8'));
  assert.equal(plan.schema, 'lattice.todo_plan.v8');
  assert.deepEqual(plan.tasks.map((t) => t.done_condition), ['全テストが通る', null]);
  assert.equal(plan.hard_dependencies.length, 1);
});

test('[Store v8] same-key conflicting joins in v5 still refuse at the join pointer', async (context) => {
  const conflicting = draft((v) => {
    v.joins = [
      { id: 'j', after: [ref('t1')], before: ref('t2') },
      { id: 'j', after: [ref('t2')], before: ref('t1') }];
    return v;
  });
  const { run } = await createFromDraft(context, conflicting);
  assert.notEqual(run.status, 0);
  assert.equal(JSON.parse(run.stderr).detail.pointer, '/joins/1');
});
