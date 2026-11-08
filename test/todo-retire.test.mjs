import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTodoCli } from '../src/todo-cli.mjs';
import {
  appendTodoEvent as appendStoreEvent,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { computeReadyFrontier } from '../src/todo-status.mjs';

const NOW = '2026-08-28T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const WRITER = createTodoStoreWriter({ caller: 'g5-authoring' });
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });

async function workspace(context, { edge = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-retire-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(path.join(root, 'plan.md'), '# fixture\n');
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('A'), task('B')],
        hard_dependencies: edge ? [{ from: ref('A'), to: ref('B') }] : [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

const retire = (root, taskId, reason = '消費計画が消滅した') => appendTodoEvent({
  repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
  event: { kind: 'retire', task_id: taskId, actor: ACTOR, recorded_at: NOW, payload: { reason } },
});

test('retireはpendingの工程を恒久除去し、status/frontierの表示から消す', async (context) => {
  const root = await workspace(context);
  await retire(root, 'B');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const state = store.members[0].tasks.find(({ task_id: id }) => id === 'B');
  assert.equal(state.status, 'retired');
  assert.equal(state.blocked_reason, '消費計画が消滅した');
  const frontier = computeReadyFrontier(store);
  assert.deepEqual(frontier.map(({ task_id: id }) => id), ['A']);
});

test('retireはblockedからも遷移できる', async (context) => {
  const root = await workspace(context);
  await appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'A', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
    event: { kind: 'block', task_id: 'A', actor: ACTOR, recorded_at: NOW, payload: { reason: '一時停止' } } });
  await retire(root, 'A', 'NO-GO裁定');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members[0].tasks.find(({ task_id: id }) => id === 'A').status, 'retired');
});

test('legacy retire payloadはin-progressからは従来通り拒否される（invalid_retire_transition）', async (context) => {
  const root = await workspace(context);
  await appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'A', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } });
  await assert.rejects(retire(root, 'A'), (error) => {
    assert.equal(error.detail?.reason ?? error.reason, 'invalid_retire_transition');
    return true;
  });
});

const reasonOf = (error) => error.detail?.reason ?? error.reason;
const taskOf = async (root, taskId) => (await readTodoStore({ repoRoot: root, now: NOW }))
  .members[0].tasks.find(({ task_id: id }) => id === taskId);
const retireFrom = (root, taskId, priorStatus) => appendTodoEvent({
  repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
  event: { kind: 'retire', task_id: taskId, actor: ACTOR, recorded_at: NOW,
    payload: { reason: '著者が削除', prior_status: priorStatus } },
});
const start = (root, taskId, overrideReason = null) => appendTodoEvent({
  repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
  event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: NOW,
    payload: { override_reason: overrideReason } },
});
async function done(root, taskId, append = (r, event) => appendTodoEvent({
  repoRoot: r, writer: WRITER, planKey: 'main', now: NOW, event })) {
  const bytes = Buffer.from(`evidence ${taskId}\n`);
  await writeFile(path.join(root, `${taskId}.txt`), bytes);
  execFileSync('git', ['add', `${taskId}.txt`], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', `evidence ${taskId}`], { cwd: root });
  const oid = execFileSync('git', ['rev-parse', `HEAD:${taskId}.txt`], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = { evidence_id: `ev-${taskId}`, repo_id: 'self', path: `${taskId}.txt`, git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'), media_type: 'text/plain',
    anchor_digest: null };
  return append(root, { kind: 'done', task_id: taskId, actor: ACTOR, recorded_at: NOW, payload: { evidence } });
}

test('retire(prior_status)はpending/blocked/in-progress/doneの各状態から遷移し、retired形に整う', async (context) => {
  for (const prior of ['pending', 'blocked', 'in-progress', 'done']) {
    const root = await workspace(context);
    if (prior !== 'pending') await start(root, 'A');
    if (prior === 'blocked') {
      await appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
        event: { kind: 'block', task_id: 'A', actor: ACTOR, recorded_at: NOW, payload: { reason: '停止' } } });
    }
    if (prior === 'done') await done(root, 'A');
    await retireFrom(root, 'A', prior);
    const state = await taskOf(root, 'A');
    assert.equal(state.status, 'retired', prior);
    assert.equal(state.blocked_reason, '著者が削除');
    assert.equal(state.evidence, null);
    assert.equal(state.test_result, null);
    assert.equal(state.imported, false);
    assert.equal(state.started_at === null, prior === 'pending', prior);
    assert.equal(state.done_at !== null, prior === 'done', prior);
    await assert.rejects(retireFrom(root, 'A', 'retired'));
    await assert.rejects(retireFrom(root, 'A', 'pending'), (error) => {
      assert.equal(reasonOf(error), 'invalid_retire_transition');
      return true;
    });
  }
});

test('retireのprior_statusが実状態と食い違えばretire_prior_status_mismatchで拒否される', async (context) => {
  const root = await workspace(context);
  await start(root, 'A');
  await assert.rejects(retireFrom(root, 'A', 'pending'), (error) => {
    assert.equal(reasonOf(error), 'retire_prior_status_mismatch');
    return true;
  });
  assert.equal((await taskOf(root, 'A')).status, 'in-progress');
});

test('in-progressをretireするとstart束縛が閉じ、同じstartへのstart_retractedは拒否される', async (context) => {
  const root = await workspace(context);
  await start(root, 'A');
  await retireFrom(root, 'A', 'in-progress');
  await assert.rejects(appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
    event: { kind: 'start_retracted', task_id: 'A', actor: ACTOR, recorded_at: NOW,
      payload: { reason: '取り消し', target_start_digest: '0'.repeat(64) } } }));
});

// Store replay only: Plan/lifecycle-owned readiness (todo-readiness.mjs) is bypassed on purpose.
const storeOnly = (root, event) => appendStoreEvent({ repoRoot: root, writer: WRITER, planKey: 'main',
  now: NOW, validateProspectiveEvent: () => ({ ok: true }),
  event: { actor: ACTOR, recorded_at: NOW, ...event } });

test('Store replay: doneからretireした前提は後続のauthored doneを許し、pendingからのretireは許さない', async (context) => {
  const fromDone = await workspace(context, { edge: true });
  await start(fromDone, 'A');
  await done(fromDone, 'A');
  await retireFrom(fromDone, 'A', 'done');
  await storeOnly(fromDone, { kind: 'start', task_id: 'B', payload: { override_reason: null } });
  await done(fromDone, 'B', storeOnly);
  assert.equal((await taskOf(fromDone, 'B')).status, 'done');

  const fromPending = await workspace(context, { edge: true });
  await retireFrom(fromPending, 'A', 'pending');
  await storeOnly(fromPending, { kind: 'start', task_id: 'B', payload: { override_reason: '前提を迂回して着手' } });
  await assert.rejects(done(fromPending, 'B', storeOnly), (error) => {
    assert.equal(reasonOf(error), 'invalid_done_transition');
    return true;
  });
});

test('retireのpayloadはreason必須', async (context) => {
  const root = await workspace(context);
  await assert.rejects(appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
    event: { kind: 'retire', task_id: 'B', actor: ACTOR, recorded_at: NOW, payload: {} } }));
});

test('retiredの前提を持つ工程はreadyにならない（撤去は完了の代わりではない）', async (context) => {
  const root = await workspace(context, { edge: true });
  await retire(root, 'A');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(computeReadyFrontier(store), []);
});

test('CLI retireコマンドが正規経路で遷移を書く', async (context) => {
  const root = await workspace(context);
  const stdout = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const stderr = { chunks: [], write(chunk) { this.chunks.push(chunk); } };
  const code = await runTodoCli({
    argv: ['retire', '--plan', 'main', '--task', 'B', '--reason', 'NO-GO裁定により恒久除去'],
    cwd: root, env: { LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1', LATTICE_TODO_ACTOR_AGENT: 'agent-1' },
    stdout, stderr,
  });
  assert.equal(code, 0, stderr.chunks.join(''));
  const result = JSON.parse(stdout.chunks.join(''));
  assert.equal(result.kind, 'retire');
  const store = await readTodoStore({ repoRoot: root, now: new Date().toISOString() });
  assert.equal(store.members[0].tasks.find(({ task_id: id }) => id === 'B').status, 'retired');
});
