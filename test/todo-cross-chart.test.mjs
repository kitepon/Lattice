// xchart: a task waits on a task of another chart (another project's Store under LATTICE_CHARTS_ROOT).
// docs/architecture/dfd-plan-revise.md#cross-chart-dependency-xchart-2026-11-13

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendImportedPlan, createTodoStoreWriter, initializeTodoStore, readTodoStore, readTodoStoreReadOnly,
} from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const NOW = '2026-11-13T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

function run(cwd, args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a',
      LATTICE_CHARTS_ROOT: '', ...extra } });
}

/** Two charts, alpha (plan a: P, S) and beta (plan b: R), under one charts root. */
async function charts(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-xchart-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CHARTS_ROOT: root };
  const ok = (chart, args, extra = env) => {
    const result = run(path.join(root, chart), args, extra);
    assert.equal(result.status, 0, `${chart}: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const refused = (chart, args, extra = env) => {
    const result = run(path.join(root, chart), args, extra);
    assert.notEqual(result.status, 0, `${chart}: ${args.join(' ')} should refuse\n${result.stdout}`);
    return JSON.parse(result.stderr);
  };
  for (const [chart, planKey, tasks] of [['alpha', 'a', ['P', 'S']], ['beta', 'b', ['R']]]) {
    const dir = path.join(root, chart);
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({
      schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
      tasks: tasks.map((id) => ({ task_id: id, title: id, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
      hard_dependencies: [],
    }));
    ok(chart, ['plan', 'create', '--input', 'plan.json']);
  }
  const connect = ['todo', 'dependency', 'connect', '--from-project', 'alpha', '--from-plan', 'a', '--from-task', 'P',
    '--to-plan', 'b', '--to-task', 'R', '--reason', 'R uses P'];
  return { root, env, ok, refused, connect };
}

const ready = (status) => status.next_ready.map(({ plan_key: plan, task_id: task }) => `${plan}/${task}`);

test('a task waits on another chart: not startable until that task is done, then startable and noticed', async (context) => {
  const { root, ok, refused, connect } = await charts(context);
  const connected = ok('beta', connect);
  assert.deepEqual(connected.from, { project_id: 'alpha', plan_key: 'a', task_id: 'P',
    expected_topology_digest: connected.from.expected_topology_digest });
  assert.equal(ok('beta', connect).unchanged, true);
  // S2: the foreign predecessor is no Store node and no finding in the waiting chart.
  assert.deepEqual((await readTodoStore({ repoRoot: path.join(root, 'beta') })).cross_plan_findings, []);
  // Nothing was written in alpha: its plan-scoped chain stays empty.
  assert.equal((await readTodoStore({ repoRoot: path.join(root, 'alpha') })).members[0].plan_scoped.events.length, 0);

  assert.deepEqual(ready(ok('beta', ['todo', 'status', '--json'])), []);
  const show = ok('beta', ['todo', 'show', '--plan', 'b', '--task', 'R', '--json']).prerequisites;
  assert.equal(show.ready, false);
  assert.deepEqual(show.blocking_tasks, [{ project_id: 'alpha', plan_key: 'a', task_id: 'P', status: 'pending', reason: null }]);
  const startRefusal = refused('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']);
  assert.equal(startRefusal.detail.cause, 'predecessor_unfinished');
  assert.deepEqual(startRefusal.detail.blocking_tasks,
    [{ project_id: 'alpha', plan_key: 'a', task_id: 'P', status: 'pending', reason: null }]);
  assert.deepEqual(ok('beta', ['todo', 'notice', 'list']).notices, []);

  ok('alpha', ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const done = ok('alpha', ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);

  assert.deepEqual(ready(ok('beta', ['todo', 'status', '--json'])), ['b/R']);
  assert.equal(ok('beta', ['todo', 'show', '--plan', 'b', '--task', 'R', '--json']).prerequisites.ready, true);
  const [notice] = ok('beta', ['todo', 'notice', 'list']).notices;
  assert.equal(notice.task_id, 'R');
  assert.deepEqual(notice.triggers.map(({ project_id: p, plan_key: k, task_id: t, kind, event_digest: d }) => [p, k, t, kind, d]),
    [['alpha', 'a', 'P', 'done', done.event_digest]]);
  const display = ok('beta', ['todo', 'display', 'read', '--json']);
  assert.deepEqual(display.external_tasks.map(({ project_id: p, task_id: t, status, finished }) => [p, t, status, finished]),
    [['alpha', 'P', 'done', true]]);
  assert.equal(ok('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']).status, 'in-progress');
});

test('disconnect removes the wait without reading the other chart', async (context) => {
  const { ok, connect } = await charts(context);
  ok('beta', connect);
  const disconnected = ok('beta', [...connect.slice(0, 2), 'disconnect', ...connect.slice(3)], { LATTICE_CHARTS_ROOT: '' });
  assert.equal(disconnected.from.project_id, 'alpha');
  assert.deepEqual(ready(ok('beta', ['todo', 'status', '--json'])), ['b/R']);
});

test('an unreadable chart reads as waiting and is named; connect without the env refuses and writes nothing', async (context) => {
  const { root, ok, refused, connect } = await charts(context);
  const unset = refused('beta', connect, { LATTICE_CHARTS_ROOT: '' });
  assert.deepEqual([unset.code, unset.detail.reason], ['DEPENDENCY_INVALID', 'charts_root_unset']);
  assert.match(unset.detail.next_action, /LATTICE_CHARTS_ROOT/u);
  const unknown = refused('beta', connect.map((word) => (word === 'alpha' ? 'gamma' : word)));
  assert.deepEqual([unknown.detail.reason, unknown.detail.project_id], ['chart_unreadable', 'gamma']);
  const missing = refused('beta', connect.map((word) => (word === 'P' ? 'Z' : word)));
  assert.deepEqual([missing.detail.reason, missing.detail.project_id], ['dependency_task_not_found', 'alpha']);
  assert.equal((await readTodoStore({ repoRoot: path.join(root, 'beta') })).members[0].plan_scoped.events.length, 0);

  ok('beta', connect);
  ok('alpha', ['todo', 'start', '--plan', 'a', '--task', 'P']);
  ok('alpha', ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);
  const findings = (status) => status.cross_plan_findings.entries.map(({ ref, reason }) => [ref.project_id, ref.task_id, reason]);
  const noEnv = ok('beta', ['todo', 'status', '--json'], { LATTICE_CHARTS_ROOT: '' });
  assert.deepEqual([ready(noEnv), findings(noEnv)], [[], [['alpha', 'P', 'charts_root_unset']]]);
  await rename(path.join(root, 'alpha'), path.join(root, 'alpha-moved'));
  const gone = ok('beta', ['todo', 'status', '--json']);
  assert.deepEqual([ready(gone), findings(gone)], [[], [['alpha', 'P', 'chart_unreadable']]]);
  assert.equal(refused('beta', ['todo', 'start', '--plan', 'b', '--task', 'R']).detail.blocking_tasks[0].reason,
    'chart_unreadable');
  // No guard: once readable again, the next read resolves it.
  await rename(path.join(root, 'alpha-moved'), path.join(root, 'alpha'));
  assert.deepEqual(ready(ok('beta', ['todo', 'status', '--json'])), ['b/R']);
});

test('a cycle visible through readable charts refuses', async (context) => {
  const { ok, refused, connect } = await charts(context);
  ok('beta', connect);
  const back = refused('alpha', ['todo', 'dependency', 'connect', '--from-project', 'beta', '--from-plan', 'b',
    '--from-task', 'R', '--to-plan', 'a', '--to-task', 'P', '--reason', 'loop']);
  assert.deepEqual([back.code, back.detail.reason], ['DEPENDENCY_CYCLE', 'cross_plan_dependency_cycle']);
  assert.deepEqual(back.detail.cycle.map(({ project_id: p, task_id: t }) => `${p}/${t}`), ['alpha/P', 'beta/R', 'alpha/P']);
  // A different task in alpha may still wait on beta.
  ok('alpha', ['todo', 'dependency', 'connect', '--from-project', 'beta', '--from-plan', 'b',
    '--from-task', 'R', '--to-plan', 'a', '--to-task', 'S', '--reason', 'S after R']);
});

test('S3: genesis/import and connectionOnly keep refusing a predecessor on another project', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-xchart-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const writer = createTodoStoreWriter({ caller: 'g4-migration' });
  const plan = (planKey, taskId, extra = {}) => ({ schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null, hard_dependencies: [], joins: [],
    tasks: [{ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null }], ...extra });
  await initializeTodoStore({ repoRoot: root, writer, projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: plan('main', 'T'), genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW });
  const main = (await readTodoStore({ repoRoot: root })).members[0].plan;
  const foreign = (to) => [{ from: { project_id: 'other', plan_key: 'x', task_id: 'X', expected_topology_digest: main.topology_digest },
    to, reason: 'wait' }];
  const mainRef = { project_id: 'project-1', plan_key: 'main', task_id: 'T', expected_topology_digest: main.topology_digest };
  const mismatch = (error) => error?.detail?.reason === 'dependency_project_mismatch';
  await assert.rejects(appendImportedPlan({ repoRoot: root, writer, plan: plan('second', 'U'),
    genesis: { actor: ACTOR, recorded_at: NOW }, crossPlanDependencies: foreign(mainRef) }), mismatch);
  await assert.rejects(appendImportedPlan({ repoRoot: root, writer, connectionOnly: true,
    connectionPlan: { project_id: 'project-1', plan_key: 'main', plan_version: 'v1' },
    genesis: { actor: ACTOR, recorded_at: NOW }, crossPlanDependencies: foreign(mainRef) }), mismatch);
  assert.deepEqual((await readTodoStore({ repoRoot: root })).members.map(({ plan: p }) => p.plan_key), ['main']);
});

test('S2: a plan-body edge to another project still yields endpoint_missing', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-xchart-body-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{ genesis: { actor: ACTOR, recorded_at: NOW }, plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1',
      plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null, joins: [],
      tasks: [{ task_id: 'T', title: 'T', lane: 'main', narrative_ref: null, compile_binding: null }],
      hard_dependencies: [{ from: { project_id: 'other', plan_key: 'x', task_id: 'X', expected_topology_digest: 'a'.repeat(64) },
        to: { project_id: 'project-1', plan_key: 'main', task_id: 'T' } }] } }] });
  assert.deepEqual((await readTodoStore({ repoRoot: root })).cross_plan_findings.map(({ ref, reason }) => [ref.project_id, reason]),
    [['other', 'endpoint_missing']]);
});

test('S1: the read-only read of a crash-left chart throws and writes nothing', async (context) => {
  const { root } = await charts(context);
  const store = path.join(root, 'alpha', '.lattice', 'todo');
  await writeFile(path.join(store, 'source-cutover-recovery.json'), '{}');
  const list = async () => (await readdir(path.join(root, 'alpha'), { recursive: true })).sort();
  const before = await list();
  await assert.rejects(readTodoStoreReadOnly({ repoRoot: path.join(root, 'alpha') }));
  assert.deepEqual(await list(), before);
});
