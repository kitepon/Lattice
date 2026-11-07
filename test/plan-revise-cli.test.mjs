import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
function desired(ids) {
  return { schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'work',
    plan_version: 'v1', actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: new Date().toISOString(), tasks: ids.map((task_id) => ({ task_id,
      title: task_id, lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
      narrative_anchor: null, parent_task_id: null, compile_binding: null, phase_id: 'p' })),
    phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
}
const decision = (task_id, policy) => ({ task_id, policy, reason: `explicit ${policy}` });
const intent = () => ({ schema: 'lattice.plan_revise_input.v1', desired: desired(['a', 'b', 'd']),
  continuity: [decision('a', 'carry'), decision('b', 'carry'), decision('c', 'retire')] });
function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', LATTICE_TODO_ACTOR_HOST: 'fixture',
      LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-revise-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# proof\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'evidence'], { cwd: root });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(desired(['a', 'b', 'c'])));
  const created = success(root, ['plan', 'create', '--input', 'plan.json']);
  return { root, created };
}

test('light CLI revises ordinary v7 work, retains done evidence and rebinds in-progress work', async (context) => {
  const { root, created } = await fixture(context);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'a']);
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'a', '--evidence', 'evidence.md']);
  success(root, ['todo', 'start', '--plan', 'work', '--task', 'b']);
  const oldA = success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']);
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(intent()));
  const result = success(root, ['plan', 'revise', '--input', 'revise.json', '--json']);
  assert.equal(result.schema, 'lattice.plan_revise_result.v1');
  assert.equal(result.revision.schema, 'lattice.phase_todo_revision.v5');
  assert.deepEqual(result.rebound_task_ids, ['b']);
  const newA = success(root, ['todo', 'show', '--plan', 'work', '--task', 'a', '--json']);
  assert.equal(newA.state.status, 'done');
  assert.deepEqual(newA.state.evidence, oldA.state.evidence);
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'b', '--json']).state.status, 'in-progress');
  assert.equal(success(root, ['todo', 'show', '--plan', 'work', '--task', 'd', '--json']).state.status, 'pending');
  assert.equal(JSON.parse(await readFile(path.join(root, created.plan_ref), 'utf8')).plan_version, 'v1');
  success(root, ['todo', 'done', '--plan', 'work', '--task', 'b', '--evidence', 'evidence.md']);
});

test('light CLI identifies changed carry at its policy pointer and dry-run does not publish', async (context) => {
  const { root } = await fixture(context);
  const input = intent();
  input.desired.tasks[0].title = 'changed meaning';
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(input));
  const manifestRef = path.join(root, '.lattice/todo/manifest.json');
  const before = await readFile(manifestRef, 'utf8');
  const refused = run(root, ['plan', 'revise', '--input', 'revise.json', '--dry-run', '--json']);
  assert.notEqual(refused.status, 0);
  const error = JSON.parse(refused.stderr);
  assert.equal(error.code, 'REVISION_INVALID');
  assert.equal(error.detail.pointer, '/continuity/0');
  assert.equal(error.detail.expected.policy, 'reset');
  input.continuity[0].policy = 'reset';
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(input));
  const preview = success(root, ['plan', 'revise', '--input', 'revise.json', '--dry-run', '--json']);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.revision.schema, 'lattice.phase_todo_revision.v5');
  assert.equal(await readFile(manifestRef, 'utf8'), before);
});

test('light CLI refuses dangling references before publishing a successor', async (context) => {
  const { root } = await fixture(context);
  const input = intent();
  input.continuity[0].policy = 'reset';
  input.continuity[1].policy = 'reset';
  const ref = (task_id) => ({ project_id: 'example', plan_key: 'work', task_id });
  input.desired.hard_dependencies = [{ from: ref('c'), to: ref('a') }];
  await writeFile(path.join(root, 'revise.json'), JSON.stringify(input));
  const manifestRef = path.join(root, '.lattice/todo/manifest.json');
  const before = await readFile(manifestRef, 'utf8');
  const refused = run(root, ['plan', 'revise', '--input', 'revise.json', '--json']);
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(manifestRef, 'utf8'), before);
});
