// retract-anyone (Owner 2026-11-12; Store lines agreed with Ludmila): any seat retracts an in-progress task, whatever
// put it in progress (start, legacy reopen, carrying revision); a reopen returns a done task to unstarted and the
// redo records a start, also inside a decided v4 phase; a legacy reopen still replays as in-progress.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTodoPlan, createTodoStoreWriter, initializeTodoStore, readTodoStore, resolveTodoStartRetractionBinding,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const NOW = '2026-11-12T00:00:00.000Z';
const seat = (agent) => ({ LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: agent, LATTICE_TODO_ACTOR_AGENT: agent });

function run(root, args, agent) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      ...seat(agent) } });
}
function success(root, args, agent = 'seat-a') {
  const result = run(root, args, agent);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
async function bare(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-retract-anyone-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}
const on = (task, plan = 'p') => ['--plan', plan, '--task', task];
const taskOf = async (root, task, plan = 'p') => (await readTodoStore({ repoRoot: root })).members
  .find(({ plan: value }) => value.plan_key === plan).tasks.find(({ task_id: id }) => id === task);

async function v1Plan(root) {
  const plan = buildTodoPlan({ schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'p', plan_version: 'v1',
    predecessor_plan_digest: null, hard_dependencies: [], joins: [],
    tasks: ['T', 'U'].map((id) => ({ task_id: id, title: id, lane: 'main', narrative_ref: null, compile_binding: null })) });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: { host: 'fixture', session: 'seat-a', agent: 'seat-a' }, recorded_at: NOW } }], now: NOW });
}

test('another seat retracts a started task; actor and reason are recorded', async (context) => {
  const root = await bare(context);
  await v1Plan(root);
  success(root, ['todo', 'start', ...on('T')], 'seat-a');
  const retracted = success(root, ['todo', 'retract', ...on('T'), '--reason', 'waits on U'], 'seat-b');
  assert.equal(retracted.status, 'pending');
  const event = (await readTodoStore({ repoRoot: root })).members[0].journal.events.at(-1);
  assert.deepEqual([event.kind, event.actor.agent, event.payload.reason], ['start_retracted', 'seat-b', 'waits on U']);
  // Started again by a third seat and retracted by the first: the binding follows the latest start.
  success(root, ['todo', 'start', ...on('T')], 'seat-c');
  assert.equal(success(root, ['todo', 'retract', ...on('T'), '--reason', 'again'], 'seat-a').status, 'pending');
});

test('a reopen returns to unstarted and the redo records a start; a legacy reopen replays in-progress and retracts', async (context) => {
  const root = await bare(context);
  await v1Plan(root);
  success(root, ['todo', 'start', ...on('T')]);
  success(root, ['todo', 'done', ...on('T'), '--message', 'first']);
  const reopened = success(root, ['todo', 'reopen', ...on('T'), '--reason', 'bug'], 'seat-b');
  assert.equal(reopened.status, 'pending');
  const reopenEvent = (await readTodoStore({ repoRoot: root })).members[0].journal.events.at(-1);
  assert.equal(reopenEvent.payload.to_status, 'pending');
  assert.equal((await taskOf(root, 'T')).started_at, null);
  assert.equal(success(root, ['todo', 'start', ...on('T')], 'seat-b').status, 'in-progress');
  success(root, ['todo', 'done', ...on('T'), '--message', 'second']);

  // A legacy reopen (no to_status, as pre-retract-anyone Lattice wrote it) still opens the task in progress,
  // and any seat can retract it: the reopen is its binding.
  const store = await readTodoStore({ repoRoot: root });
  const doneDigest = store.members[0].journal.events.at(-1).event_digest;
  await appendTodoEvent({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'p',
    event: { kind: 'reopen', task_id: 'T', actor: { host: 'fixture', session: 'old', agent: 'old' }, recorded_at: NOW,
      payload: { reason: 'legacy', override_reason: null, target_done_digest: doneDigest } } });
  assert.equal((await taskOf(root, 'T')).status, 'in-progress');
  assert.equal(success(root, ['todo', 'retract', ...on('T'), '--reason', 'undo legacy'], 'seat-c').status, 'pending');
});

test('a task carried in progress by a revision is retracted by any seat', async (context) => {
  const root = await bare(context);
  await writeFile(path.join(root, 'p.json'), JSON.stringify({ schema: 'lattice.plan_create_input.v5', plan_key: 'p',
    phases: [{ phase_id: 'x', title: 'x' }], tasks: [{ task_id: 'T', title: 'T', phase_id: 'x', design_memo: 'NO_PLAN' }] }));
  success(root, ['plan', 'create', '--input', 'p.json']);
  success(root, ['todo', 'start', ...on('T')], 'seat-a');
  success(root, ['todo', 'add', ...on('V'), '--title', 'V', '--phase', 'x', '--design-memo', 'NO_PLAN'], 'seat-c');
  // The CLI revision rebinds T to a start by the reviser; another seat still retracts it.
  assert.equal(success(root, ['todo', 'retract', ...on('T'), '--reason', 'waits'], 'seat-b').status, 'pending');
});

test('A1: a revision genesis that carries the task open (no start in this version) is its binding', () => {
  const genesis = { kind: 'plan_genesis', task_id: null, event_digest: 'g'.repeat(64),
    state_migration: [{ from_task_id: 'T', to_task_id: 'T', state_policy: 'carry', state: { status: 'in-progress' } }] };
  const member = { descriptor: { plan_key: 'p' }, plan: { plan_key: 'p', tasks: [{ task_id: 'T' }] },
    tasks: [{ task_id: 'T', status: 'in-progress' }], journal: { events: [genesis] } };
  assert.deepEqual(resolveTodoStartRetractionBinding({ members: [member] }, { planKey: 'p', taskId: 'T' }),
    { task_id: 'T', activation_event_digest: genesis.event_digest });
  // Cleared by a pending reopen; set again by a legacy reopen.
  const events = [genesis, { kind: 'done', task_id: 'T', event_digest: 'd'.repeat(64), payload: {} },
    { kind: 'reopen', task_id: 'T', event_digest: 'r'.repeat(64), payload: {} }];
  assert.equal(resolveTodoStartRetractionBinding({ members: [{ ...member, journal: { events } }] },
    { planKey: 'p', taskId: 'T' }).activation_event_digest, 'r'.repeat(64));
});

test('a task reopened inside an accepted v4 phase is redone with a start (gate and replay agree)', async (context) => {
  const root = await bare(context);
  const phase = { phase_id: 'ph', title: 'Phase', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['heavy'] };
  const plan = buildTodoPlan({ schema: 'lattice.todo_plan.v4', project_id: 'project-1', plan_key: 'p', plan_version: 'v1',
    predecessor_plan_digest: null, hard_dependencies: [], joins: [], phases: [phase],
    tasks: [{ task_id: 'T', title: 'T', lane: 'main', narrative_ref: null, compile_binding: null,
      narrative_anchor: null, parent_task_id: null, phase_id: 'ph' }] });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: { host: 'fixture', session: 'seat-a', agent: 'seat-a' }, recorded_at: NOW } }], now: NOW });
  success(root, ['todo', 'start', ...on('T')]);
  success(root, ['todo', 'done', ...on('T'), '--message', 'done']);
  success(root, ['todo', 'phase', 'review', '--plan', 'p', '--phase', 'ph', '--reason', 'audit']);
  success(root, ['todo', 'phase', 'accept', '--plan', 'p', '--phase', 'ph', '--message', 'audited']);
  assert.equal(success(root, ['todo', 'reopen', ...on('T'), '--reason', 'bug'], 'seat-b').status, 'pending');
  assert.ok(success(root, ['todo', 'status', '--json']).next_ready.some(({ task_id: id }) => id === 'T'));
  assert.equal(success(root, ['todo', 'start', ...on('T')], 'seat-b').status, 'in-progress');
  // Once started, the exemption is gone: a retract returns it to pending, and the decided phase blocks a new start.
  success(root, ['todo', 'retract', ...on('T'), '--reason', 'undo'], 'seat-c');
  const refused = run(root, ['todo', 'start', ...on('T')], 'seat-b');
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).detail.cause, 'phase_state');
});
