import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizeTodoArtifact, exactRecord, isTodoDesignMemo, isTodoDigest,
  isTodoIdentifier, isTodoRef,
  digestTodoArtifact, todoSelfDigest,
} from './todo-contracts.mjs';
import {
  appendImportedPlan, applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter,
  readTodoStore, TodoStoreError,
} from './todo-store.mjs';
import { gitSync } from './git-process.mjs';
import { readAuthoringJsonFile } from './todo-authoring-input.mjs';
import {
  explainPhaseTodoRevision, phaseTodoRevisionPlanVersion, validatePhaseTodoRevision,
} from './todo-revision.mjs';

export const BACKCHAIN_SCHEMA = 'lattice.plan_backchain.v1';
const CREATE_SCHEMA = 'lattice.plan_create_input.v4';
const MAX_FEATURES = 2_048;
const MAX_TEXT_BYTES = 16_384;
const MAX_BINDING_BYTES = 8_388_608;
const BINDING_SCHEMA = 'lattice.plan_backchain_binding.v1';

function fail(reason, pointer, detail = {}) {
  throw new TodoStoreError('PLAN_BACKCHAIN_INVALID', reason, undefined, {
    pointer, ...detail,
  });
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function identifiers(value, { nonempty = false } = {}) {
  return Array.isArray(value) && (!nonempty || value.length > 0)
    && value.length <= MAX_FEATURES && value.every(isTodoIdentifier)
    && new Set(value).size === value.length;
}

function provider(value) {
  return (exactRecord(value, ['kind', 'task_id'])
    && value.kind === 'task' && isTodoIdentifier(value.task_id))
    || (exactRecord(value, ['kind', 'evidence_ref'])
      && value.kind === 'existing' && isTodoRef(value.evidence_ref))
    || (exactRecord(value, ['kind', 'reason', 'question'])
      && value.kind === 'unknown' && text(value.reason) && text(value.question));
}

function registeredTasks(authoring) {
  if (!Array.isArray(authoring?.tasks) || !Array.isArray(authoring?.hard_dependencies)) {
    fail('authoring_invalid', '/authoring_ref');
  }
  if (authoring.schema === CREATE_SCHEMA) return authoring.tasks;
  fail('authoring_schema_unsupported', '/authoring_ref', {
    expected: CREATE_SCHEMA, actual: authoring?.schema ?? null,
  });
}

/**
 * AIの機能分解を検査する。意味の正しさを推測せず、最終機能からの到達性と
 * producer/consumer の契約が閉じていることだけを機械が保証する。
 */
export function validatePlanBackchain(chain, authoring) {
  const keys = [
    'schema', 'authoring_ref', 'project_id', 'plan_key', 'plan_version',
    'goal', 'features', 'tasks', 'chain_digest',
  ];
  if (!(exactRecord(chain, keys) || exactRecord(chain, [...keys, 'continuity']))
    || chain.schema !== BACKCHAIN_SCHEMA || !isTodoRef(chain.authoring_ref)
    || !isTodoIdentifier(chain.project_id) || !isTodoIdentifier(chain.plan_key)
    || !isTodoIdentifier(chain.plan_version)) fail('schema_invalid', '/');
  if (chain.continuity !== undefined && (!Array.isArray(chain.continuity)
    || chain.continuity.length > 512
    || !chain.continuity.every((entry) => exactRecord(entry, ['task_id', 'policy', 'reason'])
      && isTodoIdentifier(entry.task_id) && ['carry', 'reset', 'retire'].includes(entry.policy)
      && text(entry.reason))
    || new Set(chain.continuity.map(({ task_id: id }) => id)).size !== chain.continuity.length)) {
    fail('continuity_invalid', '/continuity');
  }
  if (!isTodoDigest(chain.chain_digest)
    || chain.chain_digest !== todoSelfDigest(chain, 'chain_digest')) {
    fail('digest_mismatch', '/chain_digest');
  }
  if (!exactRecord(chain.goal, ['purpose', 'outcome', 'acceptance', 'required_feature_ids'])
    || !text(chain.goal.purpose) || !text(chain.goal.outcome) || !text(chain.goal.acceptance)
    || !identifiers(chain.goal.required_feature_ids, { nonempty: true })) {
    fail('goal_invalid', '/goal');
  }
  if (!Array.isArray(chain.features) || chain.features.length === 0
    || chain.features.length > MAX_FEATURES) fail('features_invalid', '/features');
  const features = new Map();
  for (const [index, feature] of chain.features.entries()) {
    if (!exactRecord(feature, [
      'feature_id', 'capability', 'acceptance', 'requires_feature_ids', 'provider',
    ]) || !isTodoIdentifier(feature.feature_id) || !text(feature.capability)
      || !text(feature.acceptance) || !identifiers(feature.requires_feature_ids)
      || !provider(feature.provider)) fail('feature_invalid', `/features/${index}`);
    if (features.has(feature.feature_id)) fail('feature_duplicate', `/features/${index}/feature_id`);
    features.set(feature.feature_id, feature);
  }
  for (const [index, feature] of chain.features.entries()) {
    for (const id of feature.requires_feature_ids) {
      if (!features.has(id)) fail('required_feature_missing', `/features/${index}/requires_feature_ids`, {
        feature_id: feature.feature_id, required_feature_id: id,
      });
    }
  }
  const authored = registeredTasks(authoring);
  if (chain.project_id !== authoring.project_id || chain.plan_key !== authoring.plan_key
    || chain.plan_version !== authoring.plan_version) fail('authoring_identity_mismatch', '/authoring_ref');
  if (!Array.isArray(chain.tasks) || chain.tasks.length !== authored.length) {
    fail('task_coverage_missing', '/tasks');
  }
  const authoredIds = new Set(authored.map(({ task_id: id }) => id));
  const taskMap = new Map();
  for (const [index, task] of chain.tasks.entries()) {
    if (!exactRecord(task, ['task_id', 'requires_feature_ids', 'provides_feature_ids'])
      || !isTodoIdentifier(task.task_id) || !authoredIds.has(task.task_id)
      || !identifiers(task.requires_feature_ids)
      || !identifiers(task.provides_feature_ids, { nonempty: true })) {
      fail('task_invalid', `/tasks/${index}`);
    }
    if (taskMap.has(task.task_id)) fail('task_duplicate', `/tasks/${index}/task_id`);
    taskMap.set(task.task_id, task);
  }
  for (const [index, task] of chain.tasks.entries()) {
    for (const id of task.provides_feature_ids) {
      const feature = features.get(id);
      if (feature?.provider.kind !== 'task' || feature.provider.task_id !== task.task_id) {
        fail('task_output_provider_mismatch', `/tasks/${index}/provides_feature_ids`, { feature_id: id });
      }
    }
    const supplied = new Set(task.provides_feature_ids);
    const needed = [...new Set(task.provides_feature_ids.flatMap((id) =>
      features.get(id).requires_feature_ids.filter((required) => !supplied.has(required))))];
    if (needed.some((id) => !task.requires_feature_ids.includes(id))) {
      fail('task_inputs_incomplete', `/tasks/${index}/requires_feature_ids`, {
        expected: needed.sort(), actual: task.requires_feature_ids,
      });
    }
  }
  for (const feature of features.values()) {
    if (feature.provider.kind !== 'task') continue;
    const task = taskMap.get(feature.provider.task_id);
    if (task === undefined || !task.provides_feature_ids.includes(feature.feature_id)) {
      fail('feature_provider_missing', `/features/${feature.feature_id}/provider`, {
        feature_id: feature.feature_id,
      });
    }
  }
  const reached = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (!features.has(id)) fail('required_feature_missing', '/goal/required_feature_ids', { feature_id: id });
    if (visiting.has(id)) fail('feature_cycle', `/features/${id}/requires_feature_ids`);
    if (reached.has(id)) return;
    visiting.add(id);
    const feature = features.get(id);
    for (const required of feature.requires_feature_ids) visit(required);
    if (feature.provider.kind === 'task') {
      for (const required of taskMap.get(feature.provider.task_id).requires_feature_ids) visit(required);
    }
    visiting.delete(id);
    reached.add(id);
  };
  for (const id of chain.goal.required_feature_ids) visit(id);
  if (reached.size !== features.size) {
    fail('orphan_feature', '/features', {
      feature_ids: [...features.keys()].filter((id) => !reached.has(id)).sort(),
    });
  }
  const edges = new Set(authoring.hard_dependencies.map(({ from, to }) =>
    `${from.project_id}/${from.plan_key}/${from.task_id}->${to.project_id}/${to.plan_key}/${to.task_id}`));
  for (const [index, task] of chain.tasks.entries()) {
    for (const id of task.requires_feature_ids) {
      const feature = features.get(id);
      if (feature === undefined) fail('task_input_missing', `/tasks/${index}/requires_feature_ids`, {
        feature_id: id,
      });
      if (feature.provider.kind !== 'task') continue;
      const sourceId = feature.provider.task_id;
      if (sourceId === task.task_id) fail('task_requires_own_output', `/tasks/${index}/requires_feature_ids`);
      const edge = `${chain.project_id}/${chain.plan_key}/${sourceId}->${chain.project_id}/${chain.plan_key}/${task.task_id}`;
      if (!edges.has(edge)) fail('dependency_missing', `/tasks/${index}/requires_feature_ids`, {
        feature_id: id, from_task_id: sourceId, to_task_id: task.task_id,
      });
    }
  }
  return { features, tasks: taskMap };
}

/** 作業者に下流の用途まで渡す。文の生成は入力済みの定義を転記するだけ。 */
export function backchainTaskMemo(chain, taskId) {
  const features = new Map(chain.features.map((feature) => [feature.feature_id, feature]));
  const task = chain.tasks.find(({ task_id: id }) => id === taskId);
  const lines = [
    '## 機能契約',
    `全体の目的: ${chain.goal.purpose}`,
    `最終ゴール: ${chain.goal.outcome}`,
    `ゴールの受入条件: ${chain.goal.acceptance}`,
    '必要とする機能:',
    ...task.requires_feature_ids.map((id) => {
      const feature = features.get(id);
      const provider = feature.provider.kind === 'task'
        ? `工程 ${feature.provider.task_id}`
        : feature.provider.kind === 'existing'
          ? `既存機能として申告（参照: ${feature.provider.evidence_ref}）`
          : `未解決（${feature.provider.reason}。確認すること: ${feature.provider.question}）`;
      return `- ${id}: ${feature.capability}（提供元: ${provider}）`;
    }),
    '作る機能:',
    ...task.provides_feature_ids.map((id) => {
      const feature = features.get(id);
      const consumers = chain.tasks.filter((other) => other.requires_feature_ids.includes(id))
        .map(({ task_id: consumerId }) => consumerId).sort();
      return `- ${id}: ${feature.capability}。受入条件: ${feature.acceptance}。後続: ${consumers.join(', ') || '最終成果'}`;
    }),
  ];
  return lines.join('\n');
}

function localDesignMemo(memo, chain, taskId) {
  const generated = chain?.tasks.some(({ task_id: id }) => id === taskId)
    ? backchainTaskMemo(chain, taskId) : null;
  const text = memo.trimEnd();
  return generated !== null && text.endsWith(`\n\n${generated}`)
    ? text.slice(0, -generated.length - 2) : text;
}

export function attachBackchainMemos(chain, authoring, { previousChain = null } = {}) {
  const tasks = new Set(chain.tasks.map(({ task_id: id }) => id));
  const amended = {
    ...authoring,
    tasks: authoring.tasks.map((task) => {
      if (!tasks.has(task.task_id)) return task;
      const baseMemo = localDesignMemo(task.design_memo, previousChain, task.task_id);
      const designMemo = `${baseMemo}\n\n${backchainTaskMemo(chain, task.task_id)}`;
      if (!isTodoDesignMemo(designMemo)) fail('design_memo_limit', `/tasks/${task.task_id}/design_memo`);
      return { ...task, design_memo: designMemo };
    }),
  };
  const digestField = 'input_digest';
  amended[digestField] = todoSelfDigest(amended, digestField);
  return amended;
}

export async function readPlanBackchainBinding({ repoRoot, plan }) {
  const ref = `.lattice/todo/plans/${plan.plan_key}/${plan.plan_version}/backchain.json`;
  const absolute = path.resolve(repoRoot, ref);
  let bytes;
  try {
    const state = await lstat(absolute);
    if (!state.isFile() || state.isSymbolicLink() || state.size > MAX_BINDING_BYTES
      || await realpath(absolute) !== absolute) fail('binding_unsafe', ref);
    bytes = await readFile(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof TodoStoreError) throw error;
    fail('binding_unreadable', ref);
  }
  let binding;
  try { binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('binding_invalid_json', ref); }
  if (!exactRecord(binding, ['schema', 'plan_digest', 'chain', 'binding_digest'])
    || binding.schema !== BINDING_SCHEMA || binding.plan_digest !== plan.plan_digest
    || !isTodoDigest(binding.binding_digest)
    || binding.binding_digest !== todoSelfDigest(binding, 'binding_digest')) {
    fail('binding_invalid', ref);
  }
  const chain = binding.chain;
  validatePlanBackchain(chain, {
    schema: CREATE_SCHEMA, project_id: plan.project_id, plan_key: plan.plan_key,
    plan_version: plan.plan_version, tasks: plan.tasks,
    hard_dependencies: plan.hard_dependencies,
  });
  return binding;
}

export async function readTaskBackchainContext({ repoRoot, plan, taskId }) {
  const binding = await readPlanBackchainBinding({ repoRoot, plan });
  if (binding === null) return null;
  const chain = binding.chain;
  const task = chain.tasks.find(({ task_id: id }) => id === taskId);
  const ref = `.lattice/todo/plans/${plan.plan_key}/${plan.plan_version}/backchain.json`;
  if (task === undefined) fail('binding_task_missing', ref, { task_id: taskId });
  const features = new Map(chain.features.map((feature) => [feature.feature_id, feature]));
  const downstream = chain.tasks.filter((other) => other.task_id !== taskId
    && other.requires_feature_ids.some((id) => task.provides_feature_ids.includes(id)))
    .map(({ task_id: id }) => id).sort();
  const required = task.requires_feature_ids.map((id) => features.get(id));
  return {
    schema: 'lattice.todo_feature_context.v1',
    plan_key: chain.plan_key, plan_version: chain.plan_version,
    goal: chain.goal,
    requires: required,
    provides: task.provides_feature_ids.map((id) => features.get(id)),
    downstream_task_ids: downstream,
    unknown_feature_ids: required.filter(({ provider }) => provider.kind === 'unknown')
      .map(({ feature_id: id }) => id),
    chain_digest: chain.chain_digest,
  };
}

function gitRoot(cwd) {
  try {
    return path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch { fail('repository_unresolved', '/'); }
}

async function verifyExistingFeatureReferences(repoRoot, chain) {
  const canonicalRoot = await realpath(repoRoot);
  for (const feature of chain.features) {
    if (feature.provider.kind !== 'existing') continue;
    const ref = feature.provider.evidence_ref;
    const absolute = path.resolve(canonicalRoot, ref);
    if (!absolute.startsWith(`${canonicalRoot}${path.sep}`)) {
      fail('existing_feature_reference_unsafe', `/features/${feature.feature_id}/provider`, {
        evidence_ref: ref,
      });
    }
    let state;
    try { state = await lstat(absolute); }
    catch { fail('existing_feature_reference_missing', `/features/${feature.feature_id}/provider`, {
      evidence_ref: ref,
    }); }
    let resolved;
    try { resolved = await realpath(absolute); }
    catch { fail('existing_feature_reference_unreadable', `/features/${feature.feature_id}/provider`, {
      evidence_ref: ref,
    }); }
    if (!state.isFile() || state.isSymbolicLink()
      || !resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
      fail('existing_feature_reference_unsafe', `/features/${feature.feature_id}/provider`, {
        evidence_ref: ref,
      });
    }
  }
}

function planSeed(authoring, predecessorPlanDigest) {
  return {
    schema: 'lattice.todo_plan.v7', project_id: authoring.project_id,
    plan_key: authoring.plan_key, predecessor_plan_digest: predecessorPlanDigest,
    tasks: authoring.tasks, phases: authoring.phases,
    hard_dependencies: authoring.hard_dependencies, joins: authoring.joins,
    phase_accept_dependencies: authoring.phase_accept_dependencies,
  };
}

function featureGraphDigest(chain) {
  return digestTodoArtifact({ goal: chain.goal, features: chain.features, tasks: chain.tasks });
}

function taskSignature(chain, taskId) {
  const task = chain?.tasks?.find(({ task_id: id }) => id === taskId);
  if (task === undefined) return null;
  const byId = new Map(chain.features.map((feature) => [feature.feature_id, feature]));
  const ids = [...new Set([...task.requires_feature_ids, ...task.provides_feature_ids])].sort();
  return canonicalizeTodoArtifact({
    requires_feature_ids: task.requires_feature_ids,
    provides_feature_ids: task.provides_feature_ids,
    features: ids.map((id) => byId.get(id)),
  });
}

function incoming(plan, taskId) {
  return canonicalizeTodoArtifact({
    hard: plan.hard_dependencies.filter(({ to }) => to.task_id === taskId),
    phase: plan.phase_accept_dependencies.filter(({ to }) => to.task_id === taskId),
    joins: plan.joins.filter(({ before }) => before.task_id === taskId),
  });
}

function compileTaskMigration(previousPlan, oldChain, desiredSeed, newChain) {
  const desired = new Map(desiredSeed.tasks.map((task) => [task.task_id, task]));
  const decisions = new Map((newChain.continuity ?? []).map((entry) => [entry.task_id, entry]));
  const oldIds = new Set(previousPlan.tasks.map(({ task_id: id }) => id));
  if ([...decisions.keys()].some((id) => !oldIds.has(id))) fail('continuity_task_missing', '/continuity');
  return previousPlan.tasks.map((oldTask) => {
    const id = oldTask.task_id;
    const nextTask = desired.get(id);
    const decision = decisions.get(id);
    if (nextTask === undefined) {
      if (decision !== undefined && decision.policy !== 'retire') {
        fail('continuity_removed_task_mismatch', '/continuity', { task_id: id });
      }
      return { from_task_id: id, to_task_id: 'removed', state_policy: 'removed' };
    }
    if (decision?.policy === 'retire') fail('continuity_live_task_mismatch', '/continuity', { task_id: id });
    const sameContract = taskSignature(oldChain, id) === taskSignature(newChain, id);
    const sameTask = oldTask.title === nextTask.title && oldTask.lane === nextTask.lane
      && oldTask.phase_id === nextTask.phase_id
      && oldTask.parent_task_id === nextTask.parent_task_id
      && localDesignMemo(oldTask.design_memo, oldChain, id)
        === localDesignMemo(nextTask.design_memo, newChain, id)
      && canonicalizeTodoArtifact(oldTask.compile_binding)
        === canonicalizeTodoArtifact(nextTask.compile_binding)
      && incoming(previousPlan, id) === incoming(desiredSeed, id);
    const carry = decision?.policy === 'carry'
      || (decision === undefined && sameContract && sameTask);
    return { from_task_id: id, to_task_id: id,
      state_policy: carry ? 'carry_reconciled_metadata' : 'reset_pending' };
  }).sort((left, right) => left.from_task_id.localeCompare(right.from_task_id));
}

function compilePhaseMigration(previousPlan, desiredSeed, taskMigration) {
  const nextPhases = new Map(desiredSeed.phases.map((phase) => [phase.phase_id, phase]));
  const oldPhases = new Set(previousPlan.phases.map(({ phase_id: id }) => id));
  const affected = new Set(taskMigration.filter(({ state_policy }) =>
    !['carry', 'carry_reconciled_metadata'].includes(state_policy))
    .map(({ from_task_id: id }) => previousPlan.tasks.find(({ task_id }) => task_id === id)?.phase_id));
  for (const task of desiredSeed.tasks) {
    if (!previousPlan.tasks.some(({ task_id: id }) => id === task.task_id)) affected.add(task.phase_id);
  }
  return [
    ...previousPlan.phases.map((phase) => {
      const next = nextPhases.get(phase.phase_id);
      if (next === undefined) return { from_phase_id: phase.phase_id,
        to_phase_id: 'removed', state_policy: 'removed' };
      const carry = !affected.has(phase.phase_id)
        && canonicalizeTodoArtifact(phase) === canonicalizeTodoArtifact(next);
      return { from_phase_id: phase.phase_id, to_phase_id: phase.phase_id,
        state_policy: carry ? 'carry' : 'reset' };
    }),
    ...desiredSeed.phases.filter(({ phase_id: id }) => !oldPhases.has(id))
      .map(({ phase_id: id }) => ({ from_phase_id: null,
        to_phase_id: id, state_policy: 'reset' })),
  ];
}

async function compileBackchainRevision({ repoRoot, member, chain, authoring }) {
  if (member.plan.schema !== 'lattice.todo_plan.v7') {
    fail('predecessor_plan_schema_unsupported', '/plan_key', {
      actual: member.plan.schema, next_action: 'author_a_new_backchain_plan',
    });
  }
  const previousBinding = await readPlanBackchainBinding({ repoRoot, plan: member.plan });
  const previousChain = previousBinding?.chain ?? null;
  const amended = attachBackchainMemos(chain, authoring, { previousChain });
  const predecessor = {
    plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version,
  };
  const seed = planSeed(amended, predecessor.plan_digest);
  const taskMigration = compileTaskMigration(member.plan, previousChain, seed, chain);
  const phaseMigration = compilePhaseMigration(member.plan, seed, taskMigration);
  const version = phaseTodoRevisionPlanVersion({
    projectId: chain.project_id, planKey: chain.plan_key, predecessor,
    desiredPlan: seed, taskMigration, phaseMigration,
    featureGraphDigest: featureGraphDigest(chain),
  });
  const successorChain = { ...chain, plan_version: version, chain_digest: '' };
  successorChain.chain_digest = todoSelfDigest(successorChain, 'chain_digest');
  const desiredPlan = buildTodoPlan({ ...seed, plan_version: version });
  validatePlanBackchain(successorChain, {
    schema: CREATE_SCHEMA, project_id: desiredPlan.project_id,
    plan_key: desiredPlan.plan_key, plan_version: desiredPlan.plan_version,
    tasks: desiredPlan.tasks, hard_dependencies: desiredPlan.hard_dependencies,
  });
  const revision = {
    schema: 'lattice.phase_todo_revision.v4',
    project_id: chain.project_id, plan_key: chain.plan_key,
    predecessor, desired_plan: desiredPlan, task_migration: taskMigration,
    phase_migration: phaseMigration, backchain: successorChain, revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  if (!validatePhaseTodoRevision(revision)) {
    fail('revision_invalid', '/revision', { diagnosis: explainPhaseTodoRevision(revision) });
  }
  return revision;
}

async function activeIntentUnchanged({ repoRoot, member, chain, authoring }) {
  if (member.plan.schema !== 'lattice.todo_plan.v7') return false;
  const binding = await readPlanBackchainBinding({ repoRoot, plan: member.plan });
  if (binding === null || featureGraphDigest(binding.chain) !== featureGraphDigest(chain)) return false;
  const amended = attachBackchainMemos(chain, authoring, { previousChain: binding.chain });
  return canonicalizeTodoArtifact({
    tasks: amended.tasks, phases: amended.phases,
    hard_dependencies: amended.hard_dependencies, joins: amended.joins,
    phase_accept_dependencies: amended.phase_accept_dependencies,
  }) === canonicalizeTodoArtifact({
    tasks: member.plan.tasks, phases: member.plan.phases,
    hard_dependencies: member.plan.hard_dependencies, joins: member.plan.joins,
    phase_accept_dependencies: member.plan.phase_accept_dependencies,
  });
}

async function rebindCarriedWork({ repoRoot, planKey, env }) {
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ plan }) => plan.plan_key === planKey);
  const rebound = [];
  for (const state of member.tasks.filter(({ status }) => status === 'in-progress')) {
    const hasCurrentStart = member.journal.events.some((event) => event.kind === 'start'
      && event.task_id === state.task_id && event.payload?.start_mode !== 'historical_import');
    if (hasCurrentStart) continue;
    const { rebindStart } = await import('./todo-cli.mjs');
    try {
      await rebindStart({ repoRoot, env, planKey, taskId: state.task_id,
        reason: 'ゴール変更後のplan versionへ作業中ToDoを結び直す' });
    } catch (error) {
      throw new TodoStoreError('BACKCHAIN_REBIND_PENDING', 'carried_task_rebind_failed', undefined, {
        task_id: state.task_id, plan_version: member.plan.plan_version,
        cause_code: error?.code ?? 'unknown',
        next_action: `lattice todo start --plan ${planKey} --task ${state.task_id} --rebind --reason <text>`,
      });
    }
    rebound.push(state.task_id);
  }
  return rebound;
}

export async function runPlanBackchain({ cwd, inputRef, stdout, dryRun = false, env = process.env }) {
  const repoRoot = gitRoot(cwd);
  const chain = await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode: 'PLAN_BACKCHAIN_INVALID' });
  const authoring = await readAuthoringJsonFile(repoRoot, chain.authoring_ref, {
    invalidCode: 'PLAN_BACKCHAIN_INVALID',
  });
  validatePlanBackchain(chain, authoring);
  await verifyExistingFeatureReferences(repoRoot, chain);
  let member = null;
  let store = null;
  try {
    await lstat(path.join(repoRoot, '.lattice', 'todo', 'manifest.json'));
    store = await readTodoStore({ repoRoot });
    if (store.project_id !== chain.project_id) fail('project_id_mismatch', '/project_id');
    member = store.members.find(({ plan }) => plan.plan_key === chain.plan_key) ?? null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (member === null && (chain.continuity?.length ?? 0) > 0) {
    fail('continuity_without_predecessor', '/continuity');
  }
  const unchanged = member !== null && await activeIntentUnchanged({
    repoRoot, member, chain, authoring,
  });
  const revision = member === null || unchanged ? null
    : await compileBackchainRevision({ repoRoot, member, chain, authoring });
  const amended = revision === null ? attachBackchainMemos(chain, authoring) : null;
  if (!unchanged && revision === null) {
    try { buildTodoPlan({ ...planSeed(amended, null), plan_version: chain.plan_version }); }
    catch { fail('authoring_plan_invalid', '/authoring_ref'); }
  }
  const unknownFeatureIds = chain.features.filter(({ provider: source }) => source.kind === 'unknown')
    .map(({ feature_id: id }) => id).sort();
  if (dryRun) {
    const checked = {
      schema: 'lattice.plan_backchain_check.v1', valid: true,
      validation_scope: 'feature_chain_and_plan_shape',
      project_id: chain.project_id, plan_key: chain.plan_key,
      task_count: chain.tasks.length, feature_count: chain.features.length,
      unknown_feature_ids: unknownFeatureIds, chain_digest: chain.chain_digest,
      operation: unchanged ? 'unchanged' : revision !== null ? 'revise'
        : store === null ? 'create' : 'add',
      task_migration: revision?.task_migration ?? null,
      result_digest: '',
    };
    checked.result_digest = todoSelfDigest(checked, 'result_digest');
    stdout.write(`${JSON.stringify(checked)}\n`);
    return 0;
  }
  let created;
  let effectiveChain = chain;
  if (unchanged) {
    const binding = await readPlanBackchainBinding({ repoRoot, plan: member.plan });
    effectiveChain = binding.chain;
    created = { schema: 'lattice.plan_backchain_unchanged.v1',
      plan_key: member.plan.plan_key, plan_version: member.plan.plan_version,
      plan_digest: member.plan.plan_digest };
  } else if (revision !== null) {
    created = await applyPhaseTodoRevision({
      repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
      revision, actor: authoring.actor, recordedAt: new Date().toISOString(),
    });
    effectiveChain = revision.backchain;
  } else if (store === null) {
    const { runPlanCreate } = await import('./project-cli.mjs');
    let output = '';
    await runPlanCreate({ cwd: repoRoot, inputRef: chain.authoring_ref,
      inputValue: amended, featureChain: chain,
      stdout: { write(value) { output += value; } } });
    created = JSON.parse(output);
  } else {
    const plan = buildTodoPlan({
      ...planSeed(amended, null), plan_version: chain.plan_version,
    });
    const added = await appendImportedPlan({
      repoRoot, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
      plan, genesis: { actor: authoring.actor, recorded_at: authoring.recorded_at,
        provenance: null }, featureChain: chain,
    });
    created = {
      schema: 'lattice.plan_backchain_add_result.v1',
      plan_key: added.plan.plan_key, plan_version: added.plan.plan_version,
      plan_digest: added.plan.plan_digest,
    };
  }
  const reboundTaskIds = unchanged || revision !== null
    ? await rebindCarriedWork({ repoRoot, planKey: chain.plan_key, env }) : [];
  const finalStore = await readTodoStore({ repoRoot });
  const finalMember = finalStore.members.find(({ plan }) => plan.plan_key === chain.plan_key);
  const result = {
    schema: 'lattice.plan_backchain_result.v1',
    project_id: chain.project_id, plan_key: chain.plan_key,
    plan_version: created.plan_version, plan_digest: created.plan_digest ?? null,
    feature_count: chain.features.length, task_count: chain.tasks.length,
    unknown_feature_ids: unknownFeatureIds,
    chain_digest: effectiveChain.chain_digest, authoring_result: created,
    rebound_task_ids: reboundTaskIds,
    operation: unchanged ? 'unchanged' : revision !== null ? 'revise'
      : store === null ? 'create' : 'add',
    journal_head_digest: finalMember.journal.events.at(-1).event_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

export async function backchainSchema() {
  return JSON.parse(await readFile(new URL('../docs/schemas/lattice.plan_backchain.v1.schema.json', import.meta.url), 'utf8'));
}
