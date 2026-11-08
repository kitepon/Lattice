import { createHash } from 'node:crypto';

import { auditPendingPhasesOf } from './todo-audit-pending.mjs';
import { serializeJsonForScript } from './todo-markdown-renderer.mjs';
import { renderTodoGanttSvg, TODO_GANTT_STATUS_PRESENTATION } from './todo-gantt-svg.mjs';
import { renderDiagramLegend, renderRightPane } from './todo-gantt-html-independence.mjs';
import { escapeHtmlAttribute, escapeHtmlText, refKey } from './todo-gantt-html-shared.mjs';
import { CSS, NESTED_CSS } from './todo-gantt-html-style.mjs';
import { TODO_STRUCTURE_PRESENTATION_SCHEMA } from './todo-structure-presentation.mjs';

export const TODO_GANTT_RENDERER_VERSION = 'lattice.todo_gantt_renderer.v20';
export const TODO_GANTT_PROSE_MAX_BYTES = 8 * 1024 * 1024;
export const TODO_GANTT_HTML_MAX_BYTES = 24 * 1024 * 1024;

function projectDisplayName(readModel, metadata) {
  for (const candidate of [metadata?.project_display_name, metadata?.project_name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return readModel.project_id;
}

/**
 * 監査待ちPhaseをヘッダへ出す(ADR 0147／0148)。
 *
 * CLIのstdoutは1行のversioned JSONというADR 0049の公理があり、人が読むテキスト面が無い。
 * 人が実際に見るのはこの図とdashboard(同じHTMLを配信する)なので、監査待ちはここへ出す。
 * 全taskがdoneでも監査が済んでいなければ工程は閉じていない——図が「全部緑」に見えるのに
 * ヘッダが無言なら、読み手は完了したと読む。
 *
 * 判断の着いたPhase(accepted／closed_unaudited)しか無ければ、この札は出ない。
 *
 * **出す文字列を有界にする。** ツールバーはpane幅で制約されていないので、長い札は縮まずに
 * 行を押し広げ、ズーム操作を画面外へ追い出す(2026-08-08に実測)。CSSの`text-overflow`は
 * ここでは発動しないため、頼れない。全plan名を並べる代わりに先頭1件＋残件数だけを出し、
 * 全文は`title`に残す。件数(`監査待ち N件`)は常に見える——省略するのは内訳であって、
 * 監査待ちの存在そのものではない。
 */
function renderAuditPendingChip(readModel) {
  const pending = auditPendingPhasesOf(readModel);
  if (pending.length === 0) return '';
  const label = ({ plan_key: planKey, phase_id: phaseId, status }) => `${planKey}/${phaseId} (${status})`;
  // 残件数は書かない——先頭の`N件`が既に全体を数えており、「ほかM件」はその引き算でしかない。
  // 幅は有限なので、同じことを二度言う分だけplan名が削れる。
  const text = `監査待ち ${pending.length}件: ${label(pending[0])}`;
  const full = `監査待ち ${pending.length}件: ${pending.map(label).join(' · ')}`;
  return `<span class="audit-pending-chip" title="${escapeHtmlAttribute(full)}">${escapeHtmlText(text)}</span>`;
}

export class TodoGanttRenderError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TodoGanttRenderError';
    this.code = code;
    this.detail = detail;
  }
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Sections carry one row per ToDo, plus the prose accounting for the narratives
 * behind them.
 *
 * The right pane shows the store, not the Markdown: per the 2026-07-19 ruling
 * the "全工程" list is the plan rendered from the ToDo store, and the original
 * documents are reached through each ToDo's source reference. The narratives are
 * still read, because anchor verification needs them, and their size is still
 * bounded — but they are not rendered into the page.
 */
function normalizeSections(readModel, narratives, anchorOutcomes, noteContexts) {
  const supplied = new Map(narratives.map((entry) => [refKey(entry.ref), entry]));
  const outcomes = new Map(anchorOutcomes.map((entry) => [refKey(entry.ref), entry]));
  const notes = noteContexts === null ? null : new Map(noteContexts.map((entry) => [
    refKey({ project_id: entry.project_id, plan_key: entry.plan_key, task_id: entry.task_id }), entry,
  ]));
  const result = [];
  const counted = new Set();
  let proseBytes = 0;
  for (const member of readModel.members) {
    const states = new Map(member.tasks.map((state) => [state.task_id, state]));
    for (const task of member.plan.tasks) {
      // retired（恒久除去）は図にも詳細パネルにも出さない。履歴と理由はsnapshot/journalが持つ。
      if (states.get(task.task_id)?.status === 'retired') continue;
      const ref = { project_id: member.plan.project_id, plan_key: member.plan.plan_key, task_id: task.task_id };
      const narrative = supplied.get(refKey(ref));
      const markdown = narrative?.markdown ?? '';
      const narrativeRef = narrative?.narrative_ref ?? task.narrative_ref;
      // 終了条件（u12）も設計メモと同じ埋め込み散文として数える。
      for (const prose of [task.design_memo, task.done_condition]) {
        if (typeof prose !== 'string') continue;
        proseBytes += Buffer.byteLength(prose, 'utf8');
        if (proseBytes > TODO_GANTT_PROSE_MAX_BYTES) {
          throw new TodoGanttRenderError('TODO_SCALE_EXCEEDED', 'todo gantt embedded prose limit exceeded', {
            prose_bytes: proseBytes, prose_limit: TODO_GANTT_PROSE_MAX_BYTES,
          });
        }
      }
      // ToDos that share one narrative document count its bytes once.
      const documentKey = narrativeRef === null
        ? refKey(ref) : JSON.stringify([member.plan.plan_key, narrativeRef, digest(markdown)]);
      if (!counted.has(documentKey)) {
        counted.add(documentKey);
        proseBytes += Buffer.byteLength(markdown, 'utf8');
        if (proseBytes > TODO_GANTT_PROSE_MAX_BYTES) {
          throw new TodoGanttRenderError('TODO_SCALE_EXCEEDED', 'todo gantt embedded prose limit exceeded', {
            prose_bytes: proseBytes, prose_limit: TODO_GANTT_PROSE_MAX_BYTES,
          });
        }
      }
      const anchorOutcome = outcomes.get(refKey(ref)) ?? {
        ref, narrative_ref: narrativeRef, anchored: false, reason: 'anchor_missing',
        origin_line: task.narrative_anchor?.origin_line ?? null,
      };
      const noteContext = notes?.get(refKey(ref)) ?? null;
      if (noteContext !== null) {
        proseBytes += noteContext.notes.reduce((bytes, note) => (
          bytes + Buffer.byteLength(note.body, 'utf8')
        ), 0);
        if (proseBytes > TODO_GANTT_PROSE_MAX_BYTES) {
          throw new TodoGanttRenderError('TODO_SCALE_EXCEEDED', 'todo gantt embedded prose limit exceeded', {
            prose_bytes: proseBytes, prose_limit: TODO_GANTT_PROSE_MAX_BYTES,
          });
        }
      }
      result.push({
        ref, task, state: states.get(task.task_id), narrativeRef, anchorOutcome, noteContext,
      });
    }
  }
  return { sections: result, proseBytes };
}

const CONTROLLER = `
(()=>{
  const root=document.querySelector('[data-gantt-root]');if(!root)return;
  const shell=root.querySelector('.shell');
  const divider=root.querySelector('[data-pane-divider]');
  const overviewPanel=root.querySelector('[data-right-panel="overview"]');
  const detailsPanel=root.querySelector('[data-right-panel="details"]');
  const taskIndexPanel=root.querySelector('[data-right-panel="task-index"]');
  const structurePanel=root.querySelector('[data-right-panel="structure"]');
  const selectedReturnButton=root.querySelector('[data-show-selected]');
  const detailPanels=[...root.querySelectorAll('[data-detail-key]')];
  const nodes=[...root.querySelectorAll('[data-node-key]')];
  const edges=[...root.querySelectorAll('[data-edge-id]')];
  const laneChips=[...root.querySelectorAll('.summary-lane[data-lane-key]')];
  const diagrams=[...root.querySelectorAll('[data-diagram]')];
  const expandToggle=root.querySelector('[data-toggle-expanded]');
  const toggleLabel=root.querySelector('[data-toggle-label]');
  const scroller=root.querySelector('[data-diagram-scroll]');
  const zoomOutput=root.querySelector('[data-zoom-output]');
  let svg=root.querySelector('[data-diagram]:not([hidden]) [data-gantt-svg]')??root.querySelector('[data-gantt-svg]');
  let baseWidth=Number(svg?.dataset.svgWidth??0);
  let baseHeight=Number(svg?.dataset.svgHeight??0);
  let zoom=1;let activeLaneKey=null;let selectedKey=null;let resizePointerId=null;let expanded=false;
  const stacked=()=>window.matchMedia('(max-width:900px)').matches;
  const setSplit=(clientX)=>{if(!shell||stacked())return;const bounds=shell.getBoundingClientRect();if(bounds.width<=0)return;const percent=Math.max(30,Math.min(75,(clientX-bounds.left)/bounds.width*100));shell.style.setProperty('--split',percent+'%');};
  const finishResize=(event)=>{if(event.pointerId!==resizePointerId)return;if(divider?.hasPointerCapture(event.pointerId))divider.releasePointerCapture(event.pointerId);resizePointerId=null;};
  const setZoom=(value,minimum=.2)=>{if(!svg||!Number.isFinite(value)||value<=0)return;zoom=Math.max(minimum,Math.min(2,value));svg.setAttribute('width',String(Math.max(1,Math.round(baseWidth*zoom))));svg.setAttribute('height',String(Math.max(1,Math.round(baseHeight*zoom))));if(zoomOutput){const percent=zoom>=.1?String(Math.round(zoom*100)):String(Number((zoom*100).toFixed(1)));zoomOutput.textContent=percent+'%';}};
  const applyLane=(key)=>{activeLaneKey=key;for(const chip of laneChips)chip.setAttribute('aria-pressed',String(chip.dataset.laneKey===key));for(const node of nodes)node.classList.toggle('lane-dimmed',key!==null&&node.dataset.laneKey!==key);for(const edge of edges)edge.classList.toggle('lane-dimmed',key!==null&&edge.dataset.fromLaneKey!==key&&edge.dataset.toLaneKey!==key);};
  const toggleLane=(key)=>applyLane(activeLaneKey===key?null:key);
  // Both diagrams ship in the page; the badge picks which one is on screen.
  const setExpanded=(next)=>{if(diagrams.length<2)return;expanded=next;for(const diagram of diagrams)diagram.hidden=(diagram.dataset.diagram==='expanded')!==expanded;svg=diagrams.find(diagram=>!diagram.hidden)?.querySelector('[data-gantt-svg]')??svg;baseWidth=Number(svg?.dataset.svgWidth??0);baseHeight=Number(svg?.dataset.svgHeight??0);if(expandToggle){expandToggle.setAttribute('aria-expanded',String(expanded));}if(toggleLabel){toggleLabel.textContent=expanded?toggleLabel.dataset.expandedLabel:toggleLabel.dataset.collapsedLabel;}setZoom(zoom);applyLane(activeLaneKey);syncSelection();scroller?.scrollTo(0,0);};
  const showPanel=(name)=>{if(overviewPanel)overviewPanel.hidden=name!=='overview';if(detailsPanel)detailsPanel.hidden=name!=='details';if(taskIndexPanel)taskIndexPanel.hidden=name!=='task-index';if(structurePanel)structurePanel.hidden=name!=='structure';if(selectedReturnButton)selectedReturnButton.hidden=name!=='task-index'||selectedKey===null;root.dataset.viewState=name;};
  const syncSelection=()=>{for(const detail of detailPanels)detail.hidden=detail.dataset.detailKey!==selectedKey;for(const node of nodes){const selected=node.dataset.nodeKey===selectedKey;node.setAttribute('aria-selected',String(selected));node.classList.toggle('selected-node',selected);}for(const edge of edges){const selected=selectedKey!==null;edge.classList.toggle('selected-incident-edge',selected&&(edge.dataset.fromNodeKey===selectedKey||edge.dataset.toNodeKey===selectedKey));}};
  const showOverview=()=>{selectedKey=null;syncSelection();showPanel('overview');};
  const showTaskIndex=()=>showPanel('task-index');
  const showSelected=()=>{if(selectedKey===null){showOverview();return;}const target=detailPanels.find(detail=>detail.dataset.detailKey===selectedKey);showPanel('details');target?.scrollIntoView({block:'start'});};
  const select=(key)=>{const target=detailPanels.find(detail=>detail.dataset.detailKey===key);if(!target)return;selectedKey=key;syncSelection();showPanel('details');target.scrollIntoView({block:'start'});};
  root.addEventListener('click',event=>{
    const overviewButton=event.target.closest('[data-show-overview]');if(overviewButton&&root.contains(overviewButton)){showOverview();return;}
    const selectedButton=event.target.closest('[data-show-selected]');if(selectedButton&&root.contains(selectedButton)){showSelected();return;}
    const taskIndexButton=event.target.closest('[data-show-task-index]');if(taskIndexButton&&root.contains(taskIndexButton)){showTaskIndex();return;}
    const structureButton=event.target.closest('[data-show-structure]');if(structureButton&&root.contains(structureButton)){showPanel('structure');return;}
    const structureTarget=event.target.closest('[data-structure-target-id]');if(structureTarget&&root.contains(structureTarget)){const target=document.getElementById(structureTarget.dataset.structureTargetId);if(target&&root.contains(target)){for(const item of root.querySelectorAll('.structure-node.focused,.structure-edge-list li.focused'))item.classList.remove('focused');target.classList.add('focused');target.scrollIntoView({block:'center'});}return;}
    const expandButton=event.target.closest('[data-toggle-expanded]');if(expandButton&&root.contains(expandButton)){setExpanded(!expanded);return;}
    const selectButton=event.target.closest('[data-select-node-key]');if(selectButton&&root.contains(selectButton)){select(selectButton.dataset.selectNodeKey);return;}
    const zoomButton=event.target.closest('[data-zoom-action]');if(zoomButton&&root.contains(zoomButton)){const action=zoomButton.dataset.zoomAction;if(action==='in')setZoom(zoom<1&&zoom*1.25>=1?1:zoom*1.25,.001);else if(action==='out')setZoom(zoom>1&&zoom/1.25<=1?1:zoom/1.25,.001);else if(action==='reset')setZoom(1);else if(action==='fit'&&scroller){setZoom(Math.min(1,(scroller.clientWidth-16)/baseWidth),.001);scroller.scrollTo(0,0);}return;}
    const laneChip=event.target.closest('.summary-lane[data-lane-key]');if(laneChip&&root.contains(laneChip)){toggleLane(laneChip.dataset.laneKey);return;}
    const node=event.target.closest('[data-node-key]');if(node&&root.contains(node))select(node.dataset.nodeKey);
  });
  root.addEventListener('dblclick',event=>{const paneDivider=event.target.closest('[data-pane-divider]');if(paneDivider&&root.contains(paneDivider)&&shell&&!stacked())shell.style.setProperty('--split','58%');});
  root.addEventListener('pointerdown',event=>{const paneDivider=event.target.closest('[data-pane-divider]');if(!paneDivider||!root.contains(paneDivider)||stacked())return;resizePointerId=event.pointerId;paneDivider.setPointerCapture(event.pointerId);setSplit(event.clientX);event.preventDefault();});
  root.addEventListener('pointermove',event=>{if(event.pointerId===resizePointerId)setSplit(event.clientX);});
  root.addEventListener('pointerup',finishResize);root.addEventListener('pointercancel',finishResize);
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();showOverview();applyLane(null);return;}const laneChip=event.target.closest('.summary-lane[data-lane-key]');if(laneChip&&(event.key==='Enter'||event.key===' ')){event.preventDefault();toggleLane(laneChip.dataset.laneKey);return;}const node=event.target.closest('[data-node-key]');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select(node.dataset.nodeKey);}});
  // 記録時刻はUTCで埋まっている。閲覧者の地域とlocaleを知っているのはブラウザだけなので、
  // ここで現地時刻へ直す。scriptが動かなければ埋め込んだUTCがそのまま読める。
  for(const stamp of root.querySelectorAll('time[data-utc-stamp]')){
    const parsed=new Date(stamp.getAttribute('datetime'));
    if(!Number.isNaN(parsed.getTime()))stamp.textContent=parsed.toLocaleString();
  }
  showPanel('overview');
})();
`;

const NESTED_CONTROLLER = `
(()=>{
  const root=document.querySelector('[data-gantt-root]');if(!root)return;
  const toggles=[...root.querySelectorAll('[data-nested-toggle-for]')];
  const panels=[...root.querySelectorAll('[data-nested-panel-for]')];
  const panelFor=(key)=>panels.find(panel=>panel.dataset.nestedPanelFor===key);
  const toggle=(control)=>{const key=control.dataset.nestedToggleFor;const panel=panelFor(key);if(!panel)return;const open=panel.hasAttribute('hidden');panel.toggleAttribute('hidden',!open);const link=[...root.querySelectorAll('[data-nested-link-for]')].find(candidate=>candidate.dataset.nestedLinkFor===key);link?.toggleAttribute('hidden',!open);control.setAttribute('aria-expanded',String(open));const mark=control.querySelector('text');if(mark)mark.textContent=open?'−':'＋';};
  root.addEventListener('click',event=>{const control=event.target.closest('[data-nested-toggle-for]');if(!control||!root.contains(control))return;event.preventDefault();event.stopPropagation();toggle(control);});
  root.addEventListener('keydown',event=>{const control=event.target.closest('[data-nested-toggle-for]');if(!control||!root.contains(control)||(event.key!=='Enter'&&event.key!==' '))return;event.preventDefault();event.stopPropagation();toggle(control);});
})();
`;

export function renderTodoGanttHtml({
  readModel, layout, narratives = [], anchorOutcomes = [], presentation = null, metadata = {},
  expandedLayout = null, noteContexts = null, noteWarnings = [], structurePresentation = null,
}) {
  if (readModel?.schema !== 'lattice.todo_store_read.v1' || !Array.isArray(readModel.members)) {
    throw new TypeError('readModel must be lattice.todo_store_read.v1');
  }
  if (!Array.isArray(narratives)) throw new TypeError('narratives must be an array');
  if (!Array.isArray(anchorOutcomes)) throw new TypeError('anchorOutcomes must be an array');
  if (!(noteContexts === null || Array.isArray(noteContexts))) {
    throw new TypeError('noteContexts must be null or an array');
  }
  if (!Array.isArray(noteWarnings)) throw new TypeError('noteWarnings must be an array');
  if (presentation !== null
    && (presentation?.schema !== 'lattice.todo_gantt_presentation_model.v1'
      || presentation.project_id !== readModel.project_id)) {
    throw new TypeError('presentation must be lattice.todo_gantt_presentation_model.v1');
  }
  if (structurePresentation !== null
    && (structurePresentation?.schema !== TODO_STRUCTURE_PRESENTATION_SCHEMA
      || structurePresentation.project_id !== readModel.project_id)) {
    throw new TypeError('structurePresentation must be lattice.todo_structure_presentation.v1');
  }
  const normalized = normalizeSections(readModel, narratives, anchorOutcomes, noteContexts);
  const displayName = projectDisplayName(readModel, metadata);
  const hasHierarchy = layout?.hierarchy?.schema === 'lattice.todo_gantt_hierarchy.v1';
  const svg = renderTodoGanttSvg(layout, { presentation });
  // The expanded diagram travels with the page so the badge can bring the
  // history back without a round trip. A file:// artifact has nowhere to ask.
  const expandedSvg = expandedLayout === null ? '' : renderTodoGanttSvg(expandedLayout, { presentation });
  const diagrams = expandedSvg === ''
    ? `<div data-diagram="live">${svg}</div>`
    : `<div data-diagram="live">${svg}</div><div data-diagram="expanded" hidden>${expandedSvg}</div>`;
  const rightPane = renderRightPane(
    normalized.sections, layout, presentation, readModel, noteContexts !== null, noteWarnings,
    expandedSvg !== '', structurePresentation,
  );
  const staticData = serializeJsonForScript({
    renderer_version: TODO_GANTT_RENDERER_VERSION,
    metadata,
    presentation,
    structure_presentation: structurePresentation,
  });
  const html = `<!doctype html><html lang="ja"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lattice — ${escapeHtmlText(displayName)} 依存工程図</title><style>${CSS}${hasHierarchy ? NESTED_CSS : ''}</style></head><body data-gantt-root data-view-state="overview"><main class="shell"><section class="gantt-pane" aria-label="${escapeHtmlAttribute(displayName)} 依存工程図"><div class="diagram-toolbar" role="group" aria-label="図のズーム"><strong class="project-heading">${escapeHtmlText(displayName)} 依存工程図</strong>${renderAuditPendingChip(readModel)}<button type="button" data-zoom-action="out" aria-label="縮小">−</button><button type="button" data-zoom-action="reset">等倍</button><button type="button" data-zoom-action="in" aria-label="拡大">＋</button><button type="button" data-zoom-action="fit">全体表示</button><output class="zoom-readout" data-zoom-output aria-live="polite">100%</output><span class="diagram-note">縦=依存段階（時間ではない）</span></div>${renderDiagramLegend(presentation, layout, expandedSvg !== '')}<div class="diagram-scroll" data-diagram-scroll tabindex="0" aria-label="縦方向を主にスクロール可能な依存工程図">${diagrams}</div></section><div class="pane-divider" data-pane-divider aria-hidden="true"></div><aside class="narrative-pane" aria-label="選択工程の詳細と全工程一覧">${rightPane}</aside></main><script type="application/json" id="todo-gantt-data">${staticData}</script><script>${CONTROLLER}${hasHierarchy ? NESTED_CONTROLLER : ''}</script></body></html>`;
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > TODO_GANTT_HTML_MAX_BYTES) {
    throw new TodoGanttRenderError('TODO_SCALE_EXCEEDED', 'todo gantt HTML limit exceeded', {
      html_bytes: htmlBytes, html_limit: TODO_GANTT_HTML_MAX_BYTES,
    });
  }
  return { html, html_digest: digest(html), prose_bytes: normalized.proseBytes, html_bytes: htmlBytes };
}
