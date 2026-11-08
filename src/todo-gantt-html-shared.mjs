import { renderTodoGanttSvg, TODO_GANTT_STATUS_PRESENTATION } from './todo-gantt-svg.mjs';
import { isDecoupledPhaseTodoPlanSchema } from './todo-store-view.mjs';

export const DOCUMENT_STATUS = TODO_GANTT_STATUS_PRESENTATION;

export function statusMarkup(status, suffix = '') {
  const value = DOCUMENT_STATUS[status] ?? { mark: '?', label: '状態不明' };
  return `<span class="status-symbol status-${escapeHtmlAttribute(status)}" role="img" aria-label="${escapeHtmlAttribute(value.label)}">${escapeHtmlText(value.mark)}</span>${suffix}`;
}

export function escapeHtmlAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;').replace(/[\u0000-\u001f\u007f]/gu, '');
}

export function escapeHtmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function refKey(ref) {
  return JSON.stringify([ref.project_id, ref.plan_key, ref.task_id]);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keys of the ToDos the diagram does not draw, empty when nothing was folded. */
export function foldIndex(layout) {
  return new Set((layout?.folded ?? []).map((ref) => refKey(ref)));
}

export function renderTaskIndexEntry(section, lookup) {
  const key = refKey(section.ref);
  const status = DOCUMENT_STATUS[section.state.status] ?? { mark: '?', label: '状態不明' };
  const blockedReason = section.state.status === 'blocked'
    ? `<span class="task-index-blocked-reason">— ${escapeHtmlText(section.state.blocked_reason ?? '理由未記録')}</span>` : '';
  // A ToDo the diagram does not draw keeps its row here — the index is the
  // complete list — and it selects its own detail, which exists either way.
  const selectKey = key;
  return `<li><button type="button" data-select-node-key="${escapeHtmlAttribute(selectKey)}"><span class="task-index-status status-${escapeHtmlAttribute(section.state.status)}" role="img" aria-label="${escapeHtmlAttribute(status.label)}">${escapeHtmlText(status.mark)}</span><span class="task-index-reference">${escapeHtmlText(taskReference(section, lookup))}</span><strong>${escapeHtmlText(section.task.title)}</strong>${blockedReason}</button></li>`;
}

/** plan_key -> 最終活動時刻。journalの末尾eventが、そのplanが最後に動いた時点。 */
export function planActivity(readModel) {
  return new Map((readModel?.members ?? []).map((member) => {
    const events = member.journal?.events ?? [];
    const last = events.at(-1)?.recorded_at ?? events[0]?.recorded_at ?? '';
    return [member.plan.plan_key, last];
  }));
}

export function renderTaskIndex(sections, lookup, folds = new Set(), activity = new Map()) {
  const byPlan = new Map();
  for (const section of sections) {
    if (!byPlan.has(section.ref.plan_key)) byPlan.set(section.ref.plan_key, []);
    byPlan.get(section.ref.plan_key).push(section);
  }
  // 全ToDoが図から外れたplanは終わった仕事。読む側が先に見たいのは動いているplanなので、
  // 動いているものを最終活動の新しい順で上へ、終わったものを古い順で下へまとめる。
  // plan内のToDo順は登録順のまま触らない。
  const plans = [...byPlan.entries()].map(([planKey, tasks]) => ({
    planKey,
    tasks,
    settled: tasks.every((section) => folds.has(refKey(section.ref))),
    lastActivity: activity.get(planKey) ?? '',
  }));
  plans.sort((left, right) => {
    if (left.settled !== right.settled) return left.settled ? 1 : -1;
    const order = left.settled
      ? compareText(left.lastActivity, right.lastActivity)
      : compareText(right.lastActivity, left.lastActivity);
    return order !== 0 ? order : compareText(left.planKey, right.planKey);
  });
  return plans.map((plan) => {
    const drawn = plan.tasks.filter((section) => !folds.has(refKey(section.ref)));
    const folded = plan.tasks.filter((section) => folds.has(refKey(section.ref)));
    const drawnList = drawn.length === 0 ? ''
      : `<ol class="task-index-list">${drawn.map((section) => renderTaskIndexEntry(section, lookup)).join('')}</ol>`;
    const foldedList = folded.length === 0 ? ''
      : `<details class="task-index-folded"><summary>完走済みとして畳んだ工程 ${folded.length}件</summary><ol class="task-index-list">${folded.map((section) => renderTaskIndexEntry(section, lookup)).join('')}</ol></details>`;
    return `<section class="task-index-plan"><h2><code>${escapeHtmlText(plan.planKey)}</code></h2>${drawnList}${foldedList}</section>`;
  }).join('');
}

export function presentationLookup(presentation) {
  return {
    lanes: new Map((presentation?.lanes ?? []).map((lane) => [JSON.stringify([lane.plan_key, lane.lane]), lane])),
    taskNumbers: new Map((presentation?.task_numbers ?? []).map((entry) => [refKey(entry), entry])),
  };
}

export function taskReference(section, lookup) {
  return `工程 ${section.task.task_id}`;
}

export function renderRelationList(relations, sectionByKey, lookup, emptyText, folds = new Set()) {
  if (relations.length === 0) return `<p class="relation-empty">${escapeHtmlText(emptyText)}</p>`;
  return `<ul class="relation-list">${relations.map((relation) => {
    const targetKey = refKey(relation.ref);
    const target = sectionByKey.get(targetKey);
    if (target === undefined) return '';
    const join = relation.joinIds.length === 0 ? ''
      : `<span class="relation-kind">合流条件: ${escapeHtmlText(relation.joinIds.join(', '))}</span>`;
    // Say which ones the diagram does not draw, so the reader stops looking.
    const reference = folds.has(targetKey)
      ? `${taskReference(target, lookup)}（図では非表示）` : taskReference(target, lookup);
    // 前提が終わっているか、後続が動き出せるかは、相手の状態を見ないと判断できない。
    const status = DOCUMENT_STATUS[target.state.status] ?? { mark: '?', label: '状態不明' };
    const badge = `<span class="relation-status status-${escapeHtmlAttribute(target.state.status)}">${escapeHtmlText(`${status.mark} ${status.label}`)}</span>`;
    return `<li><button type="button" data-select-node-key="${escapeHtmlAttribute(targetKey)}"><span class="relation-head">${badge}<strong>${escapeHtmlText(reference)}</strong></span><span>${escapeHtmlText(target.task.title)}</span></button>${join}</li>`;
  }).join('')}</ul>`;
}

/** Phase states that are over: nothing is dispatched or judged under them again. */
export const SETTLED_PHASE_STATUS = Object.freeze(['accepted', 'closed_unaudited']);

function phaseGuidance(planKey, phase) {
  if (phase.status === 'gate_ready') return {
    reason: '全ToDoは完了していますが、終端監査がまだ受理されていません。',
    next: `lattice todo phase review --plan ${planKey} --phase ${phase.phase_id} --reason <text>`,
  };
  if (phase.status === 'reviewing') return {
    reason: '終端監査を実施中です。受理または棄却の判断がまだ記録されていません。',
    next: `lattice todo phase accept --plan ${planKey} --phase ${phase.phase_id} --input <file>`,
  };
  if (phase.status === 'rejected') return {
    reason: '終端監査で棄却され、修正または再監査が必要です。',
    next: `lattice todo phase reopen --plan ${planKey} --phase ${phase.phase_id} --reason <text>`,
  };
  return null;
}

export function renderPhaseProgress(readModel) {
  const rows = [];
  const settledRows = [];
  for (const member of readModel.members) {
    // snapshot artifactの形式には縛られない導出ビュー(member.phases)を正本にする(ADR 0147)。
    // plan.phasesは表示metadataだけを補い、暗黙terminal-auditやmetadata欠落を落とさない。
    const metadata = new Map((member.plan.phases ?? []).map((phase) => [phase.phase_id, phase]));
    for (const state of member.phases ?? []) {
      const phase = metadata.get(state.phase_id) ?? {
        phase_id: state.phase_id,
        title: state.phase_id === 'terminal-audit' ? '終端監査（暗黙）' : state.phase_id,
        gate_policy: 'heavy',
      };
      const tasks = metadata.has(state.phase_id)
        ? member.plan.tasks.filter((task) => task.phase_id === state.phase_id)
        : member.plan.tasks;
      const states = new Map(member.tasks.map((task) => [task.task_id, task.status]));
      const done = tasks.filter((task) => states.get(task.task_id) === 'done').length;
      const guidance = phaseGuidance(member.plan.plan_key, state);
      const guidanceMarkup = guidance === null ? ''
        : `<p><strong>状態の意味:</strong> ${escapeHtmlText(guidance.reason)}</p><p><strong>次の一歩:</strong> <code>${escapeHtmlText(guidance.next)}</code></p>`;
      const row = `<li class="phase-progress status-${escapeHtmlAttribute(state.status)}"><header><strong>${escapeHtmlText(phase.title ?? phase.phase_id)}</strong><span>${escapeHtmlText(state.status)}</span></header><p><code>${escapeHtmlText(`${member.plan.plan_key}/${phase.phase_id}`)}</code> — policy <code>${escapeHtmlText(phase.gate_policy)}</code> — ToDo ${done}/${tasks.length}</p>${guidanceMarkup}<progress max="${tasks.length}" value="${done}">${done}/${tasks.length}</progress></li>`;
      // A settled Phase is history. It stays reachable, but it does not push the
      // live ones off the first screen.
      (SETTLED_PHASE_STATUS.includes(state.status) ? settledRows : rows).push(row);
    }
  }
  const decoupled = readModel.members.some(({ plan }) => (
    isDecoupledPhaseTodoPlanSchema(plan.schema)
  ));
  const guidance = decoupled
    ? 'ToDo完了とPhase受理は別です。Phaseは重監査の順序を表し、通常ToDoの開始順はToDo依存だけで決まります。'
    : 'ToDo完了とPhase受理は別です。<code>gate_ready</code>では後続Phaseはまだ解放されません。';
  if (rows.length === 0 && settledRows.length === 0) return '';
  const liveList = rows.length === 0
    ? '<p class="readiness-note">進行中のPhaseはありません。</p>'
    : `<ol>${rows.join('')}</ol>`;
  const settledList = settledRows.length === 0 ? ''
    : `<details class="phase-settled"><summary>決着済みPhase ${settledRows.length}件</summary><ol>${settledRows.join('')}</ol></details>`;
  return `<section class="phase-overview"><h2>Phase進捗</h2><p>${guidance}</p>${liveList}${settledList}</section>`;
}

export const SEVERABILITY_LABEL = Object.freeze({
  code_seam: 'コードの分割で並列化しうる',
  serial: '共有状態のため直列必須',
});

export function renderSeamComponent(component) {
  const conflicts = component.conflicts.map((conflict) => {
    const pairs = conflict.task_pairs
      .map(([left, right]) => `<span class="seam-task-pair"><code>${escapeHtmlText(left)}</code><span aria-hidden="true"> ↔ </span><code>${escapeHtmlText(right)}</code></span>`)
      .join('');
    return `<li class="seam-conflict"><strong class="seam-target">${escapeHtmlText(conflict.target)}</strong><span class="seam-conflict-kind"><code>${escapeHtmlText(conflict.kind)}</code></span><span class="seam-pairs">${pairs}</span></li>`;
  }).join('');
  const unknowns = component.unknowns.length === 0 ? '' : `<section class="seam-evidence-needed"><h4>次に必要な証拠</h4><ul>${component.unknowns.map((unknown) => {
    const reference = component.task_ids.includes(unknown.ref)
      ? `ToDo <code>${escapeHtmlText(unknown.ref)}</code>`
      : `ref <code>${escapeHtmlText(unknown.ref)}</code>`;
    return `<li><code>${escapeHtmlText(unknown.kind)}</code><span>${reference}</span></li>`;
  }).join('')}</ul></section>`;
  const reasons = component.reasons.length === 0 ? '' : `<section class="seam-reasons"><h4>判定理由</h4><ul>${component.reasons.map((reason) => `<li><code>${escapeHtmlText(reason.code)}</code><span>${escapeHtmlText(reason.detail)}</span></li>`).join('')}</ul></section>`;
  const proposed = component.proposed_surfaces.length === 0 ? '' : `<section class="seam-surfaces"><h4>提案する所有境界</h4><ul>${component.proposed_surfaces.map((surface) => `<li><strong>${escapeHtmlText(surface.target)}</strong><span><code>${escapeHtmlText(surface.kind)}</code> / <code>${escapeHtmlText(surface.role)}</code> / owner ${surface.owner_task_ids.map((taskId) => `<code>${escapeHtmlText(taskId)}</code>`).join(', ') || '—'}</span></li>`).join('')}</ul></section>`;
  const affectedTests = component.affected_tests.length === 0 ? ''
    : `<p class="seam-tests"><strong>影響test:</strong> ${component.affected_tests.map((testRef) => `<code>${escapeHtmlText(testRef)}</code>`).join(', ')}</p>`;
  return `<article class="seam-component verdict-${escapeHtmlAttribute(component.verdict)}"><header><span>Seam判定</span><code>${escapeHtmlText(component.verdict)}</code></header><ul class="seam-conflicts">${conflicts}</ul>${unknowns}${reasons}${proposed}${affectedTests}</article>`;
}

export function renderSeamPlan(plan, { compact = false } = {}) {
  const components = plan.components.map(renderSeamComponent).join('');
  const count = plan.component_count === null ? '—' : String(plan.component_count);
  const nextAction = plan.guidance.next_action === 'none' ? ''
    : `<p class="seam-next-action"><strong>次の一歩:</strong> <code>${escapeHtmlText(plan.guidance.next_action)}</code></p>`;
  return `<section class="seam-plan${compact ? ' seam-plan-compact' : ''}" data-seam-plan="${escapeHtmlAttribute(plan.plan_key)}"><header><code>${escapeHtmlText(plan.plan_key)}</code><span class="seam-coverage coverage-${escapeHtmlAttribute(plan.coverage)}">${escapeHtmlText(plan.guidance.code)}</span><span class="seam-component-count">component ${escapeHtmlText(count)}件</span></header><p class="seam-guidance">${escapeHtmlText(plan.guidance.message)}</p>${nextAction}${components}</section>`;
}

/**
 * componentがあるplanを先に展開し、0件planはcoverageごとに畳む。
 * 実データのunknownと係争資源を、未生成planの列より先に視認できるようにする。
 */
export function renderSeamProposalOverview(layout) {
  const plans = layout.seam_proposals?.plans;
  if (!Array.isArray(plans)) return '';
  const withComponents = plans.filter((plan) => plan.components.length > 0);
  const emptyByGuidance = new Map();
  for (const plan of plans.filter((entry) => entry.components.length === 0)) {
    if (!emptyByGuidance.has(plan.guidance.code)) emptyByGuidance.set(plan.guidance.code, []);
    emptyByGuidance.get(plan.guidance.code).push(plan);
  }
  const decisions = withComponents.map((plan) => renderSeamPlan(plan)).join('');
  const emptyGroups = [...emptyByGuidance.entries()].sort(([left], [right]) => compareText(left, right))
    .map(([code, grouped]) => `<details class="seam-empty-group"><summary><code>${escapeHtmlText(code)}</code><span>${grouped.length} plan</span></summary>${grouped.map((plan) => renderSeamPlan(plan, { compact: true })).join('')}</details>`)
    .join('');
  return `<section class="seam-overview"><h2>Seam提案</h2>${decisions}${emptyGroups}</section>`;
}
