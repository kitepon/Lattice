// w2-impl: note targets are resolved from a sparse, cached lineage instead of a walk through every version per note.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_NOTE_EVENT_SCHEMA, todoSelfDigest } from '../src/todo-contracts.mjs';
import { appendTodoNote, projectTodoNoteContext, readTodoNoteContext } from '../src/todo-note-store.mjs';
import { phaseTodoRevisionPlanVersion } from '../src/todo-revision.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter, initializeTodoStore, readTodoStore,
} from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const actor = { host: 'host', session: 'session', agent: 'fixture' };
const recordedAt = '2026-11-07T00:00:00.000Z';

// The walk this change replaced, kept as the oracle: every note follows task_migration through every later version.
function oracleTarget(event, { head, taskIds, migrations }) {
  const byFrom = new Map(migrations.map((migration) => [migration.from_plan_version,
    { to: migration.to_plan_version, map: new Map(migration.task_migration.map((entry) => [entry.from_task_id,
      entry.to_task_id === 'removed' ? null : entry.to_task_id])) }]));
  let version = event.plan_version;
  let task = event.task_id;
  while (version !== head) {
    const step = byFrom.get(version);
    const next = step?.map.get(task);
    if (next === undefined || next === null) return null;
    version = step.to;
    task = next;
  }
  return taskIds.has(task) ? task : null;
}

test('the lineage equals the per-note walk on a long chain with renames, swaps, removals and re-added ids', () => {
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const versions = Array.from({ length: 40 }, (_, index) => `v${index}`);
  let next = 0;
  let tasks = Array.from({ length: 12 }, () => `t${next++}`);
  const taskSets = [tasks];
  const migrations = [];
  for (let index = 1; index < versions.length; index += 1) {
    const kept = [...tasks];
    const target = new Map(kept.map((task) => [task, task]));
    for (const task of kept) {
      const roll = random(10);
      if (roll === 0) target.set(task, null);
      else if (roll === 1) target.set(task, `t${next++}`);
    }
    if (random(4) === 0 && kept.length > 1) { // swap two ids: a rename must not be read as the other's identity
      const [a, b] = [kept[random(kept.length)], kept[random(kept.length)]];
      if (a !== b && target.get(a) === a && target.get(b) === b) { target.set(a, b); target.set(b, a); }
    }
    if (random(5) === 0) { const removed = kept.find((task) => target.get(task) === null); if (removed) target.set(removed, null); }
    const readded = [...migrations.flatMap(({ task_migration: moves }) => moves).filter((m) => m.to_task_id === 'removed')][0];
    const born = [`t${next++}`, ...(readded && random(3) === 0 && !target.has(readded.from_task_id) ? [readded.from_task_id] : [])];
    migrations.push({ from_plan_version: versions[index - 1], to_plan_version: versions[index],
      task_migration: kept.map((task) => ({ from_task_id: task, to_task_id: target.get(task) ?? 'removed' })) });
    tasks = [...new Set([...kept.map((task) => target.get(task)).filter((task) => task !== null), ...born])];
    taskSets.push(tasks);
  }
  const specs = taskSets.flatMap((set, index) => set.map((task) => ({ plan_version: versions[index], task_id: task })));
  let previous = null;
  const events = specs.map((spec, index) => {
    const event = { schema: TODO_NOTE_EVENT_SCHEMA, project_id: 'lattice', plan_key: 'plan-a', task_id: spec.task_id,
      plan_version: spec.plan_version, sequence: index + 1, previous_digest: previous?.event_digest ?? null, actor,
      recorded_at: recordedAt, body: `${spec.plan_version}/${spec.task_id}`, supersedes: null, event_digest: '' };
    event.event_digest = todoSelfDigest(event, 'event_digest');
    previous = event;
    return event;
  });
  const head = versions.at(-1);
  const currentTaskIds = taskSets.at(-1);
  let moved = 0;
  for (const currentTaskId of currentTaskIds) {
    const result = projectTodoNoteContext({ projectId: 'lattice', planKey: 'plan-a', currentPlanVersion: head, currentTaskId,
      currentTaskIds, events, planEvents: [], migrations });
    const expected = events.filter((event) => oracleTarget(event, { head, taskIds: new Set(currentTaskIds), migrations }) === currentTaskId);
    assert.deepEqual(result.history.map(({ event_digest: digest }) => digest).sort(), expected.map(({ event_digest: digest }) => digest).sort());
    moved += expected.filter((event) => event.task_id !== currentTaskId).length;
    const archived = events.filter((event) => oracleTarget(event, { head, taskIds: new Set(currentTaskIds), migrations }) === null);
    assert.deepEqual(result.archived.map(({ event_digest: digest }) => digest).sort(), archived.map(({ event_digest: digest }) => digest).sort());
  }
  assert.ok(moved > 0 && events.length > 100, 'the chain exercises renames');
});

test('a migration list with a fork or a cycle is refused as before', () => {
  const base = { projectId: 'lattice', planKey: 'plan-a', currentPlanVersion: 'v2', currentTaskId: 'a', currentTaskIds: ['a'], events: [], planEvents: [] };
  const step = (from, to) => ({ from_plan_version: from, to_plan_version: to, task_migration: [{ from_task_id: 'a', to_task_id: 'a' }] });
  assert.throws(() => projectTodoNoteContext({ ...base, migrations: [step('v1', 'v2'), step('v1', 'v3')] }), { code: 'NOTE_PROJECTION_INVALID' });
  assert.throws(() => projectTodoNoteContext({ ...base, migrations: [step('v1', 'v2'), step('v2', 'v1')] }), { code: 'NOTE_PROJECTION_INVALID' });
});

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-note-lineage-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v4', project_id: 'project', plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
    tasks: ['a', 'b'].map((task_id) => ({ task_id, title: task_id, lane: 'main', narrative_ref: null, narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase' })),
    phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['gate'] }],
    hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }], plans: [{ plan, genesis: { actor, recorded_at: recordedAt } }] });
  return root;
}

const note = async (root, taskId, body) => {
  const store = await readTodoStore({ repoRoot: root });
  const member = store.members[0];
  return appendTodoNote({ repoRoot: root, projectId: 'project', planKey: 'main', planVersion: member.plan.plan_version, taskId,
    actor, recordedAt, body, supersedes: null, eligibleSupersedes: [] });
};

// One revision: `moves` maps each predecessor task to its new id (null: removed); `born` are new tasks. Every predecessor task needs an entry.
async function revise(root, moves, born = []) {
  const previous = (await readTodoStore({ repoRoot: root })).members[0];
  const predecessor = { plan_digest: previous.plan.plan_digest, journal_head_digest: previous.journal.events.at(-1).event_digest,
    plan_version: previous.plan.plan_version };
  const task_migration = Object.entries(moves).sort(([x], [y]) => (x < y ? -1 : 1)).map(([from, to]) => ({ from_task_id: from,
    to_task_id: to ?? 'removed', state_policy: to === null ? 'removed' : 'carry' }));
  const phase_migration = [{ from_phase_id: 'phase', to_phase_id: 'phase', state_policy: 'reset' }];
  const ids = [...Object.values(moves).filter((id) => id !== null), ...born].sort();
  const desired = { ...previous.plan, predecessor_plan_digest: predecessor.plan_digest,
    tasks: ids.map((task_id) => ({ ...previous.plan.tasks[0], task_id })) };
  desired.plan_version = phaseTodoRevisionPlanVersion({ projectId: 'project', planKey: 'main', predecessor, desiredPlan: desired,
    taskMigration: task_migration, phaseMigration: phase_migration });
  const revision = { schema: 'lattice.phase_todo_revision.v1', project_id: 'project', plan_key: 'main', predecessor,
    desired_plan: buildTodoPlan(desired), task_migration, phase_migration, revision_digest: '' };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  await applyPhaseTodoRevision({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision, actor, recordedAt });
}
const renameAndRemove = (root) => revise(root, { a: 'renamed', b: null });
const add = async (root, id) => {
  const { plan } = (await readTodoStore({ repoRoot: root })).members[0];
  await revise(root, Object.fromEntries(plan.tasks.map(({ task_id: task }) => [task, task])), [id]);
};

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'adder' } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test('the store lineage follows renames and removals, is cached, extended per revision, and a bad cache is only a miss', async (context) => {
  const root = await fixture(context);
  await note(root, 'a', 'carried from v1');
  await note(root, 'b', 'retired with b');
  await renameAndRemove(root);
  await note(root, 'renamed', 'written on v2');
  await add(root, 'c');
  await note(root, 'c', 'written on v3');
  const read = async (taskId) => {
    const store = await readTodoStore({ repoRoot: root });
    return readTodoNoteContext({ repoRoot: root, store, planKey: 'main', taskId });
  };
  const bodies = ({ context: { notes } }) => notes.map(({ body }) => body);
  const first = await read('renamed');
  assert.deepEqual(bodies(first), ['written on v2', 'carried from v1']);
  // A short chain leaves no file in the user's tree (an ordinary todo start must not dirty a git status); a long one is cached.
  await assert.rejects(readFile(path.join(root, '.lattice/generated/store-note-lineage/main.json')), { code: 'ENOENT' });
  for (let index = 0; index < 30; index += 1) await add(root, `f${String(index).padStart(2, '0')}`);
  assert.deepEqual(bodies(await read('renamed')), ['written on v2', 'carried from v1']);
  assert.deepEqual(first.archived.map(({ body }) => body), ['retired with b']);
  assert.deepEqual(bodies(await read('c')), ['written on v3']);

  const cacheFile = path.join(root, '.lattice/generated/store-note-lineage/main.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cache.schema, 'lattice.todo_note_lineage_cache.v1');
  assert.equal(cache.versions.length, 33);
  assert.equal(cache.versions[0], 'v1');
  assert.deepEqual(cache.moves, [[0, 'a', 'renamed'], [0, 'b', null]]);
  const plant = async (mutate, digest = true) => {
    const { cache_digest: _old, ...body } = JSON.parse(await readFile(cacheFile, 'utf8'));
    mutate(body);
    const text = JSON.stringify(body);
    await writeFile(cacheFile, digest ? `${text.slice(0, -1)},"cache_digest":"${createHash('sha256').update(text).digest('hex')}"}` : text);
  };
  // A cached head equal to the head is used as it stands: a planted move shows through with no version read (a fresh process:
  // this one memoizes the lineage of a head).
  await plant((body) => { body.moves.push([1, 'renamed', null]); });
  const listed = cli(root, ['todo', 'note', 'list', '--plan', 'main', '--task', 'renamed', '--json']);
  assert.deepEqual(listed.notes, []);
  assert.deepEqual(listed.archived.map(({ body }) => body).sort(), ['carried from v1', 'retired with b', 'written on v2']);
  // One revision later the read extends the cached lineage (the planted move survives) and publishes it.
  await plant((body) => { body.moves = [[0, 'a', 'planted'], [0, 'b', null]]; });
  await add(root, 'd');
  assert.deepEqual(bodies(await read('renamed')), ['written on v2']);
  const extended = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(extended.versions.length, 34);
  assert.deepEqual(extended.versions.slice(0, 33), cache.versions);
  assert.deepEqual(extended.moves, [[0, 'a', 'planted'], [0, 'b', null]]);
  // A cache that does not verify (digest, schema, shape, a head off the chain) is a miss: the chain is read again.
  const misses = [
    [(body) => { body.moves = [[0, 'a', 'planted']]; }, false],
    [(body) => { body.schema = 'lattice.todo_note_lineage_cache.v0'; }, true],
    [(body) => { body.moves = [[99, 'a', 'x']]; }, true],
    [(body) => { body.versions = ['v1', 'elsewhere']; }, true],
  ];
  for (const [mutate, digest] of misses) {
    await plant(mutate, digest);
    await add(root, `m${misses.indexOf(misses.find(([m]) => m === mutate))}`);
    assert.deepEqual(bodies(await read('renamed')), ['written on v2', 'carried from v1']);
    const rebuilt = JSON.parse(await readFile(cacheFile, 'utf8'));
    assert.deepEqual(rebuilt.moves, [[0, 'a', 'renamed'], [0, 'b', null]]);
  }
  // A cache that cannot be written never fails the read.
  await rm(path.join(root, '.lattice/generated/store-note-lineage'), { recursive: true });
  await writeFile(path.join(root, '.lattice/generated/store-note-lineage'), 'not a directory');
  await add(root, 'z');
  assert.deepEqual(bodies(await read('renamed')), ['written on v2', 'carried from v1']);
});

test('todo note answers with the context a fresh read gives, with or without a correction', async (context) => {
  const root = await fixture(context);
  await renameAndRemove(root);
  const written = cli(root, ['todo', 'note', '--plan', 'main', '--task', 'renamed', '--message', 'first']);
  const store = await readTodoStore({ repoRoot: root });
  const fresh = await readTodoNoteContext({ repoRoot: root, store, planKey: 'main', taskId: 'renamed' });
  assert.deepEqual(written.note_context, fresh.context);
  const corrected = cli(root, ['todo', 'note', '--plan', 'main', '--task', 'renamed', '--message', 'second', '--supersedes', written.event.event_digest]);
  const after = await readTodoNoteContext({ repoRoot: root, store: await readTodoStore({ repoRoot: root }), planKey: 'main', taskId: 'renamed' });
  assert.deepEqual(corrected.note_context, after.context);
  assert.equal(corrected.note_context.notes[0].body, 'second');
});
