import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeReadyFrontier, projectTodoStatus } from '../src/todo-status.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

// ready判定の単一正本化（ADR 0127 工程5）。切り出しは挙動不変でなければならないため、
// status v4の出力バイト列をgoldenで固定する。ready集合はstatusと同じ計算から出る。

const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-18T00:00:00.000Z';

const task = (taskId, title = taskId) => ({
  task_id: taskId, title, lane: 'main', narrative_ref: null, compile_binding: null,
});
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-ready-frontier-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  const evidenceBytes = Buffer.from('ready frontier fixture evidence\n', 'utf8');
  await writeFile(path.join(root, 'evidence.txt'), evidenceBytes);
  const blobOid = execFileSync('git', ['hash-object', '-w', 'evidence.txt'], { cwd: root })
    .toString().trim();
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1',
        project_id: 'project-1',
        plan_key: 'main',
        plan_version: 'v1',
        predecessor_plan_digest: null,
        tasks: [
          task('A', 'Active work'), task('B', 'Blocked work'), task('C', 'Ready work'),
          task('D', 'Waiting work'), task('E', 'Completed prerequisite'),
          task('F', 'Second ready work'),
        ],
        hard_dependencies: [
          { from: ref('A'), to: ref('D') },
          { from: ref('E'), to: ref('C') },
        ],
        joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const append = (taskId, kind, recordedAt, payload) => appendTodoEvent({
    repoRoot: root, writer, planKey: 'main', now: recordedAt,
    event: { task_id: taskId, kind, actor: ACTOR, recorded_at: recordedAt, payload },
  });
  await append('A', 'start', '2026-07-18T00:01:00.000Z', { override_reason: null });
  await append('B', 'start', '2026-07-18T00:02:00.000Z', { override_reason: null });
  await append('B', 'block', '2026-07-18T00:03:00.000Z', { reason: 'waiting on review' });
  await append('E', 'start', '2026-07-18T00:04:00.000Z', { override_reason: null });
  await append('E', 'done', '2026-07-18T00:05:00.000Z', {
    evidence: {
      evidence_id: 'ev-1',
      repo_id: 'self',
      path: 'evidence.txt',
      git_blob_oid: blobOid,
      content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
      media_type: 'text/plain',
      anchor_digest: null,
    },
  });
  return readTodoStore({ repoRoot: root, now: NOW });
}

// 切り出し前のprojectTodoStatusが出していたバイト列。挙動不変の錨。
const GOLDEN_STATUS = '{"schema":"lattice.todo_status_result.v8","project_id":"project-1",'
  + '"active_set":[{"plan_key":"main","task_id":"A","label":"Active work",'
  + '"unmet_dependencies":[]}],'
  // u12: ready entryは作成者が書いた終了条件を足して載せる（欄なしplanはnull）。
  + '"next_ready":[{"plan_key":"main","task_id":"C","label":"Ready work","done_condition":null},'
  + '{"plan_key":"main","task_id":"F","label":"Second ready work","done_condition":null}],'
  + '"dispatch_frontier":{"schema":"lattice.todo_dispatch_frontier.v1",'
  + '"selection_source":"next_ready","policy":"all_ready_parallel_by_default",'
  + '"recommended_parallelism":2,"subset_requires_reason":true,'
  + '"parallel_start_flag":"--parallel-frontier",'
  + '"frontier_digest":"__FRONTIER__"},'
  + '"blocked":[{"plan_key":"main","task_id":"B","reason":"waiting on review"}],'
  // 全taskがdoneではない(Phaseはactive)ので監査待ちは空。v5で足した欄はblockedとmember_headsの間。
  + '"audit_pending":[],'
  // v7で足した構造finalization待ち欄。未適用planでは空でdispatchを変えない。
  + '"structure_finalization_pending":[],'
  // v6で足したplan_notes欄。このfixtureはplan単位noteを持たないので空。挿入位置は
  // audit_pendingとmember_headsの間で、dispatch側のバイトは1つも動いていない。
  + '"plan_notes":[],'
  // ob03: 調整方式は未宣言なので空。v6で足した欄はplan_notesとmember_headsの間。
  + '"coordination":[],'
  // ob05: 並列候補。呼び出し側が渡す欄で、このtestは明示の空を渡している。挿入位置は
  // coordinationとmember_headsの間で、dispatch側のバイトは1つも動いていない。
  + '"parallel_candidates":[],'
  + '"cross_plan_findings":{"total":0,"entries":[]},'
  + '"member_heads":[__HEADS__],"result_digest":"__RESULT__"}';

test('status v7の出力バイト列が加算列以外変わらない', async (context) => {
  const readModel = await workspace(context);
  const result = projectTodoStatus(readModel, { parallelCandidates: [], planNotes: [] });
  const actual = JSON.stringify(result);

  // digestとmember headはfixtureの時刻・digestに依存するので、構造だけを錨にする。
  const expected = GOLDEN_STATUS
    .replace('__FRONTIER__', result.dispatch_frontier.frontier_digest)
    .replace('__HEADS__', JSON.stringify(result.member_heads).slice(1, -1))
    .replace('__RESULT__', result.result_digest);
  assert.equal(actual, expected);
});

test('computeReadyFrontierはstatusのnext_readyと同一の集合を返す', async (context) => {
  const readModel = await workspace(context);
  const status = projectTodoStatus(readModel, { parallelCandidates: [], planNotes: [] });
  const frontier = computeReadyFrontier(readModel);

  assert.deepEqual(frontier, status.next_ready);
  assert.deepEqual(frontier.map(({ task_id: id }) => id), ['C', 'F']);
});

test('computeReadyFrontierはstatusと同じ入力検査でfail closedする', async () => {
  assert.throws(() => computeReadyFrontier({ schema: 'wrong' }),
    (error) => error.code === 'TODO_STATUS_INVALID_INPUT');
});
