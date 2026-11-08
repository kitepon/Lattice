import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TODO_DESIGN_MEMO_PROMPT,
  explainTodoDesignMemo,
  todoSelfDigest,
  validateTodoPlan,
} from '../src/todo-contracts.mjs';
import {
  appendTodoExtraction,
  compileTodoExtraction,
  validateTodoExtraction,
} from '../src/todo-migration.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';
import { buildTodoPlan, readTodoStore } from '../src/todo-store.mjs';

const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const SOURCE_COMMIT = '1'.repeat(40);

function extraction(designMemo) {
  const value = {
    schema: 'lattice.todo_extraction.v3',
    project_id: 'project-1',
    plan_key: 'design-memo',
    plan_version: 'v1',
    actor: ACTOR,
    recorded_at: '2026-08-01T00:00:00.000Z',
    tasks: [{
      task_id: 'T1',
      title: '設計メモ契約を検証する',
      lane: 'main',
      design_memo: designMemo,
      narrative_ref: null,
      compile_binding: null,
      disposition: 'register_pending',
      start: null,
      completion: null,
      source: {
        origin_plan_ref: 'plan.md',
        origin_line: 1,
        source_commit: SOURCE_COMMIT,
        heading_path: ['Plan'],
        markdown_depth: 0,
        parent_task_id: null,
        checkbox_state: 'unchecked',
      },
      migration_context: {
        external_canonical_ref: null,
        carry_over_ref: null,
        h_required: false,
        condition: null,
        evidence_refs: [],
        notes: [],
      },
    }],
    hard_dependencies: [],
    joins: [],
    extraction_digest: '',
  };
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

test('v3 extractionは空の設計メモを拒否しNO_PLANを明示値として受理する', () => {
  assert.equal(validateTodoExtraction(extraction('')), false);
  assert.equal(validateTodoExtraction(extraction('  \n\t')), false);
  assert.equal(validateTodoExtraction(extraction('NO_PLAN')), true);
  assert.equal(validateTodoExtraction(extraction('## 方針\n\nstoreへ本文を束縛する。')), true);
  assert.equal(
    TODO_DESIGN_MEMO_PROMPT,
    'あなたがこのToDoに対して、何も考えていないならば、設計メモに `NO_PLAN` と書いてください',
  );
});

test('設計メモ診断はtype・blank・too_large・controlを本文非露出で区別する', () => {
  assert.equal(explainTodoDesignMemo(null).reason, 'type');
  assert.equal(explainTodoDesignMemo(' \n').reason, 'blank');
  const tooLarge = explainTodoDesignMemo('設'.repeat(6_000));
  assert.equal(tooLarge.reason, 'too_large');
  assert.equal(tooLarge.actual.byte_length, 18_000);
  assert.equal(Object.values(tooLarge.actual).includes('設'.repeat(6_000)), false);
  const control = explainTodoDesignMemo('方針\u0000本文');
  assert.equal(control.reason, 'forbidden_control');
  assert.equal(control.actual.contains_forbidden_control, true);
});

test('v3 extractionは設計メモをToDo本体へ保存するv6 planへcompileする', () => {
  const request = compileTodoExtraction(extraction('## 方針\n\n後続AIへ自動供給する。'), '/repo');
  assert.equal(request.plan.schema, 'lattice.todo_plan.v6');
  assert.equal(request.plan.tasks[0].design_memo, '## 方針\n\n後続AIへ自動供給する。');

  const plan = buildTodoPlan(request.plan);
  assert.equal(validateTodoPlan(plan), true);
  assert.equal(plan.tasks[0].design_memo, request.plan.tasks[0].design_memo);
});

test('v3 migrate後のshowとstartは同じ設計メモを自動供給する', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-design-memo-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const memo = '## 実装方針\n\n後続AIはこの本文だけで着手できる。';
  await appendTodoExtraction({ repoRoot, extraction: extraction(memo) });
  const store = await readTodoStore({ repoRoot });
  assert.equal(store.members[0].plan.schema, 'lattice.todo_plan.v6');
  assert.equal(store.members[0].plan.tasks[0].design_memo, memo);

  const invoke = async (argv) => {
    let output = '';
    let error = '';
    const exitCode = await runTodoCli({
      argv,
      cwd: repoRoot,
      stdout: { write: (chunk) => { output += chunk; } },
      stderr: { write: (chunk) => { error += chunk; } },
      env: {
        ...process.env,
        LATTICE_DASHBOARD_AUTOSTART: '0',
        LATTICE_TODO_ACTOR_HOST: ACTOR.host,
        LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
        LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
      },
    });
    assert.equal(exitCode, 0, error);
    return JSON.parse(output);
  };
  const shown = await invoke(['show', '--plan', 'design-memo', '--task', 'T1', '--json']);
  assert.deepEqual(shown.design_memo, {
    status: 'available', markdown: memo, prompt: TODO_DESIGN_MEMO_PROMPT,
  });
  const started = await invoke(['start', '--plan', 'design-memo', '--task', 'T1']);
  assert.deepEqual(started.design_memo, shown.design_memo);
});

test('design_memo欠落errorはNO_PLANの問いかけと違反位置を返す', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-design-memo-error-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const value = extraction('NO_PLAN');
  delete value.tasks[0].design_memo;
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  await writeFile(path.join(repoRoot, 'input.json'), `${JSON.stringify(value)}\n`);
  let output = '';
  let error = '';
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'input.json'],
    cwd: repoRoot,
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { error += chunk; } },
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(exitCode, 1);
  assert.equal(output, '');
  const failure = JSON.parse(error);
  assert.equal(failure.code, 'INVALID_TODO_EXTRACTION');
  assert.equal(failure.detail.violation_path, '/tasks/0/design_memo');
  assert.equal(failure.detail.design_memo_prompt, TODO_DESIGN_MEMO_PROMPT);
});

test('migrate dry-runは独立した複数違反を一度に返しstoreを作らない', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-design-memo-dry-run-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const value = extraction('NO_PLAN');
  value.tasks[0].disposition = 'unknown_requires_evidence';
  delete value.tasks[0].design_memo;
  value.tasks.push({ ...structuredClone(value.tasks[0]), task_id: 'T2' });
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  await writeFile(path.join(repoRoot, 'input.json'), `${JSON.stringify(value)}\n`);
  let output = '';
  let error = '';
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'input.json', '--dry-run', '--json'], cwd: repoRoot,
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { error += chunk; } }, env: process.env,
  });
  assert.equal(exitCode, 0, error);
  const result = JSON.parse(output);
  assert.equal(result.schema, 'lattice.todo_migrate_dry_run_result.v2');
  assert.equal(result.valid, false);
  assert.deepEqual(result.violations.map(({ code }) => code), [
    'design_memo_type', 'design_memo_type',
  ]);
  // u03p A64: 証拠の無いunknownは違反でなくregister_pendingの既定として申告される。
  assert.deepEqual(result.defaulted_pending_task_ids, ['T1', 'T2']);
  assert.deepEqual(result.violations[0].task_ids, ['T1']);
  assert.equal(result.violations[0].path, '/tasks/0/design_memo');
  assert.deepEqual(result.violations[1].task_ids, ['T2']);
  assert.equal(result.violations[1].path, '/tasks/1/design_memo');
  assert.equal(result.violations[0].prompt, TODO_DESIGN_MEMO_PROMPT);
  await assert.rejects(readTodoStore({ repoRoot }), (failure) => failure.code === 'STORE_INCONSISTENT');
});

test('migrate dry-run成功時は予定planと実write commandを返してstoreを作らない', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-design-memo-dry-run-ok-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const value = extraction('NO_PLAN');
  await writeFile(path.join(repoRoot, 'input.json'), `${JSON.stringify(value)}\n`);
  let output = '';
  let error = '';
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'input.json', '--dry-run', '--json'], cwd: repoRoot,
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { error += chunk; } }, env: process.env,
  });
  assert.equal(exitCode, 0, error);
  const result = JSON.parse(output);
  assert.equal(result.valid, true);
  assert.equal(result.planned.plan_schema, 'lattice.todo_plan.v6');
  assert.equal(result.planned.task_count, 1);
  assert.equal(result.next_action, 'lattice todo migrate --input input.json');
  await assert.rejects(readTodoStore({ repoRoot }), (failure) => failure.code === 'STORE_INCONSISTENT');
});

test('migrate dry-runは循環topologyをnull参照せずplanned nullの違反として返す', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-design-memo-cycle-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const value = extraction('NO_PLAN');
  value.tasks.push({ ...structuredClone(value.tasks[0]), task_id: 'T2',
    design_memo: '## 方針\n\nT1との循環を検査する。' });
  const ref = (taskId) => ({ project_id: value.project_id, plan_key: value.plan_key, task_id: taskId });
  value.hard_dependencies = [
    { from: ref('T1'), to: ref('T2') },
    { from: ref('T2'), to: ref('T1') },
  ];
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  await writeFile(path.join(repoRoot, 'input.json'), `${JSON.stringify(value)}\n`);
  let output = '';
  let error = '';
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'input.json', '--dry-run', '--json'], cwd: repoRoot,
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { error += chunk; } }, env: process.env,
  });
  assert.equal(exitCode, 0, error);
  const result = JSON.parse(output);
  assert.equal(result.valid, false);
  assert.equal(result.planned, null);
  assert.equal(result.violations.some(({ code }) => code === 'dispatch_shape_dependency_cycle'), true);
});

test('migrate dry-runはenum・配列・digest・参照・clock skewを一回で特定する', async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-authoring-diagnostics-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repoRoot }).status, 0);
  const value = extraction('## 方針\n\n実装する。');
  value.recorded_at = '2099-01-01T00:00:00.000Z';
  value.tasks[0].disposition = 'register_done';
  value.tasks[0].completion = { done_mode: 'historical_evidence', completed_at: value.recorded_at };
  value.tasks[0].migration_context.notes = 'not-an-array';
  value.hard_dependencies = [{
    from: { project_id: 'project-1', plan_key: 'design-memo', task_id: 'T1' },
    to: { project_id: 'project-1', plan_key: 'design-memo', task_id: 'MISSING' },
  }];
  value.extraction_digest = '0'.repeat(64);
  await writeFile(path.join(repoRoot, 'input.json'), `${JSON.stringify(value)}\n`);
  let output = '';
  let error = '';
  const exitCode = await runTodoCli({
    argv: ['migrate', '--input', 'input.json', '--dry-run', '--json'], cwd: repoRoot,
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { error += chunk; } }, env: process.env,
  });
  assert.equal(exitCode, 0, error);
  const result = JSON.parse(output);
  assert.deepEqual(result.violations.map(({ code }) => code), [
    'enum_mismatch', 'expected_array',
    'local_ref_unresolved', 'future_clock_skew',
  ]);
  assert.equal(result.violations[0].path, '/tasks/0/completion/done_mode');
  assert.equal(result.violations[0].expected, 'historical_import');
  assert.equal(result.violations[2].path, '/hard_dependencies/0/to');
  assert.equal(result.violations[3].expected.max_future_skew_ms, 300_000);
  await assert.rejects(readTodoStore({ repoRoot }), (failure) => failure.code === 'STORE_INCONSISTENT');
});
