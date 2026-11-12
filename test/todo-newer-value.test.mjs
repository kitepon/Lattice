// newer-value-says-upgrade: a reader that meets a value a newer Lattice wrote refuses with
// UNSUPPORTED_SCHEMA/newer_lattice_value and an upgrade next_action, never STORE_CORRUPT.
// Damaged records stay STORE_CORRUPT. Diagram: docs/architecture/dfd-store-newer-value.md.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  NEWEST_KNOWN_TODO_SCHEMA, createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const NOW = '2026-07-26T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const BASE = '.lattice/todo/plans/main/v1';
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-newer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('T1')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }], now: NOW,
  });
  await appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey: 'main', now: NOW,
    event: { kind: 'coordination_mode', actor: ACTOR, recorded_at: NOW, payload: { mode: 'witness', reason: 'r' } },
  });
  return root;
}

const lines = async (root, ref) => (await readFile(path.join(root, ref), 'utf8')).slice(0, -1).split('\n').map(JSON.parse);
const writeLines = (root, ref, events) => writeFile(path.join(root, ref),
  events.map((event) => `${canonicalizeTodoArtifact(event)}\n`).join(''));
// What a newer writer produces: the changed value with its own digest recomputed.
const sealed = (event) => ({ ...event, event_digest: todoSelfDigest(event, 'event_digest') });

async function refusal(root) {
  const error = await readTodoStore({ repoRoot: root, now: NOW }).then(() => null, (caught) => caught);
  assert.ok(error, 'the read must refuse');
  return error;
}

function assertNewer(error, pointer, value, ref) {
  assert.equal(error.code, 'UNSUPPORTED_SCHEMA');
  assert.equal(error.detail.reason, 'newer_lattice_value');
  assert.equal(error.detail.pointer, pointer);
  assert.equal(error.detail.value, value);
  assert.equal(error.detail.ref, ref);
  assert.equal(error.detail.reader_version, version);
  assert.equal(error.detail.required_version, `>${version}`);
  assert.match(error.detail.next_action, new RegExp(`Upgrade Lattice on this host to a version newer than ${version.replaceAll('.', '\\.')}`, 'u'));
  assert.match(error.detail.next_action, /not corrupt: do not repair or delete it/u);
}

test('an unknown coordination mode a newer Lattice wrote asks for a newer Lattice', async (context) => {
  const root = await workspace(context);
  const ref = `${BASE}/journal/plan-scoped.jsonl`;
  const [event] = await lines(root, ref);
  await writeLines(root, ref, [sealed({ ...event, payload: { ...event.payload, mode: 'quorum' } })]);
  assertNewer(await refusal(root), '/payload/mode', 'quorum', ref);
});

test('the same value without a matching digest is damage and stays STORE_CORRUPT', async (context) => {
  const root = await workspace(context);
  const ref = `${BASE}/journal/plan-scoped.jsonl`;
  const [event] = await lines(root, ref);
  await writeLines(root, ref, [{ ...event, payload: { ...event.payload, mode: 'quorum' } }]);
  const error = await refusal(root);
  assert.equal(error.code, 'STORE_CORRUPT');
  assert.equal(error.detail.reason, 'journal_schema_invalid');
});

test('an unknown event kind and a higher event schema in the lifecycle journal ask for a newer Lattice', async (context) => {
  const root = await workspace(context);
  const ref = `${BASE}/journal/active.jsonl`;
  const events = await lines(root, ref);
  const last = events.at(-1);
  const next = { ...last, sequence: last.sequence + 1, previous_digest: last.event_digest, kind: 'handoff', task_id: 'T1' };
  await writeLines(root, ref, [...events, sealed(next)]);
  assertNewer(await refusal(root), '/kind', 'handoff', ref);

  const schema = `lattice.todo_event.v${NEWEST_KNOWN_TODO_SCHEMA.todo_event + 1}`;
  await writeLines(root, ref, [...events, { ...next, schema, kind: 'start' }]);
  assertNewer(await refusal(root), '/schema', schema, ref);
});

test('a higher plan or manifest schema asks for a newer Lattice; an unknown family stays as before', async (context) => {
  const root = await workspace(context);
  const planRef = `${BASE}/plan.json`;
  const plan = (await lines(root, planRef))[0];
  const planSchema = `lattice.todo_plan.v${NEWEST_KNOWN_TODO_SCHEMA.todo_plan + 1}`;
  await writeLines(root, planRef, [{ ...plan, schema: planSchema }]);
  assertNewer(await refusal(root), '/schema', planSchema, planRef);

  await writeLines(root, planRef, [{ ...plan, schema: 'lattice.todo_manifest.v99' }]);
  const foreign = await refusal(root);
  assert.equal(foreign.code, 'STORE_INCONSISTENT');
  assert.equal(foreign.detail.reason, 'schema_invalid');
  await writeLines(root, planRef, [plan]);

  const manifestRef = '.lattice/todo/manifest.json';
  const manifest = (await lines(root, manifestRef))[0];
  const manifestSchema = `lattice.todo_manifest.v${NEWEST_KNOWN_TODO_SCHEMA.todo_manifest + 1}`;
  await writeLines(root, manifestRef, [{ ...manifest, schema: manifestSchema }]);
  assertNewer(await refusal(root), '/schema', manifestSchema, manifestRef);
});

test('the CLI keeps the Store upgrade next_action', async (context) => {
  const root = await workspace(context);
  const ref = `${BASE}/journal/plan-scoped.jsonl`;
  const [event] = await lines(root, ref);
  await writeLines(root, ref, [sealed({ ...event, payload: { ...event.payload, mode: 'quorum' } })]);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'lattice.mjs'), 'todo', 'status', '--json'],
    { cwd: root, encoding: 'utf8' });
  const output = JSON.parse(result.stdout || result.stderr);
  assert.equal(output.code, 'UNSUPPORTED_SCHEMA');
  assert.equal(output.detail.rule, 'newer_lattice_value');
  assert.equal(output.detail.pointer, '/payload/mode');
  assert.match(output.detail.next_action, /Upgrade Lattice/u);
});

// Registration guard: the newest version each validator accepts equals the reader table.
test('NEWEST_KNOWN_TODO_SCHEMA matches the newest schema the validators know', async () => {
  const contracts = await readFile(path.join(ROOT, 'src', 'todo-contracts.mjs'), 'utf8');
  for (const [family, newest] of Object.entries(NEWEST_KNOWN_TODO_SCHEMA)) {
    const versions = [...contracts.matchAll(new RegExp(`lattice\\.${family}\\.v(\\d+)'`, 'gu'))].map(([, n]) => Number(n));
    assert.equal(Math.max(...versions), newest, family);
  }
});
