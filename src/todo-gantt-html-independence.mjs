import { DOCUMENT_STATUS, SEVERABILITY_LABEL, escapeHtmlAttribute, escapeHtmlText, foldIndex, planActivity, presentationLookup, refKey, renderPhaseProgress, renderRelationList, renderSeamProposalOverview, renderTaskIndex, statusMarkup, taskReference } from './todo-gantt-html-shared.mjs';
import {
  hasTodoStructurePresentation,
  renderTodoStructureNoscript,
  renderTodoStructurePanel,
} from './todo-gantt-structure.mjs';
import { renderTodoMarkdown } from './todo-markdown-renderer.mjs';
import { isTerminalPublicLabel } from './terminal-identity.mjs';

/**
 * 記録に残る端末名を、ページへ出す名前へ写す（ADR 0198）。
 *
 * journalと作業記録の`actor.host`は、書いた時の自由文である——OSのhost名のことも、席が自分で付けた名前の
 * こともあり、持ち主の名前を含みうる。ページは公開面へ配信されるので、そのまま出さない。出してよいのは
 * 端末の公開label（`terminal-`と16進12桁）だけで、それ以外は同じ名前に同じ番号を振った「端末N」にする。
 * 番号はその名前が最初に記録された時刻の順で、同時刻は名前の順。記録は追記だけなので、後から現れた名前は
 * 後ろの番号になり、既に振った番号は動かない。記録の本体は変えない——変えるのは表示だけである。
 */
export function recordedHostDisplayNames(sections) {
  const firstSeen = new Map();
  for (const section of sections) {
    for (const note of section.noteContext?.notes ?? []) {
      const host = note.actor.host;
      if (isTerminalPublicLabel(host)) continue;
      const known = firstSeen.get(host);
      if (known === undefined || note.recorded_at < known) firstSeen.set(host, note.recorded_at);
    }
  }
  const ordered = [...firstSeen].sort(([leftHost, leftAt], [rightHost, rightAt]) => (
    leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : leftHost < rightHost ? -1 : leftHost > rightHost ? 1 : 0));
  return new Map(ordered.map(([host], index) => [host, `端末${index + 1}`]));
}

function recordedHostDisplayName(host, displayNames) {
  if (isTerminalPublicLabel(host)) return host;
  // 対応表に無い名前を素通しにしない。表を作る側の漏れは、名前でなく固定の語として現れる。
  return displayNames.get(host) ?? '端末';
}

function renderNoteContext(context, hostDisplayNames) {
  if (context === null) {
    return '<section class="work-log"><h2>作業記録</h2><p class="note-warning">作業記録を読み取れません。概要の読取警告を確認してください。</p></section>';
  }
  if (context.notes.length === 0) {
    return '<section class="work-log"><h2>作業記録</h2><p>記録はありません。</p></section>';
  }
  const entries = context.notes.map((note) => {
    const rendered = renderTodoMarkdown(note.body);
    const filtering = rendered.discarded.length === 0 ? ''
      : '<p class="note-warning">安全上表示できない要素を除外しました。</p>';
    const correction = note.correction_state === 'superseded'
      ? `訂正済み（後継 ${note.superseded_by.slice(0, 12)}…）` : '現行';
    // UTCのまま埋め、閲覧者の現地時刻への変換はブラウザ側へ委ねる（title属性に原文を残す）。
    const stamp = `<time datetime="${escapeHtmlAttribute(note.recorded_at)}" title="${escapeHtmlAttribute(note.recorded_at)}" data-utc-stamp>${escapeHtmlText(note.recorded_at)}</time>`;
    return `<article class="work-log-entry"><header>${stamp}<span>${escapeHtmlText(correction)}</span></header><div class="work-log-body">${rendered.html}</div>${filtering}<p class="work-log-origin">来歴: ${escapeHtmlText(note.origin_plan_version)}/${escapeHtmlText(note.origin_task_id)}・記録者 ${escapeHtmlText(`${recordedHostDisplayName(note.actor.host, hostDisplayNames)}/${note.actor.agent}`)}</p></article>`;
  }).join('');
  const overflow = context.overflow_count === 0 ? ''
    : `<p class="note-warning">ほか ${context.overflow_count}件は上限のため省略。全履歴: <code>${escapeHtmlText(context.full_history_command)}</code></p>`;
  return `<section class="work-log"><h2>作業記録</h2>${entries}${overflow}<p class="work-log-head">note head: <code>${escapeHtmlText(context.note_head_digest ?? 'none')}</code></p></section>`;
}

function renderDesignMemo(task) {
  if (typeof task.design_memo !== 'string') {
    return '<section class="design-memo"><h2>設計メモ</h2><p class="note-warning">未登録（legacy ToDo）</p></section>';
  }
  const rendered = renderTodoMarkdown(task.design_memo);
  const filtering = rendered.discarded.length === 0 ? ''
    : '<p class="note-warning">安全上表示できない要素を除外しました。</p>';
  return `<section class="design-memo"><h2>設計メモ</h2><div class="design-memo-body">${rendered.html}</div>${filtering}</section>`;
}

/**
 * 図の外が語るための独立性要約を、plan単位の投影から引ける形へ畳む（ADR 0129 Decision 3）。
 */
export function summarizeIndependence(layout) {
  if (layout.independence === null) return null;
  const byPlan = new Map(layout.independence.plans.map((plan) => [plan.plan_key, plan]));
  return {
    plans: layout.independence.plans,
    byPlan,
    verifiedTaskCount: layout.independence.plans
      .reduce((total, plan) => total + plan.verified_task_count, 0),
    unknownTaskCount: layout.independence.plans
      .reduce((total, plan) => total + plan.unknown_task_ids.length, 0),
    serializePairCount: layout.independence.plans
      .reduce((total, plan) => total + plan.serialize_pairs.length, 0),
  };
}

/** 記録が無いときだけADR 0063の既定をそのまま述べる。 */
export function dispatchBasis(summary) {
  if (summary === null) {
    return 'ready frontier全件が既定です。一部だけを直列着手する場合は理由が必要です。';
  }
  const parts = [`検証済み並列 ${summary.verifiedTaskCount}工程`];
  if (summary.serializePairCount > 0) parts.push(`要直列 ${summary.serializePairCount}組`);
  if (summary.unknownTaskCount > 0) parts.push(`未検査 ${summary.unknownTaskCount}工程`);
  return `${parts.join('、')}。未検査は依存線が無くても並列可の根拠になりません。`;
}

const COVERAGE_REASON = Object.freeze({
  missing: 'このplanには独立性の記録がまだありません。',
  stale: '記録はありますが、その後のdiffで失効しています。',
  superseded: '記録は旧plan versionのもので、現在のtopologyには読めません。',
});

/**
 * 未検査を黙って消さない。記録が無い状態こそ最も警告が要る（ADR 0127）。
 *
 * 枠ごと消すと「競合なし」と読まれる。判定していないことと、次の一手を必ず言う。
 */
function unverifiedIndependence(planKey, coverage) {
  const reason = COVERAGE_REASON[coverage] ?? COVERAGE_REASON.missing;
  return `<p class="readiness-note"><strong>並列可否:</strong> 未検査です。競合が無いのではなく、まだ判定していません。${escapeHtmlText(reason)}宣言を書いて <code>lattice todo independence compile --plan ${escapeHtmlText(planKey)} --input &lt;ref&gt;</code> を通すと判定できます。</p>`;
}

function conflictItems(pairs) {
  return pairs.map((pair) => `<li>${escapeHtmlText(pair.other)} — ${escapeHtmlText(SEVERABILITY_LABEL[pair.severability] ?? pair.severability)}（資源 ${escapeHtmlText(pair.detail)}）</li>`).join('');
}

/**
 * 作業中の工程は自分がready frontierに居ないため、conflictの相手側として現れる。
 * 「今これを動かしている間、何が同時に始められないか」がその工程での並列可否である。
 */
function activeIndependence(plan, taskId) {
  const blocked = plan.conflicts_with_active
    .filter((entry) => entry.active_task_id === taskId)
    .map((entry) => ({
      other: entry.ready_task_id, severability: entry.severability, detail: entry.detail,
    }));
  if (blocked.length > 0) {
    return `<p class="readiness-note"><strong>並列可否:</strong> この工程が作業中のあいだ、次の着手候補は同時に始められません。</p><ul class="independence-conflicts">${conflictItems(blocked)}</ul>`;
  }
  if (plan.coverage !== 'verified') return unverifiedIndependence(plan.plan_key, plan.coverage);
  return '<p class="readiness-note"><strong>並列可否:</strong> 着手済のため同時着手の判定対象ではありません。現在の着手候補に、この工程と競合するものはありません。</p>';
}

/** 個別ToDoについて、競合相手と切断可能性を言葉で示す。 */
export function renderIndependenceNote(ref, node, summary, status) {
  // 完了した工程は同時着手の判断材料ではない。ここだけは黙ってよい。
  if (status === 'done') return '';
  const plan = summary === null ? undefined : summary.byPlan.get(ref.plan_key);
  if (plan === undefined) return unverifiedIndependence(ref.plan_key, 'missing');
  const taskId = ref.task_id;
  const state = node?.visibility?.independence ?? null;
  if (state === null) {
    if (status === 'in-progress') return activeIndependence(plan, taskId);
    return '<p class="readiness-note"><strong>並列可否:</strong> まだ着手候補ではないため判定していません。前提工程が片付いて着手候補に入った時点で判定します。</p>';
  }
  if (state === 'verified') {
    return '<p class="readiness-note"><strong>並列可否:</strong> 独立検証済です。記録時点の宣言境界では他のready工程と干渉しません。</p>';
  }
  if (state === 'unknown') return unverifiedIndependence(plan.plan_key, plan.coverage);
  const pairs = [
    ...plan.serialize_pairs
      .filter((pair) => pair.task_ids.includes(taskId))
      .map((pair) => ({
        other: pair.task_ids.find((id) => id !== taskId),
        severability: pair.severability,
        detail: pair.detail,
      })),
    ...plan.conflicts_with_active
      .filter((entry) => entry.ready_task_id === taskId)
      .map((entry) => ({
        other: `${entry.active_task_id}（作業中）`,
        severability: entry.severability,
        detail: entry.detail,
      })),
  ];
  return `<p class="readiness-note"><strong>並列可否:</strong> 要直列です。</p><ul class="independence-conflicts">${conflictItems(pairs)}</ul>`;
}

export function renderRightPane(
  sections, layout, presentation, readModel, notesEnabled = false, noteWarnings = [], expandable = false,
  structurePresentation = null,
) {
  const lookup = presentationLookup(presentation);
  // 番号はproject全体で1つの対応表から振る。工程ごとに振ると、同じ端末が工程によって別の番号になる。
  const hostDisplayNames = recordedHostDisplayNames(sections);
  const sectionByKey = new Map(sections.map((section) => [refKey(section.ref), section]));
  const semanticNodes = [...layout.nodes, ...(layout.hierarchy_nodes ?? [])];
  const nodeByKey = new Map(semanticNodes.map((node) => [refKey(node.ref), node]));
  const folds = foldIndex(layout);
  const incoming = new Map(sections.map((section) => [refKey(section.ref), []]));
  const outgoing = new Map(sections.map((section) => [refKey(section.ref), []]));
  const addRelation = (relations, ownerKey, ref, joinIds) => {
    const entries = relations.get(ownerKey);
    if (entries === undefined) return;
    let entry = entries.find((candidate) => refKey(candidate.ref) === refKey(ref));
    if (entry === undefined) {
      entry = { ref, joinIds: [] };
      entries.push(entry);
    }
    entry.joinIds = [...new Set([...entry.joinIds, ...joinIds])].sort();
  };
  // Premises and successors come from the FULL graph. `layout.edges` is the
  // drawn graph, where a fold unit's interior dependencies have been contracted
  // away — reading those here would tell a folded ToDo it has no premises.
  for (const edge of layout.full_edges ?? layout.edges) {
    addRelation(incoming, refKey(edge.to), edge.from, edge.join_ids);
    addRelation(outgoing, refKey(edge.from), edge.to, edge.join_ids);
  }
  const counts = { pending: 0, 'in-progress': 0, blocked: 0, done: 0 };
  for (const section of sections) counts[section.state.status] += 1;
  const active = sections.filter((section) => section.state.status === 'in-progress');
  const ready = semanticNodes.filter((node) => node.visibility.next_ready);
  const independenceSummary = summarizeIndependence(layout);
  const readyHeadline = ready.length > 1
    ? `<p class="readiness-note"><strong>同時dispatch推奨:</strong> ${ready.length}工程。${escapeHtmlText(dispatchBasis(independenceSummary))}</p>`
    : ready.length === 1
      ? '<p class="readiness-note"><strong>着手候補:</strong> 1工程です。</p>'
      : '<p class="readiness-note">現在のready frontierは空です。</p>';
  // ready件数によらず、記録があるなら内訳を述べる。1件の時だけ黙ると、
  // その1件が未検査でも「候補が1つある」としか伝わらない。
  const independenceNote = independenceSummary === null || ready.length > 1 ? ''
    : `<p class="readiness-note"><strong>並列可否:</strong> ${escapeHtmlText(dispatchBasis(independenceSummary))}</p>`;
  const dispatchSummary = `${readyHeadline}${independenceNote}`;
  const activeLinks = active.length === 0 ? '<p>作業中の工程はありません。</p>'
    : `<ul class="active-list">${active.map((section) => `<li><button type="button" data-select-node-key="${escapeHtmlAttribute(refKey(section.ref))}">${escapeHtmlText(taskReference(section, lookup))} — ${escapeHtmlText(section.task.title)}</button></li>`).join('')}</ul>`;
  const noteWarningMarkup = noteWarnings.length === 0 ? ''
    : `<section class="gantt-warning"><h2>作業記録の読取警告</h2><ul>${noteWarnings.map((warning) => `<li><code>${escapeHtmlText(warning.plan_key)}</code>: <strong>${escapeHtmlText(warning.code)}</strong> — ${escapeHtmlText(warning.message)}</li>`).join('')}</ul></section>`;
  const overview = `<section class="right-overview" data-right-panel="overview"><h1>工程を選択してください</h1><p>左の依存工程図から工程を選ぶと、題名・状態・前提・後続を表示します。</p><div class="status-summary"><span>☐ 未着手 ${counts.pending}</span><span>▶ 作業中 ${counts['in-progress']}</span><span>✅ 完了 ${counts.done}</span><span>⛔ ブロック中 ${counts.blocked}</span></div>${noteWarningMarkup}${dispatchSummary}${renderSeamProposalOverview(layout)}${renderPhaseProgress(readModel)}<h2>作業中</h2>${activeLinks}</section>`;
  const details = sections.map((section) => {
    const key = refKey(section.ref);
    const node = nodeByKey.get(key);
    const status = DOCUMENT_STATUS[section.state.status] ?? { mark: '?', label: '状態不明' };
    const lane = lookup.lanes.get(JSON.stringify([section.ref.plan_key, section.task.lane]));
    const category = lane === undefined ? section.task.lane : `${section.task.lane} — ${lane.name}`;
    const categoryDescription = lane === undefined ? '' : `<p class="category-description">${escapeHtmlText(lane.description)}</p>`;
    const blockedReason = section.state.status === 'blocked'
      ? `<p><strong>ブロック理由:</strong> ${escapeHtmlText(section.state.blocked_reason ?? '理由未記録')}</p>` : '';
    const sourceLine = section.anchorOutcome.origin_line === null ? '' : `:${section.anchorOutcome.origin_line}`;
    const sourceRef = section.narrativeRef ?? '参照なし';
    const anchorText = section.anchorOutcome.anchored
      ? `元plan: ${sourceRef}${sourceLine} — 行対応を確認済み`
      : `元plan: ${sourceRef}${sourceLine} — 行対応を確認できないため、本文位置との対応は表示していません`;
    const readiness = node?.visibility.next_ready
      ? `<p class="readiness-note">ready frontierの一員です。${ready.length > 1 ? '他のready工程と同時着手できるかは下の並列可否で判断してください。' : '現在の唯一の着手候補です。'}</p>`
      : incoming.get(key).length === 0 ? '<p class="readiness-note">登録済みの前提工程はありません。図だけではdispatch可否を判定しません。</p>' : '';
    const independenceNote = renderIndependenceNote(
      section.ref, node, independenceSummary, section.state.status,
    );
    // Say it plainly when the reader will not find this ToDo on the diagram.
    const foldedNote = !folds.has(key) ? ''
      : expandable
        ? '<p class="fold-note">完走済みのため既定の図には描いていません。左上の「完走済み」バッジを押すと、このページ内で表示できます。</p>'
        : '<p class="fold-note">完走済みのため図には描いていません。図に出すには動的dashboardを <code>lattice todo gantt serve --port &lt;port&gt; --scope all</code> で起動してください。</p>';
    const workLog = notesEnabled ? renderNoteContext(section.noteContext, hostDisplayNames) : '';
    const designMemo = renderDesignMemo(section.task);
    return `<article class="task-detail" data-detail-key="${escapeHtmlAttribute(key)}" hidden><header><span class="detail-status status-${escapeHtmlAttribute(section.state.status)}">${escapeHtmlText(status.mark)} ${escapeHtmlText(status.label)}</span><span class="detail-reference">${escapeHtmlText(taskReference(section, lookup))}</span></header><h1>${escapeHtmlText(section.task.title)}</h1><p class="detail-category"><strong>カテゴリ:</strong> ${escapeHtmlText(category)}</p>${categoryDescription}<p><strong>正規ID:</strong> <code>${escapeHtmlText(`${section.ref.plan_key}/${section.task.task_id}`)}</code></p>${blockedReason}${readiness}${independenceNote}${foldedNote}${designMemo}<section><h2>前提工程</h2>${renderRelationList(incoming.get(key), sectionByKey, lookup, '登録済みの前提工程はありません。', folds)}</section><section><h2>後続工程</h2>${renderRelationList(outgoing.get(key), sectionByKey, lookup, '登録済みの後続工程はありません。', folds)}</section>${workLog}<p class="anchor-status">${escapeHtmlText(anchorText)}</p><details class="task-diagnostics"><summary>開発者向け診断</summary><dl><dt>canonical ref</dt><dd><code>${escapeHtmlText(`${section.ref.project_id}/${section.ref.plan_key}/${section.task.task_id}`)}</code></dd><dt>anchor</dt><dd>${escapeHtmlText(section.anchorOutcome.anchored ? 'verified' : section.anchorOutcome.reason)}</dd></dl></details></article>`;
  }).join('');
  const taskIndex = renderTaskIndex(sections, lookup, folds, planActivity(readModel));
  const structureButton = hasTodoStructurePresentation(structurePresentation)
    ? '<button type="button" data-show-structure>構造検査</button>' : '';
  return `<div class="right-toolbar"><button type="button" data-show-overview>概要</button><button type="button" data-show-selected hidden>選択工程へ戻る</button><button type="button" data-show-task-index>全工程一覧</button>${structureButton}</div><div class="right-content">${overview}<div data-right-panel="details" hidden>${details}</div><section class="task-index" data-right-panel="task-index" hidden><h1>全工程</h1><p>Latticeに登録された全工程を現在の状態とともに表示しています。planは動いているものを最終活動の新しい順で上に、完走したものを古い順で下にまとめ、plan内は登録順です。</p>${taskIndex}</section>${renderTodoStructurePanel(structurePresentation)}${renderTodoStructureNoscript(structurePresentation)}</div>`;
}

export function renderDiagramLegend(presentation, layout = null, expandable = false) {
  const categories = (presentation?.lanes ?? []).map((lane) => `<div class="category-entry"><dt><code>${escapeHtmlText(lane.lane)}</code> — ${escapeHtmlText(lane.name)}</dt><dd>${escapeHtmlText(lane.description)}</dd></div>`).join('');
  const categoryDetails = categories === '' ? '' : `<details class="category-legend"><summary>カテゴリ説明</summary><dl>${categories}</dl></details>`;
  const foldedCount = layout?.scope?.folded_task_count ?? 0;
  // The badge says what is missing from the diagram, so it is also the control
  // that brings it back — a reader who notices the count is exactly the reader
  // who wants to see it.
  const foldChip = foldedCount === 0 ? ''
    : expandable
      ? `<button type="button" class="fold-chip" data-toggle-expanded aria-expanded="false"><span data-toggle-label data-collapsed-label="完走済み ${foldedCount}件を非表示（押すと表示）" data-expanded-label="完走済み ${foldedCount}件を表示中（押すと非表示）">完走済み ${foldedCount}件を非表示（押すと表示）</span></button>`
      : `<span class="fold-chip">完走済み ${foldedCount}件を非表示</span>`;
  const foldNote = foldedCount === 0 ? ''
    : expandable
      ? '<p class="fold-note">後続に作業中・未着手が残っていない完了工程は図から外しています。生きた工程とその直接の前提工程は必ず描きます。上のバッジを押すと外した工程も含めて描きます。総数・進捗・最長依存鎖は外す前の全工程で数えています。</p>'
      : '<p class="fold-note">後続に作業中・未着手が残っていない完了工程は図から外しています。生きた工程とその直接の前提工程は必ず描きます。外した工程は右の「全工程」から辿れ、図に出すには動的dashboardを <code>lattice todo gantt serve --port &lt;port&gt; --scope all</code> で起動してください。総数・進捗・最長依存鎖は外す前の全工程で数えています。</p>';
  const independenceLegend = layout.independence === null ? ''
    : '<span>∥ 独立検証済</span><span>⛓ 要直列</span><span>? 未検査</span>';
  // 独立性の記録がある間は「全件同時dispatchが既定」と無条件に述べない（ADR 0129 Decision 3）。
  const dispatchSentence = layout.independence === null
    ? 'ready frontierは全件同時dispatchが既定です。未登録の資源・host制約によりsubsetだけを選ぶ場合は理由を記録します。'
    : '同時着手できるかはカードの並列可否で判断してください。未検査の工程は依存線が無くても並列可の根拠になりません。';
  return `<div class="diagram-legend" aria-label="工程図の凡例"><span>${statusMarkup('pending', ' 未着手')}</span><span>${statusMarkup('in-progress', ' 作業中')}</span><span>${statusMarkup('done', ' 完了')}</span><span>${statusMarkup('blocked', ' ブロック中')}</span><span>破線枠: ready frontier</span>${independenceLegend}<span>太線: 構造上の最長依存鎖</span><span>半円: 非接触の線交差</span><span>黒丸: 論理上の合流</span>${foldChip}${categoryDetails}${foldNote}<p>縦方向は時間ではなく、登録済み依存関係による工程段階です。${dispatchSentence}構造上の最長依存鎖は各工程を同じ重みとして数え、実時間・工数・納期を表しません。</p></div>`;
}
