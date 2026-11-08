import { createTodoReadiness } from './todo-readiness.mjs';
import { isDecoupledPhaseTodoPlanSchema, isFinishedTodoTaskState } from './todo-store-view.mjs';
import {
  AUDIT_PENDING_PHASE_STATUSES,
  auditPendingNextCommands,
  isAuditPendingPhaseStatus,
} from './todo-audit-pending.mjs';
import {
  TODO_COORDINATION_MODES,
  TODO_LIMITS,
  exactRecord,
  isNonNegativeSafeInteger,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoIdentifier,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { TODO_INDEPENDENCE_COVERAGE } from './todo-independence-contracts.mjs';
import { todoLegacyReconciliationDigest } from './todo-revision.mjs';
import {
  isPhaselessTodoPlanSchema,
  projectTodoCrossPlanDependencies,
  todoPhaseDefinitions,
} from './todo-store.mjs';

/**
 * v7で`structure_finalization_pending`を足す。構造機能が未適用のplanでは空配列になり、
 * dispatch面は変えない。ADR 0054・0063の前例どおり既存versionへのin-place追加はしない。
 *
 * plan単位noteは工程に属する義務で、taskへ着手した人のcontextには届くが、**まだ誰も
 * 着手していない工程の義務は、この欄が無いとどこにも出ない**。
 */
export const TODO_STATUS_SCHEMA = 'lattice.todo_status_result.v9';
/** v9 (u03 A77): `truncated: [{list, total, shown}]` records every cut of an output list. */
/** v8: cross_plan_findingsは件数だけ全数、本文は先頭からこの件数まで（statusを止めない）。 */
export const TODO_STATUS_FINDING_LIMIT = 32;
export const TODO_DISPATCH_FRONTIER_SCHEMA = 'lattice.todo_dispatch_frontier.v1';
export const TODO_STATUS_LIST_LIMIT = 2_000;
export const TODO_STATUS_LABEL_LIMIT = 160;
export const TODO_STATUS_REASON_LIMIT = 512;
export const TODO_STATUS_CAPTURE_LIMIT = 64 * 1_024;

export class TodoStatusProjectionError extends Error {
  constructor(code, reason, detail = {}) {
    super(reason);
    this.name = 'TodoStatusProjectionError';
    this.code = code;
    this.detail = { reason, ...detail };
  }
}

function fail(code, reason, detail) {
  throw new TodoStatusProjectionError(code, reason, detail);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Python consumerのlen()/ord()と同じUnicode code point単位のbounded_text。 */
export function isTodoStatusBoundedText(value, limit = TODO_STATUS_REASON_LIMIT) {
  if (typeof value !== 'string') return false;
  const points = [...value];
  return points.length > 0 && points.length <= limit
    && points.every((character) => character.codePointAt(0) >= 0x20 && character !== '\x7f');
}

function displayText(value, fallback, limit) {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  const points = [...source].slice(0, limit).map((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0x20 && codePoint !== 0x7f ? character : '\uFFFD';
  });
  const result = points.join('');
  return result.length > 0 ? result : fallback;
}

/**
 * 一覧が使う1工程の表示欄。`todo status`と`session-context`の`turn.own`が同じ文字列を返すための共有点。
 * u12: done_conditionは1行・512文字までの表示用で、全文は`todo show`が返す。v7以前は欄が無くnull。
 */
export function todoStatusTaskDisplay(task) {
  return {
    label: displayText(task.title, task.task_id, TODO_STATUS_LABEL_LIMIT),
    done_condition: typeof task.done_condition === 'string' && task.done_condition.trim().length > 0
      ? displayText(task.done_condition.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim(), '', TODO_STATUS_REASON_LIMIT)
      : null,
  };
}

/** `todo status`のblocked欄と同じ表示のblocked理由。 */
export function todoStatusBlockedReason(reason) {
  return displayText(reason, 'blocked', TODO_STATUS_REASON_LIMIT);
}

function taskKey(projectId, planKey, taskId) {
  return `${projectId}\0${planKey}\0${taskId}`;
}

function refKey(ref) {
  return taskKey(ref.project_id, ref.plan_key, ref.task_id);
}

function compareTaskEntries(left, right) {
  return left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1
    : left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0;
}

function enforceListLimit(name, value) {
  if (value.length > TODO_STATUS_LIST_LIMIT) {
    fail('TODO_SCALE_EXCEEDED', 'todo_status_list_limit_exceeded', {
      list: name,
      count: value.length,
      limit: TODO_STATUS_LIST_LIMIT,
    });
  }
}

function taskEntry(value) {
  return exactRecord(value, ['plan_key', 'task_id', 'label', 'done_condition'])
    && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.task_id)
    && isTodoStatusBoundedText(value.label, TODO_STATUS_LABEL_LIMIT)
    && (value.done_condition === null || isTodoStatusBoundedText(value.done_condition, TODO_STATUS_REASON_LIMIT));
}

function taskRefEntry(value) {
  return exactRecord(value, ['plan_key', 'task_id'])
    && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.task_id);
}

function activeTaskEntry(value) {
  return exactRecord(value, ['plan_key', 'task_id', 'label', 'unmet_dependencies'])
    && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.task_id)
    && isTodoStatusBoundedText(value.label, TODO_STATUS_LABEL_LIMIT)
    && boundedList(value.unmet_dependencies, taskRefEntry);
}

function blockedEntry(value) {
  return exactRecord(value, ['plan_key', 'task_id', 'reason'])
    && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.task_id)
    && isTodoStatusBoundedText(value.reason, TODO_STATUS_REASON_LIMIT);
}

/**
 * 監査待ちPhase 1件。
 *
 * task entryと紛れないよう`status`ではなく`phase_status`にする。状態集合は
 * `todo-audit-pending.mjs`の定義をそのまま使う（ここで書き直さない）。
 * `next_commands`を非空必須にしたのは、監査待ちなのに次の一手が空なら次アクション面として
 * 無意味だからである（状態集合が閉じている以上、空になる枝は無い）。
 */
function auditPendingEntry(value) {
  return exactRecord(value, [
    'plan_key', 'phase_id', 'phase_status', 'implicit', 'required_evidence_slots', 'next_commands',
  ]) && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.phase_id)
    && AUDIT_PENDING_PHASE_STATUSES.has(value.phase_status)
    && typeof value.implicit === 'boolean'
    && boundedList(value.required_evidence_slots, isTodoIdentifier)
    && Array.isArray(value.next_commands) && value.next_commands.length > 0
    && boundedList(value.next_commands, (command) => isTodoStatusBoundedText(command, TODO_STATUS_REASON_LIMIT));
}

function planNoteLatestEntry(value) {
  return exactRecord(value, ['event_digest', 'actor_agent', 'recorded_at'])
    && isTodoDigest(value.event_digest) && isTodoIdentifier(value.actor_agent)
    && isStrictTodoTimestamp(value.recorded_at);
}

/**
 * plan単位noteの要約1件。
 *
 * **本文を持たない。** 自由記述のMarkdownをここへinlineすると、noteを書くほど
 * `TODO_STATUS_CAPTURE_LIMIT`へ近づき、健全なstoreが`TODO_SCALE_EXCEEDED`で落ちる
 * ——「記録すると壊れる」面を作らない。載せるのは件数・帰属・次の一手までで、
 * 中身は`next_commands`が指す`note list`が持つ。
 *
 * `plan_note_head_digest`は`note_context.note_head_digest`（task chain）と**別のchainのhead**なので、
 * 名前で区別する。同名にすると型が同じdigestなので、取り違えてもexact validatorを通ってしまう。
 *
 * `count`は1以上（0件のplanはentryごと出さない）。`next_commands`が非空必須なのは
 * `audit_pending`と同じ理由で、欄に出るだけで次の一手が無いなら次アクション面として無意味である。
 */
function planNoteEntry(value) {
  return exactRecord(value, ['plan_key', 'plan_note_head_digest', 'count', 'latest', 'next_commands'])
    && isTodoIdentifier(value.plan_key) && isTodoDigest(value.plan_note_head_digest)
    && isNonNegativeSafeInteger(value.count) && value.count > 0
    && Array.isArray(value.latest) && value.latest.length > 0
    && value.latest.length <= Math.min(value.count, TODO_LIMITS.statusPlanNoteLatest)
    && value.latest.every(planNoteLatestEntry)
    && value.latest[0].event_digest === value.plan_note_head_digest
    && Array.isArray(value.next_commands) && value.next_commands.length > 0
    && boundedList(value.next_commands,
      (command) => isTodoStatusBoundedText(command, TODO_STATUS_REASON_LIMIT));
}

/**
 * 調整方式を宣言したplan 1件（ob03・オーナー裁定C①）。
 *
 * **宣言済みのplanだけを列挙する。** 未宣言を`mode: null`で全plan出すと、plan数ぶん常に
 * 埋まって読み飛ばされる列になる——前campaignで`audit_pending`の設計時に避けた形と同じ。
 * 未宣言は「`member_heads`に居て`coordination`に居ない」で引ける。
 *
 * `declared_by`が本体である。witnessが全planの暗黙義務だった時に無かったのが帰属で、
 * ここを落とすとこの欄は「もう1つの督促」に戻る。
 */
function coordinationEntry(value) {
  return exactRecord(value, ['plan_key', 'mode', 'declared_by', 'declared_at', 'reason'])
    && isTodoIdentifier(value.plan_key)
    && TODO_COORDINATION_MODES.includes(value.mode)
    && exactRecord(value.declared_by, ['host', 'session', 'agent'])
    && ['host', 'session', 'agent'].every((key) => isTodoStatusBoundedText(value.declared_by[key], TODO_STATUS_LABEL_LIMIT))
    && isStrictTodoTimestamp(value.declared_at)
    && isTodoStatusBoundedText(value.reason, TODO_STATUS_REASON_LIMIT);
}

/**
 * 並列候補1 plan（ob05・オーナー裁定C③）。
 *
 * **新しい判定は1つも行わない。** ここに載るのは`projectIndependenceFrontier`が既に出している
 * 結果を、候補の視点で並べ直したものだけである。並列できそうな組を選ぶのはAIの仕事で、
 * 機械が持つのは「まだ判定していないreadyはこれ」「判定済みの結果はこれ」だけ
 * ——推定・判断をLatticeの中へ実装しない（所有境界）。
 *
 * **ready taskを1つも持たないplanはentryごと出さない。** 全plan常に1行にすると、plan数ぶん
 * 埋まって読み飛ばされる列になる（前campaignのwitness `coverage: missing`が実際にそうなった）。
 *
 * 逆に`coverage: 'missing'`のplanは**出す**。「まだ誰も判定していない」はこの欄が最も要る状態で、
 * そこを飛ばすと沈黙が不在に見える。
 */
function parallelCandidateEntry(value) {
  return exactRecord(value, [
    'plan_key', 'coverage', 'unreadable_reason', 'unjudged_task_ids',
    'verified_parallel_groups', 'serialize_pairs', 'next_commands',
  ]) && isTodoIdentifier(value.plan_key)
    // 読めない記録は`coverage`を名乗らず理由を名乗る（ADR 0131・`summarizeIndependence`と同じ答え方）。
    // 「壊れている」を「まだ判定していない」へ丸めない。
    && (value.unreadable_reason === null
      ? TODO_INDEPENDENCE_COVERAGE.includes(value.coverage)
      : value.coverage === null
        && isTodoStatusBoundedText(value.unreadable_reason, TODO_STATUS_REASON_LIMIT))
    && boundedList(value.unjudged_task_ids, isTodoIdentifier)
    // 1件の組は並列の情報を持たない（taskは常に自分と並列である）。生産側が落としている以上、
    // 契約側でも受けない——受けると消費者が「2件以上」を前提にできなくなる。
    && boundedList(value.verified_parallel_groups, (group) => exactRecord(group, ['task_ids'])
      && Array.isArray(group.task_ids) && group.task_ids.length > 1
      && group.task_ids.every(isTodoIdentifier))
    && boundedList(value.serialize_pairs, (pair) => exactRecord(pair, ['task_ids', 'type', 'detail'])
      && Array.isArray(pair.task_ids) && pair.task_ids.length === 2
      && pair.task_ids.every(isTodoIdentifier)
      && isTodoStatusBoundedText(pair.type, TODO_STATUS_LABEL_LIMIT)
      && isTodoStatusBoundedText(pair.detail, TODO_STATUS_REASON_LIMIT))
    // 候補が在るのに次の一手が無い欄は、この工程が直している「欄だけ置いて閉じる」形になる。
    && Array.isArray(value.next_commands) && value.next_commands.length > 0
    && boundedList(value.next_commands,
      (command) => isTodoStatusBoundedText(command, TODO_STATUS_REASON_LIMIT))
    // 何も無いplanは出さない。空entryは「判定する対象が無い」と「判定が済んだ」を混ぜる。
    && (value.unjudged_task_ids.length > 0 || value.verified_parallel_groups.length > 0
      || value.serialize_pairs.length > 0);
}

function structureFinalizationPendingEntry(value) {
  return exactRecord(value, ['plan_key', 'status', 'reason', 'stale_reasons', 'next_commands'])
    && isTodoIdentifier(value.plan_key)
    && ['missing', 'stale'].includes(value.status)
    && isTodoStatusBoundedText(value.reason, TODO_STATUS_REASON_LIMIT)
    && boundedList(value.stale_reasons,
      (reason) => isTodoStatusBoundedText(reason, TODO_STATUS_LABEL_LIMIT))
    && Array.isArray(value.next_commands) && value.next_commands.length > 0
    && boundedList(value.next_commands,
      (command) => isTodoStatusBoundedText(command, TODO_STATUS_REASON_LIMIT));
}

function memberHead(value) {
  return exactRecord(value, [
    'plan_key', 'plan_version', 'through_sequence', 'journal_head_digest',
    'reconciliation_state', 'revision_digest', 'reconciliation_digest',
  ]) && isTodoIdentifier(value.plan_key) && isTodoIdentifier(value.plan_version)
    && isNonNegativeSafeInteger(value.through_sequence) && isTodoDigest(value.journal_head_digest)
    && ['registered_unreconciled', 'reconciled'].includes(value.reconciliation_state)
    && (value.revision_digest === null || isTodoDigest(value.revision_digest))
    && isTodoDigest(value.reconciliation_digest)
    && ((value.reconciliation_state === 'registered_unreconciled' && value.revision_digest === null)
      || (value.reconciliation_state === 'reconciled' && isTodoDigest(value.revision_digest)));
}

function boundedList(value, validator) {
  return Array.isArray(value) && value.length <= TODO_STATUS_LIST_LIMIT && value.every(validator);
}

function dispatchFrontier(projectId, nextReady) {
  const preimage = {
    schema: TODO_DISPATCH_FRONTIER_SCHEMA,
    project_id: projectId,
    tasks: nextReady.map(({ plan_key: planKey, task_id: taskId }) => ({
      plan_key: planKey,
      task_id: taskId,
    })),
    frontier_digest: '',
  };
  return {
    schema: TODO_DISPATCH_FRONTIER_SCHEMA,
    selection_source: 'next_ready',
    policy: 'all_ready_parallel_by_default',
    recommended_parallelism: nextReady.length,
    subset_requires_reason: nextReady.length > 1,
    parallel_start_flag: '--parallel-frontier',
    frontier_digest: todoSelfDigest(preimage, 'frontier_digest'),
  };
}

function dispatchFrontierEntry(value, projectId, nextReady) {
  const expected = dispatchFrontier(projectId, nextReady);
  return exactRecord(value, [
    'schema', 'selection_source', 'policy', 'recommended_parallelism',
    'subset_requires_reason', 'parallel_start_flag', 'frontier_digest',
  ]) && value.schema === TODO_DISPATCH_FRONTIER_SCHEMA
    && value.selection_source === 'next_ready'
    && value.policy === 'all_ready_parallel_by_default'
    && isNonNegativeSafeInteger(value.recommended_parallelism)
    && value.recommended_parallelism === nextReady.length
    && value.subset_requires_reason === (nextReady.length > 1)
    && value.parallel_start_flag === '--parallel-frontier'
    && value.frontier_digest === expected.frontier_digest;
}

function crossPlanFindingEntry(value) {
  if (!exactRecord(value, ['owner_plan_key', 'event_digest', 'side', 'ref', 'reason'])
    || !isTodoIdentifier(value.owner_plan_key)
    || !(value.event_digest === null || isTodoDigest(value.event_digest))
    || !['from', 'to'].includes(value.side)
    || !['binding_stale', 'endpoint_missing'].includes(value.reason)) return false;
  const { ref } = value;
  const common = (keys) => exactRecord(ref, keys) && isTodoIdentifier(ref.project_id)
    && isTodoIdentifier(ref.plan_key)
    && (!keys.includes('expected_topology_digest') || isTodoDigest(ref.expected_topology_digest));
  if (Object.hasOwn(ref ?? {}, 'phase_id')) {
    return value.side === 'from' && common(['project_id', 'plan_key', 'phase_id', 'expected_topology_digest'])
      && isTodoIdentifier(ref.phase_id);
  }
  return (common(['project_id', 'plan_key', 'task_id'])
    || common(['project_id', 'plan_key', 'task_id', 'expected_topology_digest']))
    && isTodoIdentifier(ref.task_id);
}

function crossPlanFindings(value) {
  return exactRecord(value, ['total', 'entries']) && isNonNegativeSafeInteger(value.total)
    && Array.isArray(value.entries) && value.entries.length <= TODO_STATUS_FINDING_LIMIT
    && value.entries.length === Math.min(value.total, TODO_STATUS_FINDING_LIMIT)
    && value.entries.every(crossPlanFindingEntry);
}

/** todo status v8 wire shapeを検証し、digestも再計算する。 */
export function validateTodoStatusResult(value) {
  try {
    return exactRecord(value, [
      'schema', 'project_id', 'active_set', 'next_ready', 'dispatch_frontier',
      'blocked', 'audit_pending', 'structure_finalization_pending', 'plan_notes',
      'coordination', 'parallel_candidates', 'cross_plan_findings',
      'member_heads', 'truncated', 'result_digest',
    ]) && value.schema === TODO_STATUS_SCHEMA && isTodoIdentifier(value.project_id)
      && boundedList(value.active_set, activeTaskEntry) && boundedList(value.next_ready, taskEntry)
      && dispatchFrontierEntry(value.dispatch_frontier, value.project_id, value.next_ready)
      && boundedList(value.blocked, blockedEntry) && boundedList(value.audit_pending, auditPendingEntry)
      && boundedList(value.structure_finalization_pending, structureFinalizationPendingEntry)
      && boundedList(value.plan_notes, planNoteEntry)
      && boundedList(value.coordination, coordinationEntry)
      && boundedList(value.parallel_candidates, parallelCandidateEntry)
      && crossPlanFindings(value.cross_plan_findings)
      && boundedList(value.member_heads, memberHead)
      && Array.isArray(value.truncated) && value.truncated.every((entry) => exactRecord(entry, ['list', 'total', 'shown'])
        && typeof entry.list === 'string' && isNonNegativeSafeInteger(entry.total)
        && isNonNegativeSafeInteger(entry.shown) && entry.shown < entry.total)
      && isTodoDigest(value.result_digest)
      && value.result_digest === todoSelfDigest(value, 'result_digest');
  } catch {
    return false;
  }
}

/**
 * memberの監査待ちPhaseを`audit_pending` entryへ起こす。
 *
 * 「監査待ちか」の判定は`todo-audit-pending.mjs`、Phase定義（slots）は`todo-store.mjs`の
 * `todoPhaseDefinitions`が正本である。`plan.phases`を直接読むとphase無しplan(v1/v2/v3)と
 * synthetic read modelで落ちるので読まない。
 *
 * dispatchへは一切流さない——ここで作るのは`member.phases`だけを見る別の列であり、
 * nodes／incomingへは入れない（ADR 0062・ADR 0147裁定5）。
 */
function collectAuditPending(member, sink) {
  const declared = todoPhaseDefinitions(member.plan);
  // Phase plan(v4/v5/v7)なのに`plan.phases`が配列でない場合はここでtypedに落とす
  // (素のTypeErrorで抜けさせない)。phase無しplanは常に暗黙Phase 1件が返るので該当しない。
  if (!Array.isArray(declared)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_plan_phases_invalid', { plan_key: member.plan.plan_key });
  }
  const definitions = new Map(declared.map((entry) => [entry.phase_id, entry]));
  const implicit = isPhaselessTodoPlanSchema(member.plan.schema);
  for (const phase of member.phases ?? []) {
    if (!isAuditPendingPhaseStatus(phase?.status)) continue;
    const definition = definitions.get(phase.phase_id);
    // 導出ビューに在ってplanに定義が無いPhaseは、状態とplanがずれている証拠である。
    // slotsを空へ丸めるとgateが何を要求するか嘘を吐くので、fail closedにする。
    if (definition === undefined) {
      fail('TODO_STATUS_INVALID_INPUT', 'todo_status_phase_definition_missing', {
        plan_key: member.plan.plan_key, phase_id: phase.phase_id,
      });
    }
    sink.push({
      plan_key: member.plan.plan_key,
      phase_id: phase.phase_id,
      phase_status: phase.status,
      implicit,
      required_evidence_slots: [...definition.required_evidence_slots],
      next_commands: auditPendingNextCommands(member.plan.plan_key, phase.phase_id, phase.status),
    });
  }
}

/**
 * read modelからtask node・依存辺・phase gateを組み立てる。
 *
 * ready判定の唯一の計算元。`projectTodoStatus`と`computeReadyFrontier`が同じ結果を
 * 出すために共有する（同じ規則を二箇所へ持たない）。
 */
function buildTodoGraph(readModel) {
  if (!plain(readModel) || readModel.schema !== 'lattice.todo_store_read.v1'
    || !isTodoIdentifier(readModel.project_id) || !Array.isArray(readModel.members)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_read_model_invalid');
  }

  const nodes = new Map();
  const incoming = new Map();
  const memberHeads = [];
  const auditPending = [];
  const coordination = [];
  const members = [...readModel.members].sort((left, right) => {
    const leftKey = left?.descriptor?.plan_key ?? '';
    const rightKey = right?.descriptor?.plan_key ?? '';
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  for (const member of members) {
    if (!plain(member) || !plain(member.plan) || !plain(member.descriptor)
      || !Array.isArray(member.plan.tasks) || !Array.isArray(member.plan.hard_dependencies)
      || !Array.isArray(member.plan.joins) || !Array.isArray(member.tasks)
      || !plain(member.journal) || !Array.isArray(member.journal.events)) {
      fail('TODO_STATUS_INVALID_INPUT', 'todo_status_member_invalid');
    }
    const head = member.journal.events.at(-1);
    const genesis = member.journal.events[0];
    if (!plain(head) || !isNonNegativeSafeInteger(head.sequence) || !isTodoDigest(head.event_digest)) {
      fail('TODO_STATUS_INVALID_INPUT', 'todo_status_member_head_invalid');
    }
    const reconciled = ['lattice.todo_event.v2', 'lattice.todo_event.v4'].includes(genesis.schema);
    const phaseV3 = genesis.schema === 'lattice.todo_event.v4'
      && member.revision?.schema === 'lattice.phase_todo_revision.v3';
    memberHeads.push({
      plan_key: member.plan.plan_key,
      plan_version: member.plan.plan_version,
      through_sequence: head.sequence,
      journal_head_digest: head.event_digest,
      reconciliation_state: reconciled ? 'reconciled' : 'registered_unreconciled',
      revision_digest: reconciled ? genesis.revision_digest : null,
      reconciliation_digest: reconciled
        ? phaseV3 ? member.revision.reconciliation.reconciliation_digest
          : genesis.schema === 'lattice.todo_event.v4' ? genesis.revision_digest
            : genesis.reconciliation_digest
        : todoLegacyReconciliationDigest({
          planDigest: member.plan.plan_digest, journalHeadDigest: head.event_digest,
        }),
    });
    const states = new Map(member.tasks.map((state) => [state.task_id, state]));
    collectAuditPending(member, auditPending);
    // 調整方式の宣言(ob03)。member.coordinationはstoreがplan-scoped chainから投影した
    // 導出ビューで、未宣言はnull。宣言済みだけをここへ載せる。
    if (member.coordination !== null && member.coordination !== undefined) {
      coordination.push({
        plan_key: member.plan.plan_key,
        mode: member.coordination.mode,
        declared_by: member.coordination.declared_by,
        declared_at: member.coordination.declared_at,
        reason: displayText(member.coordination.reason, member.coordination.mode, TODO_STATUS_REASON_LIMIT),
      });
    }
    for (const task of member.plan.tasks) {
      const state = states.get(task.task_id);
      if (!plain(state) || !['pending', 'in-progress', 'blocked', 'retired', 'done'].includes(state.status)) {
        fail('TODO_STATUS_INVALID_INPUT', 'todo_status_task_state_missing', {
          plan_key: member.plan.plan_key,
          task_id: task.task_id,
        });
      }
      const key = taskKey(member.plan.project_id, member.plan.plan_key, task.task_id);
      if (nodes.has(key)) fail('TODO_STATUS_INVALID_INPUT', 'todo_status_task_duplicate');
      nodes.set(key, {
        key,
        project_id: member.plan.project_id,
        plan_key: member.plan.plan_key,
        task_id: task.task_id,
        ...todoStatusTaskDisplay(task),
        status: state.status,
        finished: isFinishedTodoTaskState(state),
        blocked_reason: state.blocked_reason,
      });
      incoming.set(key, new Set());
    }
  }

  const addPredecessor = (from, to) => {
    const fromKey = refKey(from);
    const toKey = refKey(to);
    if (!nodes.has(fromKey) || !nodes.has(toKey)) {
      fail('TODO_STATUS_INVALID_INPUT', 'todo_status_dependency_dangling');
    }
    incoming.get(toKey).add(fromKey);
  };
  for (const member of members) {
    for (const edge of member.plan.hard_dependencies) addPredecessor(edge.from, edge.to);
    for (const join of member.plan.joins) {
      for (const after of join.after) addPredecessor(after, join.before);
    }
    if (isDecoupledPhaseTodoPlanSchema(member.plan.schema)) {
      for (const edge of member.plan.phase_accept_dependencies) {
        const target = refKey(edge.to);
        if (!nodes.has(target)) fail('TODO_STATUS_INVALID_INPUT', 'todo_status_dependency_dangling');
      }
    }
  }
  // active plan topologyは追記改変しない。開発中に接続したplan-scoped edgeを同じincomingへ
  // 合成することで、projectTodoStatusとcomputeReadyFrontierが同じ待機判定を即座に読む。
  for (const dependency of projectTodoCrossPlanDependencies(members)) {
    addPredecessor(dependency.from, dependency.to);
  }

  auditPending.sort((left, right) => (
    left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1
      : left.phase_id < right.phase_id ? -1 : left.phase_id > right.phase_id ? 1 : 0));

  coordination.sort((left, right) => (
    left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1 : 0));

  return { nodes, incoming, memberHeads, auditPending, coordination, readiness: createTodoReadiness(readModel) };
}

/** 先行完了とphase gateを満たしたpending taskだけがreadyになる。 */
function isNodeReady(node, { readiness }) {
  return readiness.isReady(node.key);
}

/**
 * ready frontierだけをread-only投影する。
 *
 * `todo status`の`next_ready`と同じ計算・同じ順序を返す。independence投影が
 * ready集合を別実装で持たないための共有入口である。
 */
export function computeReadyFrontier(readModel) {
  const graph = buildTodoGraph(readModel);
  const ready = [...graph.nodes.values()]
    .filter((node) => isNodeReady(node, graph))
    .map((node) => ({ plan_key: node.plan_key, task_id: node.task_id, label: node.label,
      done_condition: node.done_condition }));
  ready.sort(compareTaskEntries);
  enforceListLimit('next_ready', ready);
  return ready;
}

/**
 * dispatch面（`next_ready`／`active_set`／`dispatch_frontier`）だけを見る内部呼び出しが渡す明示の空。
 *
 * `todo start`のready判定・gantt・dashboardの生存判定は、statusのresultを**外へ出さない**。
 * そこでnote chainを読むと、noteの破損がdispatch判定やdashboardの可視性を巻き添えに落とす
 * ——ganttのnote破損は既に警告として表出する契約があり（`notesForGantt`）、二重に落とさない。
 * この定数を使った結果をwireとして出力しないこと。`plan_notes`が常に空になる。
 */
export const TODO_STATUS_DISPATCH_ONLY = Object.freeze({
  planNotes: Object.freeze([]), parallelCandidates: Object.freeze([]),
  structureFinalizations: Object.freeze([]),
});

/**
 * Canonical todo read modelからSessionStart向け現在地をread-only投影する。
 *
 * `planNotes`は**必須**である。plan単位noteはstore read modelに入っていない別chainなので、
 * 読むのは呼び出し側の責務になる。省略を空配列へ丸めると「noteが無い」と「読まなかった」が
 * 同じ形になり、配線を1箇所忘れただけで義務が静かに消える——それはこの欄が塞いでいる穴そのものである。
 * 素材は`readTodoPlanNotesForStatus`（`src/todo-note-store.mjs`）が作り、resultを出力する
 * 呼び出し元だけがそれを渡す。dispatch面しか見ない内部呼び出しは`TODO_STATUS_DISPATCH_ONLY`を使う。
 */
export function projectTodoStatus(readModel, options = undefined) {
  if (!(exactRecord(options, ['planNotes', 'parallelCandidates'])
      || exactRecord(options, ['planNotes', 'parallelCandidates', 'structureFinalizations']))
    || !Array.isArray(options.planNotes)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_plan_notes_missing');
  }
  if (!Array.isArray(options.parallelCandidates)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_parallel_candidates_missing');
  }
  if (options.structureFinalizations !== undefined
    && !Array.isArray(options.structureFinalizations)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_structure_finalizations_invalid');
  }
  const graph = buildTodoGraph(readModel);
  const { nodes, incoming, memberHeads, auditPending, coordination } = graph;
  const planNotes = [...options.planNotes];
  const parallelCandidates = [...options.parallelCandidates];
  const structureFinalizations = [...(options.structureFinalizations ?? [])];

  // u03 A77: output callers get a bounded result that records each cut; dispatch-only callers
  // (never printed) keep full lists and the list limit as before.
  const output = options !== TODO_STATUS_DISPATCH_ONLY;
  const truncated = new Map();
  const cut = (name, value, limit) => {
    if (value.length <= limit) return value;
    const entry = truncated.get(name) ?? { list: name, total: 0, shown: 0 };
    truncated.set(name, entry);
    return value.slice(0, limit);
  };
  const activeSet = [];
  const nextReady = [];
  const blocked = [];
  for (const node of nodes.values()) {
    const task = { plan_key: node.plan_key, task_id: node.task_id, label: node.label };
    if (node.status === 'in-progress') {
      const unmetDependencies = [...incoming.get(node.key)]
        .filter((key) => !nodes.get(key).finished)
        .map((key) => {
          const predecessor = nodes.get(key);
          return { plan_key: predecessor.plan_key, task_id: predecessor.task_id };
        })
        .sort(compareTaskEntries);
      if (!output) enforceListLimit('active_set.unmet_dependencies', unmetDependencies);
      const shownDependencies = cut('active_set.unmet_dependencies', unmetDependencies, TODO_STATUS_LIST_LIMIT);
      if (shownDependencies !== unmetDependencies) {
        const entry = truncated.get('active_set.unmet_dependencies');
        entry.total += unmetDependencies.length; entry.shown += shownDependencies.length;
      }
      activeSet.push({ ...task, unmet_dependencies: shownDependencies });
    }
    if (isNodeReady(node, graph)) nextReady.push({ ...task, done_condition: node.done_condition });
    if (node.status === 'blocked') {
      blocked.push({
        plan_key: node.plan_key,
        task_id: node.task_id,
        reason: todoStatusBlockedReason(node.blocked_reason),
      });
    }
  }
  activeSet.sort(compareTaskEntries);
  nextReady.sort(compareTaskEntries);
  blocked.sort(compareTaskEntries);
  memberHeads.sort((left, right) => left.plan_key < right.plan_key ? -1 : left.plan_key > right.plan_key ? 1 : 0);
  const lists = {
    active_set: activeSet, next_ready: nextReady, blocked, audit_pending: auditPending,
    structure_finalization_pending: structureFinalizations, plan_notes: planNotes,
    coordination, parallel_candidates: parallelCandidates, member_heads: memberHeads,
  };
  const totals = Object.fromEntries(Object.entries(lists).map(([name, value]) => [name, value.length]));
  for (const [name, value] of Object.entries(lists)) {
    if (output) lists[name] = cut(name, value, TODO_STATUS_LIST_LIMIT);
    else enforceListLimit(name, value);
  }
  const findings = readModel.cross_plan_findings ?? [];
  const build = () => {
    for (const [name, value] of Object.entries(lists)) {
      if (value.length < totals[name]) truncated.set(name, { list: name, total: totals[name], shown: value.length });
    }
    const result = {
      schema: TODO_STATUS_SCHEMA,
      project_id: readModel.project_id,
      active_set: lists.active_set,
      next_ready: lists.next_ready,
      dispatch_frontier: dispatchFrontier(readModel.project_id, lists.next_ready),
      blocked: lists.blocked,
      // 監査待ちは`member.phases`だけから作った別の列で、dispatch(next_ready/dispatch_frontier)へは
      // 影響しない。監査が進んでもfrontier_digestは動かない。
      audit_pending: lists.audit_pending,
      // 全task done後、構造finalizationが無い／古いplanだけを別列へ出す。監査状態と
      // dispatch状態を混ぜず、terminal受理へ進めない理由と正規コマンドを同時に示す。
      structure_finalization_pending: lists.structure_finalization_pending,
      // plan単位noteも同じく別の列である。noteの有無・件数はdispatchへ影響しないので、
      // next_ready・dispatch_frontier・frontier_digestはnoteを書いても1バイトも動かない。
      plan_notes: lists.plan_notes,
      // 調整方式の宣言も同じく別の列である。宣言はdispatchを変えない——未宣言でもready
      // frontierは通常どおり出る(ADR 0160・ob04のProtected behavior)。
      coordination: lists.coordination,
      // 並列候補も別の列である。判定が進んでもdispatchは動かない——next_ready・
      // dispatch_frontier・frontier_digestは判定状態を1バイトも含まない（ADR 0063・ob04）。
      parallel_candidates: lists.parallel_candidates,
      // u03 A24/A25b/N6: 陳腐化・消えた越境参照はStoreのfindingで、dispatchを止めない。
      // 一覧で上限に達してもstatusを拒否しないよう、本文は先頭から切り、件数は全数を返す。
      cross_plan_findings: {
        total: findings.length,
        entries: findings.slice(0, TODO_STATUS_FINDING_LIMIT),
      },
      member_heads: lists.member_heads,
      truncated: [...truncated.values()].sort((left, right) => left.list.localeCompare(right.list)),
      result_digest: '',
    };
    result.result_digest = todoSelfDigest(result, 'result_digest');
    if (!validateTodoStatusResult(result)) fail('TODO_STATUS_INVALID_RESULT', 'todo_status_result_invalid');
    return result;
  };
  let result = build();
  // Output only: halve the longest list until the result fits the capture limit (never refuse).
  while (output && Buffer.byteLength(`${JSON.stringify(result)}\n`) > TODO_STATUS_CAPTURE_LIMIT) {
    const [name, value] = Object.entries(lists).sort((left, right) => right[1].length - left[1].length)[0];
    if (value.length === 0) break;
    lists[name] = value.slice(0, Math.floor(value.length / 2));
    result = build();
  }
  return result;
}

export const TODO_BINDING_PROJECTION_SCHEMA = 'lattice.todo_binding_projection.v1';

/**
 * `compile_binding`が設定されたTaskだけを、TODO正本のidentityつきで投影する（ADR 0124）。
 *
 * これはTODO工程storeとruntime実行を結ぶ唯一の公開読み取り面である。host は
 * `compiled_plan_digest`で`runtime_plan.v1`を、`base_sha`でrun requestのbaseを照合し、
 * plan→`executor_packet.v1`→`executor_receipt.v1`（`packet_digest`帰属）まで辿れる。
 *
 * binding投影は`todo_status_result`とは独立した加算の別面である（ADR 0124）。status側の
 * version bump（v4→v5）はこの面の形を動かさない。
 */
export function projectTodoBindings(readModel, { requestedPlanKey = null } = {}) {
  if (!plain(readModel) || readModel.schema !== 'lattice.todo_store_read.v1'
    || !isTodoIdentifier(readModel.project_id) || !Array.isArray(readModel.members)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_status_read_model_invalid');
  }
  if (requestedPlanKey !== null && !isTodoIdentifier(requestedPlanKey)) {
    fail('TODO_STATUS_INVALID_INPUT', 'todo_binding_plan_key_invalid');
  }
  const members = [...readModel.members].sort((left, right) => {
    const leftKey = left?.plan?.plan_key ?? '';
    const rightKey = right?.plan?.plan_key ?? '';
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const bindings = [];
  let matchedPlan = requestedPlanKey === null;
  for (const member of members) {
    const plan = member?.plan;
    if (!plain(plan) || !Array.isArray(plan.tasks)) continue;
    if (requestedPlanKey !== null && plan.plan_key !== requestedPlanKey) continue;
    if (requestedPlanKey !== null) matchedPlan = true;
    for (const task of plan.tasks) {
      if (!plain(task) || task.compile_binding === null || task.compile_binding === undefined) continue;
      bindings.push({
        project_id: plan.project_id,
        plan_key: plan.plan_key,
        plan_version: plan.plan_version,
        task_id: task.task_id,
        compile_binding: task.compile_binding,
      });
      if (bindings.length > TODO_STATUS_LIST_LIMIT) {
        fail('TODO_SCALE_EXCEEDED', 'todo_binding_projection_limit_exceeded', {
          binding_limit: TODO_STATUS_LIST_LIMIT,
        });
      }
    }
  }
  if (!matchedPlan) fail('TODO_STATUS_INVALID_INPUT', 'todo_binding_plan_not_found');
  const result = {
    schema: TODO_BINDING_PROJECTION_SCHEMA,
    project_id: readModel.project_id,
    plan_key: requestedPlanKey,
    bindings,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}
