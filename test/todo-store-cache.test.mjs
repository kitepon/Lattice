import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTodoStoreCache, todoStoreReadFailurePhase as failurePhase } from '../src/todo-store-cache.mjs';
import { createTodoStoreWriter, initializeTodoStore } from '../src/todo-store.mjs';
import { registerTodoDashboardActivity, readVisibleTodoDashboardProjects,
  TODO_DASHBOARD_STALE_MS } from '../src/todo-dashboard-registry.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-store-cache-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.lattice', 'todo'), { recursive: true });
  return root;
}

async function writeManifest(root, body, { mtime } = {}) {
  const ref = path.join(root, '.lattice', 'todo', 'manifest.json');
  await writeFile(ref, body);
  if (mtime !== undefined) await utimes(ref, mtime, mtime);
}

function countingReader(store) {
  let calls = 0;
  return { calls: () => calls, readStable: async () => { calls += 1; return store; } };
}

test('manifestが変わらなければreadStableを呼ばずcacheを返す', async (context) => {
  const root = await fixture(context);
  await writeManifest(root, '{"a":1}');
  const counter = countingReader({ marker: 'store-1' });
  const cache = createTodoStoreCache({ readStable: counter.readStable });
  const first = await cache.read(root);
  const second = await cache.read(root);
  assert.equal(first.marker, 'store-1');
  assert.equal(second, first);
  assert.equal(counter.calls(), 1);
});

test('manifestのbyteが変われば、stat(mtime/size)が同じでもcacheを無効化する', async (context) => {
  const root = await fixture(context);
  const sameMtime = new Date('2026-08-10T00:00:00.000Z');
  // 旧実装はdev/ino/size/mtimeMs/ctimeMsのstat fingerprintでcache鍵を作っていた。
  // 同じmtimeかつ同じbyte長の異なる内容は、その旧実装ではcache hitと誤判定される
  // ——これがroom 2488の「gantt serve固着」の原因候補だった。ここでは同じ長さ・
  // 同じmtimeの異なるbyte列を用意し、content digest方式が正しく別物と見分けることを固定する。
  await writeManifest(root, '{"digest":"aaaa"}', { mtime: sameMtime });
  const first = { marker: 'store-old' };
  const second = { marker: 'store-new' };
  let call = 0;
  const cache = createTodoStoreCache({
    readStable: async () => { call += 1; return call === 1 ? first : second; },
  });
  const firstRead = await cache.read(root);
  assert.equal(firstRead.marker, 'store-old');

  await writeManifest(root, '{"digest":"bbbb"}', { mtime: sameMtime });
  const secondRead = await cache.read(root);
  assert.equal(secondRead.marker, 'store-new', '同じstatでも内容が変わればcacheを再取得しなければならない');
  assert.equal(call, 2);
});

test('readStableが失敗した読み取りはcacheへ書き込まれず、次回も再取得する', async (context) => {
  const root = await fixture(context);
  await writeManifest(root, '{"a":1}');
  let call = 0;
  const cache = createTodoStoreCache({
    readStable: async () => {
      call += 1;
      if (call === 1) throw new Error('store broken');
      return { marker: 'store-recovered' };
    },
  });
  await assert.rejects(cache.read(root), /store broken/u);
  const recovered = await cache.read(root);
  assert.equal(recovered.marker, 'store-recovered');
  assert.equal(call, 2, '失敗した1回目はcacheへ書かれず、2回目もreadStableが呼ばれる');
});

test('異なるrepoRootは別々にcacheされる', async (context) => {
  const rootA = await fixture(context);
  const rootB = await fixture(context);
  await writeManifest(rootA, '{"a":1}');
  await writeManifest(rootB, '{"a":1}');
  let call = 0;
  const cache = createTodoStoreCache({
    readStable: async ({ repoRoot }) => { call += 1; return { marker: repoRoot }; },
  });
  const a = await cache.read(rootA);
  const b = await cache.read(rootB);
  assert.equal(a.marker, rootA);
  assert.equal(b.marker, rootB);
  assert.equal(call, 2);
});

async function initializedStore(context) {
  const root = await fixture(context);
  await initializeTodoStore({ repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'fixture',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'fixture',
      plan_key: 'main', plan_version: 'v1', predecessor_plan_digest: null,
      tasks: [{ task_id: 'T1', title: 'T1', lane: 'main', narrative_ref: null, compile_binding: null }],
      hard_dependencies: [], joins: [] }, genesis: {
      actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
      recorded_at: '2026-07-18T00:00:00.000Z',
    } }], now: '2026-07-18T00:00:00.000Z' });
  return root;
}

async function treeBytes(root) {
  const result = {};
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else result[relative] = (await readFile(path.join(dir, entry.name))).toString('base64');
    }
  }
  await walk(root);
  return result;
}

test('store読取りは6分類を区別し、元の例外・errnoとstore/登録/配信集合を保つ', async (context) => {
  const parent = await fixture(context);
  const cases = [];
  const missingManifest = await fixture(context);
  cases.push({ name: 'manifest absent', root: missingManifest, phase: 'store_manifest_missing' });
  cases.push({ name: 'root absent', root: await fixture(context), phase: 'store_root_missing' });
  for (const [code, phase] of [['EACCES', 'store_access_denied'], ['EPERM', 'store_access_denied'],
    ['EIO', 'store_io_failed']]) {
    const root = await initializedStore(context);
    const error = Object.assign(new Error('secret-error-body'), { code });
    cases.push({ name: code, root, phase, error,
      cache: createTodoStoreCache({ readStable: async () => { throw error; } }) });
  }
  for (const [name, bytes] of [['JSON', '{broken\n'], ['schema', '{}\n']]) {
    const root = await fixture(context);
    await writeManifest(root, bytes);
    cases.push({ name, root, phase: 'store_manifest_invalid' });
  }
  const broken = await initializedStore(context);
  const manifest = JSON.parse(await readFile(path.join(broken, '.lattice/todo/manifest.json'), 'utf8'));
  await rm(path.join(broken, manifest.members[0].plan_ref));
  cases.push({ name: 'referenced artifact absent', root: broken, phase: 'store_artifact_missing' });
  const normal = await initializedStore(context);
  const now = new Date('2026-10-29T03:15:00.000Z');
  const env = { LATTICE_DASHBOARD_RUNTIME_DIR: path.join(parent, 'runtime') };
  for (const [index, entry] of cases.entries()) {
    await registerTodoDashboardActivity({ repoRoot: entry.root, projectId: `broken-${index}`,
      displayName: `broken-${index}`, sessionId: 'fixture', env,
      now: new Date(now.getTime() - TODO_DASHBOARD_STALE_MS - 1) });
  }
  await registerTodoDashboardActivity({ repoRoot: normal, projectId: 'normal', displayName: 'normal',
    sessionId: 'fixture', env, now });
  await rm(cases[1].root, { recursive: true });
  const before = await treeBytes(parent);
  const storesBefore = await Promise.all(cases.filter(x => x.name !== 'root absent').map(x => treeBytes(x.root)));
  const normalBefore = await treeBytes(normal);
  const phases = [];
  const visible = await readVisibleTodoDashboardProjects({ env, now: now.getTime(),
    projectHasActiveRun: async (entry) => {
      const index = Number(entry.project_id.slice('broken-'.length));
      const item = cases[index];
      let failure;
      try { await (item.cache ?? createTodoStoreCache()).read(entry.repo_root); }
      catch (error) { failure = error; }
      assert.ok(failure, item.name);
      if (item.error) assert.equal(failure, item.error, 'preserve original exception and errno');
      const phase = failurePhase(failure);
      phases.push({ name: item.name, phase });
      return false;
    } });
  assert.deepEqual(visible.map(x => x.project_id), ['normal']);
  assert.deepEqual(await treeBytes(parent), before, 'registry is read-only');
  assert.deepEqual(await Promise.all(cases.filter(x => x.name !== 'root absent').map(x => treeBytes(x.root))), storesBefore);
  const normalCache = createTodoStoreCache();
  const first = await normalCache.read(normal);
  assert.equal(first.project_id, 'fixture');
  assert.equal(await normalCache.read(normal), first);
  assert.deepEqual(await treeBytes(normal), normalBefore, 'normal store is read-only');
  assert.deepEqual(phases, cases.map(({ name, phase }) => ({ name, phase })));
  assert.equal(new Set(phases.map(x => x.phase)).size, 6);
  assert.equal(failurePhase(new Error('secret-path')), 'store_read_failed', 'unknown is not guessed');
});


test('legacy artifact_missingだけでは欠落を推測せず、競合時も元の失敗を保つ', async (context) => {
  for (const removeManifest of [false, true]) {
    const root = await initializedStore(context);
    const ref = '.lattice/todo/plans/main/v1/plan.json';
    const error = Object.assign(new Error('secret-error-body'), {
      code: 'STORE_INCONSISTENT', detail: { reason: 'artifact_missing', ref },
    });
    const cache = createTodoStoreCache({ readStable: async () => {
      if (removeManifest) {
        await rm(path.join(root, ref));
        await rm(path.join(root, '.lattice/todo/manifest.json'));
      }
      throw error;
    } });
    await assert.rejects(cache.read(root), failure => {
      assert.equal(failure, error);
      assert.equal(failurePhase(failure), 'store_read_failed');
      return true;
    });
  }
});
