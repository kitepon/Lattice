import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTodoGanttDisplayReader, displayHeadDigest, GANTT_DISPLAY_OMITTED_OVERLAYS,
  projectUnverifiedStore } from '../src/todo-gantt-display.mjs';
import { startTodoGanttLiveServer } from '../src/todo-gantt-live.mjs';
import { digestTodoArtifact } from '../src/todo-contracts.mjs';
import { createTodoGanttDisplayServing, renderTodoGanttForProject, startTodoGanttDisplayLive } from '../src/todo-cli.mjs';
import { createTodoStoreWriter, initializeTodoStore, readTodoStoreStable } from '../src/todo-store.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const task = (taskId) => ({ task_id: taskId, title: `title ${taskId}`, lane: 'dev',
  narrative_ref: null, compile_binding: null });
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });
// Detail beyond `reason` must never leave the server.
const INCONSISTENCY = Object.freeze({ code: 'STORE_INCONSISTENT',
  detail: { reason: 'cross_plan_stale_binding', ref: '/srv/secret/path.json', secret: 'S3CR3T' } });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-display-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null, tasks: [task('T1'), task('T2')],
        hard_dependencies: [{ from: ref('T1'), to: ref('T2') }], joins: [] },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  return root;
}

// The raw shape the Store's display reader returns for `unverified`.
const rawOf = (store) => ({ project_id: store.project_id, manifest: store.manifest,
  members: store.members.map(({ descriptor, snapshot }) => ({ descriptor, snapshot })) });
const SOURCE = { project_id: 'project-1', manifest_digest: 'm1', members: [] };
const typed = (state, extra) => ({ state, store: null, verified_at: null, source: SOURCE,
  inconsistency: state === 'verified' ? null : INCONSISTENCY, dropped_members: [], ...extra });

function serving(root, result, extra = {}) {
  const state = { result, source: SOURCE };
  return { state, ...createTodoGanttDisplayServing({
    repoRoot: root, projectId: 'project-1', ...extra,
    readForDisplay: async () => (typeof state.result === 'function' ? state.result() : state.result),
    readDisplaySource: async () => state.source,
  }) };
}

async function serve(context, served) {
  const live = await startTodoGanttLiveServer({
    projectId: 'project-1', displayName: 'P1', port: 0, render: served.render, readHead: served.readHead,
  });
  context.after(() => live.close());
  return live;
}

const pageData = (html) => JSON.parse(/<script type="application\/json" id="todo-gantt-data">([\s\S]*?)<\/script>/u
  .exec(html)[1]);

test('unverified: 契約どおり現在のrawを200で描き、checkpointが在っても使わず、overlayを出さない', async (context) => {
  const root = await workspace(context);
  const store = await readTodoStoreStable({ repoRoot: root });
  const live = await serve(context, serving(root, typed('unverified', {
    store: rawOf(store),
    dropped_members: [{ plan_key: 'other', snapshot_ref: '.lattice/todo/other/snapshot.json',
      code: 'SNAPSHOT_INVALID', reason: 'json_unparsable' }],
  })));
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /未検証の現在の状態を表示中。計画は整合していない/u);
  assert.match(html, /<code>STORE_INCONSISTENT<\/code> \/ <code>cross_plan_stale_binding<\/code>/u);
  for (const name of GANTT_DISPLAY_OMITTED_OVERLAYS) assert.ok(html.includes(`<code>${name}</code>`), name);
  assert.match(html, /<code>other<\/code>: <code>SNAPSHOT_INVALID<\/code> \/ <code>json_unparsable<\/code>/u);
  assert.match(html, /data-task-id="T1"/u);
  assert.match(html, /data-task-id="T2"/u);
  assert.doesNotMatch(html, /最後に確認できた状態/u);
  const data = pageData(html);
  assert.equal(data.presentation, null);
  assert.equal(data.structure_presentation, null);
  assert.equal(data.metadata.presentation_digest, null);
  assert.equal(data.metadata.structure_projection_digest, null);
  // the public diagnostic is the code and the reason slug only
  assert.doesNotMatch(html, /S3CR3T|\/srv\/secret/u);
});

test('unverified: 形の崩れたmember/task/phaseだけが名指しで落ち、隣は描かれて200のまま', async (context) => {
  const root = await workspace(context);
  const raw = rawOf(await readTodoStoreStable({ repoRoot: root }));
  const good = raw.members[0];
  const phased = { descriptor: { ...good.descriptor, plan_key: 'phased' }, snapshot: {
    ...good.snapshot, plan_key: 'phased',
    tasks: [{ ...good.snapshot.tasks[0], task_id: 'ok' }, { task_id: 'bad', status: 'weird' },
      { ...good.snapshot.tasks[0], task_id: 'ok' }, 42],
    phases: [{ phase_id: 'p1', status: 'active' }, { phase_id: 'p2', status: 7 }] } };
  const broken = [
    { descriptor: { ...good.descriptor, plan_key: 'no-tasks' }, snapshot: { tasks: 'nope' } },
    { descriptor: { ...good.descriptor, plan_key: 'null-snapshot' }, snapshot: null },
    { descriptor: { plan_key: 7 }, snapshot: good.snapshot },
    null,
  ];
  raw.members.push(phased, ...broken);
  const live = await serve(context, serving(root, typed('unverified', { store: raw })));
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-task-id="T1"/u);
  assert.match(html, /data-task-id="ok"/u);
  assert.doesNotMatch(html, /data-task-id="bad"/u);
  for (const name of ['no-tasks', 'null-snapshot']) assert.match(html, new RegExp(`<code>${name}</code>: `, 'u'));
  assert.match(html, /<code>phased<\/code> \/ <code>bad<\/code>: <code>DISPLAY_PROJECTION_DROPPED<\/code> \/ <code>task_invalid<\/code>/u);
  assert.match(html, /<code>phased<\/code> \/ <code>p2<\/code>: .*phase_invalid/u);
  assert.match(html, /task_duplicate/u);
  assert.match(html, /descriptor_plan_key_invalid/u);

  // the projection itself never throws, whatever the raw looks like
  for (const garbage of [null, 7, 'x', {}, { members: 'x' }, { members: [{}] }]) {
    assert.deepEqual(projectUnverifiedStore(garbage).store.members, []);
  }
});

test('unverified で何も投影できなければ500でなく空状態の200', async (context) => {
  const root = await workspace(context);
  const live = await serve(context, serving(root, typed('unverified', {
    store: { project_id: 'project-1', manifest: {}, members: [{ descriptor: { plan_key: 'x' }, snapshot: 1 }] },
  })));
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-display-state="unavailable"[\s\S]*snapshot_tasks_invalid/u);
});

test('last_verified: checkpointを描き、verified_atを見せ、overlayを出さず、未検証を検証済みと言わない', async (context) => {
  const root = await workspace(context);
  const store = await readTodoStoreStable({ repoRoot: root });
  const live = await serve(context, serving(root, typed('last_verified', {
    store, verified_at: '2026-11-08T01:02:03.000Z',
  })));
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /最後に確認できた状態（2026-11-08T01:02:03.000Z）を表示中。現在の計画は整合していない/u);
  assert.match(html, /<code>cross_plan_stale_binding<\/code>/u);
  for (const name of GANTT_DISPLAY_OMITTED_OVERLAYS) assert.ok(html.includes(`<code>${name}</code>`), name);
  assert.match(html, /title T1/u);
  assert.doesNotMatch(html, /未検証の現在の状態/u);
  const data = pageData(html);
  assert.equal(data.presentation, null);
  assert.equal(data.structure_presentation, null);
  // no narrative file is read: the bindings of a degraded page are the empty list
  assert.equal(data.metadata.narrative_bindings_digest, digestTodoArtifact([]));
});

test('unavailable: 200の空状態でcode/reasonだけを名指しし、gantt本体は出さない', async (context) => {
  const root = await workspace(context);
  const live = await serve(context, serving(root, typed('unavailable', { source: null })));
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<code>STORE_INCONSISTENT<\/code> \/ <code>cross_plan_stale_binding<\/code>/u);
  assert.doesNotMatch(html, /<body data-gantt-root|S3CR3T/u);
  assert.match(html, /EventSource/u); // the page still reloads itself when the store reads again
});

test('strictな成功へ戻ると head token が変わりSSEが再読込を促す。型付き不整合でstreamは閉じない', async (context) => {
  const root = await workspace(context);
  const store = await readTodoStoreStable({ repoRoot: root });
  const served = serving(root, typed('unavailable', { source: null }));
  const live = await serve(context, served);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const events = await fetch(live.eventsUrl, { signal: controller.signal });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern) => {
    const deadline = Date.now() + 4_000;
    while (!pattern.test(text)) {
      assert.ok(Date.now() < deadline, `timeout waiting for ${pattern}: ${text}`);
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'the stream closed');
      text += decoder.decode(chunk.value, { stream: true });
    }
  };
  await until(/event: state/u);
  assert.doesNotMatch(text, /lattice-error/u);
  const before = /"head_digest":"([0-9a-f]{64})"/u.exec(text)[1];
  served.state.result = typed('verified', { store, verified_at: NOW });
  served.state.source = { ...SOURCE, manifest_digest: 'm2' };
  await until(/"head_digest":"([0-9a-f]{64})"[\s\S]*event: state[\s\S]*"head_digest":"(?!\1)/u);
  const heads = [...text.matchAll(/"head_digest":"([0-9a-f]{64})"/gu)].map((match) => match[1]);
  assert.notEqual(heads.at(-1), before);
  assert.doesNotMatch(text, /lattice-error/u);
  const html = await (await fetch(live.url)).text();
  assert.doesNotMatch(html, /data-display-state/u); // verified: page as today, no banner
  assert.match(html, /title T1/u);
});

test('head token: plan-scoped-onlyの追記(sourceだけの変化)とstate/codeの変化で動き、同じ入力では動かない', () => {
  const base = typed('unverified');
  const same = displayHeadDigest({ ...base });
  assert.equal(displayHeadDigest({ ...base }), same);
  const appended = { ...SOURCE, members: [{ plan_key: 'main', plan_scoped_head: 'e1' }] };
  assert.notEqual(displayHeadDigest({ ...base, source: appended }), same);
  assert.notEqual(displayHeadDigest({ ...base, state: 'last_verified' }), same);
  assert.notEqual(displayHeadDigest({ ...base, inconsistency: { code: 'STORE_CORRUPT' } }), same);
  // reason and detail do not move it; overlay digests count only in verified
  assert.equal(displayHeadDigest({ ...base, inconsistency: { code: 'STORE_INCONSISTENT', detail: { reason: 'x' } } }), same);
  assert.equal(displayHeadDigest(base, 'overlay-a'), displayHeadDigest(base, 'overlay-b'));
  const verified = typed('verified');
  assert.notEqual(displayHeadDigest(verified, 'overlay-a'), displayHeadDigest(verified, 'overlay-b'));
});

function readerHarness({ result = typed('unverified'), now = { value: 0 } } = {}) {
  const harness = { fullReads: 0, probes: 0, source: SOURCE, probeError: null, result, now,
    afterFullRead: null };
  harness.reader = createTodoGanttDisplayReader({
    repoRoot: '/unused', now: () => now.value,
    readForDisplay: async () => {
      harness.fullReads += 1;
      const value = harness.result;
      harness.afterFullRead?.();
      return value;
    },
    readDisplaySource: async () => {
      harness.probes += 1;
      if (harness.probeError !== null) throw harness.probeError;
      return harness.source;
    },
  });
  return harness;
}

test('同じsource tokenなら~30秒までfull readせず(劣化中も)、超えたら1回だけ読み直す', async () => {
  for (const state of ['verified', 'unverified', 'last_verified', 'unavailable']) {
    const harness = readerHarness({ result: typed(state) });
    const first = await harness.reader.read();
    for (let poll = 0; poll < 5; poll += 1) {
      harness.now.value += 500;
      assert.equal(await harness.reader.read(), first);
    }
    assert.equal(harness.fullReads, 1, state);
    harness.now.value += 30_000;
    await harness.reader.read();
    assert.equal(harness.fullReads, 2, state);
  }
});

test('tokenが変われば読み直し、変化中の読みはmemoを無効にして次のpollで読む', async () => {
  const harness = readerHarness();
  await harness.reader.read();
  harness.source = { ...SOURCE, manifest_digest: 'm2' };
  await harness.reader.read();
  assert.equal(harness.fullReads, 2);
  // the head moves during the attempt
  harness.afterFullRead = () => { harness.source = { ...SOURCE, manifest_digest: 'm3' }; harness.afterFullRead = null; };
  harness.source = { ...SOURCE, manifest_digest: 'm2b' };
  await harness.reader.read();
  assert.equal(harness.fullReads, 3);
  await harness.reader.read();
  assert.equal(harness.fullReads, 4);
  await harness.reader.read();
  assert.equal(harness.fullReads, 4);
});

test('probeが失敗し続けても500msごとのfull read loopにならず、復旧したら読み直す', async () => {
  const harness = readerHarness({ result: typed('unavailable', { source: null }) });
  await harness.reader.read();
  harness.probeError = Object.assign(new Error('boom'), { code: 'STORE_INCONSISTENT' });
  await harness.reader.read(); // the first failure is one full read
  assert.equal(harness.fullReads, 2);
  for (let poll = 0; poll < 20; poll += 1) {
    harness.now.value += 500;
    await harness.reader.read();
  }
  assert.equal(harness.fullReads, 2);
  harness.probeError = null;
  await harness.reader.read();
  assert.equal(harness.fullReads, 3);
  harness.probeError = Object.assign(new Error('boom'), { code: 'STORE_INCONSISTENT' });
  harness.now.value += 30_000;
  await harness.reader.read();
  harness.now.value += 30_000;
  await harness.reader.read();
  assert.equal(harness.fullReads, 5); // the revalidation ceiling still applies
});

test('同時の読みはprojectごとに1回のfull readを共有する', async () => {
  const harness = readerHarness();
  const results = await Promise.all([harness.reader.read(), harness.reader.read(), harness.reader.read()]);
  assert.equal(harness.fullReads, 1);
  assert.equal(results[0], results[2]);
});

test('Store結果の外の故障(rendererの異常)は従来どおり500のlattice.todo_gantt_http_error.v1', async (context) => {
  const root = await workspace(context);
  const live = await serve(context, serving(root, typed('verified', { store: { schema: 'broken' } })));
  const response = await fetch(live.url);
  assert.equal(response.status, 500);
  assert.equal((await response.json()).schema, 'lattice.todo_gantt_http_error.v1');
});

test('one-shotのrenderはstrictな読みのまま不整合で失敗する', async (context) => {
  const root = await workspace(context);
  await unlink(path.join(root, '.lattice', 'todo', 'manifest.json'));
  await assert.rejects(renderTodoGanttForProject({ repoRoot: root }), (error) => typeof error.code === 'string');
});

test('起動もdisplay readを使い、不整合のstoreでもlocal live ganttは起動して状態を出す', async (context) => {
  const root = await workspace(context);
  const store = await readTodoStoreStable({ repoRoot: root });
  const start = async (result, extra = {}) => {
    const { live, planKeys } = await startTodoGanttDisplayLive({ repoRoot: root, ...extra,
      readForDisplay: async () => result, readDisplaySource: async () => SOURCE });
    context.after(() => live.close());
    return { live, planKeys };
  };
  // unverified carries project_id and the projected plan keys
  const unverified = await start(typed('unverified', { store: rawOf(store) }));
  assert.equal(unverified.live.projectId, 'project-1');
  assert.deepEqual(unverified.planKeys, ['main']);
  assert.equal((await fetch(unverified.live.url)).status, 200);
  // unavailable, nothing registered: still starts and serves the empty state
  const bare = await start(typed('unavailable', { source: null }));
  assert.deepEqual(bare.planKeys, []);
  const response = await fetch(bare.live.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-display-state="unavailable"/u);
  // unavailable with a registered project id keeps that id
  await writeFile(path.join(root, '.lattice', 'project.json'), `${JSON.stringify({
    schema: 'lattice.project_identity.v1', project_id: 'registered-1', display_name: 'Registered' })}\n`);
  const registered = await start(typed('unavailable', { source: null }));
  assert.equal(registered.live.projectId, 'registered-1');
  assert.equal(registered.live.displayName, 'Registered');
});

test('Store readerのthrow(型付き結果の外の故障)は同じtokenなら読み直さず500のまま、ceilingで再検証する', async (context) => {
  const root = await workspace(context);
  const harness = readerHarness();
  const fault = Object.assign(new Error('io'), { code: 'EIO' });
  harness.result = null;
  const reader = createTodoGanttDisplayReader({ repoRoot: root, now: () => harness.now.value,
    readForDisplay: async () => { harness.fullReads += 1; throw fault; },
    readDisplaySource: async () => harness.source });
  const live = await serve(context, createTodoGanttDisplayServing({ repoRoot: root,
    projectId: 'project-1', reader }));
  for (let poll = 0; poll < 5; poll += 1) {
    harness.now.value += 500;
    const response = await fetch(live.url);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, 'EIO');
  }
  assert.equal(harness.fullReads, 1);
  harness.now.value += 30_000;
  await assert.rejects(reader.read(), fault);
  assert.equal(harness.fullReads, 2);
  harness.source = { ...SOURCE, manifest_digest: 'm2' };
  await assert.rejects(reader.read(), fault);
  assert.equal(harness.fullReads, 3);
});
