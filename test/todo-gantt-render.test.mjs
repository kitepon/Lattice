import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { projectTodoChainV1 } from '../src/todo-chain.mjs';
import { layoutTodoGantt, TodoGanttLayoutError } from '../src/todo-gantt-layout.mjs';
import { projectTodoGanttPresentation } from '../src/todo-gantt-presentation.mjs';
import {
  renderTodoGanttHtml,
  TODO_GANTT_HTML_MAX_BYTES,
  TODO_GANTT_PROSE_MAX_BYTES,
  TodoGanttRenderError,
} from '../src/todo-gantt-html.mjs';
import { TODO_MARKDOWN_SECTION_MAX_BYTES } from '../src/todo-markdown-renderer.mjs';
import { verifyNarrativeAnchors } from '../src/todo-narrative-anchor.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
} from '../src/todo-store.mjs';
import { digestTodoArtifact } from '../src/todo-contracts.mjs';
import { renderTodoGanttForProject } from '../src/todo-cli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const NOW = '2026-07-18T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const ref = (task_id, plan_key = 'main') => ({ project_id: 'project-1', plan_key, task_id });

async function stopGanttChild(child, url) {
  if (process.platform === 'win32') {
    const response = await fetch(new URL('/__lattice/shutdown', url), { method: 'POST' });
    assert.equal(response.status, 202);
  } else {
    child.kill('SIGTERM');
  }
  return once(child, 'close');
}

function readFixture(taskCount, edges = []) {
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    task_id: `T${String(index).padStart(4, '0')}`, title: `Task ${index}`, lane: `lane-${index % 8}`,
    narrative_ref: null, compile_binding: null,
  }));
  return {
    schema: 'lattice.todo_store_read.v1', project_id: 'project-1',
    members: [{
      plan: { project_id: 'project-1', plan_key: 'main', tasks, hard_dependencies: edges, joins: [] },
      tasks: tasks.map(({ task_id }) => ({ task_id, status: 'pending', started_at: null,
        done_at: null, blocked_reason: null, evidence: null, evidence_unverified: false })),
    }],
  };
}

function topology(read) {
  return {
    nodes: read.members.flatMap(({ plan }) => plan.tasks.map(({ task_id }) => ref(task_id, plan.plan_key))),
    hard_edges: read.members.flatMap(({ plan }) => plan.hard_dependencies),
    joins: read.members.flatMap(({ plan }) => plan.joins),
  };
}

function renderFixture(read, narratives = [], anchorOutcomes = [], document = null, metadata = {}) {
  const chain = projectTodoChainV1(topology(read));
  const layout = layoutTodoGantt(read);
  const presentation = projectTodoGanttPresentation(read, document);
  return renderTodoGanttHtml({ readModel: read, layout, narratives, anchorOutcomes, presentation, metadata });
}

/** The one `<article class="task-detail...">` whose detail key ends with `taskId`. */
function detailPanelOf(html, taskId) {
  return html.split('<article class="task-detail')
    .find((chunk) => chunk.startsWith(`" data-detail-key="`)
      && chunk.slice(0, 200).includes(`&quot;${taskId}&quot;]"`)) ?? null;
}

function foldedFixture() {
  // T0000 -> T0001 -> T0002 -> T0003。T0003だけpendingなので、T0002は生きた工程の
  // 直接前提として残り、T0000とT0001が畳まれる。
  const read = readFixture(4, [
    { from: ref('T0000'), to: ref('T0001') },
    { from: ref('T0001'), to: ref('T0002') },
    { from: ref('T0002'), to: ref('T0003') },
  ]);
  read.members[0].tasks = read.members[0].tasks.map((task) => (task.task_id === 'T0003'
    ? task : { ...task, status: 'done' }));
  return read;
}

test('畳んだ工程の詳細は、畳む前の前提と後続をそのまま示す', () => {
  const html = renderFixture(foldedFixture()).html;
  const panel = detailPanelOf(html, 'T0001');
  assert.notEqual(panel, null, '畳まれた工程も詳細を持つ');
  // T0000 -> T0001 は両端が図から外れるのでedgeも消えるが、事実としては残る。
  assert.doesNotMatch(panel.slice(0, panel.indexOf('後続工程')), /登録済みの前提工程はありません/u);
  assert.match(panel, /Task 0</u);
  assert.match(panel, /Task 2</u);
});

test('図から外した工程は、代わりの箱も置かない', () => {
  const html = renderFixture(foldedFixture()).html;
  // まとめnodeを置くと、完走したplanのぶんだけ図が横に伸びる。1つも描かない。
  assert.doesNotMatch(html, /~folded/u);
  assert.doesNotMatch(html, /folded-node/u);
  assert.equal((html.match(/data-node-key=/gu) ?? []).length, 2, '残るのは生きた工程とその直接前提だけ');
  // 外したことと、その工程がどこにいるかは言葉で残す。
  assert.match(html, /完走済み 2件を非表示/u);
  assert.match(detailPanelOf(html, 'T0001'), /完走済みのため図には描いていません/u);
  assert.match(detailPanelOf(html, 'T0001'), /gantt serve --port &lt;port&gt; --scope all/u);
  assert.doesNotMatch(html, /lattice todo gantt --scope all/u);
});

test('選択ボタンは必ず開ける詳細を指す', () => {
  const html = renderFixture(foldedFixture()).html;
  const detailKeys = new Set([...html.matchAll(/data-detail-key="([^"]*)"/gu)].map(([, key]) => key));
  const selectKeys = [...html.matchAll(/data-select-node-key="([^"]*)"/gu)].map(([, key]) => key);
  const nodeKeys = [...html.matchAll(/data-node-key="([^"]*)"/gu)].map(([, key]) => key);
  assert.notEqual(selectKeys.length, 0);
  assert.notEqual(nodeKeys.length, 0);
  assert.deepEqual([...new Set(selectKeys)].filter((key) => !detailKeys.has(key)), [],
    '開ける先の無い選択ボタンを出さない');
  assert.deepEqual([...new Set(nodeKeys)].filter((key) => !detailKeys.has(key)), [],
    '図のnodeはすべてクリックで開ける');
});

test('非表示バッジを押すと外した工程も含む図へ切り替わる', () => {
  const read = foldedFixture();
  const chain = projectTodoChainV1(topology(read));
  const { html } = renderTodoGanttHtml({
    readModel: read,
    layout: layoutTodoGantt(read),
    expandedLayout: layoutTodoGantt(read, { scope: 'all' }),
    presentation: projectTodoGanttPresentation(read, null),
  });
  // 図は2枚同梱し、既定はliveだけを見せる。file://でも問い合わせ先が無いので同梱する。
  assert.match(html, /<div data-diagram="live">/u);
  assert.match(html, /<div data-diagram="expanded" hidden>/u);
  assert.match(html, /data-toggle-expanded aria-expanded="false"/u);
  assert.match(html, /完走済み 2件を非表示（押すと表示）/u);
  assert.match(html, /data-expanded-label="完走済み 2件を表示中（押すと非表示）"/u);

  const live = html.slice(html.indexOf('data-diagram="live"'), html.indexOf('data-diagram="expanded"'));
  const expanded = html.slice(html.indexOf('data-diagram="expanded"'), html.indexOf('</div></section>'));
  assert.equal((live.match(/data-node-key=/gu) ?? []).length, 2);
  assert.equal((expanded.match(/data-node-key=/gu) ?? []).length, 4, '展開図は全工程を描く');
  assert.doesNotMatch(live, /data-task-id="T0000"/u);
  assert.match(expanded, /data-task-id="T0000"/u);
  const foldedDetail = detailPanelOf(html, 'T0001');
  assert.match(foldedDetail, /このページ内で表示できます/u);
  assert.doesNotMatch(foldedDetail, /gantt serve/u,
    '展開図を同梱した動的viewerから二台目serverへ誘導しない');
});

test('外した工程が無ければ切り替えboxもbuttonも出さない', () => {
  const read = readFixture(2);
  const { html } = renderFixture(read);
  // CONTROLLER本体は属性名を含むので、凡例側のbuttonと図の枠だけを見る。
  assert.doesNotMatch(html, /class="fold-chip" data-toggle-expanded/u);
  assert.doesNotMatch(html, /<div data-diagram="expanded"/u);
  assert.match(html, /<div data-diagram="live">/u, '図の枠は常に1枚は出す');
});

test('全工程一覧は稼働中planを上、完走したplanを古い順で下へまとめる', () => {
  // live: 未着手を持つ。done-old / done-new: 全件完了で図から外れる。
  const plan = (planKey, statuses, lastActivity) => ({
    plan: {
      project_id: 'project-1', plan_key: planKey, joins: [], hard_dependencies: [],
      tasks: statuses.map((_, index) => ({ task_id: `${planKey}-${index}`, title: `${planKey} ${index}`,
        lane: 'main', narrative_ref: null, compile_binding: null })),
    },
    tasks: statuses.map((status, index) => ({ task_id: `${planKey}-${index}`, status,
      started_at: null, done_at: null, blocked_reason: null, evidence: null, evidence_unverified: false })),
    journal: { events: [{ recorded_at: lastActivity }] },
  });
  const read = {
    schema: 'lattice.todo_store_read.v1', project_id: 'project-1',
    members: [
      plan('done-old', ['done'], '2026-07-01T00:00:00.000Z'),
      plan('live', ['pending'], '2026-07-10T00:00:00.000Z'),
      plan('done-new', ['done'], '2026-07-20T00:00:00.000Z'),
    ],
  };
  const html = renderFixture(read).html;
  const index = html.slice(html.indexOf('data-right-panel="task-index"'));
  const order = [...index.matchAll(/<section class="task-index-plan"><h2><code>([^<]+)<\/code>/gu)]
    .map(([, planKey]) => planKey);
  assert.deepEqual(order, ['live', 'done-old', 'done-new']);
});

test('決着済みPhaseは概要の先頭を占領しない', () => {
  const read = readFixture(2);
  const member = read.members[0];
  member.plan.schema = 'lattice.todo_plan.v5';
  member.plan.tasks = member.plan.tasks.map((task, index) => ({
    ...task, narrative_anchor: null, parent_task_id: null, phase_id: `phase-${index + 1}`,
  }));
  member.plan.phases = [
    { phase_id: 'phase-1', title: '受理済みの重監査', gate_policy: 'heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['heavy'] },
    { phase_id: 'phase-2', title: '進行中の実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'],
      required_evidence_slots: ['heavy'] },
  ];
  member.plan.phase_accept_dependencies = [];
  member.snapshot = { phases: [
    { phase_id: 'phase-1', status: 'accepted' },
    { phase_id: 'phase-2', status: 'active' },
  ] };
  // readTodoStoreはPhase状態をmember.phasesという導出ビューでも返す(ADR 0147。
  // snapshot artifactの形式には縛られない)。renderPhaseProgress等の消費者はこちらを読む。
  member.phases = member.snapshot.phases;
  const { html } = renderFixture(read);
  const overview = html.slice(html.indexOf('data-right-panel="overview"'), html.indexOf('data-right-panel="details"'));
  assert.match(overview, /決着済みPhase 1件/u, '受理済みは畳んだ群にまとめる');
  const settledStart = overview.indexOf('<details class="phase-settled"');
  assert.ok(settledStart > 0);
  assert.doesNotMatch(overview, /<details class="phase-settled" open/u, '既定で閉じる');
  // 進行中のPhaseは畳まず、畳んだ群より前に置く。
  assert.ok(overview.indexOf('進行中の実装') < settledStart);
  assert.ok(overview.indexOf('受理済みの重監査') > settledStart);
});

test('暗黙terminal-auditをderived phaseから表示し理由と次の一歩を示す', () => {
  const read = readFixture(2);
  const member = read.members[0];
  member.plan.schema = 'lattice.todo_plan.v6';
  member.plan.plan_key = 'audit-plan';
  member.plan.tasks = member.plan.tasks.map((task) => ({ ...task, design_memo: '実装方針' }));
  member.tasks = member.tasks.map((task) => ({ ...task, status: 'done' }));
  member.phases = [{ phase_id: 'terminal-audit', status: 'gate_ready' }];
  const { html } = renderFixture(read);
  assert.match(html, /終端監査（暗黙）/u);
  assert.match(html, /全ToDoは完了していますが、終端監査がまだ受理されていません/u);
  assert.match(html, /lattice todo phase review --plan audit-plan --phase terminal-audit/u);
});

test('Phase metadataとderived stateが不一致でもderived phaseを正本に描く', () => {
  const read = readFixture(1);
  const member = read.members[0];
  member.plan.schema = 'lattice.todo_plan.v5';
  member.plan.phases = [{ phase_id: 'metadata-only', title: '古いmetadata', gate_policy: 'heavy' }];
  member.phases = [{ phase_id: 'derived-only', status: 'reviewing' }];
  const { html } = renderFixture(read);
  assert.match(html, /derived-only/u);
  assert.match(html, /終端監査を実施中です/u);
  assert.doesNotMatch(html, /古いmetadata/u);
});

test('v5 GanttはPhaseを通常ToDoのschedule gateとして説明しない', () => {
  const read = readFixture(2);
  const member = read.members[0];
  member.plan.schema = 'lattice.todo_plan.v5';
  member.plan.tasks = member.plan.tasks.map((task, index) => ({
    ...task, narrative_anchor: null, parent_task_id: null, phase_id: `phase-${index + 1}`,
  }));
  member.plan.phases = [
    { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['heavy'] },
    { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'],
      required_evidence_slots: ['heavy'] },
  ];
  member.plan.phase_accept_dependencies = [];
  member.snapshot = { phases: [
    { phase_id: 'phase-1', status: 'active' },
    { phase_id: 'phase-2', status: 'locked' },
  ] };
  member.phases = member.snapshot.phases;
  const { html } = renderFixture(read);
  assert.match(html, /Phaseは重監査の順序を表し、通常ToDoの開始順はToDo依存だけで決まります。/u);
  assert.doesNotMatch(html, /後続Phaseはまだ解放されません/u);
  const ungatedLayout = layoutTodoGantt(read);
  assert.deepEqual(ungatedLayout.nodes.filter(({ visibility }) => visibility.next_ready)
    .map(({ ref: taskRef }) => taskRef.task_id), ['T0000', 'T0001']);

  member.plan.phase_accept_dependencies = [{
    from: { project_id: 'project-1', plan_key: 'main', phase_id: 'phase-1' },
    to: ref('T0001'),
  }];
  const gatedLayout = layoutTodoGantt(read);
  assert.deepEqual(gatedLayout.nodes.filter(({ visibility }) => visibility.next_ready)
    .map(({ ref: taskRef }) => taskRef.task_id), ['T0000']);
});

async function workspace(context, title = 'T1', narrativeRef = 'narrative.md') {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-gantt-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await writeFile(path.join(root, 'narrative.md'), [
    '# Background', '', title, '', '- [ ] Follow-up', '', '[unsafe](javascript:alert(1))',
    '<svg onload=alert(2)>', '</script><script>alert(3)</script>',
    '[web](https://example.com/path)',
  ].join('\n'));
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [{ task_id: 'T1', title, lane: 'main', narrative_ref: narrativeRef, compile_binding: null }],
        hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  return root;
}

async function anchoredWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-gantt-anchor-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  const markdown = '# Plan\n- [ ] Anchored task\n';
  await writeFile(path.join(root, 'plan.md'), markdown);
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: markdown, encoding: 'utf8',
  });
  assert.equal(blob.status, 0, blob.stderr);
  const tree = spawnSync('git', ['mktree'], {
    cwd: root, input: `100644 blob ${blob.stdout.trim()}\tplan.md\n`, encoding: 'utf8',
  });
  assert.equal(tree.status, 0, tree.stderr);
  const commit = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: root,
    input: `tree ${tree.stdout.trim()}\nauthor Fixture <fixture@example.invalid> 1760000000 +0000\ncommitter Fixture <fixture@example.invalid> 1760000000 +0000\n\nfixture\n`,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stderr);
  const task = {
    task_id: 'T1', title: 'Anchored task', lane: 'main', narrative_ref: 'plan.md',
    narrative_anchor: {
      origin_plan_ref: 'plan.md', origin_line: 2, source_commit: commit.stdout.trim(),
      source_line_digest: createHash('sha256').update('- [ ] Anchored task').digest('hex'),
    },
    compile_binding: null,
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v2', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v2', predecessor_plan_digest: null, tasks: [task],
        hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  return { root, markdown };
}

async function graphWorkspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-gantt-graph-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  const tasks = [
    { task_id: 'T1', title: 'Recon', lane: 'recon', narrative_ref: null, compile_binding: null },
    { task_id: 'T2', title: 'Implement', lane: 'impl', narrative_ref: null, compile_binding: null },
    { task_id: 'T3', title: 'Verify', lane: 'verify', narrative_ref: null, compile_binding: null },
    { task_id: 'T4', title: 'Alternate', lane: 'impl', narrative_ref: null, compile_binding: null },
  ];
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }], now: NOW,
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null, tasks,
        hard_dependencies: [
          { from: ref('T1'), to: ref('T2') },
          { from: ref('T1'), to: ref('T4') },
          { from: ref('T2'), to: ref('T3') },
        ],
        joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
  });
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
}

function taskNodeY(html) {
  const positions = new Map();
  const pattern = /<g class="todo-node[^"]*"[^>]*data-task-id="([^"]+)"[^>]*><rect class="node-surface" x="[^"]+" y="([^"]+)"/gu;
  for (const match of html.matchAll(pattern)) positions.set(match[1], Number(match[2]));
  return positions;
}

test('small real store E2E renders the dynamic self-contained gantt with exact bindings', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, '.lattice', 'project.json'), `${JSON.stringify({
    schema: 'lattice.project_identity.v1', project_id: 'project-1', display_name: 'Fixture Project',
  })}\n`);
  const result = await renderTodoGanttForProject({ repoRoot: root });
  assert.equal(result.metadata.renderer_version, 'lattice.todo_gantt_renderer.v20');
  assert.match(result.rendered.html, /<title>Lattice — Fixture Project 依存工程図<\/title>/u);
  const narrativeBytes = await readFile(path.join(root, 'narrative.md'));
  assert.equal(result.metadata.narrative_bindings_digest, digestTodoArtifact([{
    project_id: 'project-1',
    plan_key: 'main',
    task_id: 'T1',
    narrative_ref: 'narrative.md',
    content_digest: createHash('sha256').update(narrativeBytes).digest('hex'),
    anchored: false,
    reason: 'anchor_missing',
  }]));
  assert.equal(JSON.stringify(result.metadata).includes('file://'), false);
  const html = result.rendered.html;
  assert.match(html, /class="todo-gantt"/u);
  assert.match(html, /data-node-key=/u);
  assert.match(html, /tabindex="0" role="button" aria-selected="false"/u);
  assert.match(html, /構造上の最長依存鎖は各工程を同じ重みとして数え、実時間・工数・資源律速を表さない/u);
  assert.match(html, /data-right-panel="task-index" hidden/u);
  assert.match(html, /class="task-index-status status-pending" role="img" aria-label="未着手">☐<\/span>/u);
  assert.match(html, /class="task-index-reference">工程 T1<\/span>/u);
  assert.doesNotMatch(html, /<h1>Background<\/h1>|class="markdown-checkbox"/u);
  assert.match(html, /"presentation_digest":"[0-9a-f]{64}"/u);
  assert.match(html, /"schema":"lattice\.todo_gantt_presentation_model\.v1"/u);
  assert.match(html, /"task_id":"T1","display_number":"1","normalized_number":"1"/u);
});

test('manual gantt serveもproject identity fileのdisplay nameを使う', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, '.lattice', 'project.json'), `${JSON.stringify({
    schema: 'lattice.project_identity.v1', project_id: 'project-1', display_name: 'Manual Fixture',
  })}\n`);
  const child = spawn(process.execPath, [CLI, 'todo', 'gantt', 'serve', '--port', '0'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  context.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '';
  while (!stdout.includes('\n')) {
    const [chunk] = await once(child.stdout, 'data');
    stdout += chunk.toString('utf8');
  }
  const live = JSON.parse(stdout.split('\n')[0]);
  assert.equal(live.schema, 'lattice.todo_gantt_live_result.v3');
  assert.equal(live.resource_scope, 'project');
  assert.equal(live.selection_scope, 'live');
  assert.deepEqual(live.included_plan_keys, ['main']);
  assert.equal(live.media_type, 'text/html; charset=utf-8');
  assert.equal(live.dynamic, true);
  const response = await fetch(live.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Lattice — Manual Fixture 依存工程図<\/title>/u);
  const [code] = await stopGanttChild(child, live.url);
  assert.equal(code, 0);
});

test('manual gantt serveもexternal_paneのタブとiframeを配信する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, '.lattice', 'project.json'), `${JSON.stringify({
    schema: 'lattice.project_identity.v1', project_id: 'project-1', display_name: 'Manual Fixture',
    external_pane: { title: '円卓', url: 'https://pane.example/room-a',
      probe_url: 'https://probe.example/api/room-a/members' },
  })}\n`);
  const child = spawn(process.execPath, [CLI, 'todo', 'gantt', 'serve', '--port', '0'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  context.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '';
  while (!stdout.includes('\n')) {
    const [chunk] = await once(child.stdout, 'data');
    stdout += chunk.toString('utf8');
  }
  const live = JSON.parse(stdout.split('\n')[0]);
  const html = await (await fetch(live.url)).text();
  assert.match(html, /connect-src 'self' https:\/\/probe\.example; frame-src https:\/\/pane\.example;/u);
  assert.match(html, /<iframe data-src="https:\/\/pane\.example\/room-a" title="円卓">/u);
  assert.ok(html.indexOf('data-show-external-pane') < html.indexOf('data-show-overview'));
  assert.equal((await stopGanttChild(child, live.url))[0], 0);
});

test('静的gantt生成とstatusは廃止済みとしてtyped拒否しartifactを作らない', async (context) => {
  const root = await workspace(context);
  for (const args of [['todo', 'gantt'], ['todo', 'gantt', 'status']]) {
    const execution = run(root, args);
    assert.equal(execution.status, 1);
    assert.equal(execution.stdout, '');
    const error = JSON.parse(execution.stderr);
    assert.equal(error.code, 'STATIC_GANTT_RETIRED');
    assert.equal(error.detail.reason, 'dynamic_dashboard_only');
    assert.equal(error.detail.next_action, 'lattice todo gantt serve --port 0');
  }
  await assert.rejects(readFile(path.join(root, '.lattice', 'generated', 'gantt.html')),
    (error) => error.code === 'ENOENT');
});

test('動的gantt serveの不正portはstatic退役と誤診断せずdashboard副作用も起こさない', async (context) => {
  const root = await workspace(context);
  const runtime = path.join(root, 'dashboard-runtime');
  for (const port of ['abc', '99999']) {
    const execution = run(root, ['todo', 'gantt', 'serve', '--port', port], {
      LATTICE_DASHBOARD_AUTOSTART: '1',
      LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
      LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1',
      LATTICE_TODO_ACTOR_AGENT: 'agent-1',
    });
    assert.equal(execution.status, 2);
    const error = JSON.parse(execution.stderr);
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.equal(error.detail.next_action, 'lattice todo gantt serve --help');
  }
  const retired = run(root, ['todo', 'gantt', 'status'], {
    LATTICE_DASHBOARD_AUTOSTART: '1', LATTICE_DASHBOARD_RUNTIME_DIR: runtime,
    LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1',
  });
  assert.equal(JSON.parse(retired.stderr).code, 'STATIC_GANTT_RETIRED');
  await assert.rejects(readFile(path.join(runtime, 'projects.json')), (error) => error.code === 'ENOENT');
});

test('Gantt narrativeはarchive line fragmentをfile pathと混同せず1行だけ読む', async (context) => {
  const root = await workspace(context, 'fragment narrative', 'narrative.md#L3');
  const result = await renderTodoGanttForProject({ repoRoot: root });
  assert.equal(result.metadata.narrative_bindings_digest, digestTodoArtifact([{
    project_id: 'project-1', plan_key: 'main', task_id: 'T1',
    narrative_ref: 'narrative.md#L3',
    content_digest: createHash('sha256').update('fragment narrative').digest('hex'),
    anchored: false, reason: 'anchor_missing',
  }]));
  const html = result.rendered.html;
  assert.match(html, /fragment narrative/u);
  assert.doesNotMatch(html, /# Background/u);
});

test('v2 anchor成立の動的ganttはoutcomeをbinding digestと行内markの両方へ一度で束縛する', async (context) => {
  const { root, markdown } = await anchoredWorkspace(context);
  const result = await renderTodoGanttForProject({ repoRoot: root });
  assert.equal(result.metadata.narrative_bindings_digest, digestTodoArtifact([{
    project_id: 'project-1', plan_key: 'main', task_id: 'T1', narrative_ref: 'plan.md',
    content_digest: createHash('sha256').update(markdown).digest('hex'), anchored: true, reason: null,
  }]));
  const html = result.rendered.html;
  assert.match(html, /class="task-index-status status-pending" role="img" aria-label="未着手">☐<\/span>/u);
  assert.doesNotMatch(html, /class="task-line"|class="narrative-warning"|class="narrative-body"/u);
});

test('real store smoke draws every edge and emits readable nodes plus named category totals', async (context) => {
  const root = await graphWorkspace(context);
  await writeFile(path.join(root, '.lattice', 'todo', 'gantt-presentation.json'), `${JSON.stringify({
    schema: 'lattice.todo_gantt_presentation.v1',
    project_id: 'project-1',
    plans: [{
      plan_key: 'main',
      lanes: [
        { lane: 'impl', name: '実装', description: '実装工程。' },
        { lane: 'recon', name: '調査', description: '調査工程。' },
        { lane: 'verify', name: '検証', description: '検証工程。' },
      ],
    }],
  })}\n`);
  const result = await renderTodoGanttForProject({ repoRoot: root });
  assert.equal(result.metadata.renderer_version, 'lattice.todo_gantt_renderer.v20');
  const html = result.rendered.html;
  assert.equal((html.match(/<g class="dependency-edge(?: |")/gu) ?? []).length, 3);
  assert.equal((html.match(/data-node-key=/gu) ?? []).length, 4);
  assert.match(html, /class="summary-plan"[^>]*aria-label="main — 4 ToDo"/u);
  assert.match(html, /class="summary-lane"[^>]*aria-label="impl — 実装、2 ToDo。実装工程。"/u);
  assert.match(html, />impl · 実装 2<\/text>/u);
  assert.ok(html.indexOf('class="summary-plan"') < html.indexOf('class="summary-lane"'));
  assert.doesNotMatch(html, /main\/(?:recon|impl|verify)/u);
  assert.doesNotMatch(html, /hidden edges|folded edges|data-fold-state|bundle-badge/u);
  assert.doesNotMatch(html, /class="node-time"|>S:|>D:|Started at|Done at/u);
  assert.doesNotMatch(html, /class="task-facts"|class="evidence"/u);
  const positions = taskNodeY(html);
  assert.ok(positions.get('T1') < positions.get('T2'));
  assert.ok(positions.get('T2') < positions.get('T3'));
  assert.match(html, /class="task-index-status status-pending"[^>]*>☐<\/span>/u);
  assert.equal((html.match(/class="task-index-status status-/gu) ?? []).length, 4);
  assert.doesNotMatch(html, /class="narrative-warning"|class="narrative-body"/u);
  assert.match(html, /\.task-index-list button\{[^}]*display:grid;width:100%/u);
  assert.match(html, /\.task-index-list strong\{[^}]*font-size:13\.5px[^}]*font-weight:600/u);
  assert.match(html, /\.task-index-plan h2\{[^}]*font-size:16px[^}]*font-weight:600/u);
  const palette = [...new Set(html.match(/#[0-9a-f]{6}/gu) ?? [])].sort();
  assert.deepEqual(palette, [
    '#0b0b0b', '#0ca30c', '#2a78d6', '#52514e', '#d03b3b', '#d9d8d4', '#f4f4f2', '#fcfcfb',
  ]);
  assert.doesNotMatch(html, /#7c3aed|drop-shadow|font-size:30px/u);
});

test('静的custom output指定も廃止済みとして一律拒否する', async (context) => {
  const root = await workspace(context);
  for (const output of ['artifacts/todo.html', '../escape.html', '/tmp/escape.html']) {
    const failure = run(root, ['todo', 'gantt', '--out', output]);
    assert.equal(failure.status, 1);
    assert.equal(JSON.parse(failure.stderr).code, 'STATIC_GANTT_RETIRED');
  }
});

// 前提が終わっているか、後続が動き出せるかは、相手の状態を見ないと判断できない。
test('前提工程・後続工程は相手の状態を4種すべて表示する', () => {
  const read = readFixture(4, [
    { from: ref('T0000'), to: ref('T0001') },
    { from: ref('T0001'), to: ref('T0002') },
    { from: ref('T0002'), to: ref('T0003') },
  ]);
  Object.assign(read.members[0].tasks[1], { status: 'in-progress', started_at: NOW });
  Object.assign(read.members[0].tasks[2], { status: 'done', done_at: NOW });
  Object.assign(read.members[0].tasks[3], { status: 'blocked', blocked_reason: '外部待ち' });
  const { html } = renderFixture(read);

  // T0001の詳細: 前提は未着手、後続は完了。
  const active = detailPanelOf(html, 'T0001');
  assert.match(active, /<span class="relation-status status-pending">☐ 未着手<\/span><strong>/u);
  assert.match(active, /<span class="relation-status status-done">✅ 完了<\/span><strong>/u);
  // T0002の詳細: 前提は作業中、後続はブロック中。
  const settled = detailPanelOf(html, 'T0002');
  assert.match(settled, /<span class="relation-status status-in-progress">▶ 作業中<\/span><strong>/u);
  assert.match(settled, /<span class="relation-status status-blocked">⛔ ブロック中<\/span><strong>/u);
  // 状態は相手ごとに引く。詳細ヘッダの自分の状態を流用しない。
  assert.doesNotMatch(active, /relation-status status-blocked/u);
});

test('right pane exposes overview/detail/current task index states while retaining navigation controls', () => {
  const read = readFixture(2, [{ from: ref('T0000'), to: ref('T0001') }]);
  for (const task of read.members[0].plan.tasks) task.narrative_ref = 'plan.md';
  Object.assign(read.members[0].tasks[1], { status: 'in-progress', started_at: NOW });
  const markdown = '# Intent\n\n- [ ] Keep the document flow\n\n## Acceptance\n\nOrdinary prose.';
  const output = renderFixture(read, read.members[0].plan.tasks.map(({ task_id }) => ({
    ref: ref(task_id), narrative_ref: 'plan.md', markdown,
  })), [], {
    schema: 'lattice.todo_gantt_presentation.v1',
    project_id: 'project-1',
    plans: [{
      plan_key: 'main',
      lanes: [
        { lane: 'lane-0', name: '調査', description: '調査工程。' },
        { lane: 'lane-1', name: '実装', description: '実装工程。' },
      ],
    }],
  });
  assert.equal((output.html.match(/class="task-index-status status-/gu) ?? []).length, 2);
  assert.equal((output.html.match(/<h1>Intent<\/h1>/gu) ?? []).length, 0);
  assert.match(output.html, /data-view-state="overview"/u);
  assert.match(output.html, /<button type="button" data-show-overview>概要<\/button>/u);
  assert.match(output.html, /<button type="button" data-show-selected hidden>選択工程へ戻る<\/button>/u);
  // boxの中身はstore由来の全工程一覧であって、元Markdown本文の再表示ではない（2026-07-19裁定）。
  assert.match(output.html, /<button type="button" data-show-task-index>全工程一覧<\/button>/u);
  assert.doesNotMatch(output.html, /元Markdown全文/u);
  assert.match(output.html, /data-right-panel="overview"/u);
  assert.match(output.html, /data-right-panel="details" hidden/u);
  assert.match(output.html, /data-right-panel="task-index" hidden/u);
  assert.equal((output.html.match(/class="task-detail" data-detail-key=/gu) ?? []).length, 2);
  assert.match(output.html, /<div class="status-summary"><span>☐ 未着手 1<\/span><span>▶ 作業中 1<\/span>/u);
  assert.match(output.html, /<strong>カテゴリ:<\/strong> lane-0 — 調査/u);
  assert.match(output.html, /class="category-description">調査工程。<\/p>/u);
  assert.match(output.html, /<h2>前提工程<\/h2>/u);
  assert.match(output.html, /<h2>後続工程<\/h2>/u);
  assert.match(output.html, /data-select-node-key="\[&quot;project-1&quot;,&quot;main&quot;,&quot;T0001&quot;\]"/u);
  assert.match(output.html, /const detailPanels=\[\.\.\.root\.querySelectorAll\('\[data-detail-key\]'\)\]/u);
  assert.match(output.html, /const showOverview=\(\)=>/u);
  assert.match(output.html, /const showTaskIndex=\(\)=>/u);
  assert.match(output.html, /const showSelected=\(\)=>/u);
  assert.match(output.html, /selectedReturnButton\.hidden=name!=='task-index'\|\|selectedKey===null/u);
  assert.match(output.html, /edge\.classList\.toggle\('selected-incident-edge',selected&&\(edge\.dataset\.fromNodeKey===selectedKey\|\|edge\.dataset\.toNodeKey===selectedKey\)\)/u);
  assert.match(output.html, /event\.key==='Enter'\|\|event\.key===' '/u);
  assert.match(output.html, /event\.key==='Escape'/u);
  assert.match(output.html, /const selectButton=event\.target\.closest\('\[data-select-node-key\]'\)/u);
  assert.equal((output.html.match(/root\.addEventListener\('click'/gu) ?? []).length, 1);
  assert.equal((output.html.match(/root\.addEventListener\('keydown'/gu) ?? []).length, 1);
  assert.match(output.html, /class="diagram-scroll" data-diagram-scroll tabindex="0"/u);
  assert.match(output.html, /data-zoom-action="reset">等倍<\/button>/u);
  assert.match(output.html, /data-zoom-action="fit">全体表示/u);
  assert.match(output.html, /zoom<1&&zoom\*1\.25>=1\?1:zoom\*1\.25/u);
  assert.match(output.html, /zoom>1&&zoom\/1\.25<=1\?1:zoom\/1\.25/u);
  assert.match(output.html, /scroller\.scrollTo\(0,0\)/u);
  assert.match(output.html, /\.diagram-scroll\{[^}]*max-width:calc\(100% - 16px\);margin:8px;overflow:auto[^}]*border:1px solid rgba\(217,216,212,\.5\)/u);
  assert.match(output.html, /grid-template-columns:minmax\(0,var\(--split,58%\)\) auto minmax\(24rem,1fr\)/u);
  assert.match(output.html, /<div class="pane-divider" data-pane-divider aria-hidden="true"><\/div>/u);
  assert.match(output.html, /\.pane-divider\{width:8px;cursor:col-resize;background:rgba\(217,216,212,\.5\);touch-action:none\}/u);
  assert.match(output.html, /@media\(max-width:900px\)\{body\{display:block;height:auto\}\.shell\{display:block\}\.pane-divider\{display:none\}/u);
  assert.match(output.html, /root\.addEventListener\('pointerdown'/u);
  assert.match(output.html, /root\.addEventListener\('pointermove'/u);
  assert.match(output.html, /root\.addEventListener\('pointerup'/u);
  assert.match(output.html, /paneDivider\.setPointerCapture\(event\.pointerId\)/u);
  assert.match(output.html, /Math\.max\(30,Math\.min\(75,/u);
  assert.match(output.html, /shell\.style\.setProperty\('--split',percent\+'%'\)/u);
  assert.match(output.html, /root\.addEventListener\('dblclick',event=>\{const paneDivider=[^}]+shell\.style\.setProperty\('--split','58%'\)/u);
  assert.match(output.html, /data-right-panel="task-index" hidden><h1>全工程<\/h1>/u);
  assert.match(output.html, /<section class="task-index-plan"><h2><code>main<\/code><\/h2><ol class="task-index-list">/u);
  assert.match(output.html, /class="task-index-reference">工程 T0000<\/span><strong>Task 0<\/strong>/u);
  assert.match(output.html, /class="task-index-reference">工程 T0001<\/span><strong>Task 1<\/strong>/u);
  assert.ok(output.html.indexOf('<strong>Task 0</strong>') < output.html.indexOf('<strong>Task 1</strong>'));
  assert.doesNotMatch(output.html, /Keep the document flow|<h2>Acceptance<\/h2>|class="markdown-checkbox"/u);
  assert.match(output.html, /\.next-ready-node \.node-surface\{stroke:var\(--accent\);stroke-width:2;stroke-dasharray:4 3\}/u);
  assert.match(output.html, /data-task-id="T0000" data-task-number="0000" data-task-number-normalized="0"/u);
  assert.match(output.html, /aria-label="工程T0000。未着手。lane-0、調査。Task 0。正規ID main\/T0000。ready frontierの同時dispatch候補"/u);
  assert.match(output.html, /class="node-meta"[^>]*>未着手 · 工程 T0000<\/text>/u);
  assert.match(output.html, /<tspan[^>]*class="node-title-line">Task 0<\/tspan>/u);
  assert.match(output.html, /\.dependency-edge \.edge-arrow\{fill:var\(--text-secondary\);opacity:\.7\}/u);
  assert.match(output.html, /data-from-node-key="\[&quot;project-1&quot;,&quot;main&quot;,&quot;T0000&quot;\]"/u);
  assert.match(output.html, /data-to-node-key="\[&quot;project-1&quot;,&quot;main&quot;,&quot;T0001&quot;\]"/u);
  assert.match(output.html, /class="summary-lane" data-lane-key="\[&quot;main&quot;,&quot;lane-0&quot;\]" role="button" tabindex="0" aria-pressed="false"/u);
  assert.match(output.html, /data-node-key="[^"]+" data-lane-key="\[&quot;main&quot;,&quot;lane-0&quot;\]"/u);
  assert.match(output.html, /\.lane-dimmed\{opacity:\.35\}/u);
  assert.doesNotMatch(output.html, /\.summary-lane:focus\{/u);
  assert.doesNotMatch(output.html, /\.summary-lane:focus-visible\{/u);
  assert.doesNotMatch(output.html, /\.summary-lane\[aria-pressed="true"\] \.summary-chip/u);
  assert.match(output.html, /const toggleLane=\(key\)=>applyLane\(activeLaneKey===key\?null:key\)/u);
  assert.match(output.html, /edge\.dataset\.fromLaneKey!==key&&edge\.dataset\.toLaneKey!==key/u);
  assert.doesNotMatch(output.html, /<p class="notice">/u);
  assert.match(output.html, /<title>Lattice — project-1 依存工程図<\/title>/u);
  assert.match(output.html, /class="project-heading">project-1 依存工程図<\/strong>/u);
  assert.match(output.html, /縦方向は時間ではなく、登録済み依存関係による工程段階/u);
  assert.match(output.html, /class="diagram-legend"[^>]*aria-label="工程図の凡例"/u);
  assert.match(output.html, /class="status-symbol status-in-progress"[^>]*>▶<\/span> 作業中/u);
  assert.match(output.html, /☐ 未着手/u);
  assert.match(output.html, /破線枠: ready frontier/u);
  // 独立性の記録が無いplanでは、従来どおりADR 0063の既定をそのまま述べる。
  assert.match(output.html, /ready frontierは全件同時dispatchが既定/u);
  // 図の凡例は記録がある時だけ独立性の記号を説明する。
  assert.doesNotMatch(output.html, /∥ 独立検証済|⛓ 要直列|\? 未検査/u);
  // 一方で各ToDoの詳細は黙らない。記録が無い状態こそ「未検査」と言う対象である。
  assert.match(output.html, /<strong>並列可否:<\/strong> 未検査です。競合が無いのではなく、まだ判定していません。このplanには独立性の記録がまだありません。/u);
  assert.match(output.html, /lattice todo independence compile --plan main --input &lt;ref&gt;/u);
  assert.doesNotMatch(output.html, /独立検証済です|要直列です/u);
  assert.match(output.html, /太線: 構造上の最長依存鎖/u);
  assert.match(output.html, /半円: 非接触の線交差/u);
  assert.match(output.html, /黒丸: 論理上の合流/u);
  assert.match(output.html, /body\{display:grid;grid-template-rows:minmax\(0,1fr\)/u);
  assert.doesNotMatch(output.html, /data-show-all|data-view-state="all"|data-view-state="selected"/u);
  assert.doesNotMatch(output.html, /class="task-facts"|class="evidence"/u);
  assert.equal(output.html.includes('innerHTML'), false);
  assert.doesNotMatch(output.html, /\son[a-z]+\s*=/iu);
});

test('project display name is preserved exactly in the visible heading and browser title', () => {
  const read = readFixture(1);
  const html = renderFixture(read, [], [], null, { project_display_name: 'AIShell' }).html;
  assert.match(html, /<title>Lattice — AIShell 依存工程図<\/title>/u);
  assert.match(html, /class="project-heading">AIShell 依存工程図<\/strong>/u);
  assert.doesNotMatch(html, /Aishell/u);
});

test('geometric crossings render a semicircle bridge without a logical junction dot', () => {
  const T0 = ref('T0000'); const T1 = ref('T0001'); const T2 = ref('T0002');
  const read = readFixture(3, [{ from: T0, to: T1 }, { from: T0, to: T2 }]);
  read.members[0].plan.tasks[1].lane = 'z-lane';
  read.members[0].plan.tasks[2].lane = 'a-lane';
  const html = renderFixture(read).html;
  assert.match(html, /class="edge-route" d="[^"]* A 5 5 /u);
  assert.doesNotMatch(html, /class="join-marker"/u);
  assert.equal((html.match(/class="edge-arrow"/gu) ?? []).length, 2);
});

test('overlapping logical joins render one distinct black dot per fully-qualified join', () => {
  const T0 = ref('T0000'); const T1 = ref('T0001'); const T2 = ref('T0002'); const T3 = ref('T0003');
  const read = readFixture(4);
  read.members[0].plan.joins = [
    { id: 'j1', after: [T0, T1], before: T3 },
    { id: 'j2', after: [T0, T2], before: T3 },
  ];
  const html = renderFixture(read).html;
  const markers = [...html.matchAll(/<g class="join-marker"[^>]*><circle cx="([^"]+)" cy="([^"]+)"/gu)];
  assert.equal(markers.length, 2);
  assert.equal(new Set(markers.map((match) => `${match[1]},${match[2]}`)).size, 2);
  assert.equal((html.match(/data-from-node-key="\[&quot;project-1&quot;,&quot;main&quot;,&quot;T0000&quot;\]"/gu) ?? []).length, 2);
});

test('全工程一覧はanchor成否に依存せずstoreの現在状態と全文タイトルを登録順で表示する', () => {
  const read = readFixture(3);
  const markdown = '# Plan\n- [ ] pending task\n- [ ] blocked task\n- [ ] drifted task';
  const lineDigest = (line) => createHash('sha256').update(line).digest('hex');
  for (const [index, task] of read.members[0].plan.tasks.entries()) {
    task.narrative_ref = 'plan.md';
    task.narrative_anchor = {
      origin_plan_ref: 'plan.md',
      origin_line: index + 2,
      source_commit: '1'.repeat(40),
      source_line_digest: lineDigest(index === 2 ? '- [ ] stale task' : markdown.split('\n')[index + 1]),
    };
  }
  Object.assign(read.members[0].tasks[1], { status: 'blocked', blocked_reason: null });
  const narratives = read.members[0].plan.tasks.map(({ task_id }) => ({
    ref: ref(task_id), narrative_ref: 'plan.md', markdown,
  }));
  const outcomes = verifyNarrativeAnchors({ readModel: read, narratives });
  const html = renderFixture(read, narratives, outcomes).html;

  assert.equal((html.match(/class="task-index-status status-/gu) ?? []).length, 3);
  assert.match(html, /class="task-index-status status-pending"[^>]*>☐<\/span><span class="task-index-reference">工程 T0000<\/span><strong>Task 0<\/strong>/u);
  assert.match(html, /class="task-index-status status-blocked"[^>]*>⛔<\/span><span class="task-index-reference">工程 T0001<\/span><strong>Task 1<\/strong><span class="task-index-blocked-reason">— 理由未記録<\/span>/u);
  assert.match(html, /class="task-index-reference">工程 T0002<\/span><strong>Task 2<\/strong>/u);
  assert.ok(html.indexOf('<strong>Task 0</strong>') < html.indexOf('<strong>Task 1</strong>'));
  assert.ok(html.indexOf('<strong>Task 1</strong>') < html.indexOf('<strong>Task 2</strong>'));
  assert.doesNotMatch(html, /pending task|blocked task|drifted task|class="anchor-diagnostics"|class="narrative-body"/u);
});

test('SVG renders readable status nodes, every edge, join marker, and hierarchical summary without timestamps', () => {
  const T0 = ref('T0000'); const T1 = ref('T0001'); const T2 = ref('T0002');
  const read = readFixture(4, [{ from: T0, to: T1 }]);
  read.members[0].plan.joins = [{ id: 'join-all', after: [T0, T1], before: T2 }];
  Object.assign(read.members[0].tasks[0], { status: 'done', started_at: NOW, done_at: NOW });
  Object.assign(read.members[0].tasks[1], { status: 'in-progress', started_at: NOW });
  Object.assign(read.members[0].tasks[2], { status: 'blocked', blocked_reason: 'Waiting for owner' });
  const html = renderFixture(read).html;
  assert.match(html, /class="todo-node status-done longest-chain-node/u);
  assert.match(html, /class="todo-node status-in-progress longest-chain-node active-node/u);
  assert.match(html, /class="todo-node status-blocked longest-chain-node/u);
  assert.match(html, /class="status-mark"[^>]*>☐<\/text>/u);
  assert.match(html, /class="status-mark"[^>]*>▶<\/text>/u);
  assert.match(html, /class="status-mark"[^>]*>✅<\/text>/u);
  assert.match(html, /class="status-mark"[^>]*>⛔<\/text>/u);
  assert.match(html, /class="dependency-edge longest-chain-edge/u);
  assert.equal((html.match(/<g class="dependency-edge(?: |")/gu) ?? []).length, 3);
  assert.match(html, /class="join-marker" aria-label="join join-all"/u);
  assert.equal((html.match(/class="join-marker"/gu) ?? []).length, 1);
  assert.match(html, /class="join-marker"[^>]*><circle[^>]*r="4"><\/circle>/u);
  assert.doesNotMatch(html, /class="join-marker"[^>]*><polygon/u);
  assert.match(html, /class="todo-summary" aria-label="カテゴリ別ToDo集計表"/u);
  assert.match(html, /class="summary-plan"[^>]*><rect[^>]*class="summary-chip plan-chip"/u);
  assert.match(html, /class="summary-lane"/u);
  assert.match(html, /class="summary-plan-group"[^>]*><rect class="summary-container"/u);
  assert.doesNotMatch(html, /class="summary-connector"/u);
  assert.match(html, /class="status-bar"/u);
  assert.match(html, /class="task-index-blocked-reason">— Waiting for owner<\/span>/u);
  assert.doesNotMatch(html, /main\/lane-/u);
  assert.doesNotMatch(html, /hidden edges|folded edges|data-fold-state|bundle-badge/u);
  assert.doesNotMatch(html, /class="node-time"|S:07-18|D:07-18|Started at|Done at/u);
  assert.doesNotMatch(html, /class="task-facts"|class="evidence"/u);
});

test('XSS through narrative and task title is inert in the final document', async (context) => {
  const payload = '</script><script>globalThis.pwned=1</script><svg onload=alert(1)>';
  const root = await workspace(context, payload);
  const { rendered: { html } } = await renderTodoGanttForProject({ repoRoot: root });
  assert.equal(html.includes('<script>globalThis.pwned=1</script>'), false);
  assert.equal(html.includes('<svg onload='), false);
  assert.equal(html.includes('javascript:'), false);
  assert.equal(html.includes('href="https://example.com'), false);
  assert.match(html, /&lt;\/script&gt;&lt;script&gt;globalThis\.pwned=1/u);
});

test('task/edge scale limit accepts 2,000/8,000 and rejects N+1', { timeout: 15_000 }, () => {
  const edges = [];
  for (let distance = 1; edges.length < 8_001; distance += 1) {
    for (let from = 0; from + distance < 2_000 && edges.length < 8_001; from += 1) {
      edges.push({ from: ref(`T${String(from).padStart(4, '0')}`),
        to: ref(`T${String(from + distance).padStart(4, '0')}`) });
    }
  }
  const atLimit = readFixture(2_000, edges.slice(0, 8_000));
  const rendered = renderFixture(atLimit);
  assert.equal((rendered.html.match(/<g class="dependency-edge(?: |")/gu) ?? []).length, 8_000);
  assert.ok(rendered.html_bytes > 0 && rendered.html_bytes <= TODO_GANTT_HTML_MAX_BYTES);
  assert.throws(() => layoutTodoGantt(readFixture(2_001)),
    (error) => error instanceof TodoGanttLayoutError && error.code === 'TODO_SCALE_EXCEEDED');
  const overEdges = readFixture(2_000, edges);
  assert.throws(() => layoutTodoGantt(overEdges),
    (error) => error instanceof TodoGanttLayoutError && error.code === 'TODO_SCALE_EXCEEDED'
      && error.detail.edge_count === 8_001);
});

test('aggregate prose limit accepts N-1/N and rejects N+1', { timeout: 15_000 }, () => {
  const read = readFixture(33);
  const oneSection = 'a'.repeat(TODO_MARKDOWN_SECTION_MAX_BYTES);
  const narrativeFor = (sizes) => sizes.map((size, index) => ({
    ref: ref(`T${String(index).padStart(4, '0')}`), markdown: 'a'.repeat(size),
  }));
  const base = Array.from({ length: 32 }, () => TODO_MARKDOWN_SECTION_MAX_BYTES);
  const below = [...base]; below[31] -= 1;
  assert.equal(renderFixture(read, narrativeFor(below)).prose_bytes, TODO_GANTT_PROSE_MAX_BYTES - 1);
  assert.equal(renderFixture(read, narrativeFor(base)).prose_bytes, TODO_GANTT_PROSE_MAX_BYTES);
  assert.throws(() => renderFixture(read, narrativeFor([...base, 1])),
    (error) => error instanceof TodoGanttRenderError && error.code === 'TODO_SCALE_EXCEEDED'
      && error.detail.prose_bytes === TODO_GANTT_PROSE_MAX_BYTES + 1);
  assert.equal(oneSection.length, TODO_MARKDOWN_SECTION_MAX_BYTES);
});

test('design_memoもaggregate prose limitへ計上する', { timeout: 15_000 }, () => {
  const read = readFixture(33);
  const section = 'a'.repeat(TODO_MARKDOWN_SECTION_MAX_BYTES);
  read.members[0].plan.tasks = read.members[0].plan.tasks.map((task, index) => (
    index < 32 ? { ...task, design_memo: section } : task
  ));
  assert.equal(renderFixture(read).prose_bytes, TODO_GANTT_PROSE_MAX_BYTES);
  read.members[0].plan.tasks[32].design_memo = 'a';
  assert.throws(() => renderFixture(read),
    (error) => error instanceof TodoGanttRenderError && error.code === 'TODO_SCALE_EXCEEDED'
      && error.detail.prose_bytes === TODO_GANTT_PROSE_MAX_BYTES + 1);
});

test('a successor of a retired, never-done task is not drawn ready (the drawing uses Lattice readiness)', () => {
  // T0000 -> T0001. T0000 was retired without finishing; Lattice readiness never counts a
  // retired predecessor as done, so T0001 must not be marked next-ready even though the
  // retired task and its edge are hidden from the drawing.
  const read = readFixture(2, [{ from: ref('T0000'), to: ref('T0001') }]);
  read.members[0].tasks[0].status = 'retired';
  const layout = layoutTodoGantt(read);
  assert.deepEqual(layout.nodes.filter(({ visibility }) => visibility.next_ready)
    .map(({ ref: taskRef }) => taskRef.task_id), []);
  read.members[0].tasks[0].status = 'done';
  assert.deepEqual(layoutTodoGantt(read).nodes.filter(({ visibility }) => visibility.next_ready)
    .map(({ ref: taskRef }) => taskRef.task_id), ['T0001']);
});
