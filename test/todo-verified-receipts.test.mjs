// s5 (dfd-store-display-read.md, "Verified-read receipts"): a derived file under .lattice/generated remembers which exact bytes
// were already validated, so a later process validates only what changed. A bad receipt file is a miss, never a failure; changed
// bytes never hit; the display checkpoint head only saves reading the checkpoint, never changes what is published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTodoStoreWriter, initializeTodoStore, readTodoStoreForDisplay } from '../src/todo-store.mjs';
import { sha256Bytes } from '../src/hash-chain.mjs';
import { AcceptedKeys, TODO_RECEIPTS_REF } from '../src/todo-verified-receipts.mjs';

const NOW = '2026-07-26T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const HEAD = '.lattice/generated/store-display/last-verified.head.json';
const CHECKPOINT = '.lattice/generated/store-display/last-verified.json';
const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-receipts-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'alpha', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  return root;
}

// A fresh process: the in-process memory of accepted bytes starts empty.
const freshRead = (root, expression) => execFileSync(process.execPath, ['--input-type=module', '-e', `
import { readTodoStoreReadOnly } from ${JSON.stringify(new URL('../src/todo-store.mjs', import.meta.url).href)};
import { AcceptedKeys } from ${JSON.stringify(new URL('../src/todo-verified-receipts.mjs', import.meta.url).href)};
try { const store = await readTodoStoreReadOnly({ repoRoot: ${JSON.stringify(root)} }); ${expression}; }
catch (error) { console.log(JSON.stringify({ failed: error.code, reason: error.detail?.reason })); }
`], { encoding: 'utf8' });

test('AcceptedKeys: persisted keys are read back by another instance; the file is derived, private and bounded', async (context) => {
  const root = await workspace(context);
  const first = new AcceptedKeys();
  for (let index = 0; index < 1100; index += 1) first.add(`segment:strict:${index}`);
  await first.persist(root);
  const file = JSON.parse(await readFile(path.join(root, TODO_RECEIPTS_REF), 'utf8'));
  assert.equal(file.keys.length, 1024);
  assert.equal(file.keys[0], 'segment:strict:76', 'the oldest keys leave first');
  const second = new AcceptedKeys();
  await second.attach(root);
  assert.equal(second.has('segment:strict:1099'), true);
  assert.equal(second.has('segment:strict:0'), false);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, TODO_RECEIPTS_REF))).mode & 0o077, 0);
});

test('AcceptedKeys: a changed fingerprint, digest or shape is a miss, never an error', async (context) => {
  const root = await workspace(context);
  const keys = new AcceptedKeys();
  keys.add('segment:read:abc');
  await keys.persist(root);
  const absolute = path.join(root, TODO_RECEIPTS_REF);
  const good = JSON.parse(await readFile(absolute, 'utf8'));
  for (const bad of [{ ...good, fingerprint: 'other-code' }, { ...good, keys: ['segment:read:evil'] }, { ...good, keys: 'x' },
    { ...good, schema: 'v0' }, 'not json at all']) {
    await writeFile(absolute, typeof bad === 'string' ? bad : JSON.stringify(bad));
    const reader = new AcceptedKeys();
    await reader.attach(root);
    assert.equal(reader.has('segment:read:abc'), false);
    assert.equal(reader.has('segment:read:evil'), false);
  }
  await rm(absolute);
  await new AcceptedKeys().attach(root); // a missing file is a miss as well
});

test('AcceptedKeys: a symlinked generated directory is not written through', async (context) => {
  const root = await workspace(context);
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'lattice-receipts-elsewhere-'));
  context.after(() => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(path.join(root, '.lattice'), { recursive: true });
  await symlink(elsewhere, path.join(root, '.lattice', 'generated'), 'dir').catch(() => null);
  const keys = new AcceptedKeys();
  keys.add('segment:read:abc');
  await keys.persist(root);
  await assert.rejects(stat(path.join(elsewhere, 'store-verified', 'receipts.json')), { code: 'ENOENT' });
});

test('a read leaves receipts for the bytes it accepted; a fresh process finds them, changed bytes do not hit', async (context) => {
  const root = await workspace(context);
  freshRead(root, 'console.log(store.members.length)');
  const journal = path.join(root, JSON.parse(await readFile(path.join(root, '.lattice/todo/manifest.json'), 'utf8')).members[0].journal_ref);
  const bytes = await readFile(journal);
  const probe = (digest) => `const keys = new AcceptedKeys(); await keys.attach(${JSON.stringify(root)}); console.log(keys.has('segment:read:' + ${JSON.stringify(digest)}))`;
  assert.equal(freshRead(root, probe(sha256Bytes(bytes))).trim(), 'true');
  assert.equal(freshRead(root, probe(sha256Bytes(Buffer.from(`${bytes}\n`)))).trim(), 'false');
  // Tamper: the same line with a different task id passes JSON but not the event digest; the receipt is for the old bytes only.
  await writeFile(journal, bytes.toString('utf8').replace('"event_digest":"', '"event_digest":"0'));
  const failed = JSON.parse(freshRead(root, 'console.log(JSON.stringify({ ok: true }))'));
  assert.equal(failed.failed, 'STORE_CORRUPT', 'a receipt never vouches for bytes it has not seen');
});

test('receipts never dirty the git work tree of the user', async (context) => {
  const root = await workspace(context);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'store'], { cwd: root });
  freshRead(root, 'console.log(store.members.length)');
  await stat(path.join(root, TODO_RECEIPTS_REF));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('a corrupt receipts file does not change a read', async (context) => {
  const root = await workspace(context);
  const expected = freshRead(root, 'console.log(JSON.stringify(store.members.map((member) => member.tasks)))');
  await writeFile(path.join(root, TODO_RECEIPTS_REF), '{"truncated');
  assert.equal(freshRead(root, 'console.log(JSON.stringify(store.members.map((member) => member.tasks)))'), expected);
});

test('display checkpoint head: unchanged source keeps both files; a stale head or a replaced checkpoint falls back to comparing', async (context) => {
  const root = await workspace(context);
  await readTodoStoreForDisplay({ repoRoot: root, now: NOW });
  const abs = (ref) => path.join(root, ref);
  const head = JSON.parse(await readFile(abs(HEAD), 'utf8'));
  assert.equal(head.size, (await stat(abs(CHECKPOINT))).size);
  const before = { checkpoint: await readFile(abs(CHECKPOINT)), head: await readFile(abs(HEAD)) };
  await readTodoStoreForDisplay({ repoRoot: root, now: '2026-07-27T00:00:00.000Z' });
  assert.deepEqual(await readFile(abs(CHECKPOINT)), before.checkpoint, 'unchanged source preserves the checkpoint bytes and timestamp');
  assert.deepEqual(await readFile(abs(HEAD)), before.head);
  // The head names another source: compare the checkpoint itself (same source), keep it, rewrite the head.
  await writeFile(abs(HEAD), JSON.stringify({ ...head, source_digest: '0'.repeat(64) }));
  await readTodoStoreForDisplay({ repoRoot: root, now: '2026-07-28T00:00:00.000Z' });
  assert.deepEqual(await readFile(abs(CHECKPOINT)), before.checkpoint);
  assert.equal(JSON.parse(await readFile(abs(HEAD), 'utf8')).source_digest, head.source_digest);
  // Another writer replaced the checkpoint (size differs from the head): never trusted, republished.
  await writeFile(abs(CHECKPOINT), 'garbage');
  await readTodoStoreForDisplay({ repoRoot: root, now: '2026-07-29T00:00:00.000Z' });
  const republished = JSON.parse(await readFile(abs(CHECKPOINT), 'utf8'));
  assert.equal(republished.schema, 'lattice.todo_store_display_checkpoint.v1');
  assert.equal(republished.verified_at, '2026-07-29T00:00:00.000Z');
  assert.equal(JSON.parse(await readFile(abs(HEAD), 'utf8')).size, (await stat(abs(CHECKPOINT))).size);
});
