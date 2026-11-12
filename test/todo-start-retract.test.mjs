import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTodoCli } from '../src/todo-cli.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';
import {
   createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const ACTOR = Object.freeze({ host: 'mac', session: 'seat-a', agent: 'seat-a' });
const OTHER = Object.freeze({ host: 'mac', session: 'seat-b', agent: 'seat-b' });
const PLAN_KEY = 'retract-plan';

function env(actor) {
  return {
    ...process.env,
    LATTICE_DASHBOARD_AUTOSTART: '0',
    LATTICE_TODO_ACTOR_HOST: actor.host,
    LATTICE_TODO_ACTOR_SESSION: actor.session,
    LATTICE_TODO_ACTOR_AGENT: actor.agent,
  };
}

function io() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => out.push(chunk) },
    stderr: { write: (chunk) => err.push(chunk) },
    out,
    err,
  };
}

async function command(root, argv, actor = ACTOR) {
  const streams = io();
  const exitCode = await runTodoCli({ argv, cwd: root, env: env(actor), ...streams });
  const text = (exitCode === 0 ? streams.out : streams.err).join('').trim();
  return { exitCode, value: text.length === 0 ? null : JSON.parse(text.split('\n').at(-1)) };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-start-retract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
  await writeFile(path.join(root, 'evidence.txt'), 'done evidence\n');
  execFileSync('git', ['add', 'evidence.txt'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const plan = {
    schema: 'lattice.todo_plan.v1', project_id: 'retract-project', plan_key: PLAN_KEY,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: ['A', 'B'].map((taskId) => ({
      task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
    })),
    hard_dependencies: [], joins: [],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'retract-project', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: '2026-08-09T00:00:00.000Z' } }],
    now: '2026-08-09T00:00:00.000Z',
  });
  return root;
}

async function event(root, kind, { taskId = 'A', actor = ACTOR, payload = {}, second = 1 } = {}) {
  const recordedAt = `2026-08-09T00:00:${String(second).padStart(2, '0')}.000Z`;
  return appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: PLAN_KEY, now: recordedAt,
    event: { kind, task_id: taskId, actor, recorded_at: recordedAt, payload },
  });
}

async function start(root, actor = ACTOR) {
  return event(root, 'start', { actor, payload: { override_reason: null } });
}

test('start撤回はpendingへ戻りnext_readyとparallel-frontierを通常どおり復元する', async (t) => {
  const root = await fixture(t);
  await start(root);
  const retracted = await command(root, [
    'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', '誤って着手した',
  ]);
  assert.equal(retracted.exitCode, 0);
  assert.equal(retracted.value.kind, 'start_retracted');
  assert.equal(retracted.value.status, 'pending');

  const projection = projectTodoStatus(await readTodoStore({ repoRoot: root }), {
    parallelCandidates: [], planNotes: [],
  });
  assert.deepEqual(projection.next_ready.map(({ task_id: taskId }) => taskId), ['A', 'B']);
  const restarted = await command(root, [
    'start', '--plan', PLAN_KEY, '--task', 'A', '--parallel-frontier',
  ], OTHER);
  assert.equal(restarted.exitCode, 0);
  assert.equal(restarted.value.status, 'in-progress');
});

test('pending taskの撤回はtyped errorになる', async (t) => {
  const root = await fixture(t);
  const result = await command(root, [
    'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', '対象外',
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.value.code, 'START_RETRACTION_INVALID');
});

// retract-anyone (Owner 2026-11-12): the start's seat restriction is lifted; the retracting actor is recorded.
test('別actorも他人のstartを理由付きで撤回できる', async (t) => {
  const root = await fixture(t);
  await start(root);
  const result = await command(root, [
    'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', '他人の着手',
  ], OTHER);
  assert.equal(result.exitCode, 0);
  assert.equal(result.value.status, 'pending');
});

test('blocked taskはstartを撤回できない', async (t) => {
  const root = await fixture(t);
  await start(root);
  await event(root, 'block', { payload: { reason: '外部待ち' }, second: 2 });
  const result = await command(root, [
    'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', 'blockedの取消',
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.value.code, 'START_RETRACTION_INVALID');
});

test('done taskはstartを撤回できない', async (t) => {
  const root = await fixture(t);
  await start(root);
  const bytes = await readFile(path.join(root, 'evidence.txt'));
  const oid = execFileSync('git', ['rev-parse', 'HEAD:evidence.txt'], { cwd: root, encoding: 'utf8' }).trim();
  await event(root, 'done', { second: 2, payload: { evidence: {
    evidence_id: 'done-evidence', repo_id: 'self', path: 'evidence.txt', git_blob_oid: oid,
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  } } });
  const result = await command(root, [
    'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', 'doneの取消',
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.value.code, 'START_RETRACTION_INVALID');
});
