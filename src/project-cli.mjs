import { gitSync } from './git-process.mjs';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import {
  TODO_DESIGN_MEMO_PROMPT,
  exactRecord,
  explainTodoDesignMemo,
  isTodoDesignMemo,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoIdentifier,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { projectTodoStatus } from './todo-status.mjs';
import { readTodoPlanNotesForStatus } from './todo-note-store.mjs';
import { projectIndependenceFrontier } from './todo-independence.mjs';
import { readTodoParallelCandidatesForStatus } from './todo-parallel-candidates.mjs';
import {
  readTodoStructureArtifactDiagnostics,
  readTodoStructureFinalizationsForStatus,
} from './todo-structure-store.mjs';
import { isTodoIndependenceLegacyMarker } from './todo-independence-contracts.mjs';
import { selectIndependenceGuidance } from './todo-independence-guidance.mjs';
import { ensureTodoDashboardActivity } from './todo-dashboard-registry.mjs';
import { reportProjectDashboardDelivery } from './dashboard-delivery.mjs';
import { resolveProjectIdentity } from './project-identity.mjs';
import {
  buildTodoPlan,
  createTodoStoreWriter,
  initializeAuthoredTodoStore,
  isPhaselessTodoPlanSchema,
  readTodoIndependenceArtifact,
  readTodoStore,
  TodoStoreError,
} from './todo-store.mjs';
import {
  computeTodoDispatchShapeForPlan,
} from './todo-dispatch-shape.mjs';
import { readAuthoringJsonFile } from './todo-authoring-input.mjs';

const STORE_REF = '.lattice/todo';
const MANIFEST_REF = `${STORE_REF}/manifest.json`;
const STATUS_SCHEMA = 'lattice.project_status.v1';
const SESSION_CONTEXT_SCHEMA = 'lattice.session_context.v1';
/** HEADが読めない環境でも投影を組めるようにする。記録があるときは実HEADで置き換わる。 */
const PLACEHOLDER_SHA = '0'.repeat(40);
const CREATE_INPUT_SCHEMA = 'lattice.plan_create_input.v1';
const PHASE_CREATE_INPUT_SCHEMA = 'lattice.plan_create_input.v2';
const DECOUPLED_PHASE_CREATE_INPUT_SCHEMA = 'lattice.plan_create_input.v3';
const MEMO_PHASE_CREATE_INPUT_SCHEMA = 'lattice.plan_create_input.v4';
const CURRENT_CREATE_INPUT_SCHEMA = MEMO_PHASE_CREATE_INPUT_SCHEMA;
const CURRENT_CREATE_SCHEMA_COMMAND = 'lattice plan create --schema-version 4 --json';
const CREATE_RESULT_SCHEMA = 'lattice.plan_create_result.v1';

function resolveRepoRoot(cwd) {
  try {
    // gitはWindowsでもforward slashを返すため、OS nativeへ正規化して
    // path.join由来のabsolute_pathと区切りを揃える。末尾newline以外（末尾空白等）は改変しない。
    return path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch {
    return null;
  }
}

function gitHead(repoRoot) {
  try {
    return gitSync(['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, '');
  } catch {
    return null;
  }
}

function resultDigest(value) {
  return todoSelfDigest(value, 'result_digest');
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function validateProjectStatus(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'cli', 'project', 'state', 'store', 'active_plans', 'active_runs',
      'can_create_plan', 'next_action', 'result_digest',
    ]) || value.schema !== STATUS_SCHEMA
      || !exactRecord(value.cli, ['available', 'version']) || value.cli.available !== true
      || typeof value.cli.version !== 'string' || value.cli.version.length > 64
      || !['uninitialized', 'ready', 'active_run', 'invalid'].includes(value.state)
      || !exactRecord(value.store, ['ref', 'absolute_path']) || value.store.ref !== STORE_REF
      || (value.store.absolute_path !== null && typeof value.store.absolute_path !== 'string')
      || !Array.isArray(value.active_plans) || value.active_plans.length > 256
      || !value.active_plans.every((entry) => exactRecord(entry, ['plan_key', 'plan_version'])
        && isTodoIdentifier(entry.plan_key) && isTodoIdentifier(entry.plan_version))
      || !Array.isArray(value.active_runs) || value.active_runs.length > 2_000
      || !value.active_runs.every((entry) => exactRecord(entry, ['plan_key', 'task_id', 'label'])
        && isTodoIdentifier(entry.plan_key) && isTodoIdentifier(entry.task_id)
        && typeof entry.label === 'string' && [...entry.label].length > 0 && [...entry.label].length <= 160)
      || typeof value.can_create_plan !== 'boolean' || !plain(value.next_action)
      || typeof value.next_action.command !== 'string' || value.next_action.command.length === 0
      || !isTodoDigest(value.result_digest) || value.result_digest !== resultDigest(value)) return false;
    if (value.project !== null && (!exactRecord(value.project, ['root', 'git_head', 'project_id'])
      || typeof value.project.root !== 'string' || value.project.root.length === 0
      || (value.project.git_head !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.project.git_head))
      || (value.project.project_id !== null && !isTodoIdentifier(value.project.project_id)))) return false;
    if (value.state === 'uninitialized') {
      return value.project !== null && value.project.project_id === null && value.can_create_plan === true
        && exactRecord(value.next_action, ['command', 'input_schema', 'schema_command'])
        && value.next_action.input_schema === CURRENT_CREATE_INPUT_SCHEMA
        && value.next_action.schema_command === CURRENT_CREATE_SCHEMA_COMMAND;
    }
    if (value.state === 'invalid') {
      return value.can_create_plan === false && exactRecord(value.next_action, ['command', 'reason'])
        && typeof value.next_action.reason === 'string' && value.next_action.reason.length > 0;
    }
    return value.project !== null && isTodoIdentifier(value.project.project_id)
      && value.can_create_plan === false && exactRecord(value.next_action, ['command', 'reason'])
      && typeof value.next_action.reason === 'string' && value.next_action.reason.length > 0
      && (value.state !== 'active_run' || value.active_runs.length > 0)
      && (value.state !== 'ready' || value.active_runs.length === 0);
  } catch { return false; }
}

/**
 * readyのあるplanについてだけ並列可否を要約する（ADR 0131 Decision 5）。
 *
 * store読みは呼び出し側が済ませている。ここが払うのはplanごとの小さな記録ファイルと、
 * 記録があるときだけのHEAD照合である。readyが無いplanは述べる対象が無いので載せない。
 */
async function summarizeIndependence({ repoRoot, store, todo }) {
  const readyPlanKeys = [...new Set(todo.next_ready.map(({ plan_key: key }) => key))].sort();
  if (readyPlanKeys.length === 0) return [];
  const activeByPlan = new Map();
  for (const task of todo.active_set) {
    if (!activeByPlan.has(task.plan_key)) activeByPlan.set(task.plan_key, []);
    activeByPlan.get(task.plan_key).push(task.task_id);
  }
  let currentBaseSha = null;
  const summaries = [];
  for (const planKey of readyPlanKeys) {
    const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
    if (member === undefined) continue;
    let artifact = null;
    try {
      artifact = await readTodoIndependenceArtifact({ repoRoot, store, planKey });
    } catch (error) {
      // 読めない記録を「記録なし」へ丸めない。理由を載せて先へ進む。
      summaries.push({
        plan_key: planKey, coverage: null,
        guidance: { code: 'independence_unrecorded', message: null, next_action: 'none' },
        unreadable_reason: error instanceof TodoStoreError
          ? `${error.code}:${error.detail?.reason ?? error.message}` : 'independence_unreadable',
        parallel_groups: [], serialize_pair_count: 0,
        conflict_with_active_count: 0, unknown_task_ids: [],
      });
      continue;
    }
    if (currentBaseSha === null && artifact !== null) currentBaseSha = gitHead(repoRoot);
    const projected = projectIndependenceFrontier({
      artifact,
      readyTaskIds: todo.next_ready.filter((task) => task.plan_key === planKey)
        .map(({ task_id: taskId }) => taskId),
      activeTaskIds: activeByPlan.get(planKey) ?? [],
      plan: member.plan,
      currentBaseSha: currentBaseSha ?? PLACEHOLDER_SHA,
      changedPaths: null,
    });
    summaries.push({
      plan_key: planKey,
      coverage: projected.coverage,
      guidance: selectIndependenceGuidance({
        coverage: projected.coverage,
        contractSuperseded: isTodoIndependenceLegacyMarker(artifact),
        readyCount: todo.next_ready.filter((task) => task.plan_key === planKey).length,
        taskDeclared: projected.frontier.unknown
          .every(({ unknowns }) => !unknowns.some(({ kind }) => kind === 'witness_missing')),
        taskStale: projected.frontier.unknown
          .some(({ unknowns }) => unknowns.some(({ kind }) => kind === 'record_stale')),
        conflictWithActive: projected.frontier.conflicts_with_active[0]?.severability ?? null,
        conflictBetweenReady: projected.frontier.serialize_pairs[0]?.severability ?? null,
        coordinationMode: member.coordination?.mode ?? null,
      }),
      unreadable_reason: null,
      parallel_groups: projected.frontier.parallel_groups.map(({ task_ids: ids }) => [...ids]),
      serialize_pair_count: projected.frontier.serialize_pairs.length,
      conflict_with_active_count: projected.frontier.conflicts_with_active.length,
      unknown_task_ids: projected.frontier.unknown.map(({ task_id: taskId }) => taskId),
    });
  }
  return summaries;
}

function statusResult(fields) {
  const result = { schema: STATUS_SCHEMA, ...fields, result_digest: '' };
  result.result_digest = resultDigest(result);
  if (!validateProjectStatus(result)) throw new TypeError('project status result contract invalid');
  return result;
}

function invalidStatus({ cliVersion, repoRoot, reason, nextAction = null }) {
  return statusResult({
    cli: { available: true, version: cliVersion },
    project: repoRoot === null ? null : { root: repoRoot, git_head: gitHead(repoRoot), project_id: null },
    state: 'invalid',
    store: { ref: STORE_REF, absolute_path: repoRoot === null ? null : path.join(repoRoot, STORE_REF) },
    active_plans: [], active_runs: [], can_create_plan: false,
    next_action: nextAction ?? {
      command: repoRoot === null ? 'git status' : 'lattice todo verify', reason,
    },
  });
}

/**
 * discoveryとstore読みを1回で済ませ、status結果と（読めたなら）storeを返す。
 *
 * `runProjectStatus`と`runSessionContext`が同じ判定を二度書かないための共有点。
 * store読みはここでしか行わない——session開始経路が同じstoreを二度払っていたのが
 * ADR 0131で直した欠陥である。
 */
async function resolveProjectState({ cwd, cliVersion, diagnoseStructureArtifacts = false }) {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === null) {
    return { exitCode: 1, repoRoot: null, store: null, todo: null,
      result: invalidStatus({ cliVersion, repoRoot: null, reason: 'git_repository_unresolved' }) };
  }
  const storeAbsolute = path.join(repoRoot, STORE_REF);
  const manifestAbsolute = path.join(repoRoot, MANIFEST_REF);
  const latticeAbsolute = path.join(repoRoot, '.lattice');
  let latticeState;
  let storeState;
  let manifestState;
  const invalid = (reason) => ({
    exitCode: 1, repoRoot, store: null, todo: null,
    result: invalidStatus({ cliVersion, repoRoot, reason }),
  });
  try { latticeState = await lstat(latticeAbsolute); } catch (error) {
    if (error?.code !== 'ENOENT') return invalid('lattice_root_unreadable');
  }
  if (latticeState !== undefined && (latticeState.isSymbolicLink() || !latticeState.isDirectory())) {
    return invalid('lattice_root_invalid');
  }
  try { storeState = await lstat(storeAbsolute); } catch (error) {
    if (error?.code !== 'ENOENT') return invalid('store_unreadable');
  }
  try { manifestState = await lstat(manifestAbsolute); } catch (error) {
    if (error?.code !== 'ENOENT') return invalid('manifest_unreadable');
  }
  if (storeState === undefined && manifestState === undefined) {
    return { exitCode: 0, repoRoot, store: null, todo: null, result: statusResult({
      cli: { available: true, version: cliVersion },
      project: { root: repoRoot, git_head: gitHead(repoRoot), project_id: null },
      state: 'uninitialized',
      store: { ref: STORE_REF, absolute_path: storeAbsolute },
      active_plans: [], active_runs: [], can_create_plan: true,
      next_action: {
        command: 'lattice plan create --input .lattice/plan-create.json',
        input_schema: CURRENT_CREATE_INPUT_SCHEMA,
        schema_command: CURRENT_CREATE_SCHEMA_COMMAND,
      },
    }) };
  }
  if (storeState?.isSymbolicLink() || !storeState?.isDirectory()
    || manifestState?.isSymbolicLink() || !manifestState?.isFile()) {
    return invalid('store_layout_invalid');
  }
  try {
    const store = await readTodoStore({ repoRoot });
    if (diagnoseStructureArtifacts) {
      const diagnostics = await readTodoStructureArtifactDiagnostics({ repoRoot, store });
      if (diagnostics.length > 0) {
        throw new TodoStoreError(
          'STRUCTURE_ARTIFACT_INVALID', diagnostics[0].reason, undefined, { diagnostics },
        );
      }
    }
    const todo = projectTodoStatus(store, {
      planNotes: await readTodoPlanNotesForStatus({ repoRoot, store }),
      parallelCandidates: await readTodoParallelCandidatesForStatus({ repoRoot, store, gitHead }),
      structureFinalizations: await readTodoStructureFinalizationsForStatus({ repoRoot, store }),
    });
    const activeRuns = todo.active_set.map((entry) => ({
      plan_key: entry.plan_key, task_id: entry.task_id, label: entry.label,
    }));
    const state = activeRuns.length > 0 ? 'active_run' : 'ready';
    const next = activeRuns.length > 0
      ? { command: 'lattice todo status', reason: 'active_run_present' }
      : todo.next_ready.length > 0
        ? { command: `lattice todo start --plan ${todo.next_ready[0].plan_key} --task ${todo.next_ready[0].task_id}${todo.next_ready.length > 1 ? ' --parallel-frontier' : ''}`,
          reason: todo.next_ready.length > 1 ? 'parallel_frontier_present' : 'next_ready_present' }
        // 監査／構造finalization待ちが在る限り「残作業なし」と答えない。優先順位は
        // active_run > next_ready > structure finalization > audit_pending > なし。
        // ready frontierが在る間はADR 0063の並列開始コマンドが勝つ
        // ——ここを監査で上書きするとdispatchが再直列化する。監査待ちはtodo statusの
        // audit_pending欄に常在するので、順位を下げても消えない。
        // commandはverbatim実行可能で読み取り専用のものにする。`phase review`は
        // `--reason <text>`のplaceholderを含みjournalを書き換えるので置かない
        // （`todo phase status`の結果には既に両分岐のguidanceが載っている）。
        : todo.structure_finalization_pending.length > 0
          ? { command: todo.structure_finalization_pending[0].next_commands[0],
            reason: 'structure_finalization_pending' }
          : todo.audit_pending.length > 0
          ? { command: `lattice todo phase status --plan ${todo.audit_pending[0].plan_key}`,
            reason: 'audit_pending' }
          : { command: 'lattice todo status', reason: 'no_ready_task' };
    const result = statusResult({
      cli: { available: true, version: cliVersion },
      project: { root: repoRoot, git_head: gitHead(repoRoot), project_id: store.project_id },
      state,
      store: { ref: STORE_REF, absolute_path: storeAbsolute },
      active_plans: todo.member_heads.map((entry) => ({
        plan_key: entry.plan_key, plan_version: entry.plan_version,
      })),
      active_runs: activeRuns,
      can_create_plan: false,
      next_action: next,
    });
    return { exitCode: 0, repoRoot, store, todo, result };
  } catch (error) {
    if (error?.code === 'STRUCTURE_ARTIFACT_INVALID') throw error;
    const reason = error instanceof TodoStoreError
      ? `${error.code}:${error.detail?.reason ?? error.message}` : 'store_validation_failed';
    const nextAction = error instanceof TodoStoreError
      && error.detail?.next_action === 'lattice todo repair-eol --json'
      ? { command: error.detail.next_action, reason: `${reason}:${error.detail.ref}` }
      : null;
    return {
      exitCode: 1, repoRoot, store: null, todo: null,
      result: invalidStatus({ cliVersion, repoRoot, reason, nextAction }),
    };
  }
}

export async function runProjectStatus({ cwd, stdout, stderr = process.stderr, cliVersion, env = process.env,
  ensureDashboardActivity = ensureTodoDashboardActivity,
  reportDelivery = reportProjectDashboardDelivery }) {
  const state = await resolveProjectState({
    cwd, cliVersion, diagnoseStructureArtifacts: true,
  });
  // dashboard活動の登録はdiscovery面の副作用として維持する（ADR 0131 Decision 4で
  // session-context側だけが持たない、と決めた面である）。
  if (state.store !== null && env.LATTICE_DASHBOARD_AUTOSTART !== '0') {
    try {
      const identity = await resolveProjectIdentity({
        repoRoot: state.repoRoot, projectId: state.store.project_id, env,
      });
      const actorSession = env.LATTICE_TODO_ACTOR_SESSION;
      const activity = await ensureDashboardActivity({
        repoRoot: state.repoRoot, projectId: state.store.project_id,
        displayName: identity.displayName,
        sessionId: isTodoIdentifier(actorSession) ? actorSession : `status-${process.pid}`, env,
      });
      if (activity !== undefined) {
        await reportDelivery({ projectId: state.store.project_id, env, stderr });
      }
    } catch (error) {
      // dashboardはdiscoveryの副作用。statusをdashboard故障で止めない（ADR 0181）。
      stderr.write(`${JSON.stringify({ schema: 'lattice.dashboard_delivery.v1', state: 'failed',
        reason: error.code ?? 'DASHBOARD_FAILED', project_ids: [state.store.project_id], urls: [],
        next_action: 'lattice todo dashboard ensure --json' })}\n`);
    }
  }
  stdout.write(`${JSON.stringify(state.result)}\n`);
  return state.exitCode;
}

/**
 * session開始時の現在地を1プロセス・1 store読みで返す（ADR 0131）。
 *
 * `lattice status`と`lattice todo status`は同じ`readTodoStore`を別プロセスで二重に払う。
 * hostのSessionStartはその両方を呼ぶため、storeが育ったprojectでは実行枠を超えて
 * 案内ごと捨てられていた。ここは合成であって置き換えではない——既存2面は不変で、
 * それぞれの消費者を持ち続ける。
 *
 * dashboard活動の登録は行わない。現在地を知るために呼ぶ面であり、常駐面を起こす面ではない。
 */
export async function runSessionContext({ cwd, stdout, cliVersion }) {
  const state = await resolveProjectState({ cwd, cliVersion });
  const independence = state.store === null || state.todo === null
    ? [] : await summarizeIndependence({ repoRoot: state.repoRoot, store: state.store, todo: state.todo });
  const result = {
    schema: SESSION_CONTEXT_SCHEMA,
    // project discoveryの答えをそのまま埋める。hostは既存の検証器を再利用できる。
    status: state.result,
    // todoは`lattice todo status`のresultそのもの。新しい意味論を発明しない。
    todo: state.todo,
    independence,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  stdout.write(`${JSON.stringify(result)}\n`);
  return state.exitCode;
}

async function readCanonicalInput(repoRoot, inputRef) {
  try {
    return await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode: 'INPUT_INVALID' });
  } catch (error) {
    if (error instanceof TodoStoreError && [
      'INPUT_UNREADABLE', 'INPUT_TOO_LARGE', 'INVALID_JSON',
    ].includes(error.code)) {
      throw new TodoStoreError('INPUT_INVALID', error.detail?.reason ?? 'input_unreadable', undefined,
        error.detail);
    }
    throw error;
  }
}

/**
 * buildTodoPlanは通ったか否かしか返さない。authorが実際に書くtasks・phasesについて、
 * 落ちた最初の条件をpointer付きで名指しする。ここで拾えない違反だけ総称へ落とす。
 * 整列要求（task_id昇順など）はJSON Schemaに書けないので、ここが唯一の案内面になる。
 */
function describePlanShapeViolation(value, { phaseInput }) {
  const TASK_KEYS = ['task_id', 'title', 'lane', 'design_memo', 'narrative_ref',
    'narrative_anchor', 'compile_binding', 'parent_task_id', 'phase_id'];
  const PHASE_KEYS = ['phase_id', 'title', 'gate_policy', 'predecessor_phase_ids',
    'required_evidence_slots'];

  if (value.tasks.length === 0) {
    return { violation_kind: 'empty', pointer: '/tasks',
      expected: { min_items: 1 }, actual: { length: 0 } };
  }
  for (const [index, task] of value.tasks.entries()) {
    if (!exactRecord(task, TASK_KEYS)) {
      return { violation_kind: 'unexpected_or_missing_keys', pointer: `/tasks/${index}`,
        expected: { keys: [...TASK_KEYS].sort() },
        actual: (task === null || typeof task !== 'object')
          ? { type: task === null ? 'null' : typeof task }
          : { keys: Object.keys(task).sort() } };
    }
    for (const field of ['task_id', 'lane', 'phase_id']) {
      if (!isTodoIdentifier(task[field])) {
        return { violation_kind: 'identifier_invalid', pointer: `/tasks/${index}/${field}`,
          expected: { format: 'todo_identifier' }, actual: task[field] };
      }
    }
    if (index > 0 && !(value.tasks[index - 1].task_id < task.task_id)) {
      return { violation_kind: 'unsorted', pointer: `/tasks/${index}/task_id`,
        expected: { greater_than: value.tasks[index - 1].task_id, order: 'ascending_unique' },
        actual: task.task_id };
    }
  }
  if (!phaseInput) return null;

  if (!Array.isArray(value.phases) || value.phases.length === 0) {
    return { violation_kind: 'empty', pointer: '/phases', expected: { min_items: 1 },
      actual: Array.isArray(value.phases) ? { length: 0 } : { type: typeof value.phases } };
  }
  for (const [index, phase] of value.phases.entries()) {
    if (!exactRecord(phase, PHASE_KEYS)) {
      return { violation_kind: 'unexpected_or_missing_keys', pointer: `/phases/${index}`,
        expected: { keys: [...PHASE_KEYS].sort() },
        actual: (phase === null || typeof phase !== 'object')
          ? { type: phase === null ? 'null' : typeof phase }
          : { keys: Object.keys(phase).sort() } };
    }
    for (const field of ['phase_id', 'gate_policy']) {
      if (!isTodoIdentifier(phase[field])) {
        return { violation_kind: 'identifier_invalid', pointer: `/phases/${index}/${field}`,
          expected: { format: 'todo_identifier' }, actual: phase[field] };
      }
    }
    if (!Array.isArray(phase.required_evidence_slots) || phase.required_evidence_slots.length === 0) {
      return { violation_kind: 'empty',
        pointer: `/phases/${index}/required_evidence_slots`,
        expected: { min_items: 1, note: 'Phase gateが要求する証跡slotを1つ以上挙げる' },
        actual: Array.isArray(phase.required_evidence_slots)
          ? { length: 0 } : { type: typeof phase.required_evidence_slots } };
    }
    for (const field of ['predecessor_phase_ids', 'required_evidence_slots']) {
      const list = phase[field];
      const unsorted = list.findIndex((entry, i) => i > 0 && !(list[i - 1] < entry));
      if (unsorted > 0) {
        return { violation_kind: 'unsorted', pointer: `/phases/${index}/${field}/${unsorted}`,
          expected: { greater_than: list[unsorted - 1], order: 'ascending_unique' },
          actual: list[unsorted] };
      }
    }
    if (index > 0 && !(value.phases[index - 1].phase_id < phase.phase_id)) {
      return { violation_kind: 'unsorted', pointer: `/phases/${index}/phase_id`,
        expected: { greater_than: value.phases[index - 1].phase_id, order: 'ascending_unique' },
        actual: phase.phase_id };
    }
  }
  const phaseIds = new Set(value.phases.map(({ phase_id }) => phase_id));
  const orphan = value.tasks.findIndex(({ phase_id }) => !phaseIds.has(phase_id));
  if (orphan >= 0) {
    return { violation_kind: 'unknown_reference', pointer: `/tasks/${orphan}/phase_id`,
      expected: { one_of: [...phaseIds].sort() }, actual: value.tasks[orphan].phase_id };
  }
  return null;
}

/**
 * plan create入力の違反を、通ったか否かでなく「どこがどう違うか」で返す。
 * 以前は巨大な `||` 連鎖と `catch { return false }` で理由を捨てており、
 * 呼び手には pointer `/` と `validation: failed` しか届かなかった。
 * 直せない指摘は指摘ではないので、最初に落ちた条件をpointer付きで返す。
 * 違反が無ければ null。
 */
function describeCreateInputViolation(value) {
  const phaseInput = [PHASE_CREATE_INPUT_SCHEMA, DECOUPLED_PHASE_CREATE_INPUT_SCHEMA,
    MEMO_PHASE_CREATE_INPUT_SCHEMA].includes(value?.schema);
  const decoupledPhaseInput = [DECOUPLED_PHASE_CREATE_INPUT_SCHEMA,
    MEMO_PHASE_CREATE_INPUT_SCHEMA].includes(value?.schema);
  const keys = [
    'schema', 'project_id', 'plan_key', 'plan_version', 'actor', 'recorded_at',
    'tasks', 'hard_dependencies', 'joins', 'input_digest',
  ];
  if (phaseInput) keys.push('phases');
  if (decoupledPhaseInput) keys.push('phase_accept_dependencies');

  if (!exactRecord(value, keys)) {
    const actual = (value === null || typeof value !== 'object' || Array.isArray(value))
      ? { type: value === null ? 'null' : typeof value }
      : { keys: Object.keys(value).sort() };
    return { violation_kind: 'unexpected_or_missing_keys', pointer: '/',
      expected: { keys: [...keys].sort() }, actual };
  }
  const schemas = [CREATE_INPUT_SCHEMA, PHASE_CREATE_INPUT_SCHEMA,
    DECOUPLED_PHASE_CREATE_INPUT_SCHEMA, MEMO_PHASE_CREATE_INPUT_SCHEMA];
  if (!schemas.includes(value.schema)) {
    return { violation_kind: 'const_mismatch', pointer: '/schema',
      expected: { one_of: schemas }, actual: value.schema };
  }
  for (const field of ['project_id', 'plan_key', 'plan_version']) {
    if (!isTodoIdentifier(value[field])) {
      return { violation_kind: 'identifier_invalid', pointer: `/${field}`,
        expected: { format: 'todo_identifier' }, actual: value[field] };
    }
  }
  if (!exactRecord(value.actor, ['host', 'session', 'agent'])) {
    return { violation_kind: 'unexpected_or_missing_keys', pointer: '/actor',
      expected: { keys: ['agent', 'host', 'session'] },
      actual: (value.actor === null || typeof value.actor !== 'object')
        ? { type: value.actor === null ? 'null' : typeof value.actor }
        : { keys: Object.keys(value.actor).sort() } };
  }
  for (const field of ['host', 'session', 'agent']) {
    if (!isTodoIdentifier(value.actor[field])) {
      return { violation_kind: 'identifier_invalid', pointer: `/actor/${field}`,
        expected: { format: 'todo_identifier' }, actual: value.actor[field] };
    }
  }
  if (!isStrictTodoTimestamp(value.recorded_at)) {
    return { violation_kind: 'timestamp_invalid', pointer: '/recorded_at',
      expected: { format: 'strict_iso8601_utc_milliseconds' }, actual: value.recorded_at };
  }
  if (!isTodoDigest(value.input_digest)
    || value.input_digest !== todoSelfDigest(value, 'input_digest')) {
    return { violation_kind: 'input_digest_mismatch', pointer: '/input_digest',
      expected: todoSelfDigest(value, 'input_digest'),
      actual: { type: typeof value.input_digest, matches_canonical_input: false } };
  }
  if (!Array.isArray(value.tasks)) {
    return { violation_kind: 'type', pointer: '/tasks', expected: { type: 'array' },
      actual: { type: value.tasks === null ? 'null' : typeof value.tasks } };
  }
  for (const [index, task] of value.tasks.entries()) {
    for (const field of ['narrative_anchor', 'compile_binding']) {
      if (task?.[field] !== null) {
        return { violation_kind: 'not_authorable_at_create', pointer: `/tasks/${index}/${field}`,
          expected: null, actual: task?.[field] };
      }
    }
  }
  try {
    buildTodoPlan({
      schema: value.schema === MEMO_PHASE_CREATE_INPUT_SCHEMA ? 'lattice.todo_plan.v7'
        : decoupledPhaseInput ? 'lattice.todo_plan.v5'
        : phaseInput ? 'lattice.todo_plan.v4' : 'lattice.todo_plan.v3', project_id: value.project_id,
      plan_key: value.plan_key, plan_version: value.plan_version,
      predecessor_plan_digest: null, tasks: value.tasks,
      hard_dependencies: value.hard_dependencies, joins: value.joins,
      ...(phaseInput ? { phases: value.phases } : {}),
      ...(decoupledPhaseInput ? { phase_accept_dependencies: value.phase_accept_dependencies } : {}),
    });
  } catch (error) {
    // buildTodoPlanは通否しか返さない。authorが書いた形を自分で診てpointerを出す。
    const shape = describePlanShapeViolation(value, { phaseInput });
    if (shape !== null) return shape;
    return {
      violation_kind: error?.reason ?? error?.code ?? 'topology_invalid',
      pointer: error?.detail?.pointer ?? '/',
      expected: error?.detail?.expected ?? { schema: value.schema },
      actual: error?.detail?.actual ?? { message: String(error?.message ?? error) },
    };
  }
  return null;
}

export async function runPlanCreate({ cwd, inputRef, stdout, inputValue = null, featureChain = null }) {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === null) throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved');
  const input = inputValue ?? await readCanonicalInput(repoRoot, inputRef);
  if (input?.schema !== MEMO_PHASE_CREATE_INPUT_SCHEMA) {
    throw new TodoStoreError('INPUT_INVALID', 'plan_create_schema_retired', undefined, {
      violation_kind: 'const_mismatch', pointer: '/schema',
      expected: MEMO_PHASE_CREATE_INPUT_SCHEMA,
      actual: typeof input?.schema === 'string' ? input.schema : { type: typeof input?.schema },
      next_action: CURRENT_CREATE_SCHEMA_COMMAND,
    });
  }
  if (!Array.isArray(input.tasks)) {
    throw new TodoStoreError('INPUT_INVALID', 'plan_create_schema_invalid', undefined, {
      violation_kind: 'type', pointer: '/tasks', expected: { type: 'array', min_items: 1 },
      actual: { type: input.tasks === null ? 'null' : typeof input.tasks },
      next_action: CURRENT_CREATE_SCHEMA_COMMAND,
    });
  }
  const invalidMemoIndex = input.tasks.findIndex((task) => !isTodoDesignMemo(task?.design_memo));
  if (invalidMemoIndex >= 0) {
    const explained = explainTodoDesignMemo(input.tasks[invalidMemoIndex]?.design_memo);
    throw new TodoStoreError('DESIGN_MEMO_REQUIRED', 'plan_create_design_memo_required', undefined, {
      violation_kind: explained.reason, pointer: `/tasks/${invalidMemoIndex}/design_memo`,
      expected: explained.expected, actual: explained.actual,
      prompt: TODO_DESIGN_MEMO_PROMPT, next_action: CURRENT_CREATE_SCHEMA_COMMAND,
    });
  }
  const violation = describeCreateInputViolation(input);
  if (violation !== null) {
    throw new TodoStoreError('INPUT_INVALID', 'plan_create_schema_invalid', undefined, {
      ...violation,
      next_action: 'correct_the_reported_pointer_then_rerun_plan_create',
    });
  }
  // dispatch_shapeは結果へ載せる観測であり、直列度では初期化を拒まない（ADR 0180）。
  const dispatchShape = computeTodoDispatchShapeForPlan({
    projectId: input.project_id,
    planKey: input.plan_key,
    taskIds: input.tasks.map(({ task_id: taskId }) => taskId),
    hardDependencies: input.hard_dependencies,
    joins: input.joins,
  });
  const store = await initializeAuthoredTodoStore({
    repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    projectId: input.project_id, repositories: [{ repo_id: 'self', path: '.' }],
    plan: {
      schema: input.schema === MEMO_PHASE_CREATE_INPUT_SCHEMA ? 'lattice.todo_plan.v7'
        : input.schema === DECOUPLED_PHASE_CREATE_INPUT_SCHEMA ? 'lattice.todo_plan.v5'
        : input.schema === PHASE_CREATE_INPUT_SCHEMA
          ? 'lattice.todo_plan.v4' : 'lattice.todo_plan.v3', project_id: input.project_id,
      plan_key: input.plan_key, plan_version: input.plan_version,
      predecessor_plan_digest: null, tasks: input.tasks,
      hard_dependencies: input.hard_dependencies, joins: input.joins,
      ...([PHASE_CREATE_INPUT_SCHEMA, DECOUPLED_PHASE_CREATE_INPUT_SCHEMA,
        MEMO_PHASE_CREATE_INPUT_SCHEMA].includes(input.schema) ? { phases: input.phases } : {}),
      ...([DECOUPLED_PHASE_CREATE_INPUT_SCHEMA, MEMO_PHASE_CREATE_INPUT_SCHEMA].includes(input.schema)
        ? { phase_accept_dependencies: input.phase_accept_dependencies } : {}),
    },
    genesis: { actor: input.actor, recorded_at: input.recorded_at, provenance: null },
    ...(featureChain === null ? {} : { featureChain }),
  });
  const member = store.members[0];
  const result = {
    schema: CREATE_RESULT_SCHEMA, project_id: store.project_id,
    plan_key: member.plan.plan_key, plan_version: member.plan.plan_version,
    store_ref: STORE_REF, plan_ref: member.descriptor.plan_ref,
    journal_ref: member.descriptor.journal_ref, snapshot_ref: member.descriptor.snapshot_ref,
    plan_digest: member.plan.plan_digest,
    dispatch_shape: {
      task_count: dispatchShape.task_count,
      critical_path_length: dispatchShape.critical_path_length,
      max_frontier_width: dispatchShape.max_frontier_width,
      serialization_ratio: dispatchShape.serialization_ratio,
    },
    // ADR 0147裁定3: phase無し(v3)のplan createは拒否せず、終端監査が要ることを結果へ
    // 明示するに留める。phase入力(v4/v5)ならfalse——既存のPhase gateがそのまま重監査を担う。
    terminal_audit_required: isPhaselessTodoPlanSchema(member.plan.schema),
    result_digest: '',
  };
  result.result_digest = resultDigest(result);
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

/**
 * `--schema --json`（版指定なし）の既定はCURRENT_CREATE_INPUT_SCHEMAと同じv4にする。
 * 既定がv1のままだと、素の`--schema`を叩いたAIが古いv1（Phaseを表現できない）を
 * 受け取り、実運用で通らない入力を作ってしまう（実際に踏んだ）。
 * `--schema-version 1`は互換のため引き続き取得できる（bin/lattice.mjs側で許可）。
 *
 * 「どの版を返したか」は返すJSON Schema自身の`title`（例: `lattice.plan_create_input.v4`）が
 * 既に機械可読に持っている。壊さずに追加のkeyを足す理由が無いので足さない。
 */
export async function runPlanCreateSchema({ stdout, version = 4 }) {
  if (![1, 2, 3, 4].includes(version)) throw new TypeError('unsupported plan create schema version');
  const expected = version === 4 ? MEMO_PHASE_CREATE_INPUT_SCHEMA
    : version === 3 ? DECOUPLED_PHASE_CREATE_INPUT_SCHEMA
    : version === 2 ? PHASE_CREATE_INPUT_SCHEMA : CREATE_INPUT_SCHEMA;
  const schemaUrl = new URL(`../docs/schemas/lattice.plan_create_input.v${version}.schema.json`, import.meta.url);
  const handle = await open(schemaUrl, fsConstants.O_RDONLY);
  try {
    const schema = JSON.parse(await handle.readFile('utf8'));
    if (schema?.title !== expected) throw new TypeError('bundled plan create schema invalid');
    stdout.write(`${JSON.stringify(schema)}\n`);
    return 0;
  } finally {
    await handle.close();
  }
}

const PLAN_SHOW_RESULT_SCHEMA = 'lattice.plan_show_result.v1';

/**
 * `todo bindings`はcompile_binding付きtaskだけを投影するので、通常planでは空配列を返す。
 * それを見て「planが空だ」と誤読された実績があるため、plan本体（task・依存・phase・状態）を
 * 1コマンドで読める面を別に持つ。読み出しは既存store readerとtodo status projectionの
 * 再利用に留め、journalを独自に再実装しない。
 */
export async function runPlanShow({ cwd, planKey, stdout }) {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === null) throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved');
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ descriptor }) => descriptor.plan_key === planKey);
  if (member === undefined) {
    // 既存read commands（independence compile等）と同じcode/reasonを踏襲する。
    // 未知のplan_keyを「store不整合」と同じ扱いにするのはこのCLI全体の既定であり、
    // ここだけ別codeへ逸れると呼び出し側の分岐が増える。
    throw new TodoStoreError('STORE_INCONSISTENT', 'plan_not_active', undefined, {
      plan_key: planKey, next_action: 'check_active_plans_via_status',
    });
  }
  const { plan, tasks, phases } = member;
  const phaseInput = ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7']
    .includes(plan.schema);
  const stateByTaskId = new Map(tasks.map((state) => [state.task_id, state]));
  // snapshot artifactの形式(v1にはphasesキーが無い)には縛られない導出ビューを読む
  // (readTodoStoreが常に member.phases として埋める。ADR 0147)。
  const phaseStatusById = new Map((phases ?? []).map((phase) => [phase.phase_id, phase.status]));

  // 依存の本数: このplanの中でそのtaskへ入ってくるhard_dependencies辺と、joinで
  // 合流するafter辺の合計。cross-plan参照は数えない（plan showは単一planの投影のため）。
  const dependsOnCount = new Map(plan.tasks.map((task) => [task.task_id, 0]));
  for (const edge of plan.hard_dependencies) {
    if (edge.to.plan_key === planKey && dependsOnCount.has(edge.to.task_id)) {
      dependsOnCount.set(edge.to.task_id, dependsOnCount.get(edge.to.task_id) + 1);
    }
  }
  for (const join of plan.joins) {
    if (join.before.plan_key === planKey && dependsOnCount.has(join.before.task_id)) {
      dependsOnCount.set(join.before.task_id, dependsOnCount.get(join.before.task_id) + join.after.length);
    }
  }

  const taskList = plan.tasks.map((task) => ({
    task_id: task.task_id,
    title: task.title,
    lane: task.lane,
    phase_id: phaseInput ? task.phase_id : null,
    state: stateByTaskId.get(task.task_id).status,
    depends_on_count: dependsOnCount.get(task.task_id) ?? 0,
  }));

  const phaseList = phaseInput ? plan.phases.map((phase) => ({
    phase_id: phase.phase_id,
    title: phase.title,
    gate_policy: phase.gate_policy,
    predecessor_phase_ids: phase.predecessor_phase_ids,
    status: phaseStatusById.get(phase.phase_id) ?? null,
  })) : [];

  // dispatch形状はplan create時に既に計算している同じ関数を再利用する。
  // critical path長・frontier幅を独自に計算し直さない。
  const dispatchShape = computeTodoDispatchShapeForPlan({
    projectId: plan.project_id, planKey,
    taskIds: plan.tasks.map(({ task_id: taskId }) => taskId),
    hardDependencies: plan.hard_dependencies, joins: plan.joins,
  });

  const result = {
    schema: PLAN_SHOW_RESULT_SCHEMA,
    project_id: plan.project_id,
    plan_key: plan.plan_key,
    plan_version: plan.plan_version,
    plan_schema: plan.schema,
    has_phases: phaseInput,
    phases: phaseList,
    tasks: taskList,
    topology: {
      task_count: dispatchShape.task_count,
      critical_path_length: dispatchShape.critical_path_length,
      max_frontier_width: dispatchShape.max_frontier_width,
      serialization_ratio: dispatchShape.serialization_ratio,
    },
    result_digest: '',
  };
  result.result_digest = resultDigest(result);
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

export function projectStatusFailure({ cwd, stdout, cliVersion, error }) {
  if (error?.code === 'STRUCTURE_ARTIFACT_INVALID') {
    const payload = {
      schema: 'lattice.cli_error.v2', code: error.code,
      message: error.message ?? 'structure artifact invalid',
      detail: error.detail,
    };
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 1;
  }
  const projectRootConflict = error?.code === 'PROJECT_ROOT_CONFLICT';
  const result = invalidStatus({
    cliVersion, repoRoot: resolveRepoRoot(cwd),
    reason: projectRootConflict
      ? 'project_root_conflict'
      : `status_internal_failure:${error?.constructor?.name ?? 'Error'}`,
    ...(projectRootConflict ? { nextAction: {
      command: 'lattice todo dashboard adopt --json', reason: 'project_root_conflict',
    } } : {}),
  });
  stdout.write(`${JSON.stringify(result)}\n`);
  return 1;
}

export function projectCliFailure(stderr, error) {
  const payload = {
    schema: 'lattice.cli_error.v2', code: error?.code ?? 'INTERNAL_FAILURE',
    message: error?.message ?? 'project command failed',
  };
  if (error?.detail && Object.keys(error.detail).length > 0) payload.detail = error.detail;
  stderr.write(`${JSON.stringify(payload)}\n`);
  return 1;
}
