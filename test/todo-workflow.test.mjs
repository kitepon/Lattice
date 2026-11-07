import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { validateProjectStatus } from '../src/project-cli.mjs';
import { validateTodoStatusResult } from '../src/todo-status.mjs';
import {
  WORKFLOW_STATE_SCHEMA, explainWorkflowState, workflowStatusFields,
} from '../src/todo-workflow.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const pr = 'https://github.com/example/project/pull/7';
const ci = 'https://github.com/example/project/actions/runs/42';
const input = (stage, extra = {}) => ({ schema: WORKFLOW_STATE_SCHEMA, stage,
  ...(stage === 'clear' ? {} : { pr_url: pr }), ...extra });
const note = (value, extra = {}) => ({ scope: 'task', body: JSON.stringify(value),
  event_digest: 'a'.repeat(64), recorded_at: '2026-11-07T12:00:00.000Z',
  superseded_by: null, origin_task_id: 'old-name', ...extra });

test('workflow fields reject unsupported observations before a note is written', () => {
  assert.equal(explainWorkflowState(input('pr')), null);
  assert.equal(explainWorkflowState(input('ci', { ci_url: ci, ci_result: 'running', detail: 'review queue' })), null);
  assert.equal(explainWorkflowState(input('clear', { detail: 'back to implementation' })), null);
  assert.equal(explainWorkflowState(input('unknown')).path, '/stage');
  assert.equal(explainWorkflowState(input('ci')).path, '/ci_url');
  assert.equal(explainWorkflowState(input('ci', { ci_url: ci, ci_result: 'green' })).path, '/ci_result');
  assert.equal(explainWorkflowState(input('review', { detail: {} })).path, '/detail');
  assert.equal(explainWorkflowState(input('clear', { pr_url: pr })).reason, 'workflow_clear_has_no_references');
});

test('workflow reduction uses newest effective task note and preserves Store task migration', () => {
  const older = note(input('pr'), { event_digest: 'b'.repeat(64) });
  const latest = note(input('review', { ci_url: ci, ci_result: 'pass', detail: 'waiting for review' }));
  const history = [note(input('ci', { ci_url: ci, ci_result: 'fail' }), { scope: 'plan' }),
    note(input('pr'), { superseded_by: 'c'.repeat(64) }),
    { ...latest, body: 'ordinary later prose' }, latest, older];
  const result = workflowStatusFields(history);
  assert.equal(result.flow_state, 'review');
  assert.equal(result.ci_result, 'pass');
  assert.equal(result.workflow_note_digest, latest.event_digest);
  assert.equal(result.detail, 'waiting for review');
  assert.deepEqual(workflowStatusFields([note(input('clear')), ...history]), {});
  assert.deepEqual(workflowStatusFields([history[0]]), {});
});

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_SEAT_ID: '',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture',
      LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-workflow-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# evidence\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: new Date().toISOString(), tasks: [{ task_id: 'a', title: 'task', lane: 'main',
      design_memo: 'NO_PLAN', narrative_ref: null, narrative_anchor: null,
      parent_task_id: null, compile_binding: null, phase_id: 'p' }],
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['proof'] }], hard_dependencies: [], joins: [], phase_accept_dependencies: [],
  }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}

test('workflow CLI survives prose overflow and projects identical task facts without changing lifecycle', async (context) => {
  const root = await fixture(context);
  const before = success(root, ['todo', 'status', '--json']);
  const record = success(root, ['todo', 'note', '--plan', 'work', '--task', 'a',
    '--workflow', 'ci', '--pr-url', pr, '--ci-url', ci, '--ci-result', 'running',
    '--detail', 'runner queue', '--json']);
  assert.equal(JSON.parse(record.event.body).schema, WORKFLOW_STATE_SCHEMA);
  const ready = success(root, ['todo', 'status', '--json']);
  assert.equal(ready.next_ready[0].flow_state, 'ci');
  assert.equal(ready.dispatch_frontier.frontier_digest, before.dispatch_frontier.frontier_digest);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  for (let i = 0; i < 5; i++) {
    success(root, ['todo', 'note', '--plan', 'work', '--task', 'a', '--message', `${i}${'x'.repeat(15_000)}`]);
  }
  success(root, ['todo', 'note', '--plan', 'work', '--message', JSON.stringify(input('review'))]);
  const todo = success(root, ['todo', 'status', '--json']);
  assert.equal(todo.active_set[0].flow_state, 'ci');
  assert.equal(todo.active_set[0].ci_result, 'running');
  assert.equal(todo.active_set[0].workflow_note_digest, record.event.event_digest);
  assert.equal(validateTodoStatusResult(todo), true);
  const status = success(root, ['status', '--json']);
  assert.equal(status.active_runs[0].workflow_note_digest, record.event.event_digest);
  assert.equal(validateProjectStatus(status), true);
  const contextResult = success(root, ['session-context', '--json']);
  assert.equal(contextResult.todo.active_set[0].flow_state, 'ci');
  assert.equal(contextResult.status.active_runs[0].detail, 'runner queue');
  const invalidSeat = { ...status, seat_id: null };
  invalidSeat.result_digest = todoSelfDigest(invalidSeat, 'result_digest');
  assert.equal(validateProjectStatus(invalidSeat), false);
  success(root, ['todo', 'note', '--plan', 'work', '--task', 'a', '--workflow', 'clear']);
  const cleared = success(root, ['todo', 'status', '--json']);
  assert.equal(Object.hasOwn(cleared.active_set[0], 'flow_state'), false);
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'a', '--evidence', 'evidence.md']);
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']).state.status, 'done');
});

test('workflow CLI requires a task and returns the failing CI field without writing', async (context) => {
  const root = await fixture(context);
  for (const [args, pointer] of [
    [['--workflow', 'pr', '--pr-url', pr], '/task'],
    [['--task', 'a', '--workflow', 'ci', '--pr-url', pr, '--ci-url', ci, '--ci-result', 'green'], '/ci_result'],
  ]) {
    const result = run(root, ['todo', 'note', '--plan', 'work', ...args]);
    assert.notEqual(result.status, 0);
    const error = JSON.parse(result.stderr);
    assert.equal(error.detail.pointer, pointer);
    assert.equal(typeof error.detail.rule, 'string');
    assert.equal(typeof error.detail.next_action, 'string');
  }
  const result = success(root, ['todo', 'status', '--json']);
  assert.equal(Object.hasOwn(result.next_ready[0], 'flow_state'), false);
});
