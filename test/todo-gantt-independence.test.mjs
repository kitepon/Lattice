import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TODO_GANTT_INDEPENDENCE_PRESENTATION,
  renderTodoGanttSvg,
} from '../src/todo-gantt-svg.mjs';
import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { renderTodoGanttHtml } from '../src/todo-gantt-html.mjs';
import { projectTodoGanttPresentation } from '../src/todo-gantt-presentation.mjs';
import { selectSeamProposalGuidance } from '../src/todo-independence-guidance.mjs';

// ADR 0129。独立性はカード内のバッジと色で示し、寸法と配線には触れない。
// 記録が語らないtaskへはバッジを出さない（未検査と検証済みを同じ顔にしない）。

const PROJECT = 'project-1';
const PLAN = 'main';

const ref = (taskId) => ({ project_id: PROJECT, plan_key: PLAN, task_id: taskId });

const task = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null,
  narrative_anchor: null, compile_binding: null, parent_task_id: null,
});

function readModel(taskIds) {
  return {
    schema: 'lattice.todo_store_read.v1',
    project_id: PROJECT,
    members: [{
      descriptor: { plan_key: PLAN },
      plan: {
        schema: 'lattice.todo_plan.v3',
        project_id: PROJECT,
        plan_key: PLAN,
        plan_version: 'v1',
        tasks: taskIds.map(task),
        hard_dependencies: [],
        joins: [],
      },
      tasks: taskIds.map((taskId) => ({ task_id: taskId, status: 'pending' })),
      snapshot: { phases: [] },
      journal: { events: [] },
    }],
  };
}

const chain = { schema: 'lattice.todo_chain.v1', longest_chain_node_refs: [], longest_chain_edges: [] };

const projectionFor = (frontier) => [{
  project_id: PROJECT, plan_key: PLAN, coverage: 'verified', frontier,
}];

function htmlInput(layout) {
  const read = readModel(layout.nodes.map(({ ref: nodeRef }) => nodeRef.task_id));
  return {
    readModel: read,
    layout,
    narratives: [],
    anchorOutcomes: [],
    presentation: projectTodoGanttPresentation(read, null),
    metadata: {},
  };
}

function layoutWith(taskIds, frontier) {
  return layoutTodoGantt(readModel(taskIds), {
    scope: 'all', independence: projectionFor(frontier),
  });
}

const seamProjection = ({
  planKey = PLAN, coverage = 'verified', components = [], componentCount = components.length,
} = {}) => ({
  project_id: PROJECT,
  plan_key: planKey,
  coverage,
  guidance: selectSeamProposalGuidance({ coverage }),
  component_count: coverage === 'missing' ? null : componentCount,
  conflict_resource_count: coverage === 'missing' ? null : components
    .reduce((total, component) => total + component.conflicts.length, 0),
  components,
});

const unknownSeamComponent = {
  component_id: 'component-1',
  verdict: 'unknown_requires_evidence',
  task_ids: ['A', 'B'],
  conflicts: [{
    resource_id: 'own-path-deadbeef',
    kind: 'path',
    target: 'src/todo-gantt-html.mjs',
    task_pairs: [['A', 'B']],
  }],
  proposed_surfaces: [],
  affected_tests: [],
  limits: [],
  reasons: [],
  unknowns: [{ kind: 'semantic_owner_binding_missing', ref: 'B' }],
};

test('独立性はnode projectionへ状態として載る', () => {
  const layout = layoutWith(['A', 'B', 'C', 'D'], {
    parallel_groups: [{ task_ids: ['A', 'B'] }],
    serialize_pairs: [{
      task_ids: ['C', 'D'], type: 'conflict', detail: 'own-path-1',
      kind: 'path', severability: 'code_seam',
    }],
    conflicts_with_active: [],
    unknown: [],
  });

  const stateOf = (taskId) => layout.nodes
    .find((node) => node.ref.task_id === taskId).visibility.independence;
  assert.equal(stateOf('A'), 'verified');
  assert.equal(stateOf('B'), 'verified');
  assert.equal(stateOf('C'), 'conflict');
  assert.equal(stateOf('D'), 'conflict');
  assert.equal(layout.schema, 'lattice.todo_gantt_layout.v2');
});

test('記録が語らないtaskはnullのまま残る', () => {
  const layout = layoutWith(['A', 'B'], {
    parallel_groups: [{ task_ids: ['A'] }],
    serialize_pairs: [],
    conflicts_with_active: [],
    unknown: [],
  });
  assert.equal(layout.nodes.find((node) => node.ref.task_id === 'B').visibility.independence, null);
});

test('独立性の記録が無いplanはnull summaryのまま描ける', () => {
  const layout = layoutTodoGantt(readModel(['A']), { scope: 'all' });
  assert.equal(layout.independence, null);
  assert.equal(layout.nodes[0].visibility.independence, null);
});

test('図に無いtaskを指す投影は印を付けず、通知で露見させる', () => {
  const layout = layoutWith(['A'], {
    parallel_groups: [{ task_ids: ['A', 'ghost'] }],
    serialize_pairs: [],
    conflicts_with_active: [],
    unknown: [],
  });
  assert.equal(layout.nodes.find((node) => node.ref.task_id === 'A').visibility.independence, 'verified');
  assert.equal(layout.notices.length, 1);
  assert.equal(layout.notices[0].code, 'TODO_LAYOUT_INDEPENDENCE_DRIFT');
  assert.deepEqual(layout.notices[0].detail.drifted_tasks, [{ plan_key: PLAN, task_id: 'ghost' }]);
});

test('進行中との競合もconflictとしてカードへ出る', () => {
  const layout = layoutWith(['A', 'B'], {
    parallel_groups: [],
    serialize_pairs: [],
    conflicts_with_active: [{
      ready_task_id: 'A', active_task_id: 'B', type: 'conflict',
      detail: 'own-path-1', kind: 'path', severability: 'code_seam',
    }],
    unknown: [{ task_id: 'B', unknowns: [{ kind: 'witness_missing', ref: 'x' }] }],
  });
  assert.equal(layout.nodes.find((node) => node.ref.task_id === 'A').visibility.independence,
    'conflict');
  assert.equal(layout.nodes.find((node) => node.ref.task_id === 'B').visibility.independence,
    'unknown');
});

test('右ペインは記録がある時だけ全件同時dispatchの断定をやめる', () => {
  const plain = renderTodoGanttHtml(htmlInput(layoutTodoGantt(readModel(['A', 'B']), { scope: 'all' })));
  // 記録が無いplanでは従来どおりADR 0063の既定を述べる。
  assert.match(plain.html, /ready frontierは全件同時dispatchが既定/u);

  const marked = renderTodoGanttHtml(htmlInput(layoutWith(['A', 'B', 'C'], {
    parallel_groups: [{ task_ids: ['A'] }],
    serialize_pairs: [{
      task_ids: ['B', 'C'], type: 'conflict', detail: 'own-path-1',
      kind: 'path', severability: 'code_seam',
    }],
    conflicts_with_active: [],
    unknown: [],
  })));
  assert.doesNotMatch(marked.html, /ready frontierは全件同時dispatchが既定/u);
  assert.match(marked.html, /検証済み並列 1工程/u);
  assert.match(marked.html, /要直列 1組/u);
  // 切断可能性を言葉で示し、相手の資源も出す。
  assert.match(marked.html, /コードの分割で並列化しうる/u);
  assert.match(marked.html, /∥ 独立検証済/u);
});

test('未検査は「競合が無い」と書かない', () => {
  const output = renderTodoGanttHtml(htmlInput(layoutWith(['A'], {
    parallel_groups: [],
    serialize_pairs: [],
    conflicts_with_active: [],
    unknown: [{ task_id: 'A', unknowns: [{ kind: 'witness_missing', ref: 'x' }] }],
  })));
  assert.match(output.html, /未検査です。競合が無いのではなく、まだ判定していません/u);
  assert.match(output.html, /未検査 1工程/u);
});

test('seam提案はexact資源・ToDo組・verdict・typed unknownを先頭で示す', () => {
  const read = readModel(['A', 'B']);
  const layout = layoutTodoGantt(read, {
    scope: 'all',
    seamProposals: [
      seamProjection({ coverage: 'missing', planKey: 'legacy-plan' }),
      seamProjection({ components: [unknownSeamComponent] }),
    ],
  });
  const output = renderTodoGanttHtml({
    readModel: read,
    layout,
    narratives: [],
    anchorOutcomes: [],
    presentation: projectTodoGanttPresentation(read, null),
    metadata: {},
  });

  assert.equal(layout.seam_proposals.plans[0].plan_key, PLAN,
    'componentがあるplanを未生成planより先に置く');
  assert.equal('resource_id' in layout.seam_proposals.plans[0].components[0].conflicts[0], false,
    'hash identityはhuman-facing layoutへ持ち込まない');
  assert.match(output.html, /src\/todo-gantt-html\.mjs/u);
  assert.match(output.html, /<code>A<\/code><span aria-hidden="true"> ↔ <\/span><code>B<\/code>/u);
  assert.match(output.html, /unknown_requires_evidence/u);
  assert.match(output.html, /semantic_owner_binding_missing/u);
  assert.match(output.html, /ToDo <code>B<\/code>/u);
  assert.doesNotMatch(output.html, /own-path-deadbeef/u);
  assert.ok(output.html.indexOf('src/todo-gantt-html.mjs')
    < output.html.indexOf('seam_proposal_unrecorded'));
});

test('component 0件と未生成はguidance正本のcode・message・next_actionで区別する', () => {
  const read = readModel(['A']);
  const verified = seamProjection();
  const missing = seamProjection({ coverage: 'missing', planKey: 'legacy-plan' });
  const layout = layoutTodoGantt(read, {
    scope: 'all', seamProposals: [verified, missing],
  });
  const output = renderTodoGanttHtml({
    readModel: read,
    layout,
    narratives: [],
    anchorOutcomes: [],
    presentation: projectTodoGanttPresentation(read, null),
    metadata: {},
  });

  assert.match(output.html, new RegExp(verified.guidance.code, 'u'));
  assert.match(output.html, new RegExp(verified.guidance.message, 'u'));
  assert.match(output.html, new RegExp(missing.guidance.code, 'u'));
  assert.match(output.html, new RegExp(missing.guidance.message, 'u'));
  assert.match(output.html, new RegExp(missing.guidance.next_action, 'u'));
  // seam guidanceは未検査を「競合なし」と言い換えない。個別ToDoの並列可否は
  // 詳細パネル側の担当なので、ここでは概要パネルだけを見る。
  assert.doesNotMatch(output.html.split('<article class="task-detail')[0], /競合が無い/u);
});

test('SVGはバッジ記号とクラスを描き、カード寸法を変えない', () => {
  const plain = layoutTodoGantt(readModel(['A', 'B']), { scope: 'all' });
  const marked = layoutWith(['A', 'B'], {
    parallel_groups: [{ task_ids: ['A'] }],
    serialize_pairs: [],
    conflicts_with_active: [],
    unknown: [{ task_id: 'B', unknowns: [{ kind: 'witness_missing', ref: 'x' }] }],
  });

  // 寸法が同じであることがADR 0068の配線規約へ影響しない根拠になる。
  assert.deepEqual(marked.nodes.map(({ geometry }) => geometry),
    plain.nodes.map(({ geometry }) => geometry));
  assert.deepEqual(marked.bounds, plain.bounds);

  const svg = renderTodoGanttSvg(marked, { lanes: new Map(), taskNumbers: new Map() });
  assert.match(svg, /class="independence-badge"/u);
  assert.ok(svg.includes(TODO_GANTT_INDEPENDENCE_PRESENTATION.verified.label));
  assert.ok(svg.includes(TODO_GANTT_INDEPENDENCE_PRESENTATION.unknown.label));
  assert.match(svg, /independence-verified/u);
  assert.match(svg, /independence-unknown/u);
  // 記録の無い図にはバッジを出さない。
  const plainSvg = renderTodoGanttSvg(plain, { lanes: new Map(), taskNumbers: new Map() });
  assert.equal(plainSvg.includes('independence-badge'), false);
});

/** 詳細パネルは工程ごとに1つ。task_idで切り出さないと他工程の文言を拾う。 */
function detailPanelOf(html, taskId) {
  return html.split('<article class="task-detail')
    .find((chunk) => chunk.startsWith('" data-detail-key="')
      && chunk.slice(0, 200).includes(`&quot;${taskId}&quot;]"`)) ?? null;
}

// 作業中の工程はready frontierに居ないため、conflictの相手側としてしか現れない。
// 枠ごと消すと「競合なし」と読まれるので、着手済の側からも並列可否を述べる。
test('作業中の工程は自分が塞いでいる着手候補を並列可否として述べる', () => {
  const read = readModel(['A', 'B']);
  Object.assign(read.members[0].tasks[0], { status: 'in-progress' });
  const layout = layoutTodoGantt(read, {
    scope: 'all',
    independence: projectionFor({
      parallel_groups: [],
      serialize_pairs: [],
      conflicts_with_active: [{
        ready_task_id: 'B', active_task_id: 'A', type: 'conflict',
        detail: 'src/shared.mjs', kind: 'path', severability: 'code_seam',
      }],
      unknown: [],
    }),
  });
  const { html } = renderTodoGanttHtml({
    readModel: read, layout, narratives: [], anchorOutcomes: [],
    presentation: projectTodoGanttPresentation(read, null), metadata: {},
  });

  const active = detailPanelOf(html, 'A');
  assert.match(active, /この工程が作業中のあいだ、次の着手候補は同時に始められません/u);
  assert.match(active, /<li>B — .*（資源 src\/shared\.mjs）<\/li>/u);
  // ready側は従来どおり要直列として相手を挙げる。
  const ready = detailPanelOf(html, 'B');
  assert.match(ready, /<strong>並列可否:<\/strong> 要直列です。/u);
  assert.match(ready, /<li>A（作業中） — /u);
});

// 記録が無い状態こそ最も警告が要る。黙って枠を消すと「競合なし」と読まれる。
test('記録が無い工程は状態別に未検査または判定前だと述べる', () => {
  const read = readModel(['A', 'B', 'C']);
  Object.assign(read.members[0].tasks[0], { status: 'in-progress' });
  Object.assign(read.members[0].tasks[2], { status: 'done', done_at: '2026-08-01T00:00:00.000Z' });
  const { html } = renderTodoGanttHtml({
    readModel: read, layout: layoutTodoGantt(read, { scope: 'all' }),
    narratives: [], anchorOutcomes: [],
    presentation: projectTodoGanttPresentation(read, null), metadata: {},
  });

  for (const taskId of ['A', 'B']) {
    assert.match(detailPanelOf(html, taskId),
      /<strong>並列可否:<\/strong> 未検査です。競合が無いのではなく、まだ判定していません。このplanには独立性の記録がまだありません。/u);
    assert.match(detailPanelOf(html, taskId),
      /lattice todo independence compile --plan main --input &lt;ref&gt;/u);
  }
  // 完了した工程は同時着手の判断材料ではない。ここだけは黙ってよい。
  assert.doesNotMatch(detailPanelOf(html, 'C'), /並列可否/u);
});
