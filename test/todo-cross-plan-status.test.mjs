import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendTodoEvent,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import {
  computeReadyFrontier,
  projectTodoStatus,
  TODO_STATUS_DISPATCH_ONLY,
} from '../src/todo-status.mjs';

const NOW = '2026-08-09T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-cross-plan-status-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(path.join(root, 'evidence.md'), '# evidence\n');
  execFileSync('git', ['add', 'evidence.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const plan = (planKey, taskId) => ({
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task(taskId)], hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [
      { plan: plan('producer', 'P'), genesis: { actor: ACTOR, recorded_at: NOW } },
      { plan: plan('consumer', 'C'), genesis: { actor: ACTOR, recorded_at: NOW } },
    ],
    now: NOW,
  });
  const read = () => readTodoStore({ repoRoot: root, now: NOW });
  const mutate = (planKey, taskId, kind, payload) => appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
    event: { kind, task_id: taskId, actor: ACTOR, recorded_at: NOW, payload },
  });
  const connect = async () => {
    const store = await read();
    const member = (planKey) => store.members.find(({ plan }) => plan.plan_key === planKey);
    return appendTodoEvent({
      repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
      planKey: 'consumer', now: NOW,
      event: {
        kind: 'cross_plan_dependency', actor: ACTOR, recorded_at: NOW,
        payload: {
          from: {
            project_id: store.project_id, plan_key: 'producer', task_id: 'P',
            expected_topology_digest: member('producer').plan.topology_digest,
          },
          to: {
            project_id: store.project_id, plan_key: 'consumer', task_id: 'C',
            expected_topology_digest: member('consumer').plan.topology_digest,
          },
          reason: '実装中に入力依存を発見',
        },
      },
    });
  };
  const evidence = {
    evidence_id: 'fixture', repo_id: 'self', path: 'evidence.md',
    git_blob_oid: execFileSync('git', ['rev-parse', 'HEAD:evidence.md'], { cwd: root, encoding: 'utf8' }).trim(),
    content_digest: createHash('sha256').update(await readFile(path.join(root, 'evidence.md'))).digest('hex'),
    media_type: 'text/markdown', anchor_digest: null,
  };
  const status = async () => projectTodoStatus(await read(), TODO_STATUS_DISPATCH_ONLY);
  return { read, mutate, connect, evidence, status };
}

test('pending consumerは接続直後にready/frontierとstart gateから外れる', async (context) => {
  const { read, mutate, connect, status } = await workspace(context);
  assert.deepEqual((await status()).next_ready.map(({ plan_key: plan, task_id: taskId }) => `${plan}/${taskId}`),
    ['consumer/C', 'producer/P']);

  await connect();
  const after = await status();
  assert.deepEqual(after.next_ready.map(({ plan_key: plan, task_id: taskId }) => `${plan}/${taskId}`),
    ['producer/P']);
  assert.deepEqual(computeReadyFrontier(await read()), after.next_ready);
  assert.equal(after.dispatch_frontier.recommended_parallelism, 1);
  await assert.rejects(() => mutate('consumer', 'C', 'start', { override_reason: null }),
    (error) => error.code === 'STORE_INCONSISTENT' && error.detail.reason === 'invalid_start_transition'
      && error.detail.cause === 'predecessor_unfinished');
});

test('着手後に発見したconsumerは履歴を保ち、unmetで席数入力から分離する', async (context) => {
  const { mutate, connect, evidence, status } = await workspace(context);
  await mutate('consumer', 'C', 'start', { override_reason: null });
  await connect();

  const waiting = await status();
  assert.deepEqual(waiting.active_set, [{
    plan_key: 'consumer', task_id: 'C', label: 'C',
    unmet_dependencies: [{ plan_key: 'producer', task_id: 'P' }],
  }]);
  assert.equal(waiting.active_set.filter(({ unmet_dependencies: unmet }) => unmet.length === 0).length, 0,
    'active実装席数は待機consumerを数えない');

  await mutate('producer', 'P', 'start', { override_reason: null });
  await mutate('producer', 'P', 'done', { done_mode: 'authored', imported: false, evidence });
  const released = await status();
  assert.deepEqual(released.active_set[0].unmet_dependencies, []);
  assert.equal(released.active_set.filter(({ unmet_dependencies: unmet }) => unmet.length === 0).length, 1);
});

test('producer done後はpending consumerが会話運搬なしでreadyへ戻る', async (context) => {
  const { mutate, connect, evidence, status } = await workspace(context);
  await connect();
  await mutate('producer', 'P', 'start', { override_reason: null });
  await mutate('producer', 'P', 'done', { done_mode: 'authored', imported: false, evidence });

  const released = await status();
  assert.deepEqual(released.next_ready.map(({ plan_key: plan, task_id: taskId }) => `${plan}/${taskId}`),
    ['consumer/C']);
  const started = await mutate('consumer', 'C', 'start', { override_reason: null });
  assert.equal(started.snapshot.tasks.find(({ task_id: taskId }) => taskId === 'C').status, 'in-progress');
});
