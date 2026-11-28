// b1-store-readiness: 接続 (schedule) events on the plan-scoped chain, their projection and the start gate.
// docs/architecture/dfd-todo-connections.md

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTodoStoreWriter, readTodoStore } from '../src/todo-store.mjs';
import { listTodoConnections } from '../src/todo-readiness.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ACTOR = { host: 'fixture', session: 'fixture', agent: 'bot-a' };

async function chart(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-connections-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
  const ok = (args) => {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const refused = (args) => {
    const result = run(args);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused`);
    return JSON.parse(result.stderr || result.stdout);
  };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'p1', phases: [{ phase_id: 'ph', title: 'phase' }],
    tasks: ['A', 'B'].map((id) => ({ task_id: id, title: id, phase_id: 'ph', lane: 'bot-c', design_memo: 'NO_PLAN' })),
    hard_dependencies: [],
  }));
  ok(['plan', 'create', '--input', 'plan.json']);
  const append = (kind, payload) => appendTodoEvent({ repoRoot: root, planKey: 'p1',
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    event: { kind, actor: ACTOR, payload } });
  const add = (taskId, id) => append('connection_added', { task_id: taskId, to: { kind: 'schedule', id }, reason: `wait for ${id}` });
  const connections = async (taskId, options) => listTodoConnections(await readTodoStore({ repoRoot: root }), 'p1', taskId, options);
  const ready = () => ok(['todo', 'status', '--json']).next_ready.map(({ task_id: id }) => id);
  return { root, ok, refused, append, add, connections, ready };
}

test('an open schedule 接続 keeps the task out of next_ready and refuses start with connection_open', async (context) => {
  const { ok, refused, add, connections, ready } = await chart(context);
  assert.deepEqual(ready(), ['A', 'B']);
  await add('A', 'sch-1');
  assert.deepEqual(ready(), ['B']);
  const [entry] = await connections('A');
  assert.deepEqual({ kind: entry.kind, ref: entry.ref, state: entry.state, reason: entry.reason },
    { kind: 'schedule', ref: 'sch-1', state: 'open', reason: 'wait for sch-1' });
  assert.match(entry.event_digest, /^[0-9a-f]{64}$/u);
  const status = ok(['todo', 'status', '--json']);
  assert.deepEqual(status.connection_pending.map(({ task_id: id, connections: list }) => [id, list.map(({ ref }) => ref)]),
    [['A', ['sch-1']]]);
  const refusal = refused(['todo', 'start', '--plan', 'p1', '--task', 'A']);
  assert.equal(refusal.detail.cause, 'connection_open');
  assert.deepEqual(refusal.detail.blocking_connections.map(({ kind, ref }) => ({ kind, ref })), [{ kind: 'schedule', ref: 'sch-1' }]);
  const show = ok(['todo', 'show', '--plan', 'p1', '--task', 'A', '--json']).prerequisites;
  assert.equal(show.ready, false);
  assert.deepEqual(show.connections.map(({ ref, state }) => [ref, state]), [['sch-1', 'open']]);
});

test('resolving or removing the 接続 makes the task startable; each add has one end', async (context) => {
  const { ok, root, add, append, connections, ready } = await chart(context);
  await add('A', 'sch-1'); await add('B', 'sch-2');
  const [a] = await connections('A'); const [b] = await connections('B');
  await append('connection_resolved', { target_event_digest: a.event_digest, evidence: 'exit 0: CI green' });
  await append('connection_removed', { target_event_digest: b.event_digest, reason: 'no longer needed' });
  assert.deepEqual(ready(), ['A', 'B']);
  const [settled] = await connections('A');
  assert.deepEqual({ state: settled.state, evidence: settled.evidence }, { state: 'settled', evidence: 'exit 0: CI green' });
  assert.ok(settled.settled_at);
  // n2: a removed schedule is listed as gone, so a reader tells it from "never connected".
  assert.deepEqual((await connections('B')).map(({ state, state_reason: reason }) => [state, reason]), [['gone', 'schedule_removed']]);
  ok(['todo', 'start', '--plan', 'p1', '--task', 'A']);
  // Retries replay to the same state: nothing is appended, the first evidence wins.
  const head = async () => (await readTodoStore({ repoRoot: root })).members[0].plan_scoped.events.length;
  const before = await head();
  assert.equal((await append('connection_resolved', { target_event_digest: a.event_digest, evidence: 'second' })).unchanged, true);
  assert.equal((await append('connection_removed', { target_event_digest: a.event_digest, reason: 'x' })).unchanged, true);
  assert.equal((await append('connection_removed', { target_event_digest: b.event_digest, reason: 'again' })).unchanged, true);
  assert.equal((await add('A', 'sch-1')).unchanged, undefined, 'a settled add may be added again');
  assert.equal(await head(), before + 1);
  assert.equal((await connections('A')).find(({ state }) => state === 'settled').evidence, 'exit 0: CI green');
  for (const [kind, payload, reason] of [
    ['connection_resolved', { target_event_digest: b.event_digest, evidence: 'x' }, 'connection_already_removed'],
    ['connection_resolved', { target_event_digest: 'f'.repeat(64), evidence: 'x' }, 'connection_not_found'],
    ['connection_removed', { target_event_digest: 'f'.repeat(64), reason: 'x' }, 'connection_not_found'],
  ]) {
    await assert.rejects(() => append(kind, payload), (error) => error.detail?.reason === reason, reason);
  }
});

test('refusals: unknown task, malformed target; a duplicate open add is unchanged', async (context) => {
  const { add, append } = await chart(context);
  await add('A', 'sch-1');
  assert.equal((await add('A', 'sch-1')).unchanged, true);
  await add('B', 'sch-1');
  await assert.rejects(() => add('NOPE', 'sch-1'), (error) => error.detail?.reason === 'task_not_found');
  for (const to of [{ kind: 'task', id: 'x' }, { kind: 'schedule', id: 'has space' }, { kind: 'schedule', id: '' },
    { kind: 'schedule', id: 'x'.repeat(129) }]) {
    await assert.rejects(() => append('connection_added', { task_id: 'A', to, reason: 'r' }));
  }
});

test('an in-progress task keeps its state when a 接続 is added, and done is not gated by it', async (context) => {
  const { ok, add, ready, connections } = await chart(context);
  ok(['todo', 'start', '--plan', 'p1', '--task', 'B']);
  await add('B', 'sch-1');
  assert.equal(ok(['todo', 'status', '--json']).active_set[0].connections[0].ref, 'sch-1');
  assert.deepEqual(ready(), ['A']);
  ok(['todo', 'done', '--plan', 'p1', '--task', 'B', '--message', 'finished']);
  assert.equal((await connections('B'))[0].state, 'open');
});

test('an open schedule 接続 travels through todo add (a plan revision); a settled one does not', async (context) => {
  const { ok, add, append, connections, ready } = await chart(context);
  await add('A', 'sch-1'); await add('B', 'sch-2');
  const [b] = await connections('B');
  await append('connection_resolved', { target_event_digest: b.event_digest, evidence: 'done' });
  ok(['todo', 'add', '--plan', 'p1', '--task', 'C', '--title', 'C', '--phase', 'ph', '--lane', 'bot-c', '--design-memo', 'NO_PLAN']);
  assert.deepEqual((await connections('A')).map(({ ref, state }) => [ref, state]), [['sch-1', 'open']]);
  assert.deepEqual(await connections('B'), []);
  assert.deepEqual(ready(), ['B', 'C']);
});

test('優先接続 (the todo wait mark) sits in the same connections list and gates nothing', async (context) => {
  const { ok, add, ready } = await chart(context);
  await add('A', 'sch-1');
  // A wait on a task that can start now records nothing; A is held by its 接続, so the mark is recorded.
  assert.equal(ok(['todo', 'wait', '--plan', 'p1', '--task', 'B']).state, 'startable_now');
  ok(['todo', 'wait', '--plan', 'p1', '--task', 'A', '--reason', 'need it first']);
  assert.deepEqual(ready(), ['B']);
  const pending = ok(['todo', 'status', '--json']).connection_pending;
  assert.deepEqual(pending.map(({ task_id: id }) => id), ['A']);
  assert.deepEqual(pending[0].connections.map(({ kind, agent, reason }) => ({ kind, agent, reason })),
    [{ kind: 'schedule', agent: undefined, reason: 'wait for sch-1' },
      { kind: 'priority', agent: 'bot-a', reason: 'need it first' }]);
  const show = ok(['todo', 'show', '--plan', 'p1', '--task', 'A', '--json']).prerequisites;
  assert.deepEqual(show.connections.map(({ kind }) => kind), ['schedule', 'priority']);
  assert.deepEqual(ok(['todo', 'display', 'read']).connections.map(({ task_id: id, connections }) => [id, connections.map(({ kind }) => kind)]),
    [['A', ['schedule', 'priority']]]);
});
