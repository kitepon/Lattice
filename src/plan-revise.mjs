import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeTodoArtifact, exactRecord, isTodoIdentifier, todoSelfDigest } from './todo-contracts.mjs';
import { gitSync } from './git-process.mjs';
import { completeCreateInput, readAuthoringJsonFile, resolveTodoActor } from './todo-authoring-input.mjs';
import { validatePlanCreateInput } from './project-cli.mjs';
import {
  carriedStartActors, compileBackchainRevision, planSeed, readPlanBackchainBinding, rebindCarriedWork,
} from './plan-backchain.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter, readTodoStore, TodoStoreError,
} from './todo-store.mjs';
import { appendTodoNote } from './todo-note-store.mjs';
import { phaseTodoRevisionPlanVersion, validatePhaseTodoRevision } from './todo-revision.mjs';

export { validateBindingCarry } from './plan-binding-carry.mjs';

const INPUT_SCHEMA = 'lattice.plan_revise_input.v1';

function fail(reason, pointer, detail = {}) {
  throw new TodoStoreError('INPUT_INVALID', reason, undefined, { pointer, ...detail });
}

/**
 * 軽量改訂のphase移行。作成者が書いた手順の改訂は完了済み・進行中でも許すので、
 * taskの文面や辺の変更ではPhaseを巻き込まない。resetするのは次の2つだけ:
 * 1. Phase定義（title・gate_policy・predecessor_phase_ids・required_evidence_slots）が変わった。
 * 2. 新手順の下で再審査が要る task を迎えた——新規task、他Phaseから移ったtask、resetするtask——
 *    で、その行き先の状態がdone/retiredでない。
 * 失うだけ、または完了済みだけを迎えるPhaseは受理済みのまま持ち越す。
 * backchainのcompilePhaseMigrationとは別の規則で、あちらは変えない。
 */
export function compileLightPhaseMigration(previousPlan, desiredSeed, taskMigration, taskStates) {
  const policyById = new Map(taskMigration.map((row) => [row.from_task_id, row.state_policy]));
  const previousById = new Map(previousPlan.tasks.map((task) => [task.task_id, task]));
  const definition = ({ title, gate_policy: gatePolicy, predecessor_phase_ids: predecessors,
    required_evidence_slots: slots }) => canonicalizeTodoArtifact({
    title, gate_policy: gatePolicy, predecessor_phase_ids: predecessors, required_evidence_slots: slots });
  const gaining = new Set();
  for (const task of desiredSeed.tasks) {
    const previous = previousById.get(task.task_id);
    const reset = policyById.get(task.task_id) === 'reset_pending';
    const arrives = previous === undefined || reset || previous.phase_id !== task.phase_id;
    const state = previous === undefined || reset ? 'pending' : taskStates.get(task.task_id);
    if (arrives && !['done', 'retired'].includes(state)) gaining.add(task.phase_id);
  }
  const nextPhases = new Map(desiredSeed.phases.map((phase) => [phase.phase_id, phase]));
  const oldPhaseIds = new Set(previousPlan.phases.map(({ phase_id: id }) => id));
  return [
    ...previousPlan.phases.map((phase) => {
      const next = nextPhases.get(phase.phase_id);
      if (next === undefined) {
        return { from_phase_id: phase.phase_id, to_phase_id: 'removed', state_policy: 'removed' };
      }
      const carry = !gaining.has(phase.phase_id) && definition(phase) === definition(next);
      return { from_phase_id: phase.phase_id, to_phase_id: phase.phase_id,
        state_policy: carry ? 'carry' : 'reset' };
    }),
    ...desiredSeed.phases.filter(({ phase_id: id }) => !oldPhaseIds.has(id))
      .map(({ phase_id: id }) => ({ from_phase_id: null, to_phase_id: id, state_policy: 'reset' })),
  ];
}

const nullable = (value) => (value === undefined ? null : value);

/** 履歴note用に、taskの作成者が書いた面を欄ごとに正準化して返す。 */
function authoredSurface(plan, taskId) {
  const task = plan.tasks.find(({ task_id: id }) => id === taskId);
  const local = (ref) => ref.plan_key === plan.plan_key && ref.task_id === taskId;
  const rows = (list) => canonicalizeTodoArtifact(list.map((row) => canonicalizeTodoArtifact(row)).sort());
  return {
    title: nullable(task.title), lane: task.lane, design_memo: nullable(task.design_memo),
    done_condition: nullable(task.done_condition), narrative_ref: nullable(task.narrative_ref),
    parent_task_id: nullable(task.parent_task_id), phase_id: nullable(task.phase_id),
    incoming_hard_dependencies: rows(plan.hard_dependencies.filter(({ to }) => local(to))),
    outgoing_hard_dependencies: rows(plan.hard_dependencies.filter(({ from }) => local(from))),
    join_memberships: rows(plan.joins.filter(({ before, after }) => local(before) || after.some(local))),
    phase_accept_dependencies: rows((plan.phase_accept_dependencies ?? []).filter(({ to }) => local(to))),
  };
}

/**
 * 改訂の履歴note。変わったcarry taskごとにtask note1件（変わった欄の全列挙つき）と、
 * 取り除いたtaskごとにplan note1件。本文は `plan revise <from>→<to> <task_id>: <reason>`。
 */
export function planRevisionHistoryNotes({ previousPlan, successorPlan, continuity }) {
  const prefix = (taskId) => `plan revise ${previousPlan.plan_version}→${successorPlan.plan_version} ${taskId}:`;
  const notes = [];
  const ordered = [...continuity].sort((left, right) => (
    left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0));
  for (const { task_id: taskId, policy, reason } of ordered) {
    if (policy === 'retire') {
      notes.push({ scope: 'plan', task_id: taskId, body: `${prefix(taskId)} ${reason}` });
    } else if (policy === 'carry') {
      const before = authoredSurface(previousPlan, taskId);
      const after = authoredSurface(successorPlan, taskId);
      const changed = Object.keys(before).filter((field) => before[field] !== after[field]);
      if (changed.length > 0) {
        notes.push({ scope: 'task', task_id: taskId,
          body: `${prefix(taskId)} ${reason}\nchanged: ${changed.join(', ')}` });
      }
    }
  }
  return notes;
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** 公開後にnoteを順に追記する。失敗したら、まだ書けていないnoteと正確な再実行commandを返す。 */
async function appendRevisionHistoryNotes({ repoRoot, revision, notes, actor }) {
  const planKey = revision.plan_key;
  const planVersion = revision.desired_plan.plan_version;
  const pending = [...notes];
  try {
    while (pending.length > 0) {
      const [note] = pending;
      await appendTodoNote({
        repoRoot, projectId: revision.project_id, planKey, planVersion,
        taskId: note.scope === 'task' ? note.task_id : null,
        actor, recordedAt: new Date().toISOString(), body: note.body,
        supersedes: null, eligibleSupersedes: [],
      });
      pending.shift();
    }
  } catch (error) {
    const wrapped = error instanceof TodoStoreError ? error
      : new TodoStoreError('PLAN_HISTORY_NOTE_PENDING', 'history_note_append_failed', undefined,
        { cause: String(error?.message ?? error) });
    wrapped.detail = {
      ...wrapped.detail, revision_applied: true, revision_digest: revision.revision_digest,
      plan_version: planVersion,
      pending_history_notes: pending.map(({ task_id: taskId, body }) => ({ task_id: taskId, body })),
      pending_history_note_commands: pending.map(({ scope, task_id: taskId, body }) => (
        `lattice todo note --plan ${planKey}${scope === 'task' ? ` --task ${taskId}` : ''} --message ${shellQuote(body)}`)),
    };
    throw wrapped;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 継続方針の算出(u03p N5)。先行planの全taskについて、desiredに在れば作成者の carry/reset
 * (無ければcarry)、無ければretire。desiredの在不在が優先され、読めない入力だけを拒否する。
 */
function computeContinuity(member, input, desiredIds) {
  const entries = input.continuity ?? [];
  if (!Array.isArray(entries)) fail('plan_revise_continuity_invalid', '/continuity');
  const oldIds = new Set(member.plan.tasks.map(({ task_id }) => task_id));
  const decisions = new Map();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || !Object.keys(entry).every((key) => ['task_id', 'policy', 'reason'].includes(key))
      || !isTodoIdentifier(entry.task_id) || !['carry', 'reset', 'retire'].includes(entry.policy)
      || (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.trim().length === 0))
      || !oldIds.has(entry.task_id) || decisions.has(entry.task_id)) {
      fail('plan_revise_continuity_invalid', `/continuity/${index}`);
    }
    decisions.set(entry.task_id, entry);
  }
  return member.plan.tasks.map(({ task_id: taskId }) => {
    const entry = decisions.get(taskId);
    const policy = !desiredIds.has(taskId) ? 'retire'
      : entry === undefined || entry.policy === 'retire' ? 'carry' : entry.policy;
    return { task_id: taskId, policy,
      reason: entry?.policy === policy && entry.reason !== undefined ? entry.reason : `computed ${policy}` };
  });
}

/** 入力の検査と補完。desired(補完済み)と算出した継続方針を返す。 */
export function resolvePlanRevision({ member, input, env = process.env, now = new Date() }) {
  if (!exactRecord(input, ['schema', 'desired', 'continuity'])
    && !exactRecord(input, ['schema', 'desired'])) {
    fail('plan_revise_schema_invalid', '/', { expected: INPUT_SCHEMA });
  }
  if (input.schema !== INPUT_SCHEMA) fail('plan_revise_schema_invalid', '/', { expected: INPUT_SCHEMA });
  // a31: 無いplanは補完の前に断る。補完は現行planの値を使うので、無いplanでは「欄を足せ」に化ける。
  if (member === undefined) {
    const planKey = typeof input.desired?.plan_key === 'string' ? input.desired.plan_key : null;
    fail('plan_not_active', '/desired/plan_key', {
      plan_key: planKey,
      next_action: `No active plan ${planKey === null ? 'with that plan_key' : `'${planKey}'`}: make it as a new plan with \`lattice plan create --input <file>\` (the plan itself, without the revise wrapper); to revise an existing one, set plan_key to one listed by \`lattice todo status --json\`.`,
    });
  }
  // a17: 改訂は既存planの上で行うので、project_id・plan_versionは書かなければ現行planの値で埋まる。
  const desired = completeCreateInput(input.desired, {
    env, now, projectId: member?.plan.project_id, planVersion: member?.plan.plan_version,
  });
  try { validatePlanCreateInput(desired); }
  catch (error) {
    if (typeof error?.detail?.pointer === 'string') {
      error.detail.pointer = `/desired${error.detail.pointer === '/' ? '' : error.detail.pointer}`;
    }
    throw error;
  }
  // 軽量改訂は設計メモを持つ現行plan(v7/v8)の後継を作る。v1〜v3入力は新規作成だけに使える。
  if (!['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5'].includes(desired.schema)) {
    fail('plan_revise_desired_schema_unsupported', '/desired/schema', {
      accepted: ['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5'],
      actual: desired.schema, next_action: 'lattice plan create --schema-version 5 --json',
    });
  }
  if (member.plan.schema === 'lattice.todo_plan.v6'
    || member.journal.events[0].schema === 'lattice.todo_event.v2'
    || [...member.plan.tasks, ...desired.tasks].some((task) => task.narrative_anchor !== null)) {
    fail('plan_revise_requires_source_revision', '/desired/tasks', {
      next_action: `lattice todo revise-phase --plan ${desired.plan_key} --input <phase-revision.json>`,
    });
  }
  if (!['lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(member.plan.schema)) {
    fail('predecessor_plan_schema_unsupported', '/desired/plan_key');
  }
  if (desired.project_id !== member.plan.project_id) {
    fail('plan_revise_identity_mismatch', '/desired/project_id', {
      expected: member.plan.project_id, actual: desired.project_id,
      next_action: `Omit /desired/project_id (the machine fills "${member.plan.project_id}") or set it to "${member.plan.project_id}".`,
    });
  }
  if (desired.plan_key !== member.plan.plan_key) {
    fail('plan_revise_identity_mismatch', '/desired/plan_key');
  }
  const continuity = computeContinuity(member, input,
    new Set(desired.tasks.map(({ task_id }) => task_id)));
  return { desired, continuity };
}

export function compilePlanRevision({ member, input, env, now }) {
  const { desired, continuity } = resolvePlanRevision({ member, input, env, now });
  return compileLightRevision({ member, desired, continuity });
}

function compileLightRevision({ member, desired, continuity }) {
  const taskMigration = continuity.map(({ task_id: id, policy }) => ({
    from_task_id: id, to_task_id: policy === 'retire' ? 'removed' : id,
    state_policy: policy === 'retire' ? 'removed'
      : policy === 'carry' ? 'carry_reconciled_metadata' : 'reset_pending' }));
  const predecessor = {
    plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version,
  };
  const seed = planSeed(desired, predecessor.plan_digest, member.plan);
  const phaseMigration = compileLightPhaseMigration(member.plan, seed, taskMigration,
    new Map(member.tasks.map(({ task_id: id, status }) => [id, status])));
  const version = phaseTodoRevisionPlanVersion({
    projectId: desired.project_id, planKey: desired.plan_key, predecessor,
    desiredPlan: seed, taskMigration, phaseMigration,
  });
  const revision = {
    schema: 'lattice.phase_todo_revision.v5', project_id: desired.project_id,
    plan_key: desired.plan_key, predecessor,
    desired_plan: buildTodoPlan({ ...seed, plan_version: version }),
    task_migration: taskMigration, phase_migration: phaseMigration, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

/**
 * backchain束縛plan(u03p N3): 束縛済みの機能連鎖を後継の元にする。tasksはdesiredの各taskに1件
 * (残るtaskは連鎖の項目を保ち、新しいtaskは空の項目)、continuityは算出値。目標と機能は変えない。
 */
function successorBackchain(chain, desired, continuity) {
  const entries = new Map(chain.tasks.map((entry) => [entry.task_id, entry]));
  const successor = { ...chain, continuity,
    tasks: desired.tasks.map(({ task_id: taskId }) => entries.get(taskId)
      ?? { task_id: taskId, requires_feature_ids: [], provides_feature_ids: [] }),
    chain_digest: '' };
  successor.chain_digest = todoSelfDigest(successor, 'chain_digest');
  return successor;
}

export async function planReviseSchema() {
  return JSON.parse(await readFile(new URL('../docs/schemas/lattice.plan_revise_input.v1.schema.json', import.meta.url)));
}

/**
 * 軽量改訂でそのまま表せるmemberか(a14)。resolvePlanRevisionと作成入力の検査が断る形
 * (v7/v8以外・源泉束縛・旧event・compile_binding付きtask)ならfalse。書く前の判定にだけ使う。
 */
export function lightRevisionExpresses(member) {
  return ['lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(member.plan.schema)
    && member.journal.events[0]?.schema !== 'lattice.todo_event.v2'
    && member.plan.tasks.every((task) => task.narrative_anchor === null && task.compile_binding === null);
}

/**
 * 現行plan(v7/v8)をそのまま作成入力にする(a14)。辺の追加・削除など、planの一部だけを変える
 * 軽量改訂の「いまの姿」を作る。v8はcreate v5、v7はcreate v4。continuityは付けない(全taskがcarry)。
 * 源泉束縛planと旧schemaは `plan revise` と同じ理由で拒否する。
 */
export function desiredFromPlan(plan, { env = process.env, now = new Date() } = {}) {
  if (plan.schema === 'lattice.todo_plan.v6' || plan.tasks.some((task) => task.narrative_anchor !== null)) {
    fail('plan_revise_requires_source_revision', '/desired/tasks', {
      next_action: `lattice todo revise-phase --plan ${plan.plan_key} --input <phase-revision.json>`,
    });
  }
  if (!['lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(plan.schema)) {
    fail('predecessor_plan_schema_unsupported', '/desired/plan_key');
  }
  const edge = ({ from, to }) => ({
    from: { project_id: from.project_id, plan_key: from.plan_key, task_id: from.task_id },
    to: { project_id: to.project_id, plan_key: to.plan_key, task_id: to.task_id } });
  return {
    schema: plan.schema === 'lattice.todo_plan.v8'
      ? 'lattice.plan_create_input.v5' : 'lattice.plan_create_input.v4',
    project_id: plan.project_id, plan_key: plan.plan_key, plan_version: plan.plan_version,
    actor: resolveTodoActor(env), recorded_at: now.toISOString(),
    tasks: plan.tasks, phases: plan.phases,
    hard_dependencies: plan.hard_dependencies.map(edge), joins: plan.joins,
    phase_accept_dependencies: plan.phase_accept_dependencies,
  };
}

/**
 * 軽量改訂の適用。入力(`plan_revise_input.v1`)を補完・検査し、算出した継続方針で改訂を作り、
 * 公開→履歴note→作業中taskの結び直しまで行って、結果artifactを返す(印字はしない)。
 * notes: 履歴noteへ足す plan scope の追加note([{task_id, body}])。公開後に改訂noteと同じ経路で追記する。
 */
/**
 * a31: 作成・追加・改訂は同じ入力の形を持つ（seat contract）。`desired`で包まないplan create入力は
 * そのまま望む全体として読み、継続方針は機械が算出する。包んだ形（continuity付き）もそのまま受ける。
 */
export function isBareCreateInput(input) {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && !('desired' in input) && Array.isArray(input.tasks)
    && (input.schema === undefined || /^lattice\.plan_create_input\.v[0-9]+$/u.test(input.schema));
}

/** 包まない入力の拒否は、包みの`/desired`を名指さない。 */
function unwrapPointers(error) {
  const detail = error?.detail;
  if (detail === null || typeof detail !== 'object') return error;
  if (typeof detail.pointer === 'string' && detail.pointer.startsWith('/desired')) {
    detail.pointer = detail.pointer.slice('/desired'.length) || '/';
  }
  if (typeof detail.next_action === 'string') {
    detail.next_action = detail.next_action.replaceAll('/desired/', '/');
  }
  for (const problem of Array.isArray(detail.problems) ? detail.problems : []) {
    if (typeof problem?.pointer === 'string' && problem.pointer.startsWith('/desired')) {
      problem.pointer = problem.pointer.slice('/desired'.length) || '/';
    }
  }
  return error;
}

export async function applyPlanRevision({
  repoRoot, input: authored, env = process.env, dryRun = false, notes: extraNotes = [],
}) {
  const bare = isBareCreateInput(authored);
  const input = bare ? { schema: INPUT_SCHEMA, desired: authored } : authored;
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ plan }) => plan.plan_key === input?.desired?.plan_key);
  let resolved;
  try { resolved = resolvePlanRevision({ member, input, env, now: new Date() }); }
  catch (error) { throw bare ? unwrapPointers(error) : error; }
  const { desired, continuity } = resolved;
  // 集合の並びは正準化済みなので、同じ内容の別の並びは「変更なし」になる。
  const unchanged = continuity.every(({ policy }) => policy === 'carry')
    && canonicalizeTodoArtifact(planSeed(desired, null, member.plan))
      === canonicalizeTodoArtifact(planSeed(member.plan, null));
  const binding = await readPlanBackchainBinding({ repoRoot, plan: member.plan });
  let revision;
  let featureChainFindings = null;
  if (binding !== null && !unchanged) {
    ({ revision, findings: featureChainFindings } = await compileBackchainRevision({
      repoRoot, member, authoring: desired,
      chain: successorBackchain(binding.chain, desired, continuity) }));
  } else {
    revision = compileLightRevision({ member, desired, continuity });
    if (!unchanged && !validatePhaseTodoRevision(revision)) fail('plan_revise_artifact_invalid', '/');
  }
  let applied = null;
  let reboundTaskIds = [];
  if (!dryRun) {
    if (!unchanged) {
      applied = await applyPhaseTodoRevision({ repoRoot,
        writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision,
        actor: desired.actor, recordedAt: desired.recorded_at,
      });
      await appendRevisionHistoryNotes({ repoRoot, revision, actor: desired.actor,
        notes: [...planRevisionHistoryNotes({ previousPlan: member.plan,
          successorPlan: revision.desired_plan, continuity }),
        ...extraNotes.map(({ task_id: taskId, body: text }) => ({ scope: 'plan', task_id: taskId, body: text }))] });
    }
    try {
      reboundTaskIds = await rebindCarriedWork({ repoRoot, planKey: revision.plan_key, env,
        reason: '工程改訂後のplan versionへ作業中ToDoを結び直す',
        failureCode: 'PLAN_REBIND_PENDING', carriedActors: carriedStartActors(member) });
    } catch (error) {
      // 公開後に起きたStoreの失敗は、改訂が確定済みであることを必ず報告する（2026-11-07
      // 初回使用: rebind読込の素のbinding_staleが公開済み事実を隠した）
      if (error instanceof TodoStoreError) {
        error.detail = { ...error.detail, revision_applied: !unchanged,
          revision_digest: unchanged ? null : revision.revision_digest,
          plan_version: unchanged ? member.plan.plan_version : revision.desired_plan.plan_version };
      }
      throw error;
    }
  }
  const result = {
    schema: unchanged ? 'lattice.plan_revise_unchanged.v1' : 'lattice.plan_revise_result.v1',
    project_id: revision.project_id, plan_key: revision.plan_key,
    plan_version: unchanged ? member.plan.plan_version : revision.desired_plan.plan_version,
    dry_run: dryRun, revision: unchanged ? null : revision, applied,
    continuity, rebound_task_ids: reboundTaskIds,
    ...(featureChainFindings === null ? {} : { feature_chain_findings: featureChainFindings }),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

export async function runPlanRevise({ cwd, inputRef, stdout, dryRun = false, env = process.env }) {
  let repoRoot;
  try {
    repoRoot = path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch { throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved'); }
  const input = await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode: 'INPUT_INVALID' });
  const result = await applyPlanRevision({ repoRoot, input, env, dryRun });
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
