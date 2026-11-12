import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  TODO_NOTICE_ROOT_REF, ackTodoNotices, readAllTodoNoticeAcks, readTodoNoticeAcks,
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

const ack = (root, lane, noticeIds, openIds, now = NOW) => ackTodoNotices({
  repoRoot: root, lane, noticeIds, openIds, actor: ACTOR, now,
});
async function laneFile(root) {
  const [name] = (await readdir(path.join(root, TODO_NOTICE_ROOT_REF))).filter((n) => n.endsWith('.json'));
  return path.posix.join(TODO_NOTICE_ROOT_REF, name);
}

test('ack records, repeats as already, drops acks of closed notices, and stays out of git', async (context) => {
  const root = await repo(context);
  await authored(root);
  assert.equal(await readTodoNoticeAcks({ repoRoot: root, lane: 'bot-1' }), null);

  assert.deepEqual(await ack(root, 'bot-1', [B, A], [A, B, C]), { acked: [A, B], already: [] });
  assert.deepEqual(await ack(root, 'bot-1', [A, C], [A, B, C], LATER), { acked: [C], already: [A] });
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

  assert.deepEqual(await ack(root, 'bot-1', [A], [A]), { acked: [A], already: [] });
  assert.equal((await readAllTodoNoticeAcks({ repoRoot: root })).unreadable.length, 0);
});

test('a newer ack schema asks for a newer Lattice and is never downgraded', async (context) => {
  const root = await repo(context);
  await authored(root);
  await ack(root, 'bot-1', [A], [A]);
  const ref = await laneFile(root);
  const record = JSON.parse(await readFile(path.join(root, ref), 'utf8'));
  const newer = `${canonicalizeTodoArtifact({ ...record, schema: 'lattice.todo_notice_acks.v2' })}\n`;
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
