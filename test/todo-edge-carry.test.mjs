// edge-carry: a revision of the waiting plan (todo add, plan revise) carries its live incoming ledger edges.
// docs/architecture/dfd-store-phase-revision.md#journal-backed-prospective-validation-and-identity-preserving-repair

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectTodoCrossPlanDependencies, readTodoStore } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a',
      ...extra } });
}

const planInput = (planKey, tasks) => JSON.stringify({
  schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
  tasks: tasks.map((id) => ({ task_id: id, title: id, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
  hard_dependencies: [],
});

/** alpha (plan a: P); beta (plan b: R, T, U and plan c: Q), under one charts root. */
async function charts(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-edge-carry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { LATTICE_CHARTS_ROOT: root };
  const ok = (chart, args) => {
    const result = run(path.join(root, chart), args, env);
    assert.equal(result.status, 0, `${chart}: ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  for (const [chart, plans] of [['alpha', [['a', ['P']]]], ['beta', [['b', ['R', 'T', 'U']], ['c', ['Q']]]]]) {
    const dir = path.join(root, chart);
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    for (const [planKey, tasks] of plans) {
      await writeFile(path.join(dir, 'plan.json'), planInput(planKey, tasks));
      ok(chart, ['plan', 'create', '--input', 'plan.json']);
    }
  }
  return { beta: path.join(root, 'beta'), ok };
}

const connect = (from, to, extra = []) => ['todo', 'dependency', 'connect', ...extra, '--from-plan', from[0],
  '--from-task', from[1], '--to-plan', to[0], '--to-task', to[1], '--reason', `${to[1]} uses ${from[1]}`];
const edgeKeys = (store) => projectTodoCrossPlanDependencies(store.members)
  .map(({ from, to }) => `${from.project_id}/${from.plan_key}/${from.task_id}>${to.plan_key}/${to.task_id}`).sort();
const blocking = (ok, task) => ok('beta', ['todo', 'show', '--plan', 'b', '--task', task, '--json'])
  .prerequisites.blocking_tasks.map(({ project_id: p, plan_key: k, task_id: t }) => `${p ?? 'beta'}/${k}/${t}`).sort();

test('todo add and plan revise keep the incoming edges of the waiting plan, mapped onto the successor', async (context) => {
  const { beta, ok } = await charts(context);
  ok('beta', connect(['a', 'P'], ['b', 'R'], ['--from-project', 'alpha']));
  ok('beta', connect(['c', 'Q'], ['b', 'R']));
  ok('beta', connect(['c', 'Q'], ['b', 'U']));
  const all = ['alpha/a/P>b/R', 'beta/c/Q>b/R', 'beta/c/Q>b/U'];
  // A same-plan connect is a plan revision (hard dependency): it already carries the ledger edges above.
  ok('beta', connect(['b', 'T'], ['b', 'R']));
  const before = await readTodoStore({ repoRoot: beta });
  const connected = before.members.find(({ plan }) => plan.plan_key === 'b').plan_scoped.events;
  assert.deepEqual(edgeKeys(before), all);

  // todo add: the production loss (bellteam-dev-added/a100, 2026-11-14).
  ok('beta', ['todo', 'add', '--plan', 'b', '--task', 'N', '--title', 'N', '--phase', 'p',
    '--design-memo', 'NO_PLAN', '--reason', 'found later']);
  const added = await readTodoStore({ repoRoot: beta });
  const b = added.members.find(({ plan }) => plan.plan_key === 'b');
  assert.notEqual(b.plan.plan_version, 'v1');
  assert.deepEqual(edgeKeys(added), all);
  assert.deepEqual(added.cross_plan_findings, []);
  // Bound to the successor topology; a from on another plan or chart stays as recorded.
  for (const { payload } of b.plan_scoped.events) assert.equal(payload.to.expected_topology_digest, b.plan.topology_digest);
  const foreign = b.plan_scoped.events.find(({ payload }) => payload.from.project_id === 'alpha');
  assert.deepEqual(foreign.payload.from, connected.find(({ payload }) => payload.from.project_id === 'alpha').payload.from);
  // The connection keeps who connected it and when.
  assert.deepEqual(b.plan_scoped.events.map(({ actor, recorded_at: at }) => [actor, at]),
    connected.map(({ actor, recorded_at: at }) => [actor, at]));
  assert.deepEqual(blocking(ok, 'R'), ['alpha/a/P', 'beta/b/T', 'beta/c/Q']);

  // plan revise retiring U drops only U's edge.
  const ref = (task_id) => ({ project_id: 'beta', plan_key: 'b', task_id });
  const desired = { ...JSON.parse(planInput('b', ['R', 'T', 'N'])), project_id: 'beta',
    hard_dependencies: [{ from: ref('T'), to: ref('R') }] };
  await writeFile(path.join(beta, 'revise.json'), JSON.stringify({ schema: 'lattice.plan_revise_input.v1', desired,
    continuity: ['R', 'T', 'N'].map((id) => ({ task_id: id, policy: 'carry', reason: 'keep' }))
      .concat([{ task_id: 'U', policy: 'retire', reason: 'not needed' }]) }));
  ok('beta', ['plan', 'revise', '--input', 'revise.json', '--json']);
  const revised = await readTodoStore({ repoRoot: beta });
  assert.deepEqual(edgeKeys(revised), ['alpha/a/P>b/R', 'beta/c/Q>b/R']);
  assert.deepEqual(revised.cross_plan_findings, []);

  // A carried edge is an ordinary live edge: disconnect finds it, and R still waits on the rest.
  ok('beta', ['todo', 'dependency', 'disconnect', '--from-plan', 'c', '--from-task', 'Q', '--to-plan', 'b',
    '--to-task', 'R', '--reason', 'not needed']);
  assert.deepEqual(blocking(ok, 'R'), ['alpha/a/P', 'beta/b/T']);
  ok('beta', ['todo', 'start', '--plan', 'b', '--task', 'T']);
  ok('beta', ['todo', 'done', '--plan', 'b', '--task', 'T', '--message', 'done']);
  assert.deepEqual(blocking(ok, 'R'), ['alpha/a/P']);
});
