import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
   createTodoStoreWriter, initializeTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import { renderTodoGanttForProject } from '../src/todo-cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

const task = (taskId, lane) => ({ task_id: taskId, title: taskId, lane,
  narrative_ref: null, compile_binding: null });
const ref = (taskId) => ({ project_id: 'project-1', plan_key: 'main', task_id: taskId });

const run = (root, args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: 'utf8' });

/**
 * A store with one finished branch (F) that no live work depends on, plus a
 * live chain (T1 -> T2). Only F is foldable.
 */
async function foldableWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-scope-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('F', 'done-lane'), task('T1', 'live'), task('T2', 'live')],
        hard_dependencies: [{ from: ref('T1'), to: ref('T2') }], joins: [] },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  const bytes = Buffer.from('finished branch evidence\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'],
    { cwd: root, input: bytes, encoding: 'utf8' }).trim();
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'start', task_id: 'F', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } } });
  await appendTodoEvent({ repoRoot: root, writer, planKey: 'main', now: NOW,
    event: { kind: 'done', task_id: 'F', actor: ACTOR, recorded_at: NOW,
      payload: { evidence: { evidence_id: 'finished', repo_id: 'self', path: 'evidence.txt',
        git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
        media_type: 'text/plain', anchor_digest: null } } } });
  return root;
}

test('動的rendererの既定scopeは完走した枝を畳み、allは全件描く', async (context) => {
  const root = await foldableWorkspace(context);

  const live = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });
  const all = await renderTodoGanttForProject({ repoRoot: root, scope: 'all' });
  assert.equal(live.metadata.folded_task_count, 1);
  assert.equal(all.metadata.folded_task_count, 0);
  const liveHtml = live.rendered.html;
  const allHtml = all.rendered.html;
  // 既定で見えている図はFを描かず、全件の図は描く。生きた工程はどちらにも出る。
  const shownDiagram = (html) => html.slice(html.indexOf('<div data-diagram="live">'),
    html.indexOf('<div data-diagram="expanded"') === -1
      ? html.indexOf('</div></section>') : html.indexOf('<div data-diagram="expanded"'));
  assert.doesNotMatch(shownDiagram(liveHtml), /data-task-id="F"/u);
  assert.match(shownDiagram(allHtml), /data-task-id="F"/u);
  for (const html of [liveHtml, allHtml]) {
    assert.match(shownDiagram(html), /data-task-id="T1"/u);
    assert.match(shownDiagram(html), /data-task-id="T2"/u);
    // seam proposal artifactが無くても生成でき、「提案なし」ではなく未生成guidanceを出す。
    assert.match(html, /seam_proposal_unrecorded/u);
    assert.match(html, /このplanのseam提案はまだ生成していない/u);
    assert.match(html, /compile_seam_proposal/u);
  }
  // 畳んだ図は展開図を同梱し、そこにはFが描かれている。
  assert.match(liveHtml, /<div data-diagram="expanded" hidden>/u);
  assert.doesNotMatch(allHtml, /<div data-diagram="expanded"/u);
  // 外していることと戻し方が図の上で読める。
  assert.match(liveHtml, /完走済み 1件を非表示/u);
  assert.match(liveHtml, /完走済み 1件を非表示（押すと表示）/u);
  assert.doesNotMatch(liveHtml, /--scope all/u);
  // 総数は畳み込み前のまま。
  assert.match(liveHtml, /aria-label="main — 3 ToDo"/u);
  // 一覧からは消さず、畳んだ群としてまとめる。
  assert.match(liveHtml, /完走済みとして畳んだ工程 1件/u);
});

test('図から外した工程も、生成物の上で一覧から開ける', async (context) => {
  const root = await foldableWorkspace(context);
  const { rendered: { html } } = await renderTodoGanttForProject({ repoRoot: root, scope: 'live' });

  const detailKeys = new Set([...html.matchAll(/data-detail-key="([^"]*)"/gu)].map(([, key]) => key));
  const selectKeys = [...html.matchAll(/data-select-node-key="([^"]*)"/gu)].map(([, key]) => key);
  const nodeKeys = [...html.matchAll(/data-node-key="([^"]*)"/gu)].map(([, key]) => key);
  assert.notEqual(selectKeys.length, 0);
  assert.deepEqual([...new Set(selectKeys)].filter((key) => !detailKeys.has(key)), [],
    '開ける先の無い選択ボタンを出さない');
  assert.deepEqual([...new Set(nodeKeys)].filter((key) => !detailKeys.has(key)), [],
    '図のnodeはすべてクリックで開ける');
  // 図に代わりの箱は立てない。
  assert.doesNotMatch(html, /~folded/u);
});

test('静的gantt生成とstatusはtypedに廃止し動的dashboardを案内する', async (context) => {
  const root = await foldableWorkspace(context);
  for (const args of [
    ['todo', 'gantt'],
    ['todo', 'gantt', '--out', 'docs/gantt.html'],
    ['todo', 'gantt', 'status'],
  ]) {
    const result = run(root, args);
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.code, 'STATIC_GANTT_RETIRED');
    assert.equal(failure.detail.next_action, 'lattice todo gantt serve --port 0');
  }
});
