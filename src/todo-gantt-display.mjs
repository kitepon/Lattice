/**
 * Display-side rendering states for the gantt serving paths
 * (docs/architecture/dfd-display-gantt-read.md). A read-only view writes nothing,
 * so a Store inconsistency is shown as a typed state instead of refused as a 500.
 * Store owns the read, the checkpoint and the typed result; this module owns the
 * tolerant projection, the banner/empty-state markup and the per-project memo.
 */
import * as todoStore from './todo-store.mjs';
import { digestTodoArtifact } from './todo-contracts.mjs';
import { escapeHtmlText } from './todo-gantt-html-shared.mjs';

export const GANTT_DISPLAY_REVALIDATE_MS = 30_000;
export const GANTT_DISPLAY_OMITTED_OVERLAYS = Object.freeze([
  'presentation', 'independence frontier', 'seam proposals', 'notes', 'structures', 'narratives',
]);

const TASK_STATUSES = ['pending', 'in-progress', 'blocked', 'retired', 'done'];
const PHASE_STATUSES = ['locked', 'active', 'gate_ready', 'reviewing', 'accepted', 'rejected',
  'closed_unaudited'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

// The Store exports land with the Store row; resolve at call time so this module loads before then.
function storeExport(name) {
  const fn = todoStore[name];
  if (typeof fn !== 'function') {
    throw Object.assign(new Error(`Store display export missing: ${name}`),
      { code: 'DISPLAY_READER_UNAVAILABLE' });
  }
  return fn;
}
const defaultReadForDisplay = (options) => storeExport('readTodoStoreForDisplay')(options);
const defaultReadDisplaySource = (options) => storeExport('readTodoStoreDisplaySource')(options);

/**
 * Raw `{project_id, manifest, members:[{descriptor, snapshot}]}` -> the renderer's
 * read model. The raw snapshot carries task states and phase states but no plan
 * (titles, lanes, edges), so tasks render by id in one lane without dependencies.
 * Whatever cannot be projected is dropped and named; this never throws.
 */
export function projectUnverifiedStore(raw) {
  const dropped = [];
  const members = [];
  const projectId = text(raw?.project_id) ?? text(raw?.manifest?.project_id) ?? 'unknown';
  for (const entry of Array.isArray(raw?.members) ? raw.members : []) {
    const planKey = text(entry?.descriptor?.plan_key);
    try {
      const drop = (reason, extra = {}) => dropped.push({ plan_key: planKey, code: 'DISPLAY_PROJECTION_DROPPED', reason, ...extra });
      if (planKey === null) { drop('descriptor_plan_key_invalid'); continue; }
      const snapshot = entry.snapshot;
      if (!plain(snapshot) || !Array.isArray(snapshot.tasks)) { drop('snapshot_tasks_invalid'); continue; }
      const seen = new Set();
      const tasks = [];
      for (const task of snapshot.tasks) {
        const taskId = text(task?.task_id);
        if (taskId === null || !TASK_STATUSES.includes(task.status)) {
          drop('task_invalid', { task_id: taskId }); continue;
        }
        if (seen.has(taskId)) { drop('task_duplicate', { task_id: taskId }); continue; }
        seen.add(taskId);
        tasks.push({ task_id: taskId, status: task.status, started_at: text(task.started_at),
          done_at: text(task.done_at), blocked_reason: text(task.blocked_reason), evidence: null,
          evidence_unverified: false, imported: false, test_result: null });
      }
      if (tasks.length === 0) { drop('no_projectable_task'); continue; }
      const phases = [];
      for (const phase of Array.isArray(snapshot.phases) ? snapshot.phases : []) {
        const phaseId = text(phase?.phase_id);
        if (phaseId === null || !PHASE_STATUSES.includes(phase.status)) {
          drop('phase_invalid', { phase_id: phaseId }); continue;
        }
        phases.push({ phase_id: phaseId, status: phase.status, review_event_digest: null,
          decision_event_digest: null, decision_evidence: null });
      }
      const descriptor = entry.descriptor;
      members.push({
        descriptor: { plan_key: planKey, active_plan_version: text(descriptor.active_plan_version),
          topology_digest: text(descriptor.topology_digest) },
        plan: { schema: 'lattice.todo_plan.v1', project_id: projectId, plan_key: planKey,
          plan_version: text(snapshot.plan_version) ?? text(descriptor.active_plan_version) ?? 'unknown',
          topology_digest: text(descriptor.topology_digest), hard_dependencies: [], joins: [],
          tasks: tasks.map(({ task_id: taskId }) => ({ task_id: taskId, title: taskId,
            lane: 'unverified', narrative_ref: null })) },
        tasks, phases, journal: { events: [] }, plan_scoped: { events: [] }, revision: null,
        coordination: null, snapshot_stale: false,
      });
    } catch {
      dropped.push({ plan_key: planKey, code: 'DISPLAY_PROJECTION_DROPPED', reason: 'projection_failed' });
    }
  }
  return {
    store: { schema: 'lattice.todo_store_read.v1', project_id: projectId,
      manifest: { manifest_digest: text(raw?.manifest?.manifest_digest) }, members,
      snapshot_stale: false },
    dropped,
  };
}

// Only these two slugs of an inconsistency leave the server; everything else in `detail` stays.
export function publicDiagnostic(inconsistency) {
  const code = CODE.test(inconsistency?.code) ? inconsistency.code : '-';
  const reason = SLUG.test(inconsistency?.detail?.reason) ? inconsistency.detail.reason : '-';
  return { code, reason };
}

const BANNER_STYLE = 'margin:0;padding:10px 16px;border-bottom:2px solid #e85f2a;background:#fff4e8;color:#201d19;font:13px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif';

function droppedMarkup(dropped) {
  if (dropped.length === 0) return '';
  const items = dropped.map((entry) => `<li><code>${escapeHtmlText(entry.plan_key ?? '-')}</code>${entry.task_id ? ` / <code>${escapeHtmlText(entry.task_id)}</code>` : ''}${entry.phase_id ? ` / <code>${escapeHtmlText(entry.phase_id)}</code>` : ''}: <code>${escapeHtmlText(CODE.test(entry.code) ? entry.code : 'DISPLAY_DROPPED')}</code> / <code>${escapeHtmlText(SLUG.test(entry.reason) ? entry.reason : '-')}</code></li>`).join('');
  return `<p>表示から除いた対象:</p><ul>${items}</ul>`;
}

function omittedMarkup() {
  return `<p>表示していない情報: ${GANTT_DISPLAY_OMITTED_OVERLAYS.map((name) => `<code>${escapeHtmlText(name)}</code>`).join(' · ')}</p>`;
}

/** `dropped` = Store dropped_members plus projection drops. Never claims validation. */
export function degradedBannerHtml({ state, verifiedAt = null, inconsistency, dropped = [] }) {
  const { code, reason } = publicDiagnostic(inconsistency);
  const lead = state === 'last_verified'
    ? `最後に確認できた状態（${escapeHtmlText(verifiedAt ?? '-')}）を表示中。現在の計画は整合していない`
    : '未検証の現在の状態を表示中。計画は整合していない';
  return `<aside role="status" data-display-state="${escapeHtmlText(state)}" style="${BANNER_STYLE}"><strong>${lead}: <code>${escapeHtmlText(code)}</code> / <code>${escapeHtmlText(reason)}</code></strong>${omittedMarkup()}${droppedMarkup(dropped)}</aside>`;
}

/** HTTP 200 page for `unavailable` (and an unverified view with nothing projectable). */
export function emptyStateHtml({ inconsistency, dropped = [] }) {
  const { code, reason } = publicDiagnostic(inconsistency);
  return `<!doctype html><html lang="ja"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lattice — 表示できる工程がありません</title></head><body><main data-display-state="unavailable" style="max-width:720px;margin:48px auto;padding:0 16px;font:16px/1.7 system-ui,-apple-system,'Hiragino Sans','Yu Gothic UI',sans-serif;color:#201d19"><h1>表示できる工程データがありません</h1><p>計画の状態を読み取れませんでした: <code>${escapeHtmlText(code)}</code> / <code>${escapeHtmlText(reason)}</code></p><p>読み取れるようになると、このページは自動で更新されます。</p>${droppedMarkup(dropped)}</main></body></html>`;
}

/** Live head: source + state + inconsistency code; overlay digests only when verified. */
export function displayHeadDigest(result, overlayHead = null) {
  return digestTodoArtifact({
    schema: 'lattice.todo_gantt_display_head.v1',
    state: result.state,
    source: result.source ?? null,
    inconsistency_code: result.inconsistency?.code ?? null,
    overlay_head: result.state === 'verified' ? overlayHead : null,
  });
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Project id and plan keys a display result carries; unavailable carries neither. */
export function displayResultBinding(result) {
  let projectId = null;
  let planKeys = [];
  if (result.state === 'unverified') {
    const { store } = projectUnverifiedStore(result.store);
    projectId = text(result.store?.project_id) ?? text(result.store?.manifest?.project_id);
    planKeys = store.members.map(({ plan }) => plan.plan_key);
  } else if (result.state === 'verified' || result.state === 'last_verified') {
    projectId = text(result.store?.project_id);
    planKeys = (Array.isArray(result.store?.members) ? result.store.members : [])
      .map((member) => member?.descriptor?.plan_key).filter((key) => typeof key === 'string');
  }
  return { projectId: PROJECT_ID.test(projectId) ? projectId : null, planKeys: planKeys.sort() };
}

/**
 * One per project, shared by every client. The memo is keyed by the source token
 * observed at the last full-read attempt (not result.source, which is the
 * checkpoint's in last_verified and null in unavailable), so a degraded but
 * unchanged store is not fully re-read every poll. A probe failure is its own key:
 * one full read, then reuse until the revalidation ceiling.
 */
export function createTodoGanttDisplayReader({
  repoRoot, readForDisplay = defaultReadForDisplay, readDisplaySource = defaultReadDisplaySource,
  revalidateMs = GANTT_DISPLAY_REVALIDATE_MS, now = Date.now,
}) {
  let memo = null;
  let inflight = null;
  const observe = async () => {
    try { return `ok:${digestTodoArtifact(await readDisplaySource({ repoRoot }))}`; }
    catch (error) { return `fail:${error?.code ?? 'PROBE_FAILED'}`; }
  };
  const load = async () => {
    const key = await observe();
    if (memo !== null && memo.valid && memo.key === key && now() - memo.at < revalidateMs) {
      if (memo.fault !== undefined) throw memo.fault;
      return memo.result;
    }
    const at = now();
    memo = null;
    // A token change during the attempt leaves the memo invalid for the next poll.
    const settle = async (outcome) => {
      memo = { key, at, valid: (await observe()) === key, ...outcome };
    };
    let result;
    try { result = await readForDisplay({ repoRoot }); } catch (fault) {
      // A real fault (not a typed result) is bounded like a probe failure: an unchanged token
      // with a persisting fault is not re-read every poll; the revalidation ceiling still applies.
      await settle({ fault });
      throw fault;
    }
    await settle({ result });
    return result;
  };
  return {
    read() {
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
