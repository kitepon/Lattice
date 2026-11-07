import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectTodoChainV1 } from '../src/todo-chain.mjs';
import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { renderTodoGanttHtml } from '../src/todo-gantt-html.mjs';
import { renderTodoGanttForProject } from '../src/todo-cli.mjs';
import {
   buildTodoPlan, createTodoStoreWriter, initializeTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const ref = (task_id, plan_key) => ({ project_id: 'project-1', plan_key, task_id });

/** `phases`はstoreが常に埋める導出ビュー。planの世代に関わらず同じ形で入る(ADR 0147)。 */
function phase(phase_id, status) {
  return { phase_id, status, review_event_digest: null, decision_event_digest: null, decision_evidence: null };
}

function readFixture(plans) {
  return {
    schema: 'lattice.todo_store_read.v1',
    project_id: 'project-1',
    members: plans.map(({ planKey, phases }) => ({
      plan: {
        project_id: 'project-1',
        plan_key: planKey,
        tasks: [{ task_id: 'T0001', title: 'Task', lane: 'main', narrative_ref: null, compile_binding: null }],
        hard_dependencies: [],
        joins: [],
      },
      tasks: [{ task_id: 'T0001', status: 'done', started_at: null, done_at: null,
        blocked_reason: null, evidence: null, evidence_unverified: false }],
      ...(phases === undefined ? {} : { phases }),
    })),
  };
}

function render(read) {
  const chain = projectTodoChainV1({
    nodes: read.members.flatMap(({ plan }) => plan.tasks.map(({ task_id }) => ref(task_id, plan.plan_key))),
    hard_edges: [],
    joins: [],
  });
  return renderTodoGanttHtml({ readModel: read, layout: layoutTodoGantt(read) }).html;
}

const CHIP = '<span class="audit-pending-chip"';

/** ヘッダの札のテキストだけを取り出す。無ければnull。 */
function chipText(html) {
  const start = html.indexOf(CHIP);
  if (start === -1) return null;
  const open = html.indexOf('>', start);
  return html.slice(open + 1, html.indexOf('</span>', open));
}

/** 札の`title`(全件の内訳)。無ければnull。 */
function chipTitle(html) {
  const start = html.indexOf(CHIP);
  if (start === -1) return null;
  const from = html.indexOf('title="', start) + 'title="'.length;
  return html.slice(from, html.indexOf('"', from));
}

test('gate_readyのPhaseがあればヘッダに監査待ちが出る', () => {
  const html = render(readFixture([{ planKey: 'main', phases: [phase('terminal-audit', 'gate_ready')] }]));
  assert.equal(chipText(html), '監査待ち 1件: main/terminal-audit (gate_ready)');
});

test('判断の着いたPhaseしか無ければ札は出ない', () => {
  for (const status of ['accepted', 'closed_unaudited', 'active']) {
    const html = render(readFixture([{ planKey: 'main', phases: [phase('terminal-audit', status)] }]));
    assert.equal(chipText(html), null, status);
  }
});

// 2026-08-08: 全件を並べていた時、札がツールバーを押し広げてズーム操作を画面外へ追い出した。
// ツールバーはpane幅で制約されておらずCSSの`text-overflow`が発動しないので、出す文字列の側を
// 有界にする。件数と先頭1件は常に本文、全件は`title`。
test('監査待ちが複数あれば本文は件数と先頭1件まで、全件はtitleに残る', () => {
  const html = render(readFixture([
    { planKey: 'zeta', phases: [phase('terminal-audit', 'reviewing')] },
    { planKey: 'alpha', phases: [phase('p2', 'rejected'), phase('p1', 'gate_ready')] },
  ]));
  assert.equal(chipText(html), '監査待ち 3件: alpha/p1 (gate_ready)');
  assert.equal(chipTitle(html),
    '監査待ち 3件: alpha/p1 (gate_ready) · alpha/p2 (rejected) · zeta/terminal-audit (reviewing)');
});

test('監査待ちが多くても札の本文長はplan名1件分で頭打ちになる', () => {
  const many = Array.from({ length: 20 }, (unused, index) => ({
    planKey: `plan-${String(index).padStart(2, '0')}`,
    phases: [phase('terminal-audit', 'gate_ready')],
  }));
  const text = chipText(render(readFixture(many)));
  assert.equal(text, '監査待ち 20件: plan-00/terminal-audit (gate_ready)');
  // 1件だけの時との差は件数の桁だけ。plan数に比例して伸びない。
  const one = chipText(render(readFixture(many.slice(0, 1))));
  assert.ok(text.length - one.length <= 1, `${text.length} vs ${one.length}`);
});

test('phasesを持たないread modelでも描画は壊れず札も出ない', () => {
  const html = render(readFixture([{ planKey: 'main' }]));
  assert.equal(chipText(html), null);
  assert.match(html, /依存工程図/u);
});

// ここから先は実store。手で組んだread modelは「その形が来たらどう描くか」しか示さず、
// storeが実際にその形を作るかは示さない。ADR 0147の暗黙terminal-audit Phaseは導出値なので、
// 全taskをdoneにして本当にgate_readyが立つところから通す。
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

async function auditedWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-gantt-audit-pending-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const plan = buildTodoPlan({
    schema: 'lattice.todo_plan.v3', project_id: 'project-1', plan_key: 'audited',
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [{ task_id: 'A', title: 'A', lane: 'main', narrative_ref: null,
      narrative_anchor: null, compile_binding: null, parent_task_id: null }],
    hard_dependencies: [], joins: [],
  });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  const bytes = Buffer.from('A evidence\n');
  const evidence = {
    evidence_id: 'a', repo_id: 'self', path: 'a.txt',
    git_blob_oid: execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: root, input: bytes, encoding: 'utf8' }).trim(),
    content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  };
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  for (const kind of ['start', 'done']) {
    await appendTodoEvent({ repoRoot: root, writer, planKey: 'audited', now: NOW,
      event: { kind, task_id: 'A', actor: ACTOR, recorded_at: NOW,
        payload: kind === 'start' ? { override_reason: null } : { evidence } } });
  }
  return root;
}

test('実storeで全taskがdoneになると、ganttヘッダが監査待ちを名指しする', async (context) => {
  const root = await auditedWorkspace(context);
  const { rendered } = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  assert.equal(chipText(rendered.html), '監査待ち 1件: audited/terminal-audit (gate_ready)');
});

test('実storeで監査の判断が着けば札は消える', async (context) => {
  const root = await auditedWorkspace(context);
  // ADR 0148の`closed_unaudited`。acceptと同じく「判断が着いた」終端であり、待ちではない。
  await appendTodoEvent({ repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: 'audited', now: NOW,
    event: { kind: 'phase_close_unaudited', phase_id: 'terminal-audit', actor: ACTOR,
      recorded_at: NOW, payload: { reason: '監査せず歴史として閉じる' } } });
  const { rendered } = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  assert.equal(chipText(rendered.html), null);
});
