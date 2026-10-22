import { readFile } from 'node:fs/promises';

import {
  exactRecord, isTodoDesignMemo, isTodoDigest, isTodoIdentifier, isTodoRef,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { TodoStoreError } from './todo-store.mjs';

export const BACKCHAIN_SCHEMA = 'lattice.plan_backchain.v1';
const CREATE_SCHEMA = 'lattice.plan_create_input.v4';
const EXTRACTION_SCHEMA = 'lattice.todo_extraction.v4';
const MAX_FEATURES = 2_048;
const MAX_TEXT_BYTES = 16_384;

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
  if (authoring?.schema === CREATE_SCHEMA) return authoring.tasks;
  if (authoring?.schema === EXTRACTION_SCHEMA) {
    return authoring.tasks.filter(({ disposition }) => disposition.startsWith('register_'));
  }
  fail('authoring_schema_unsupported', '/authoring_ref', {
    expected: [CREATE_SCHEMA, EXTRACTION_SCHEMA], actual: authoring?.schema ?? null,
  });
}

/**
 * AIの機能分解を検査する。意味の正しさを推測せず、最終機能からの到達性と
 * producer/consumer の契約が閉じていることだけを機械が保証する。
 */
export function validatePlanBackchain(chain, authoring) {
  if (!exactRecord(chain, [
    'schema', 'authoring_ref', 'project_id', 'plan_key', 'plan_version',
    'goal', 'features', 'tasks', 'chain_digest',
  ]) || chain.schema !== BACKCHAIN_SCHEMA || !isTodoRef(chain.authoring_ref)
    || !isTodoIdentifier(chain.project_id) || !isTodoIdentifier(chain.plan_key)
    || !isTodoIdentifier(chain.plan_version)) fail('schema_invalid', '/');
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
          ? `既存機能 ${feature.provider.evidence_ref}`
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

export function attachBackchainMemos(chain, authoring) {
  const tasks = new Set(chain.tasks.map(({ task_id: id }) => id));
  const amended = {
    ...authoring,
    tasks: authoring.tasks.map((task) => {
      if (!tasks.has(task.task_id)) return task;
      const designMemo = `${task.design_memo.trimEnd()}\n\n${backchainTaskMemo(chain, task.task_id)}`;
      if (!isTodoDesignMemo(designMemo)) fail('design_memo_limit', `/tasks/${task.task_id}/design_memo`);
      return { ...task, design_memo: designMemo };
    }),
  };
  const digestField = authoring.schema === CREATE_SCHEMA ? 'input_digest' : 'extraction_digest';
  amended[digestField] = todoSelfDigest(amended, digestField);
  return amended;
}

export async function backchainSchema() {
  return JSON.parse(await readFile(new URL('../docs/schemas/lattice.plan_backchain.v1.schema.json', import.meta.url), 'utf8'));
}
