// n2-store-outgoing: readTodoOutgoingConnections reads a chart's live cross-project edges from its plan-scoped chains only.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoOutgoingConnections } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, args, extra = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a',
      LATTICE_CHARTS_ROOT: '', ...extra } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

/** Charts alpha (plan a: P) and beta (plan b: R); beta's R waits on alpha's P once connected. */
async function charts(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-outgoing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [chart, planKey, tasks] of [['alpha', 'a', ['P']], ['beta', 'b', ['R']]]) {
    const dir = path.join(root, chart);
    await mkdir(dir);
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify({
      schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
      tasks: tasks.map((id) => ({ task_id: id, title: id, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
      hard_dependencies: [],
    }));
    run(path.join(root, chart), ['plan', 'create', '--input', 'plan.json']);
  }
  const connect = ['todo', 'dependency', 'connect', '--from-project', 'alpha', '--from-plan', 'a', '--from-task', 'P',
    '--to-plan', 'b', '--to-task', 'R', '--reason', 'R uses P'];
  return { root, beta: path.join(root, 'beta'), alpha: path.join(root, 'alpha'), connect };
}

test('lists the live cross-project edge of the waiting chart only, and drops it once disconnected', async (context) => {
  const { root, alpha, beta, connect } = await charts(context);
  const env = { LATTICE_CHARTS_ROOT: root };
  assert.deepEqual(await readTodoOutgoingConnections({ repoRoot: beta }), { project_id: 'beta', edges: [] });
  run(beta, connect, env);
  const { project_id: projectId, edges } = await readTodoOutgoingConnections({ repoRoot: beta });
  assert.equal(projectId, 'beta');
  assert.equal(edges.length, 1);
  assert.deepEqual(Object.keys(edges[0]).sort(), ['connected_at', 'event_digest', 'from', 'reason', 'to']);
  assert.deepEqual([edges[0].from.project_id, edges[0].from.plan_key, edges[0].from.task_id], ['alpha', 'a', 'P']);
  assert.deepEqual([edges[0].to.project_id, edges[0].to.plan_key, edges[0].to.task_id], ['beta', 'b', 'R']);
  assert.equal(edges[0].reason, 'R uses P');
  assert.match(edges[0].event_digest, /^[0-9a-f]{64}$/u);
  // The waited-on chart holds no edge: nothing outgoing there.
  assert.deepEqual(await readTodoOutgoingConnections({ repoRoot: alpha }), { project_id: 'alpha', edges: [] });
  // Same chart, a second read after a write must not serve the memoized events.
  run(beta, [...connect.slice(0, 2), 'disconnect', ...connect.slice(3)], { LATTICE_CHARTS_ROOT: '' });
  assert.deepEqual(await readTodoOutgoingConnections({ repoRoot: beta }), { project_id: 'beta', edges: [] });
});

test('a directory with no Store has no edges; a corrupt plan-scoped chain throws the typed Store error', async (context) => {
  const { root, beta, connect } = await charts(context);
  const empty = await mkdtemp(path.join(tmpdir(), 'lattice-outgoing-empty-'));
  context.after(() => rm(empty, { recursive: true, force: true }));
  assert.deepEqual(await readTodoOutgoingConnections({ repoRoot: empty }), { project_id: null, edges: [] });
  run(beta, connect, { LATTICE_CHARTS_ROOT: root });
  const files = [];
  for (const entry of await readdir(path.join(beta, '.lattice'), { recursive: true })) {
    if (path.basename(entry) === 'plan-scoped.jsonl') files.push(path.join(beta, '.lattice', entry));
  }
  assert.equal(files.length, 1);
  await appendFile(files[0], 'not json\n');
  await assert.rejects(readTodoOutgoingConnections({ repoRoot: beta }), (error) => error?.name === 'TodoStoreError'
    && /^STORE_/u.test(error.code));
});
