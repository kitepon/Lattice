import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderTodoGanttForProject } from '../../src/todo-cli.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ENV = Object.freeze({
  ...process.env,
  NO_COLOR: '1',
  LATTICE_DASHBOARD_AUTOSTART: '0',
  LATTICE_TODO_ACTOR_HOST: ACTOR.host,
  LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
  LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
});

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', env: ENV,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function ref(planKey, taskId) {
  return { project_id: 'cross-plan-e2e', plan_key: planKey, task_id: taskId };
}

function plan(planKey, taskId, title) {
  return {
    schema: 'lattice.todo_plan.v1', project_id: 'cross-plan-e2e', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [{
      task_id: taskId, title, lane: 'main', narrative_ref: null, compile_binding: null,
    }],
    hard_dependencies: [], joins: [],
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-cross-plan-e2e-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Lattice Test']);
  git(root, ['config', 'user.email', 'lattice-test@example.invalid']);
  git(root, ['config', 'commit.gpgSign', 'false']);
  await writeFile(path.join(root, 'evidence.md'), '# producer evidence\n');
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'cross-plan-e2e',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: plan('producer', 'P', '入力を作る'), genesis: { actor: ACTOR,
        recorded_at: '2026-08-09T00:00:00.000Z' } },
      { plan: plan('consumer', 'C', '入力を使う'), genesis: { actor: ACTOR,
        recorded_at: '2026-08-09T00:00:00.000Z' } },
    ],
    now: '2026-08-09T00:00:00.000Z',
  });
  git(root, ['add', '--', '.lattice/todo', 'evidence.md']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  const bytes = await readFile(path.join(root, 'evidence.md'));
  const descriptor = {
    evidence_id: 'producer-evidence', repo_id: 'self', path: 'evidence.md',
    git_blob_oid: git(root, ['rev-parse', 'HEAD:evidence.md']),
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/markdown', anchor_digest: null,
  };
  await writeFile(path.join(root, 'producer-evidence.json'), `${JSON.stringify(descriptor)}\n`);
  return root;
}

test('consumer着手後の発見を接続し、待機・Gantt・producer完了後解錠まで機械で運ぶ', async (context) => {
  const root = await fixture(context);
  cli(root, [
    'todo', 'start', '--plan', 'consumer', '--task', 'C',
    '--override-reason', '発見前から進行中だったconsumerを再現するため先行着手する',
    '--serial-confirmed',
  ]);
  const connected = cli(root, [
    'todo', 'dependency', 'connect',
    '--from-plan', 'producer', '--from-task', 'P',
    '--to-plan', 'consumer', '--to-task', 'C',
    '--reason', '実装中に入力依存を発見',
  ]);
  assert.deepEqual(connected.from, {
    ...ref('producer', 'P'), expected_topology_digest: connected.from.expected_topology_digest,
  });
  assert.deepEqual(connected.to, {
    ...ref('consumer', 'C'), expected_topology_digest: connected.to.expected_topology_digest,
  });

  const waiting = cli(root, ['todo', 'status']);
  assert.deepEqual(waiting.next_ready.map(({ plan_key: planKey, task_id: taskId }) =>
    `${planKey}/${taskId}`), ['producer/P']);
  assert.deepEqual(waiting.active_set, [{
    plan_key: 'consumer', task_id: 'C', label: '入力を使う',
    unmet_dependencies: [{ plan_key: 'producer', task_id: 'P' }], connections: [],
  }]);
  assert.equal(waiting.active_set.filter(({ unmet_dependencies: unmet }) => unmet.length === 0).length, 0);
  assert.equal(waiting.dispatch_frontier.recommended_parallelism, 1);

  const beforeDoneStore = await readTodoStore({ repoRoot: root });
  const consumer = beforeDoneStore.members.find(({ plan: memberPlan }) =>
    memberPlan.plan_key === 'consumer');
  assert.deepEqual(consumer.plan_scoped.events.map(({ kind, payload }) => ({
    kind, from: payload.from, to: payload.to,
  })), [{ kind: 'cross_plan_dependency', from: {
    ...ref('producer', 'P'),
    expected_topology_digest: connected.from.expected_topology_digest,
  }, to: {
    ...ref('consumer', 'C'),
    expected_topology_digest: connected.to.expected_topology_digest,
  } }]);

  const { rendered } = await renderTodoGanttForProject({
    repoRoot: root, readModel: beforeDoneStore, displayName: 'cross-plan-e2e', scope: 'all',
  });
  assert.match(rendered.html,
    /data-from-node-key="\[&quot;cross-plan-e2e&quot;,&quot;producer&quot;,&quot;P&quot;\]"/u);
  assert.match(rendered.html,
    /data-to-node-key="\[&quot;cross-plan-e2e&quot;,&quot;consumer&quot;,&quot;C&quot;\]"/u);
  assert.match(rendered.html, /正規ID consumer\/C/u);

  cli(root, ['todo', 'start', '--plan', 'producer', '--task', 'P']);
  cli(root, [
    'todo', 'done', '--plan', 'producer', '--task', 'P',
    '--evidence', 'producer-evidence.json',
  ]);
  const released = cli(root, ['todo', 'status']);
  assert.deepEqual(released.active_set, [{
    plan_key: 'consumer', task_id: 'C', label: '入力を使う', unmet_dependencies: [], connections: [],
  }]);
  assert.equal(released.active_set.filter(({ unmet_dependencies: unmet }) => unmet.length === 0).length, 1);
  assert.deepEqual(released.next_ready, []);

  const finalStore = await readTodoStore({ repoRoot: root });
  const producer = finalStore.members.find(({ plan: memberPlan }) =>
    memberPlan.plan_key === 'producer');
  assert.deepEqual(producer.journal.events.map(({ kind }) => kind), ['plan_genesis', 'start', 'done']);
  assert.equal(finalStore.members.find(({ plan: memberPlan }) => memberPlan.plan_key === 'consumer')
    .plan_scoped.events[0].event_digest, connected.event_digest);
});
