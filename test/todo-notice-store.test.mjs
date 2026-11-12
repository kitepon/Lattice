import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  TODO_NOTICE_ROOT_REF, ackTodoNotices, cancelTodoNoticeWait, readAllTodoNoticeAcks, readAllTodoNoticeWaits,
  readTodoNoticeAcks, todoNoticeWaitingDigest, writeTodoNoticeWait,
} from '../src/todo-notice-store.mjs';
import {
  buildTodoPlan, createTodoStoreWriter, initializeAuthoredTodoStore, isUninitializedTodoStore,
} from '../src/todo-store.mjs';

const NOW = '2026-11-12T00:00:00.000Z';
const LATER = '2026-11-12T01:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ID = (n) => String(n).repeat(64).slice(0, 64);
const [A, B, C] = [ID(1), ID(2), ID(3)];
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-notice-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '--quiet']);
  return root;
}

async function authored(root) {
  await initializeAuthoredTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), projectId: 'project',
    repositories: [{ repo_id: 'self', path: '.' }],
    plan: buildTodoPlan({
      schema: 'lattice.todo_plan.v7', project_id: 'project', plan_key: 'main', plan_version: 'v1',
      predecessor_plan_digest: null,
      tasks: [{ task_id: 'a', title: 'a', lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase' }],
      phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy', predecessor_phase_ids: [],
        required_evidence_slots: ['gate'] }],
      hard_dependencies: [], joins: [], phase_accept_dependencies: [],
    }),
    genesis: { actor: ACTOR, recorded_at: NOW },
  });
}

const NONE = todoNoticeWaitingDigest([]);
const pair = (id, digest = NONE) => ({ notice_id: id, waiting_digest: digest });
// Notices nobody waits on: the lane is the only recipient.
const ack = (root, lane, noticeIds, openIds, now = NOW) => ackTodoNotices({
  repoRoot: root, lane, notices: noticeIds.map((id) => ({ ...pair(id), recipients: [lane] })), openIds, actor: ACTOR, now,
});
async function laneFile(root) {
  const [name] = (await readdir(path.join(root, TODO_NOTICE_ROOT_REF))).filter((n) => n.endsWith('.json'));
  return path.posix.join(TODO_NOTICE_ROOT_REF, name);
}

test('ack records, repeats as already, drops acks of closed notices, and stays out of git', async (context) => {
  const root = await repo(context);
  await authored(root);
  assert.equal(await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' }), null);

  assert.deepEqual(await ack(root, 'bot-1', [B, A], [A, B, C]), { acked: [pair(A), pair(B)], already: [] });
  assert.deepEqual(await ack(root, 'bot-1', [A, C], [A, B, C], LATER), { acked: [pair(C)], already: [pair(A)] });
  let record = await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' });
  assert.deepEqual(record.acks.map((a) => [a.notice_id, a.acked_at]), [[A, NOW], [B, NOW], [C, LATER]]);
  assert.equal(record.acks_digest, todoSelfDigest(record, 'acks_digest'));

  // B closed: the next write drops it, so the set is bounded by the lane's open notices.
  await ack(root, 'bot-1', [C], [A, C]);
  record = await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' });
  assert.deepEqual(record.acks.map((a) => a.notice_id), [A, C]);
  await assert.rejects(ack(root, 'bot-1', [B], [A]), TypeError);

  // Host-local in any repository: the next --atomic-commit sees a clean store.
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all', '--', TODO_NOTICE_ROOT_REF]), '');
});

test('one corrupt lane is STORE_CORRUPT with its path and never hides the others; ack replaces it', async (context) => {
  const root = await repo(context);
  await authored(root);
  await ack(root, 'bot-1', [A], [A]);
  const ref = await laneFile(root);
  await ack(root, 'bot-2', [B], [B]);
  const record = JSON.parse(await readFile(path.join(root, ref), 'utf8'));
  await writeFile(path.join(root, ref), `${canonicalizeTodoArtifact({ ...record, acks: [] })}\n`);

  await assert.rejects(readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' }),
    (error) => error.code === 'STORE_CORRUPT' && error.detail.reason === 'notice_acks_digest_mismatch'
      && error.detail.ref === ref);
  const all = await readAllTodoNoticeAcks({ repoRoot: root });
  assert.deepEqual(all.acks.map((r) => r.lane), ['bot-2']);
  assert.deepEqual(all.unreadable, [{ lane_file: ref, code: 'STORE_CORRUPT', reason: 'notice_acks_digest_mismatch' }]);

  assert.deepEqual(await ack(root, 'bot-1', [A], [A]), { acked: [pair(A)], already: [] });
  assert.equal((await readAllTodoNoticeAcks({ repoRoot: root })).unreadable.length, 0);
});

test('a newer ack schema asks for a newer Lattice and is never downgraded', async (context) => {
  const root = await repo(context);
  await authored(root);
  await ack(root, 'bot-1', [A], [A]);
  const ref = await laneFile(root);
  const record = JSON.parse(await readFile(path.join(root, ref), 'utf8'));
  const newer = `${canonicalizeTodoArtifact({ ...record, schema: 'lattice.todo_notice_acks.v3' })}\n`;
  await writeFile(path.join(root, ref), newer);
  const isNewer = (error) => error.code === 'UNSUPPORTED_SCHEMA' && error.detail.reason === 'newer_lattice_value'
    && error.detail.ref === ref;
  await assert.rejects(readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' }), isNewer);
  await assert.rejects(ack(root, 'bot-1', [B], [A, B]), isNewer);
  assert.equal(await readFile(path.join(root, ref), 'utf8'), newer);
  assert.equal((await readAllTodoNoticeAcks({ repoRoot: root })).unreadable[0].code, 'UNSUPPORTED_SCHEMA');
});

test('ack residue of a removed store does not block authoring a new one', async (context) => {
  const root = await repo(context);
  await assert.rejects(ack(root, 'bot-1', [A], [A]), (error) => error.code === 'STORE_WRITE_CONFLICT');
  await mkdir(path.join(root, TODO_NOTICE_ROOT_REF), { recursive: true });
  await writeFile(path.join(root, TODO_NOTICE_ROOT_REF, '.gitignore'), '*\n');
  await writeFile(path.join(root, TODO_NOTICE_ROOT_REF, '0123456789abcdef.json'), '{}\n');
  assert.equal(await isUninitializedTodoStore({ repoRoot: root }), true);
  await authored(root);
  await assert.rejects(readdir(path.join(root, TODO_NOTICE_ROOT_REF)), { code: 'ENOENT' });
});

test('a v1 ack set reads as no waiters with the lane as recipient; a new wait opens a second variant', async (context) => {
  const root = await repo(context);
  await authored(root);
  await ack(root, 'bot-1', [A], [A, B]);
  const ref = await laneFile(root);
  const v1 = { schema: 'lattice.todo_notice_acks.v1', lane: 'bot-1',
    acks: [A, B].map((id) => ({ notice_id: id, acked_at: NOW, actor: ACTOR })), acks_digest: '' };
  v1.acks_digest = todoSelfDigest(v1, 'acks_digest');
  const v1Bytes = `${canonicalizeTodoArtifact(v1)}\n`;
  await writeFile(path.join(root, ref), v1Bytes);

  const read = await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' });
  assert.equal(read.schema, 'lattice.todo_notice_acks.v2');
  assert.deepEqual(read.acks.map((a) => [a.notice_id, a.waiting_digest, a.recipients]),
    [[A, NONE, ['bot-1']], [B, NONE, ['bot-1']]]);
  // Nothing new to record: the v1 bytes stay for an older Lattice.
  assert.deepEqual(await ack(root, 'bot-1', [A], [A, B]), { acked: [], already: [pair(A)] });
  assert.equal(await readFile(path.join(root, ref), 'utf8'), v1Bytes);

  // Agent bot-2 waits on A: a new digest, acked separately; B closed and dropped; both variants of A kept.
  const waited = todoNoticeWaitingDigest([{ agent: 'bot-2', since: NOW, reason: null }]);
  assert.notEqual(waited, NONE);
  assert.deepEqual(await ackTodoNotices({ repoRoot: root, lane: 'bot-1', openIds: [A], actor: ACTOR, now: LATER,
    notices: [{ ...pair(A, waited), recipients: ['bot-1', 'bot-2'] }] }), { acked: [pair(A, waited)], already: [] });
  const record = await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' });
  assert.deepEqual(record.acks.map((a) => [a.notice_id, a.waiting_digest, a.recipients]),
    [[A, NONE, ['bot-1']], [A, waited, ['bot-1', 'bot-2']]].sort((l, r) => (l[1] < r[1] ? -1 : 1)));
  assert.equal(JSON.parse(await readFile(path.join(root, ref), 'utf8')).schema, 'lattice.todo_notice_acks.v2');
  // Recipients must name the lane.
  await assert.rejects(ackTodoNotices({ repoRoot: root, lane: 'bot-1', openIds: [A], actor: ACTOR, now: LATER,
    notices: [{ ...pair(A), recipients: ['bot-2'] }] }), TypeError);
});

test('waiting digest is the sorted waiter set, independent of order and reason', () => {
  const one = { agent: 'b', since: NOW, reason: 'x' };
  const two = { agent: 'a', since: LATER, reason: null };
  assert.equal(todoNoticeWaitingDigest([one, two]), todoNoticeWaitingDigest([two, { ...one, reason: null }]));
  assert.notEqual(todoNoticeWaitingDigest([one]), todoNoticeWaitingDigest([{ ...one, since: LATER }]));
});

const wait = (root, taskId, agent, { reason = null, now = NOW, keep = () => true, planKey = 'main' } = {}) =>
  writeTodoNoticeWait({ repoRoot: root, planKey, taskId, agent, reason, now, keep });
const planWaits = async (root) => (await readAllTodoNoticeWaits({ repoRoot: root })).waits
  .map((r) => [r.plan_key, r.waits.map((w) => [w.task_id, w.agent, w.since, w.reason])]);

test('wait records, repeats keeping since, drops what keep rejects, cancels, and stays out of git', async (context) => {
  const root = await repo(context);
  assert.deepEqual(await readAllTodoNoticeWaits({ repoRoot: root }), { waits: [], unreadable: [] });
  assert.deepEqual(await cancelTodoNoticeWait({ repoRoot: root, planKey: 'main', taskId: 'a', agent: 'bot-1' }),
    { cancelled: false });
  await assert.rejects(wait(root, 'a', 'bot-1'), (error) => error.code === 'STORE_WRITE_CONFLICT');
  await authored(root);

  assert.deepEqual(await wait(root, 'b', 'bot-2'), { recorded: true, since: NOW });
  assert.deepEqual(await wait(root, 'a', 'bot-1', { reason: 'idle' }), { recorded: true, since: NOW });
  assert.deepEqual(await wait(root, 'a', 'bot-1', { reason: 'still idle', now: LATER }), { recorded: false, since: NOW });
  assert.deepEqual(await wait(root, 'c', 'bot-1', { planKey: 'other' }), { recorded: true, since: NOW });
  assert.deepEqual(await planWaits(root).then((all) => all.find(([key]) => key === 'main')[1]),
    [['a', 'bot-1', NOW, 'still idle'], ['b', 'bot-2', NOW, null]]);

  // keep sees the existing waits only; a rejected wait is dropped, and an ended one starts over.
  const seen = [];
  assert.deepEqual(await wait(root, 'a', 'bot-1', { now: LATER, keep: (w) => { seen.push(w.task_id); return false; } }),
    { recorded: true, since: LATER });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual((await planWaits(root)).find(([key]) => key === 'main')[1], [['a', 'bot-1', LATER, null]]);

  assert.deepEqual(await cancelTodoNoticeWait({ repoRoot: root, planKey: 'main', taskId: 'a', agent: 'bot-1' }),
    { cancelled: true });
  assert.deepEqual(await cancelTodoNoticeWait({ repoRoot: root, planKey: 'main', taskId: 'a', agent: 'bot-1' }),
    { cancelled: false });
  assert.deepEqual((await planWaits(root)).find(([key]) => key === 'main')[1], []);
  await assert.rejects(wait(root, 'a', 'bot-1', { reason: 'bad\nreason' }), TypeError);
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all', '--', TODO_NOTICE_ROOT_REF]), '');
});

test('a corrupt wait file is named and replaced; a newer one is refused and kept; residue never blocks authoring',
  async (context) => {
    const root = await repo(context);
    await authored(root);
    await wait(root, 'a', 'bot-1');
    await wait(root, 'a', 'bot-1', { planKey: 'other' });
    const names = (await readdir(path.join(root, TODO_NOTICE_ROOT_REF))).filter((n) => n.startsWith('wait-')).sort();
    const refs = names.map((n) => path.posix.join(TODO_NOTICE_ROOT_REF, n));
    const records = await Promise.all(refs.map(async (ref) => JSON.parse(await readFile(path.join(root, ref), 'utf8'))));
    const mainRef = refs[records.findIndex((r) => r.plan_key === 'main')];
    const mainRecord = records.find((r) => r.plan_key === 'main');
    await writeFile(path.join(root, mainRef), `${canonicalizeTodoArtifact({ ...mainRecord, waits: [] })}\n`);

    const all = await readAllTodoNoticeWaits({ repoRoot: root });
    assert.deepEqual(all.waits.map((r) => r.plan_key), ['other']);
    assert.deepEqual(all.unreadable, [{ wait_file: mainRef, code: 'STORE_CORRUPT', reason: 'notice_waits_digest_mismatch' }]);
    // The ack sets never read wait files.
    assert.deepEqual(await readAllTodoNoticeAcks({ repoRoot: root }), { acks: [], unreadable: [] });
    assert.deepEqual(await cancelTodoNoticeWait({ repoRoot: root, planKey: 'main', taskId: 'a', agent: 'bot-1' }),
      { cancelled: false });
    assert.deepEqual(await wait(root, 'b', 'bot-1'), { recorded: true, since: NOW });
    assert.equal((await readAllTodoNoticeWaits({ repoRoot: root })).unreadable.length, 0);

    const newer = `${canonicalizeTodoArtifact({ ...mainRecord, schema: 'lattice.todo_notice_waits.v2' })}\n`;
    await writeFile(path.join(root, mainRef), newer);
    const isNewer = (error) => error.code === 'UNSUPPORTED_SCHEMA' && error.detail.reason === 'newer_lattice_value'
      && error.detail.ref === mainRef;
    await assert.rejects(wait(root, 'a', 'bot-1'), isNewer);
    await assert.rejects(cancelTodoNoticeWait({ repoRoot: root, planKey: 'main', taskId: 'a', agent: 'bot-1' }), isNewer);
    assert.equal(await readFile(path.join(root, mainRef), 'utf8'), newer);
    assert.equal((await readAllTodoNoticeWaits({ repoRoot: root })).unreadable[0].code, 'UNSUPPORTED_SCHEMA');

    // A store that is gone leaves wait files beside the acks; authoring a new store sweeps them.
    await rm(path.join(root, '.lattice'), { recursive: true, force: true });
    await mkdir(path.join(root, TODO_NOTICE_ROOT_REF), { recursive: true });
    await writeFile(path.join(root, TODO_NOTICE_ROOT_REF, 'wait-0123456789abcdef.json'), '{}\n');
    await writeFile(path.join(root, TODO_NOTICE_ROOT_REF, '.wait-0123456789abcdef.json.1.0123456789ab.tmp'), '{}\n');
    assert.equal(await isUninitializedTodoStore({ repoRoot: root }), true);
    await authored(root);
    await assert.rejects(readdir(path.join(root, TODO_NOTICE_ROOT_REF)), { code: 'ENOENT' });
  });
