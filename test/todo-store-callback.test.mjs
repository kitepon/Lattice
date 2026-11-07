import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateProspectiveEvent } from '../src/todo-readiness.mjs';
import { appendTodoEvent, createTodoStoreWriter, initializeTodoStore, readTodoStore } from '../src/todo-store.mjs';

const NOW = '2026-08-09T00:00:00.000Z';
const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const artifacts = ['manifest.json', 'plans/main/v1/journal/active.jsonl', 'plans/main/v1/snapshot.json'];

async function fixture(t) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'lattice-store-callback-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
  await initializeTodoStore({ repoRoot, now: NOW, projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }], writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
      plan_version: 'v1', predecessor_plan_digest: null,
      tasks: [{ task_id: 'T1', title: 'T1', lane: 'main', narrative_ref: null, compile_binding: null }],
      hard_dependencies: [], joins: [] }, genesis: { actor: ACTOR, recorded_at: NOW } }] });
  const request = { repoRoot, now: NOW, planKey: 'main', writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    event: { kind: 'start', task_id: 'T1', actor: ACTOR, recorded_at: NOW, payload: { override_reason: null } } };
  const bytes = () => Promise.all(artifacts.map((ref) => readFile(path.join(repoRoot, '.lattice/todo', ref))));
  return { repoRoot, request, bytes };
}

test('the raw Store requires the supplied validator before acquiring ownership or changing bytes', async (t) => {
  const { request, bytes } = await fixture(t);
  const before = await bytes();
  await assert.rejects(appendTodoEvent(request), TypeError);
  assert.deepEqual(await bytes(), before);
  await assert.rejects(readFile(path.join(request.repoRoot, '.lattice/todo/.write.lock')), { code: 'ENOENT' });
});

test('the callback sees recovered fresh state once while the transaction lock is held', async (t) => {
  const { repoRoot, request } = await fixture(t);
  const callerView = await readTodoStore({ repoRoot, now: NOW });
  const started = await appendTodoEvent({ ...request, validateProspectiveEvent });
  await writeFile(path.join(repoRoot, '.lattice/todo/plans/main/v1/snapshot.json'), '{}\n');
  let calls = 0;
  const result = await appendTodoEvent({ ...request,
    event: { ...request.event, kind: 'block', payload: { reason: 'waiting' } },
    validateProspectiveEvent(value) {
      calls++;
      const { store, member, event } = value;
      assert.notEqual(store, callerView);
      assert.ok(store.members.includes(member));
      assert.equal(member.tasks[0].status, 'in-progress');
      assert.equal(member.descriptor.journal_head_digest, started.event.event_digest);
      assert.equal(member.snapshot_stale, false);
      assert.ok(Array.isArray(member.phases));
      assert.equal(event.previous_digest, started.event.event_digest);
      assert.equal(JSON.parse(readFileSync(path.join(repoRoot, '.lattice/todo/.write.lock'), 'utf8')).pid, process.pid);
      return validateProspectiveEvent(value);
    } });
  assert.equal(calls, 1);
  assert.equal(result.event.sequence, 2);
  assert.equal(result.snapshot.tasks[0].status, 'blocked');
});

test('validator refusal retains code/reason/cause and leaves durable artifacts unchanged', async (t) => {
  const { request, bytes } = await fixture(t);
  const before = await bytes();
  let calls = 0;
  await assert.rejects(appendTodoEvent({ ...request, validateProspectiveEvent() {
    calls++;
    return { ok: false, code: 'STORE_INCONSISTENT', detail: { reason: 'invalid_start_transition', cause: 'task_state' } };
  } }), (error) => error.code === 'STORE_INCONSISTENT'
    && error.detail.reason === 'invalid_start_transition' && error.detail.cause === 'task_state');
  assert.equal(calls, 1);
  assert.deepEqual(await bytes(), before);
});

test('a malformed validator response cannot bypass validation or append an event', async (t) => {
  const { request, bytes } = await fixture(t);
  const before = await bytes();
  await assert.rejects(appendTodoEvent({ ...request, validateProspectiveEvent: () => ({ ok: 'yes' }) }), TypeError);
  assert.deepEqual(await bytes(), before);
});
