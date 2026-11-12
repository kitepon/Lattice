// u12: plan_create_input.v5 = v4 + 作成者が書く終了条件`done_condition`、
// および v5 入力だけが受ける「順序に意味が無い集合」の正準化。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_DESIGN_MEMO_PROMPT, explainTodoOrder, todoSelfDigest } from '../src/todo-contracts.mjs';
import { completeCreateInput, repairAuthoringArtifact } from '../src/todo-authoring-input.mjs';
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
  // a11: done_conditionは機械がnullで埋めるので必須ではない。keyとしては残る。
  assert.deepEqual(schema.$defs.task.required.includes('done_condition'), false);
  assert.ok('done_condition' in schema.$defs.task.properties);
  const bare = spawnSync(process.execPath, [CLI, 'plan', 'create', '--schema', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(bare.stdout).title, 'lattice.plan_create_input.v5');
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

test('v5 string and null done_condition are accepted', () => {
  for (const done of ['全テストが通る', null]) {
    validatePlanCreateInput(draft((value) => { value.tasks[0].done_condition = done; return value; }));
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

test('v5 normalizer sorts tasks (u03p) and keeps same-key conflicts for the validator', () => {
  const unsortedTasks = repairAuthoringArtifact(draft((value) => {
    value.tasks = [task('t2'), task('t1')];
    return value;
  }));
  assert.deepEqual(unsortedTasks.tasks.map(({ task_id }) => task_id), ['t1', 't2']);
  const conflictingTasks = repairAuthoringArtifact(draft((value) => {
    value.tasks = [task('t1'), { ...task('t1'), title: 'other' }];
    return value;
  }));
  assert.equal(rejection(conflictingTasks).detail.pointer, '/tasks/1/task_id');

  const conflicting = repairAuthoringArtifact(draft((value) => {
    value.joins = [
      { id: 'j', after: [ref('t1')], before: ref('t2') },
      { id: 'j', after: [ref('t2')], before: ref('t1') }];
    return value;
  }));
  assert.equal(conflicting.joins.length, 2);
});

test('v4 input is normalized too (u03p: every create schema)', () => {
  const v4 = draft((value) => {
    value.schema = 'lattice.plan_create_input.v4';
    for (const entry of value.tasks) delete entry.done_condition;
    value.hard_dependencies = [{ from: ref('t2'), to: ref('t1') }, { from: ref('t1'), to: ref('t2') }];
    return value;
  });
  assert.deepEqual(repairAuthoringArtifact(v4).hard_dependencies, [...v4.hard_dependencies].reverse());
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

test('plan create v5 stores plan v8 with done_condition, sorted equal input stays canonical', async (context) => {
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

test('same-key conflicting joins in v5 still refuse at the join pointer', async (context) => {
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

// a11: 最初のplanを1〜2回で作る。作者は意図(id・題名・段・辺)だけを書く。
const FIXED_NOW = new Date('2026-11-08T03:04:05.678Z');
const COMPLETE_ENV = { LATTICE_TODO_ACTOR_HOST: 'h', LATTICE_TODO_ACTOR_SESSION: 's', LATTICE_TODO_ACTOR_AGENT: 'a' };

function bareInput(mutate = (v) => v) {
  return mutate({
    project_id: 'probe', plan_key: 'main', plan_version: 'v1',
    phases: [{ phase_id: 'p1', title: 'P1' }, { phase_id: 'p2', title: 'P2' }],
    tasks: [
      { task_id: 't1', title: 'T1', phase_id: 'p1', design_memo: 'NO_PLAN' },
      { task_id: 't2', title: 'T2', phase_id: 'p1', design_memo: 'NO_PLAN' },
      { task_id: 't3', title: 'T3', phase_id: 'p2', design_memo: 'NO_PLAN' }],
    hard_dependencies: [{ from: { task_id: 't1' }, to: { task_id: 't2' } }],
  });
}

test('a11: completeCreateInput fills schema, constant keys and in-plan edge refs', () => {
  const done = completeCreateInput(bareInput(), { env: COMPLETE_ENV, now: FIXED_NOW });
  assert.equal(done.schema, 'lattice.plan_create_input.v5');
  assert.equal(done.recorded_at, FIXED_NOW.toISOString());
  assert.deepEqual(done.joins, []);
  assert.deepEqual(done.phase_accept_dependencies, []);
  assert.deepEqual(done.tasks[0], {
    task_id: 't1', title: 'T1', phase_id: 'p1', lane: 'main', design_memo: 'NO_PLAN', done_condition: null,
    narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null,
  });
  assert.deepEqual(done.phases[0], {
    phase_id: 'p1', title: 'P1', gate_policy: 'heavy', predecessor_phase_ids: [],
    required_evidence_slots: ['acceptance'],
  });
  assert.deepEqual(done.hard_dependencies, [{ from: ref('t1'), to: ref('t2') }]);
  assert.doesNotThrow(() => validatePlanCreateInput(done));
  // v3の入力にphase_accept_dependenciesは足すが、v2には足さない。v1にはphasesもdone_conditionも足さない。
  const v2 = completeCreateInput({ ...bareInput(), schema: 'lattice.plan_create_input.v2' }, { env: COMPLETE_ENV, now: FIXED_NOW });
  assert.equal('phase_accept_dependencies' in v2, false);
  assert.equal('done_condition' in v2.tasks[0], false);
  // 形が壊れた値は触らず、validatorの指摘に任せる。
  const malformed = completeCreateInput({ ...bareInput(), tasks: 'x', hard_dependencies: [null, 3] },
    { env: COMPLETE_ENV, now: FIXED_NOW });
  assert.equal(malformed.tasks, 'x');
  assert.deepEqual(malformed.hard_dependencies, [null, 3]);
});

test('a11: plan create accepts a minimal input with every fillable key omitted', async (context) => {
  const { root, run } = await createFromDraft(context, bareInput());
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const plan = JSON.parse(await readFile(path.join(root, JSON.parse(run.stdout).plan_ref), 'utf8'));
  assert.equal(plan.schema, 'lattice.todo_plan.v8');
  assert.equal(plan.phases[0].gate_policy, 'heavy');
  assert.deepEqual(plan.hard_dependencies, [{ from: ref('t1'), to: ref('t2') }]);
});

test('a11: recorded_at accepts any ISO timestamp and normalises it to UTC milliseconds', async (context) => {
  for (const [given, expected] of [
    ['2026-11-08T12:00:00+09:00', '2026-11-08T03:00:00.000Z'],
    ['2026-11-08T03:00:00Z', '2026-11-08T03:00:00.000Z'],
    ['2026-11-08T03:00:00.5Z', '2026-11-08T03:00:00.500Z'],
  ]) {
    const done = completeCreateInput({ ...bareInput(), recorded_at: given }, { env: COMPLETE_ENV, now: FIXED_NOW });
    assert.equal(done.recorded_at, expected);
    assert.doesNotThrow(() => validatePlanCreateInput(done));
  }
  // 読めない・暦が繰り上がる・時差の無い(host依存の)文字列は書いたまま残り、/recorded_atで拒否される。
  for (const given of ['yesterday', '2026-02-30T00:00:00Z', '2026-11-08T24:00:00Z', '2026-11-08T10:00:00']) {
    const kept = completeCreateInput({ ...bareInput(), recorded_at: given }, { env: COMPLETE_ENV, now: FIXED_NOW });
    assert.equal(kept.recorded_at, given);
    assert.equal(rejection(kept).detail.pointer, '/recorded_at');
  }
  const { run } = await createFromDraft(context, bareInput((v) => ({ ...v, recorded_at: '2026-11-08T12:00:00+09:00' })));
  assert.equal(run.status, 0, run.stderr + run.stdout);
});

test('a11: a refusal lists every independent problem in document order, first one unchanged', () => {
  const done = completeCreateInput(bareInput((v) => {
    v.project_id = 'bad id';
    v.tasks[0].extra = 1;
    delete v.tasks[1].title;
    v.tasks[2].phase_id = 'nowhere';
    v.phases[1].gate_policy = '!';
    return v;
  }), { env: COMPLETE_ENV, now: FIXED_NOW });
  const error = rejection(done);
  assert.equal(error.code, 'INPUT_INVALID');
  assert.equal(error.detail.reason, 'plan_create_schema_invalid');
  const { problems } = error.detail;
  assert.deepEqual(problems.map(({ pointer }) => pointer),
    ['/project_id', '/tasks/0', '/tasks/1', '/phases/1/gate_policy', '/tasks/2/phase_id']);
  const byPointer = Object.fromEntries(problems.map((problem) => [problem.pointer, problem]));
  assert.deepEqual(byPointer['/tasks/0'].unexpected_keys, ['extra']);
  assert.deepEqual(byPointer['/tasks/0'].missing_keys, []);
  assert.deepEqual(byPointer['/tasks/1'].missing_keys, ['title']);
  assert.equal(byPointer['/tasks/2/phase_id'].violation_kind, 'unknown_reference');
  assert.equal(byPointer['/phases/1/gate_policy'].violation_kind, 'identifier_invalid');
  // 先頭の違反は従来の優先順(トップレベルが先)のまま、detailの最上位に出る。
  assert.equal(error.detail.pointer, problems[0].pointer);
  assert.equal(error.detail.violation_kind, problems[0].violation_kind);
});

test('a11: the graph check runs only when no shape problem exists', () => {
  const conflicting = [
    { id: 'j', after: [{ task_id: 't1' }], before: { task_id: 't2' } },
    { id: 'j', after: [{ task_id: 't2' }], before: { task_id: 't1' } }];
  const graphOnly = completeCreateInput(bareInput((v) => ({ ...v, joins: conflicting })),
    { env: COMPLETE_ENV, now: FIXED_NOW });
  assert.deepEqual(rejection(graphOnly).detail.problems.map(({ pointer }) => pointer), ['/joins/1']);
  const both = completeCreateInput(bareInput((v) => {
    v.joins = conflicting;
    v.tasks[0].phase_id = 'nowhere';
    return v;
  }), { env: COMPLETE_ENV, now: FIXED_NOW });
  assert.deepEqual(rejection(both).detail.problems.map(({ violation_kind }) => violation_kind), ['unknown_reference']);
});

test('a11: --template prints a minimal v5 input that plan create accepts once the memos are written', async (context) => {
  const printed = spawnSync(process.execPath, [CLI, 'plan', 'create', '--template', '--json'], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stderr, '');
  const template = JSON.parse(printed.stdout);
  assert.deepEqual(Object.keys(template).sort(),
    ['hard_dependencies', 'phases', 'plan_key', 'schema', 'tasks']);
  assert.equal(template.schema, 'lattice.plan_create_input.v5');
  assert.deepEqual(template.hard_dependencies[0].from, { task_id: template.hard_dependencies[0].from.task_id });
  // memo-no-fabrication: Lattice prints blank memos, never NO_PLAN, so a verbatim copy is refused with the prompt.
  assert.deepEqual(template.tasks.map(({ design_memo: memo }) => memo), ['', '', '']);
  const copied = await createFromDraft(context, template);
  assert.equal(copied.run.status, 1);
  const refused = JSON.parse(copied.run.stderr);
  assert.deepEqual([refused.code, refused.detail.pointer], ['DESIGN_MEMO_REQUIRED', '/tasks/0/design_memo']);
  assert.equal(refused.detail.prompt, TODO_DESIGN_MEMO_PROMPT);
  const { root, run } = await createFromDraft(context,
    { ...template, tasks: template.tasks.map((task) => ({ ...task, design_memo: 'NO_PLAN' })) });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const shown = spawnSync(process.execPath, [CLI, 'plan', 'show', template.plan_key, '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(shown.status, 0, shown.stderr);
});

test('a11: plan show lists hard_dependencies, joins and phase_accept_dependencies', async (context) => {
  const { root, run } = await createFromDraft(context, bareInput());
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const shown = spawnSync(process.execPath, [CLI, 'plan', 'show', 'main', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(shown.status, 0, shown.stderr);
  const result = JSON.parse(shown.stdout);
  assert.deepEqual(result.hard_dependencies, [{ from: ref('t1'), to: ref('t2') }]);
  assert.deepEqual(result.joins, []);
  assert.deepEqual(result.phase_accept_dependencies, []);
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
});
