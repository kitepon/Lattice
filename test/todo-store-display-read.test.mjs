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
    ['dropped_members', 'external_tasks', 'inconsistency', 'schema', 'source', 'state', 'store', 'verified_at']);
  assert.deepEqual(cli('source'), verified.source);
  await corruptManifestDigest(w);
  const degraded = cli('read');
  assert.equal(degraded.state, 'unverified');
  assert.equal(typeof degraded.inconsistency.code, 'string');
  await w.clobber('.lattice/todo/manifest.json', 'not json');
  assert.throws(() => cli('source', '--json'), (error) => error.status === 1
    && JSON.parse(error.stderr).code === 'STORE_INCONSISTENT');
});
