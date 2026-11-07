// 監査待ちは2つの面へ別々に出る——`lattice status`／`todo status`のJSON(ap03/ap04)と、
// dashboardが配信する工程図のヘッダ(ap05)である。どちらも同じ共有module
// (`src/todo-audit-pending.mjs`)の状態集合を使うが、store read modelの歩き方は別実装になっている
// (status側は自前で歩き、gantt側は`auditPendingPhasesOf`を使う)。
//
// 別実装が同じ答えを出すことは、どちらの面のtestも見ていない。片方だけがずれると、
// 「図には監査待ちが出ているのにstatusは残作業なしと答える」という、この工程がまさに
// 直している事故の形へ戻る。ここで両面を同じstoreに対して突き合わせて固定する。
//
// fixtureは2 planを実storeでgate_readyにするだけで、他のtestのfixtureとは共有しない
// (必要な形が違う。ap06の担当判断)。gate_readyを作る時の落とし穴が2つある:
// - `NOW`を現在時刻より先に置くと`STORE_INCONSISTENT / future_clock_skew`でstatusごと落ちる
//   (max_future_skew_ms=300000)。既存testが過去日付の固定`NOW`を使うのはこのため。
// - `buildTodoPlan`のtask形は`{task_id, title, lane, narrative_ref, narrative_anchor,
//   compile_binding, parent_task_id}`ちょうど。`design_memo`を足すとschema violationで弾かれる。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderTodoGanttForProject } from '../src/todo-cli.mjs';
import { projectTodoStatus } from '../src/todo-status.mjs';
import {
   buildTodoPlan, createTodoStoreWriter, initializeTodoStore, readTodoStoreStable,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

const task = (taskId) => ({ task_id: taskId, title: taskId, lane: 'main',
  narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null });

function evidenceFor(root, label) {
  const bytes = Buffer.from(`${label} evidence\n`);
  return {
    evidence_id: label, repo_id: 'self', path: `${label}.txt`,
    git_blob_oid: execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: root, input: bytes, encoding: 'utf8' }).trim(),
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  };
}

/** 2つのphase無しplanを持つstore。両方の唯一のtaskをdoneにして暗黙Phaseをgate_readyにする。 */
async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-audit-agreement-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const keys = ['alpha-plan', 'beta-plan'];
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: keys.map((planKey) => ({
      plan: buildTodoPlan({ schema: 'lattice.todo_plan.v3', project_id: 'project-1',
        plan_key: planKey, plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('A')], hard_dependencies: [], joins: [] }),
      genesis: { actor: ACTOR, recorded_at: NOW },
    })),
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  for (const planKey of keys) {
    for (const kind of ['start', 'done']) {
      await appendTodoEvent({ repoRoot: root, writer, planKey, now: NOW,
        event: { kind, task_id: 'A', actor: ACTOR, recorded_at: NOW,
          payload: kind === 'start' ? { override_reason: null } : { evidence: evidenceFor(root, planKey) } } });
    }
  }
  return root;
}

/** 両面の答えを、比較できる同じ表記(`plan_key/phase_id (status)`)へ落とす。 */
async function bothSurfaces(root) {
  const store = await readTodoStoreStable({ repoRoot: root });
  const status = projectTodoStatus(store, { parallelCandidates: [], planNotes: [] });
  const { rendered } = await renderTodoGanttForProject({ repoRoot: root, scope: 'live', displayName: 'X' });
  const marker = '<span class="audit-pending-chip"';
  const start = rendered.html.indexOf(marker);
  // 札の`title`が全件を持つ(本文は幅の都合で先頭1件まで)。突き合わせるのは全件の方。
  const title = start === -1 ? null
    : rendered.html.slice(rendered.html.indexOf('title="', start) + 'title="'.length,
      rendered.html.indexOf('">', start));
  return {
    fromStatus: status.audit_pending.map((entry) => (
      `${entry.plan_key}/${entry.phase_id} (${entry.phase_status})`)),
    fromGantt: title === null ? [] : title.replace(/^監査待ち \d+件: /u, '').split(' · '),
    chipPresent: start !== -1,
    statusCount: status.audit_pending.length,
    title,
  };
}

const review = (root, planKey) => appendTodoEvent({
  repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
  event: { kind: 'phase_review', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
    payload: { reason: '監査を始める' } },
});

const closeUnaudited = (root, planKey) => appendTodoEvent({
  repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), planKey, now: NOW,
  event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR, recorded_at: NOW,
    payload: { reason: '監査せず歴史として閉じる' } },
});

test('statusのaudit_pendingと工程図ヘッダは、同じstoreに対して同じ監査待ちを同じ順で指す', async (context) => {
  const root = await workspace(context);
  const { fromStatus, fromGantt, statusCount, title } = await bothSurfaces(root);
  assert.deepEqual(fromStatus, [
    'alpha-plan/terminal-audit (gate_ready)', 'beta-plan/terminal-audit (gate_ready)',
  ]);
  assert.deepEqual(fromGantt, fromStatus);
  // 件数の表記も食い違わない。図が2件と言ってstatusが1件を返す、が起きない。
  assert.equal(title.startsWith(`監査待ち ${statusCount}件: `), true, title);
});

test('片方のPhaseだけが監査中へ進んでも、両面はずれずに追従する', async (context) => {
  const root = await workspace(context);
  await review(root, 'alpha-plan');
  const { fromStatus, fromGantt } = await bothSurfaces(root);
  assert.deepEqual(fromStatus, [
    'alpha-plan/terminal-audit (reviewing)', 'beta-plan/terminal-audit (gate_ready)',
  ]);
  assert.deepEqual(fromGantt, fromStatus);
});

test('判断が着いたPhaseは両面から同時に消え、全部着けば両面とも空になる', async (context) => {
  const root = await workspace(context);
  await closeUnaudited(root, 'alpha-plan');
  const partial = await bothSurfaces(root);
  assert.deepEqual(partial.fromStatus, ['beta-plan/terminal-audit (gate_ready)']);
  assert.deepEqual(partial.fromGantt, partial.fromStatus);

  await closeUnaudited(root, 'beta-plan');
  const empty = await bothSurfaces(root);
  assert.deepEqual(empty.fromStatus, []);
  // 図の側は「空配列」ではなく「札そのものが出ない」で表す。空の札を出さない。
  assert.equal(empty.chipPresent, false);
  assert.deepEqual(empty.fromGantt, []);
});
