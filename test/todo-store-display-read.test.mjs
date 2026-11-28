// Store display read (dfd-store-display-read.md): verified > unverified > last_verified > unavailable.
//
// 固定するのは: 検証済み読みだけがcheckpointを書く／strict失敗でも現在のrawが読めれば
// unverifiedで返る／何も読めない時だけcheckpointのlast_verified／無ければunavailable／
// 回復したら次の読みでverifiedへ戻る／canonical Storeへは一切書かない。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTodoStoreWriter, initializeTodoStore, readTodoStoreDisplaySource, readTodoStoreForDisplay,
} from '../src/todo-store.mjs';
import { closedDisplayHistory, compactDisplayStore, decodeHistoryCursor, openDisplayResult } from '../src/todo-store-view.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-07-26T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const CHECKPOINT = '.lattice/generated/store-display/last-verified.json';
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, compile_binding: null });
const planEntry = (planKey) => ({
  plan: {
    schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: planKey,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [],
  },
  genesis: { actor: ACTOR, recorded_at: NOW },
});

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-display-read-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [planEntry('alpha'), planEntry('beta')], now: NOW,
  });
  const abs = (ref) => path.join(root, ref);
  const manifest = JSON.parse(await readFile(abs('.lattice/todo/manifest.json'), 'utf8'));
  const ref = (planKey) => manifest.members.find((member) => member.plan_key === planKey);
  return {
    root, abs, ref,
    display: () => readTodoStoreForDisplay({ repoRoot: root, now: NOW }),
    source: () => readTodoStoreDisplaySource({ repoRoot: root }),
    append: (planKey = 'alpha') => appendTodoEvent({
      repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
      event: { kind: 'coordination_mode', actor: ACTOR, recorded_at: NOW, payload: { mode: 'conversation', reason: 'x' } },
    }),
    // Overwrites a file and returns a function restoring its original bytes.
    async clobber(ref, bytes) {
      const original = await readFile(abs(ref));
      await writeFile(abs(ref), bytes);
      return () => writeFile(abs(ref), original);
    },
    async clobberSnapshots(bytes = 'not json') {
      const restores = await Promise.all(['alpha', 'beta'].map((key) => this.clobber(ref(key).snapshot_ref, bytes)));
      return () => Promise.all(restores.map((restore) => restore()));
    },
    checkpointBytes: () => readFile(abs(CHECKPOINT)),
  };
}

// Recursive byte snapshot: relative path -> hex bytes.
async function treeBytes(directory, base = directory, out = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await treeBytes(full, base, out);
    else out[path.relative(base, full)] = (await readFile(full)).toString('hex');
  }
  return out;
}

const corruptManifestDigest = async (w) => {
  const manifest = JSON.parse(await readFile(w.abs('.lattice/todo/manifest.json'), 'utf8'));
  manifest.manifest_digest = '0'.repeat(64);
  return w.clobber('.lattice/todo/manifest.json', JSON.stringify(manifest));
};

// A garbage snapshot alone is tolerated by the strict read (snapshot_stale), so every
// "unreadable snapshot" case also breaks strict via the manifest digest.
const breakStrictAndSnapshots = async (w) => {
  const restoreManifest = await corruptManifestDigest(w);
  const restoreSnapshots = await w.clobberSnapshots();
  return () => Promise.all([restoreManifest(), restoreSnapshots()]);
};

test('healthy store is verified, serializable and publishes the checkpoint', async (context) => {
  const w = await workspace(context);
  const result = await w.display();
  assert.equal(result.state, 'verified');
  assert.equal(result.store.schema, 'lattice.todo_store_read.v1');
  assert.equal(result.verified_at, new Date(NOW).toISOString());
  assert.equal(result.inconsistency, null);
  assert.deepEqual(result.dropped_members, []);
  assert.equal(result.store.members.length, 2);
  for (const member of result.store.members) {
    assert.equal(member.journal.activeBytes, undefined);
    assert.equal(member.journal.segments, undefined);
    assert.equal(member.plan_scoped.activeBytes, undefined);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const checkpoint = JSON.parse(await w.checkpointBytes());
  assert.equal(checkpoint.verified_at, result.verified_at);
  assert.deepEqual(checkpoint.source, result.source);
});

test('unchanged source does not rewrite the checkpoint; a plan-scoped-only append does', async (context) => {
  const w = await workspace(context);
  const first = await w.display();
  const bytes = await w.checkpointBytes();
  const before = await stat(w.abs(CHECKPOINT));
  const second = await w.display();
  const after = await stat(w.abs(CHECKPOINT));
  assert.equal(second.state, 'verified');
  assert.deepEqual(await w.checkpointBytes(), bytes);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);

  await w.append('alpha');
  const third = await w.display();
  assert.equal(third.state, 'verified');
  assert.equal(third.source.manifest_digest, first.source.manifest_digest);
  const head = (result) => result.source.members.find((member) => member.plan_key === 'alpha').plan_scoped_head;
  assert.notEqual(head(third), head(first));
  assert.notDeepEqual(await w.checkpointBytes(), bytes);
  assert.equal(JSON.parse(await w.checkpointBytes()).source.members.find((m) => m.plan_key === 'alpha').plan_scoped_head, head(third));
});

test('display source equals the verified source and tracks plan-scoped heads', async (context) => {
  const w = await workspace(context);
  const verified = await w.display();
  const before = await w.source();
  assert.deepEqual(before, verified.source);
  await w.append('alpha');
  const after = await w.source();
  const head = (source, key) => source.members.find((member) => member.plan_key === key).plan_scoped_head;
  assert.notEqual(head(after, 'alpha'), head(before, 'alpha'));
  assert.equal(head(after, 'beta'), head(before, 'beta'));
  assert.equal(after.manifest_digest, before.manifest_digest);
});

test('strict failure with readable snapshots is unverified and leaves the checkpoint alone', async (context) => {
  const w = await workspace(context);
  const verified = await w.display();
  const bytes = await w.checkpointBytes();
  await corruptManifestDigest(w);
  const result = await w.display();
  assert.equal(result.state, 'unverified');
  assert.equal(result.verified_at, null);
  assert.equal(typeof result.inconsistency.code, 'string');
  assert.equal(typeof result.inconsistency.detail.reason, 'string');
  assert.deepEqual(result.dropped_members, []);
  assert.equal(result.store.members.length, 2);
  for (const member of result.store.members) {
    assert.deepEqual(Object.keys(member).sort(), ['descriptor', 'plan', 'snapshot']);
  }
  assert.equal(result.source.repository_identity, verified.source.repository_identity);
  assert.deepEqual(await w.checkpointBytes(), bytes);
});

test('an unreadable snapshot is dropped by name and its neighbour is kept', async (context) => {
  const w = await workspace(context);
  await corruptManifestDigest(w);
  await w.clobber(w.ref('alpha').snapshot_ref, 'not json');
  const result = await w.display();
  assert.equal(result.state, 'unverified');
  assert.equal(result.dropped_members.length, 1);
  const [dropped] = result.dropped_members;
  assert.equal(dropped.plan_key, 'alpha');
  assert.equal(dropped.snapshot_ref, w.ref('alpha').snapshot_ref);
  assert.equal(typeof dropped.code, 'string');
  assert.equal(typeof dropped.reason, 'string');
  assert.deepEqual(result.store.members.map((member) => member.descriptor.plan_key), ['beta']);
});

test('a readable snapshot with an unreadable plan keeps the member with plan null', async (context) => {
  const w = await workspace(context);
  await w.clobber(w.ref('alpha').plan_ref, 'not json');
  const result = await w.display();
  assert.equal(result.state, 'unverified');
  const alpha = result.store.members.find((member) => member.descriptor.plan_key === 'alpha');
  assert.equal(alpha.plan, null);
  assert.notEqual(alpha.snapshot, null);
  assert.equal(result.store.members.length, 2);
  assert.equal(result.dropped_members.length, 1);
  assert.equal(result.dropped_members[0].plan_key, 'alpha');
  assert.equal(result.dropped_members[0].plan_ref, w.ref('alpha').plan_ref);
  assert.equal(result.dropped_members[0].snapshot_ref, undefined);
});

test('nothing readable with an earlier checkpoint is last_verified', async (context) => {
  const w = await workspace(context);
  const verified = await w.display();
  await breakStrictAndSnapshots(w);
  const result = await w.display();
  assert.equal(result.state, 'last_verified');
  assert.equal(result.verified_at, verified.verified_at);
  assert.deepEqual(result.source, verified.source);
  assert.deepEqual(result.store, verified.store);
  assert.equal(typeof result.inconsistency.code, 'string');
  assert.equal(result.dropped_members.length, 2);
});

test('nothing readable without a checkpoint is unavailable', async (context) => {
  const w = await workspace(context);
  await breakStrictAndSnapshots(w);
  const result = await w.display();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.store, null);
  assert.equal(result.source, null);
  assert.equal(result.verified_at, null);
  assert.equal(typeof result.inconsistency.code, 'string');
});

test('a tampered checkpoint is never last_verified', async (context) => {
  const w = await workspace(context);
  await w.display();
  const text = (await w.checkpointBytes()).toString('utf8');
  const tampered = text.replace('"verified_at":"2026', '"verified_at":"2027');
  assert.notEqual(tampered, text);
  await writeFile(w.abs(CHECKPOINT), tampered);
  await breakStrictAndSnapshots(w);
  const result = await w.display();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.store, null);
});

test('a checkpoint copied from another repository is never last_verified', async (context) => {
  const donor = await workspace(context);
  await donor.display();
  const w = await workspace(context);
  await mkdir(path.dirname(w.abs(CHECKPOINT)), { recursive: true });
  await writeFile(w.abs(CHECKPOINT), await donor.checkpointBytes());
  await breakStrictAndSnapshots(w);
  const result = await w.display();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.source, null);
});

test('recovery: restoring the original bytes returns the next read to verified', async (context) => {
  const w = await workspace(context);
  const restoreManifest = await corruptManifestDigest(w);
  assert.equal((await w.display()).state, 'unverified');
  const restoreSnapshots = await w.clobberSnapshots();
  assert.equal((await w.display()).state, 'unavailable');
  await Promise.all([restoreManifest(), restoreSnapshots()]);
  const result = await w.display();
  assert.equal(result.state, 'verified');
  assert.equal(result.inconsistency, null);
  assert.deepEqual(result.dropped_members, []);
});

test('a degraded read mutates nothing under .lattice/todo and creates no lock', async (context) => {
  const w = await workspace(context);
  await w.display();
  await corruptManifestDigest(w);
  await w.clobber(w.ref('alpha').snapshot_ref, 'not json');
  const todo = w.abs('.lattice/todo');
  const before = await treeBytes(todo);
  assert.equal((await w.display()).state, 'unverified');
  await w.source();
  const after = await treeBytes(todo);
  assert.deepEqual(after, before);
  assert.equal(Object.keys(after).some((file) => file.endsWith('.write.lock')), false);
});

test('checkpoint publication failure still returns the verified view without throwing', async (context) => {
  const w = await workspace(context);
  await writeFile(w.abs('.lattice/generated'), 'in the way');
  const warned = new Promise((resolve) => process.once('warning', resolve));
  const result = await w.display();
  assert.equal(result.state, 'verified');
  assert.equal(result.store.members.length, 2);
  const warning = await Promise.race([warned, new Promise((resolve) => setTimeout(resolve, 1000))]);
  assert.equal(warning?.code, 'LATTICE_STORE_DISPLAY_CHECKPOINT_PUBLICATION_FAILED');
});

test('an untyped strict-read error degrades to unverified instead of throwing', async (context) => {
  if (process.getuid?.() === 0) return context.skip('root ignores file modes');
  // chmod 0o000 does not deny reads on Windows, so the barrier stays readable there.
  if (process.platform === 'win32') return context.skip('Windows ignores POSIX read modes');
  const w = await workspace(context);
  // An unreadable cutover barrier makes the strict reader's readFile throw a plain EACCES
  // Error (not a TodoStoreError); the raw reader never touches the barrier.
  const barrier = w.abs('.lattice/todo/source-cutover-recovery.json');
  await writeFile(barrier, '{}\n');
  await chmod(barrier, 0o000);
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  let result;
  try {
    result = await w.display();
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.off('warning', onWarning); }
  assert.equal(result.state, 'unverified');
  assert.deepEqual(result.inconsistency, { code: 'STORE_READ_FAULT', detail: { reason: 'unexpected_error' } });
  assert.equal(result.store.members.length, 2);
  assert.equal(warnings.some((warning) => warning.code === 'LATTICE_STORE_DISPLAY_READ_FAULT'), true);
});

test('a corrupt manifest with an earlier checkpoint is last_verified', async (context) => {
  const w = await workspace(context);
  const verified = await w.display();
  await w.clobber('.lattice/todo/manifest.json', 'not json');
  const result = await w.display();
  assert.equal(result.state, 'last_verified');
  assert.deepEqual(result.store, verified.store);
  assert.deepEqual(result.source, verified.source);
  assert.equal(result.verified_at, verified.verified_at);
  assert.equal(typeof result.inconsistency.code, 'string');
});

test('a corrupt manifest without a checkpoint is unavailable', async (context) => {
  const w = await workspace(context);
  await w.clobber('.lattice/todo/manifest.json', 'not json');
  const result = await w.display();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.store, null);
  assert.equal(result.source, null);
});

test('the display source probe throws typed STORE_INCONSISTENT on a corrupt manifest', async (context) => {
  const w = await workspace(context);
  await w.clobber('.lattice/todo/manifest.json', 'not json');
  await assert.rejects(w.source(), (error) => error.name === 'TodoStoreError' && error.code === 'STORE_INCONSISTENT');
});

// Host surface (BellTeam module reads only CLI JSON): `todo display read|source`.
test('todo display read/source expose the envelope over the CLI; inconsistency is a state with exit 0', async (context) => {
  const w = await workspace(context);
  const bin = path.join(import.meta.dirname, '..', 'bin', 'lattice.mjs');
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' };
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [bin, 'todo', 'display', ...args],
    { cwd: w.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const verified = cli('read', '--json');
  assert.equal(verified.schema, 'lattice.todo_display_read_result.v1');
  assert.equal(verified.state, 'verified');
  assert.deepEqual(Object.keys(verified).sort(),
    ['connections', 'dropped_members', 'external_tasks', 'inconsistency', 'schema', 'source', 'state', 'store', 'trees', 'verified_at']);
  assert.deepEqual(cli('source'), verified.source);
  await corruptManifestDigest(w);
  const degraded = cli('read');
  assert.equal(degraded.state, 'unverified');
  assert.equal(typeof degraded.inconsistency.code, 'string');
  await w.clobber('.lattice/todo/manifest.json', 'not json');
  assert.throws(() => cli('source', '--json'), (error) => error.status === 1
    && JSON.parse(error.stderr).code === 'STORE_INCONSISTENT');
});

// Compact host read (`todo display read --compact`): the same facts the host reads, in a size that does not grow with payloads.
const lifecycle = (kind, taskId, agent, at, payload = {}) => ({ kind, task_id: taskId, recorded_at: at, actor: { agent }, payload, event_digest: `d-${kind}-${taskId}-${at}` });

test('compactDisplayStore (n3): a task with an add record and no event gets an entry; an event task carries its added; others null', () => {
  const store = { schema: 's', project_id: 'project-1', manifest: { m: 1 }, members: [
    { descriptor: { plan_key: 'alpha' }, plan: { plan_key: 'alpha' }, tasks: [],
      journal: { events: [lifecycle('start', 'T1', 'a1', '2026-01-02T00:00:00.000Z')] }, plan_scoped: { ref: 'r', events: [] } }] };
  const added = new Map([['alpha', new Map([['T1', { at: '2026-01-01T00:00:00.000Z', agent: 'x' }], ['T3', { at: '2026-01-03T00:00:00.000Z', agent: 'y' }]])]]);
  const { tasks } = compactDisplayStore(store, { addedByPlan: added }).members[0].activity;
  assert.deepEqual(tasks, [
    { task_id: 'T1', changed_at: '2026-01-02T00:00:00.000Z', started: { at: '2026-01-02T00:00:00.000Z', agent: 'a1' }, added: { at: '2026-01-01T00:00:00.000Z', agent: 'x' } },
    { task_id: 'T3', changed_at: '2026-01-03T00:00:00.000Z', started: null, added: { at: '2026-01-03T00:00:00.000Z', agent: 'y' } }]);
});

test('compactDisplayStore: activity is the earliest/latest event and per-task latest + last start; live cross-plan edges only', () => {
  const edge = (digest, from, to) => ({ kind: 'cross_plan_dependency', event_digest: digest, payload: { from, to, reason: 'long text '.repeat(50) } });
  const ref = (plan, taskId) => ({ project_id: 'project-1', plan_key: plan, task_id: taskId });
  const store = { schema: 's', project_id: 'project-1', manifest: { m: 1 }, members: [
    { descriptor: { plan_key: 'alpha' }, plan: { plan_key: 'alpha' }, tasks: [{ task_id: 'T1', status: 'done' }],
      journal: { events: [
        lifecycle('start', 'T1', 'a1', '2026-01-02T00:00:00.000Z', { evidence: 'x'.repeat(1000) }),
        lifecycle('start', 'T1', 'a2', '2026-01-03T00:00:00.000Z'),
        lifecycle('note', 'T1', 'a3', '2026-01-04T00:00:00.000Z', { body: 'y'.repeat(1000) }),
        lifecycle('start', 'T2', 'a1', '2026-01-01T00:00:00.000Z'),
        { kind: 'coordination_mode', recorded_at: '2026-01-05T00:00:00.000Z', actor: { agent: 'a9' }, payload: {} }] },
      plan_scoped: { ref: 'r', events: [edge('e1', ref('beta', 'B1'), ref('alpha', 'T1')), edge('e2', ref('beta', 'B2'), ref('alpha', 'T1'))] } },
    { descriptor: { plan_key: 'beta' }, plan: { plan_key: 'beta' }, tasks: [], journal: { events: [] },
      plan_scoped: { ref: 'r2', events: [{ kind: 'cross_plan_dependency_removed', event_digest: 'x1', payload: { target_event_digest: 'e2' } }] } },
    { descriptor: { plan_key: 'gamma' }, plan: null, snapshot: { tasks: [] } }] };
  const compact = compactDisplayStore(store);
  const [alpha, beta, gamma] = compact.members;
  assert.equal(alpha.journal, undefined);
  assert.equal(alpha.plan_scoped, undefined);
  assert.deepEqual(alpha.activity, { first: { at: '2026-01-01T00:00:00.000Z', agent: 'a1' }, last_at: '2026-01-05T00:00:00.000Z',
    tasks: [{ task_id: 'T1', changed_at: '2026-01-04T00:00:00.000Z', started: { at: '2026-01-03T00:00:00.000Z', agent: 'a2' }, added: null },
      { task_id: 'T2', changed_at: '2026-01-01T00:00:00.000Z', started: { at: '2026-01-01T00:00:00.000Z', agent: 'a1' }, added: null }] });
  // e2 is removed by a tombstone in another member's chain; only the live edge stays, without its reason
  assert.deepEqual(alpha.cross_plan_dependencies, [{ event_digest: 'e1', from: ref('beta', 'B1'), to: ref('alpha', 'T1') }]);
  assert.deepEqual(beta.activity, { first: null, last_at: null, tasks: [] });
  assert.deepEqual(beta.cross_plan_dependencies, []);
  assert.deepEqual(gamma, store.members[2], 'an unverified raw member has no journal and is returned as it is');
  assert.deepEqual([alpha.descriptor, alpha.plan, alpha.tasks, compact.manifest], [store.members[0].descriptor, store.members[0].plan, store.members[0].tasks, store.manifest]);
});

test('todo display read --compact: every field the host uses equals the full read, and payloads do not grow it', async (context) => {
  const w = await workspace(context);
  const bin = path.join(import.meta.dirname, '..', 'bin', 'lattice.mjs');
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_TODO_ACTOR_HOST: 'h', LATTICE_TODO_ACTOR_SESSION: 's', LATTICE_TODO_ACTOR_AGENT: 'agent-7' };
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: w.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (...flags) => JSON.parse(run('todo', 'display', 'read', ...flags));
  run('todo', 'start', '--plan', 'alpha', '--task', 'T1');
  const before = read('--json', '--compact');
  assert.equal(before.schema, 'lattice.todo_display_compact_result.v1');
  assert.deepEqual(Object.keys(before).sort(), Object.keys(read('--json')).sort());
  for (const heavy of [
    () => run('todo', 'note', '--plan', 'alpha', '--task', 'T1', '--message', 'n'.repeat(2000)),
    () => run('todo', 'retract', '--plan', 'alpha', '--task', 'T1', '--reason', 'r'.repeat(500)),
    () => run('todo', 'start', '--plan', 'alpha', '--task', 'T1'),
  ]) heavy();
  const full = read('--json');
  const compact = read('--json', '--compact');
  const sizes = (value) => Buffer.byteLength(JSON.stringify(value));
  assert.ok(sizes(compact) < sizes(full), 'the full read carries the events');
  for (const [index, member] of full.store.members.entries()) {
    const light = compact.store.members[index];
    assert.deepEqual([light.descriptor, light.plan, light.tasks, light.journal, light.plan_scoped], [member.descriptor, member.plan, member.tasks, undefined, undefined]);
    const events = member.journal.events;
    assert.equal(light.activity.first?.at ?? null, events.length === 0 ? null : events.map(({ recorded_at: at }) => at).sort()[0]);
    assert.equal(light.activity.last_at, events.length === 0 ? null : events.map(({ recorded_at: at }) => at).sort().at(-1));
    for (const { task_id: id, changed_at: changed, started, added } of light.activity.tasks) {
      const own = events.filter(({ task_id: taskId }) => taskId === id);
      // a task with no event is listed through its add record (plan create: the creator), changed at its add time
      assert.equal(changed, own.length === 0 ? added.at : own.map(({ recorded_at: at }) => at).sort().at(-1));
      const last = own.filter(({ kind }) => kind === 'start').at(-1);
      assert.deepEqual(started, last === undefined ? null : { at: last.recorded_at, agent: last.actor.agent });
    }
    assert.deepEqual(light.activity.tasks.map(({ task_id: id }) => id).sort(), [...new Set([...events.map(({ task_id: id }) => id).filter(Boolean), ...member.plan.tasks.map(({ task_id: id }) => id)])].sort());
  }
  assert.equal(compact.store.members[0].activity.tasks[0].started.agent, 'agent-7');
  // more payload and repeated events on the same task: the compact read keeps its size (timestamps have fixed width)
  for (let n = 0; n < 5; n += 1) {
    run('todo', 'note', '--plan', 'alpha', '--task', 'T1', '--message', `more ${n} `.repeat(300));
    run('todo', 'retract', '--plan', 'alpha', '--task', 'T1', '--reason', 'again '.repeat(80));
    run('todo', 'start', '--plan', 'alpha', '--task', 'T1');
  }
  const after = read('--json', '--compact');
  assert.ok(sizes(read('--json')) > sizes(full) + 5000, 'the full read grew');
  assert.ok(sizes(after) - sizes(compact) < 400, `compact grew ${sizes(after) - sizes(compact)} bytes`);
  assert.equal(after.store.members[0].activity.tasks.length, compact.store.members[0].activity.tasks.length);
});

// Open read and closed history (`display read --open`, `display history`): only open trees stay in the read; closed ones page.
test('openDisplayResult: every per-task list is limited to open trees; closed counts come from trees', () => {
  const ref = (plan, taskId, project = 'p1') => ({ project_id: project, plan_key: plan, task_id: taskId });
  const trees = [
    { tree_id: 'a/A1', tasks: [{ plan_key: 'a', task_id: 'A1' }, { plan_key: 'a', task_id: 'A2' }], total: 2, finished: 2 },
    { tree_id: 'a/A3', tasks: [{ plan_key: 'a', task_id: 'A3' }, { plan_key: 'b', task_id: 'B1' }], total: 2, finished: 1 },
    { tree_id: 'b/B2', tasks: [{ plan_key: 'b', task_id: 'B2' }], total: 1, finished: 1 }];
  const result = { schema: 'lattice.todo_display_compact_result.v1', state: 'verified', trees, labels: [{ keep: 'whole' }],
    connections: [{ plan_key: 'a', task_id: 'A1', connections: [{ kind: 'task', ref: 'p2/x/X1' }] },
      { plan_key: 'a', task_id: 'A3', connections: [{ kind: 'task', ref: 'p2/x/X2' }, { kind: 'priority' }] }],
    external_tasks: [{ project_id: 'p2', plan_key: 'x', task_id: 'X1' }, { project_id: 'p2', plan_key: 'x', task_id: 'X2' }],
    store: { project_id: 'p1', members: [
      { descriptor: { plan_key: 'a' }, tasks: ['A1', 'A2', 'A3'].map((id) => ({ task_id: id })), revision: { desired_plan: 'whole' },
        snapshot: { tasks: ['A1', 'A2', 'A3'].map((id) => ({ task_id: id })) },
        plan: { project_id: 'p1', plan_key: 'a', phases: [{ phase_id: 'ph' }], tasks: ['A1', 'A2', 'A3'].map((id) => ({ task_id: id })),
          hard_dependencies: [{ from: ref('a', 'A1'), to: ref('a', 'A2') }, { from: ref('a', 'A3'), to: ref('b', 'B1') }],
          joins: [{ before: ref('a', 'A2'), after: [ref('a', 'A1')] }, { before: ref('b', 'B1'), after: [ref('a', 'A3'), ref('a', 'A1'), ref('x', 'X2', 'p2')] }] },
        activity: { first: { at: '1', agent: 'g' }, last_at: '9', tasks: ['A1', 'A2', 'A3'].map((id) => ({ task_id: id, changed_at: '5', started: null })) },
        cross_plan_dependencies: [{ event_digest: 'k1', from: ref('a', 'A1'), to: ref('a', 'A2') }, { event_digest: 'k2', from: ref('x', 'X2', 'p2'), to: ref('a', 'A3') }] },
      { descriptor: { plan_key: 'b' }, snapshot: { tasks: ['B1', 'B2'].map((id) => ({ task_id: id })) }, revision: {}, plan: null }] } };
  const open = openDisplayResult({ ...result, next_ready: [{ plan_key: 'a', task_id: 'A3' }] });
  assert.equal(open.schema, 'lattice.todo_display_open_result.v2');
  assert.deepEqual(open.next_ready, [{ plan_key: 'a', task_id: 'A3' }]);
  assert.equal(openDisplayResult(result).next_ready, null, 'no next_ready given reads as null');
  assert.deepEqual(open.trees, [trees[1]]);
  assert.deepEqual(open.closed, { trees: 2, tasks: 3 });
  assert.deepEqual(open.labels, result.labels);
  const [a, b] = open.store.members;
  assert.deepEqual([a.tasks, a.plan.tasks, a.activity.tasks.map(({ task_id: id }) => id)], [[{ task_id: 'A3' }], [{ task_id: 'A3' }], ['A3']]);
  assert.deepEqual(a.plan.hard_dependencies, [{ from: ref('a', 'A3'), to: ref('b', 'B1') }]);
  assert.deepEqual(a.plan.joins, [{ before: ref('b', 'B1'), after: [ref('a', 'A3'), ref('x', 'X2', 'p2')] }], 'a closed after is dropped, a ref of another chart stays');
  assert.deepEqual(a.plan.phases, [{ phase_id: 'ph' }]);
  assert.deepEqual([a.activity.first, a.activity.last_at], [{ at: '1', agent: 'g' }, '9']);
  assert.deepEqual(a.cross_plan_dependencies.map(({ event_digest: digest }) => digest), ['k2']);
  assert.deepEqual(b.snapshot.tasks, [{ task_id: 'B1' }], 'a raw member (no tasks) keeps its filtered snapshot');
  assert.equal(a.snapshot, undefined, 'a verified member (it has tasks) drops its snapshot');
  assert.equal(a.revision ?? b.revision, undefined, 'revision is dropped from every member');
  assert.deepEqual(open.connections, [result.connections[1]]);
  assert.deepEqual(open.external_tasks, [result.external_tasks[1]], 'only an external task a kept connection refers to');
  assert.equal(result.store.members[0].tasks.length, 3, 'the input is not changed');
  assert.deepEqual(openDisplayResult({ ...result, store: null, trees: [] }).closed, { trees: 0, tasks: 0 });
});

test('closedDisplayHistory: closed-tree tasks only, newest finish first, pages are exact and bounded', () => {
  const tasks = ['T1', 'T2', 'T3', 'T4'].map((id) => ({ task_id: id, title: id, lane: 'l', design_memo: 'm', done_condition: null }));
  const states = [{ task_id: 'T1', status: 'done', done_at: '2026-01-03' }, { task_id: 'T2', status: 'done', done_at: '2026-01-03' },
    { task_id: 'T3', status: 'retired', done_at: null }, { task_id: 'T4', status: 'pending', done_at: null }];
  const store = { members: [{ descriptor: { plan_key: 'a' }, plan: { tasks }, tasks: states,
    journal: { events: [lifecycle('start', 'T3', 'g1', '2026-01-05'), lifecycle('retire', 'T3', 'g2', '2026-01-06'), lifecycle('start', 'T1', 'g3', '2026-01-01')] } }] };
  const trees = [{ tree_id: 'a/T1', tasks: ['T1', 'T2', 'T3'].map((id) => ({ plan_key: 'a', task_id: id })), total: 3, finished: 3 },
    { tree_id: 'a/T4', tasks: [{ plan_key: 'a', task_id: 'T4' }], total: 1, finished: 0 }];
  const all = closedDisplayHistory({ store, trees }, { limit: 50 });
  assert.deepEqual(all.closed, { trees: 1, tasks: 3 });
  assert.deepEqual(all.tasks.map(({ task_id: id, finished_at: at }) => [id, at]), [['T3', '2026-01-06'], ['T1', '2026-01-03'], ['T2', '2026-01-03']]);
  assert.deepEqual(all.tasks[0], { tree_id: 'a/T1', plan_key: 'a', task_id: 'T3', title: 'T3', lane: 'l', phase_id: null, parent_task_id: null,
    design_memo: 'm', done_condition: null, status: 'retired', done_at: null, finished_at: '2026-01-06',
    activity: { changed_at: '2026-01-06', started: { at: '2026-01-05', agent: 'g1' } } });
  assert.equal(all.next_cursor, null);
  const pages = [];
  for (let cursor = null, guard = 0; guard < 10; guard += 1) {
    const page = closedDisplayHistory({ store, trees }, { limit: 1, before: cursor === null ? null : decodeHistoryCursor(cursor) });
    assert.ok(page.tasks.length <= 1);
    pages.push(...page.tasks);
    cursor = page.next_cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(pages, all.tasks, 'pages cover every closed task exactly once, in order');
  for (const bad of [undefined, '', 'x', 'h1.', 'h1.!!', `h1.${Buffer.from('[1,2,3]').toString('base64url')}`]) assert.equal(decodeHistoryCursor(bad), null);
});

test('todo display read --open / display history over the CLI: a closed tree leaves the open read and comes back on reopen', async (context) => {
  const w = await workspace(context);
  const bin = path.join(import.meta.dirname, '..', 'bin', 'lattice.mjs');
  const env = { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_TODO_ACTOR_HOST: 'h', LATTICE_TODO_ACTOR_SESSION: 's', LATTICE_TODO_ACTOR_AGENT: 'agent-7' };
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: w.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (...flags) => JSON.parse(run('todo', 'display', 'read', ...flags));
  const history = (...flags) => JSON.parse(run('todo', 'display', 'history', ...flags));
  for (const plan of ['alpha', 'beta']) {
    run('todo', 'start', '--plan', plan, '--task', 'T1');
    run('todo', 'done', '--plan', plan, '--task', 'T1', '--message', 'x');
  }
  const ids = (open) => open.store.members.flatMap((member) => member.plan.tasks.map(({ task_id: id }) => `${member.plan.plan_key}/${id}`)).sort();
  const open = read('--open', '--json');
  assert.equal(open.schema, 'lattice.todo_display_open_result.v2');
  // C1: next_ready is todo status's own list, from the same verified read (no second process).
  const statusReady = () => JSON.parse(run('todo', 'status', '--json')).next_ready;
  assert.deepEqual(open.next_ready, statusReady());
  assert.equal(open.next_ready.length, 2);
  const same = (flags) => ({ ...read(...flags), verified_at: null });
  assert.deepEqual(same(['--json', '--open']), { ...open, verified_at: null }, 'flags in any order');
  assert.deepEqual(same(['--compact', '--open', '--json']), { ...open, verified_at: null }, '--open implies --compact');
  assert.deepEqual(ids(open), ['alpha/T2', 'beta/T2']);
  for (const member of open.store.members) {
    assert.deepEqual([member.tasks.map(({ task_id: id }) => id), member.activity.tasks.map(({ task_id: id }) => id)], [['T2'], ['T2']]);
    assert.equal(member.journal, undefined);
    assert.deepEqual([member.revision, member.snapshot], [undefined, undefined], 'open v2 ships neither revision nor a verified member\'s snapshot');
  }
  const full = read('--json');
  assert.deepEqual(open.trees, full.trees.filter(({ finished, total }) => finished < total));
  assert.deepEqual(open.closed, { trees: 2, tasks: 2 });
  assert.deepEqual(open.closed, { trees: full.trees.filter(({ finished, total }) => finished >= total).length,
    tasks: full.trees.filter(({ finished, total }) => finished >= total).reduce((sum, { total }) => sum + total, 0) });
  assert.deepEqual(Object.keys(open).sort(), [...Object.keys(read('--json', '--compact')), 'closed', 'next_ready'].sort());
  assert.equal(read('--json', '--compact').next_ready, undefined, '--compact (v1) is unchanged');

  const all = history('--json');
  assert.equal(all.schema, 'lattice.todo_display_history_result.v1');
  assert.deepEqual([all.state, all.closed, all.next_cursor], ['verified', { trees: 2, tasks: 2 }, null]);
  assert.deepEqual(all.tasks.map(({ plan_key: plan, task_id: id, status }) => [plan, id, status]).sort(), [['alpha', 'T1', 'done'], ['beta', 'T1', 'done']]);
  assert.ok(all.tasks.every(({ finished_at: at, done_at: done }) => at === done), 'a done task finishes at done_at');
  assert.deepEqual(all.tasks.map(({ finished_at: at }) => at), all.tasks.map(({ finished_at: at }) => at).sort().reverse());
  const first = history('--limit', '1');
  assert.equal(first.tasks.length, 1);
  assert.equal(typeof first.next_cursor, 'string');
  const second = history('--json', '--before', first.next_cursor, '--limit', '1');
  assert.deepEqual([...first.tasks, ...second.tasks], all.tasks);
  assert.equal(second.next_cursor, null);
  for (const bad of [['--before', 'nonsense'], ['--limit', '0'], ['--limit', 'x'], ['--limit']]) {
    assert.throws(() => history(...bad), (error) => error.status === 2 && JSON.parse(error.stderr).code === 'INVALID_ARGUMENTS', bad.join(' '));
  }
  assert.equal(history('--limit', '9999').tasks.length, 2, 'a larger limit is clamped, not refused');

  run('todo', 'reopen', '--plan', 'alpha', '--task', 'T1', '--reason', 'again');
  const reopened = read('--open', '--json');
  assert.deepEqual(ids(reopened), ['alpha/T1', 'alpha/T2', 'beta/T2']);
  assert.deepEqual(reopened.closed, { trees: 1, tasks: 1 });
  assert.deepEqual(reopened.next_ready, statusReady());
  assert.deepEqual(history('--json').tasks.map(({ plan_key: plan }) => plan), ['beta']);

  // Any state but verified: next_ready is null, and a raw member keeps its snapshot.
  await corruptManifestDigest(w);
  const raw = read('--open', '--json');
  assert.equal(raw.state, 'unverified');
  assert.equal(raw.next_ready, null);
  assert.ok(raw.store.members.every((member) => member.revision === undefined && Array.isArray(member.snapshot?.tasks)));
});
