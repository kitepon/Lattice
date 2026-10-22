import {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  exactRecord,
  isTodoDigest,
  isTodoIdentifier,
  isTodoRef,
  todoSelfDigest,
  validateTodoPlan,
} from './todo-contracts.mjs';

const REVISION_V1_KEYS = [
  'schema', 'project_id', 'plan_key', 'predecessor', 'desired_plan', 'task_migration',
  'source_inventory', 'reconciliation', 'revision_digest',
];
const REVISION_V2_KEYS = [...REVISION_V1_KEYS, 'source_cutover_batch'];
const PHASE_REVISION_KEYS = [
  'schema', 'project_id', 'plan_key', 'predecessor', 'desired_plan', 'task_migration',
  'phase_migration', 'revision_digest',
];
const PHASE_REVISION_V3_KEYS = [
  'schema', 'project_id', 'plan_key', 'predecessor', 'desired_plan',
  'runtime_task_migration', 'task_migration', 'phase_migration', 'source_inventory',
  'reconciliation', 'source_cutover_batch', 'revision_digest',
];
const PHASE_REVISION_V4_KEYS = [...PHASE_REVISION_KEYS, 'backchain'];

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const boundedText = (value) => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value) <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(value);

export function parseTodoSourceRef(value) {
  if (typeof value !== 'string') return null;
  const match = /^(.*)#L([1-9]\d*)$/u.exec(value);
  if (match === null || !isTodoRef(match[1])) return null;
  const line = Number(match[2]);
  return Number.isSafeInteger(line) ? { path: match[1], line } : null;
}

export function todoRevisionPlanVersion({
  projectId, planKey, predecessor, desiredPlan, taskMigration, sourceInventory,
  sourceCutoverBatch = undefined,
}) {
  const versionDigest = digestTodoArtifact({
    schema: sourceCutoverBatch === undefined
      ? 'lattice.todo_revision_version.v1' : 'lattice.todo_revision_version.v2',
    project_id: projectId,
    plan_key: planKey,
    predecessor,
    desired_topology: {
      schema: desiredPlan.schema,
      project_id: desiredPlan.project_id,
      plan_key: desiredPlan.plan_key,
      predecessor_plan_digest: desiredPlan.predecessor_plan_digest,
      tasks: desiredPlan.tasks,
      hard_dependencies: desiredPlan.hard_dependencies,
      joins: desiredPlan.joins,
    },
    task_migration: taskMigration,
    source_inventory: sourceInventory,
    ...(sourceCutoverBatch === undefined ? {} : { source_cutover_batch: sourceCutoverBatch }),
  });
  return `rev-${versionDigest.slice(0, 24)}`;
}

export function phaseTodoRevisionPlanVersion({
  projectId, planKey, predecessor, desiredPlan, taskMigration, phaseMigration,
  featureGraphDigest = null,
}) {
  const versionDigest = digestTodoArtifact({
    schema: featureGraphDigest !== null ? 'lattice.phase_todo_revision_version.v3'
      : ['lattice.todo_plan.v5', 'lattice.todo_plan.v7'].includes(desiredPlan.schema)
      ? 'lattice.phase_todo_revision_version.v2' : 'lattice.phase_todo_revision_version.v1', project_id: projectId,
    plan_key: planKey, predecessor, desired_topology: {
      schema: desiredPlan.schema, project_id: desiredPlan.project_id,
      plan_key: desiredPlan.plan_key, predecessor_plan_digest: desiredPlan.predecessor_plan_digest,
      tasks: desiredPlan.tasks, phases: desiredPlan.phases,
      hard_dependencies: desiredPlan.hard_dependencies, joins: desiredPlan.joins,
      ...(['lattice.todo_plan.v5', 'lattice.todo_plan.v7'].includes(desiredPlan.schema)
        ? { phase_accept_dependencies: desiredPlan.phase_accept_dependencies } : {}),
    }, task_migration: taskMigration, phase_migration: phaseMigration,
    ...(featureGraphDigest === null ? {} : { feature_graph_digest: featureGraphDigest }),
  });
  return `rev-${versionDigest.slice(0, 24)}`;
}

export function todoLegacyReconciliationDigest({ planDigest, journalHeadDigest }) {
  if (!isTodoDigest(planDigest) || !isTodoDigest(journalHeadDigest)) {
    throw new TypeError('legacy reconciliation anchor digest required');
  }
  return digestTodoArtifact({
    schema: 'lattice.todo_reconciliation_anchor.v1',
    state: 'registered_unreconciled',
    plan_digest: planDigest,
    journal_head_digest: journalHeadDigest,
  });
}

export function todoSourceInventoryDigest(sourceInventory) {
  return digestTodoArtifact(sourceInventory);
}

export function todoReconciliationDigest({
  predecessorReconciliationDigest,
  sourceInventoryDigest,
  predecessor,
  desiredPlanDigest,
  taskMigration,
  sourceCutoverBatch = undefined,
}) {
  if (!isTodoDigest(predecessorReconciliationDigest) || !isTodoDigest(sourceInventoryDigest)
    || !isTodoDigest(desiredPlanDigest)) throw new TypeError('reconciliation digest input invalid');
  return digestTodoArtifact({
    schema: sourceCutoverBatch === undefined
      ? 'lattice.todo_reconciliation_binding.v1' : 'lattice.todo_reconciliation_binding.v2',
    predecessor_reconciliation_digest: predecessorReconciliationDigest,
    source_inventory_digest: sourceInventoryDigest,
    predecessor,
    desired_plan_digest: desiredPlanDigest,
    task_migration_digest: digestTodoArtifact(taskMigration),
    ...(sourceCutoverBatch === undefined ? {} : {
      source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
    }),
  });
}

export function todoCutoverArchiveSourceRef(batch, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('cutover operation index invalid');
  return `${batch.archive_ref}#L${index + 6}`;
}

function validLiveReplacement(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4_096
    && !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !/^[\t ]*(?:[-+*]|\d+[A-Za-z]?\.|\d+\))[\t ]+\[[ xX]\](?:[\t ]+.*)?$/u.test(value);
}

function validSourceCutoverBatch(value, revision) {
  if (!exactRecord(value, ['batch_id', 'archive_ref', 'operations', 'batch_digest'])
    || !isTodoIdentifier(value.batch_id) || !isTodoRef(value.archive_ref)
    || !value.archive_ref.endsWith('.md') || parseTodoSourceRef(value.archive_ref) !== null
    || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 512
    || !isTodoDigest(value.batch_digest)
    || value.batch_digest !== todoSelfDigest(value, 'batch_digest')) return false;
  const sourceRefs = new Set();
  const activeTaskIds = new Set();
  for (const [index, operation] of value.operations.entries()) {
    if (!exactRecord(operation, [
      'task_id', 'disposition', 'source_ref', 'source_digest', 'live_replacement',
    ]) || !['active', 'excluded'].includes(operation.disposition)
      || (operation.disposition === 'active' ? !isTodoIdentifier(operation.task_id) : operation.task_id !== null)
      || parseTodoSourceRef(operation.source_ref) === null || !isTodoDigest(operation.source_digest)
      || !validLiveReplacement(operation.live_replacement)
      || sourceRefs.has(operation.source_ref)
      || (index > 0 && compareText(value.operations[index - 1].source_ref, operation.source_ref) >= 0)) return false;
    sourceRefs.add(operation.source_ref);
    const archivedSourceRef = todoCutoverArchiveSourceRef(value, index);
    if (operation.disposition === 'active') {
      if (activeTaskIds.has(operation.task_id)) return false;
      activeTaskIds.add(operation.task_id);
      const inventory = revision.source_inventory.active.find(({ task_id }) => task_id === operation.task_id);
      const task = revision.desired_plan.tasks.find(({ task_id }) => task_id === operation.task_id);
      if (inventory?.source_ref !== archivedSourceRef
        || inventory.source_digest !== operation.source_digest
        || task?.narrative_ref !== archivedSourceRef) return false;
    } else {
      const tombstone = revision.source_inventory.excluded_tombstones.find((entry) => (
        entry.source_ref === archivedSourceRef && entry.source_digest === operation.source_digest
      ));
      if (tombstone === undefined) return false;
    }
  }
  return true;
}

function validPredecessor(value) {
  return exactRecord(value, ['plan_digest', 'journal_head_digest', 'plan_version'])
    && isTodoDigest(value.plan_digest) && isTodoDigest(value.journal_head_digest)
    && isTodoIdentifier(value.plan_version);
}

function validTaskMigration(value) {
  const activeTargets = Array.isArray(value)
    ? value.filter(({ to_task_id }) => to_task_id !== 'removed').map(({ to_task_id }) => to_task_id)
    : [];
  return Array.isArray(value) && value.length > 0 && value.length <= 512
    && value.every((entry) => exactRecord(entry, [
      'from_task_id', 'to_task_id', 'state_policy',
    ]) && isTodoIdentifier(entry.from_task_id)
      && (entry.to_task_id === 'removed' || isTodoIdentifier(entry.to_task_id))
      && ((entry.state_policy === 'removed' && entry.to_task_id === 'removed')
        || (['carry', 'carry_reconciled_metadata', 'reset_pending', 'acquire_phase'].includes(entry.state_policy)
          && entry.to_task_id !== 'removed')))
    && new Set(value.map(({ from_task_id }) => from_task_id)).size === value.length
    && new Set(activeTargets).size === activeTargets.length
    && value.every((entry, index) => index === 0
      || compareText(value[index - 1].from_task_id, entry.from_task_id) < 0);
}

function validPhaseMigration(value, desiredPlan) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512
    || !value.every((entry) => exactRecord(entry, [
      'from_phase_id', 'to_phase_id', 'state_policy',
    ]) && (entry.from_phase_id === null || isTodoIdentifier(entry.from_phase_id))
      && (entry.to_phase_id === 'removed' || isTodoIdentifier(entry.to_phase_id))
      && ['carry', 'reset', 'removed'].includes(entry.state_policy)
      && (entry.state_policy !== 'carry' || (entry.from_phase_id !== null && entry.to_phase_id !== 'removed'))
      && (entry.state_policy !== 'removed' || (entry.from_phase_id !== null && entry.to_phase_id === 'removed'))
      && (entry.state_policy !== 'reset' || entry.to_phase_id !== 'removed'))) return false;
  const sources = value.filter(({ from_phase_id }) => from_phase_id !== null).map(({ from_phase_id }) => from_phase_id);
  const targets = value.filter(({ to_phase_id }) => to_phase_id !== 'removed').map(({ to_phase_id }) => to_phase_id);
  return new Set(sources).size === sources.length && new Set(targets).size === targets.length
    && canonicalizeForCompare(targets) === canonicalizeForCompare(desiredPlan.phases.map(({ phase_id }) => phase_id));
}

function canonicalizeForCompare(value) {
  return canonicalizeTodoArtifact([...value].sort((left, right) => compareText(
    canonicalizeTodoArtifact(left), canonicalizeTodoArtifact(right),
  )));
}

export function todoTaskMigrationDigest(taskMigration) {
  return todoSelfDigest({ task_migration: taskMigration, task_migration_digest: '' },
    'task_migration_digest');
}

function validRuntimeTaskMigration(value) {
  if (!exactRecord(value, ['schema', 'entries', 'migration_digest'])
    || value.schema !== 'lattice.runtime_task_migration.v1'
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 512
    || !isTodoDigest(value.migration_digest)
    || value.migration_digest !== todoSelfDigest(value, 'migration_digest')) return false;
  const targets = [];
  for (const [index, entry] of value.entries.entries()) {
    const successorTail = Array.isArray(entry.successor_task_ids)
      ? entry.successor_task_ids.slice(1) : [];
    if (!exactRecord(entry, [
      'predecessor_task_id', 'disposition', 'successor_task_ids', 'reason', 'evidence_digests',
    ]) || !isTodoIdentifier(entry.predecessor_task_id)
      || !['carry', 'stay', 'replace', 'split', 'retire'].includes(entry.disposition)
      || !Array.isArray(entry.successor_task_ids) || entry.successor_task_ids.length > 512
      || !entry.successor_task_ids.every(isTodoIdentifier)
      || new Set(entry.successor_task_ids).size !== entry.successor_task_ids.length
      || successorTail.some((id, targetIndex) => targetIndex > 0
        && compareText(successorTail[targetIndex - 1], id) >= 0)
      || !boundedText(entry.reason) || !Array.isArray(entry.evidence_digests)
      || entry.evidence_digests.length < 1 || entry.evidence_digests.length > 512
      || !entry.evidence_digests.every(isTodoDigest)
      || new Set(entry.evidence_digests).size !== entry.evidence_digests.length
      || entry.evidence_digests.some((digest, digestIndex) => digestIndex > 0
        && compareText(entry.evidence_digests[digestIndex - 1], digest) >= 0)
      || (index > 0 && compareText(value.entries[index - 1].predecessor_task_id,
        entry.predecessor_task_id) >= 0)) return false;
    if (['carry', 'stay'].includes(entry.disposition)
      && (entry.successor_task_ids.length !== 1
        || entry.successor_task_ids[0] !== entry.predecessor_task_id)) return false;
    if (entry.disposition === 'retire' && entry.successor_task_ids.length !== 0) return false;
    if (['replace', 'split'].includes(entry.disposition) && entry.successor_task_ids.length === 0) return false;
    targets.push(...entry.successor_task_ids);
  }
  return new Set(targets).size === targets.length;
}

function projectRuntimeTaskMigration(value) {
  return value.entries.map((entry) => {
    if (['carry', 'stay'].includes(entry.disposition)) return {
      from_task_id: entry.predecessor_task_id,
      to_task_id: entry.predecessor_task_id,
      state_policy: 'carry',
    };
    if (entry.disposition === 'retire') return {
      from_task_id: entry.predecessor_task_id, to_task_id: 'removed', state_policy: 'removed',
    };
    return { from_task_id: entry.predecessor_task_id,
      to_task_id: entry.successor_task_ids[0], state_policy: 'reset_pending' };
  });
}

function validRuntimeTodoProjection(runtimeMigration, taskMigration) {
  const projected = projectRuntimeTaskMigration(runtimeMigration);
  return projected.length === taskMigration.length && projected.every((expected, index) => {
    const actual = taskMigration[index];
    return expected.from_task_id === actual.from_task_id && expected.to_task_id === actual.to_task_id
      // runtime disposition carry/stayは実行状態の持ち越しだけを申告する。task_migration側は
      // carry_reconciled_metadataに加え、Phase獲得だけを許すacquire_phase(ADR 0147裁定4)も
      // 「状態を持ち越すcarry系」の投影として受理する。
      && (expected.state_policy === 'carry'
        ? ['carry', 'carry_reconciled_metadata', 'acquire_phase'].includes(actual.state_policy)
        : expected.state_policy === actual.state_policy);
  });
}

export function validatePhaseTodoRevision(value) {
  try {
    const revisionV1 = value?.schema === 'lattice.phase_todo_revision.v1';
    const revisionV2 = value?.schema === 'lattice.phase_todo_revision.v2';
    const revisionV3 = value?.schema === 'lattice.phase_todo_revision.v3';
    const revisionV4 = value?.schema === 'lattice.phase_todo_revision.v4';
    const keys = revisionV3 ? PHASE_REVISION_V3_KEYS
      : revisionV4 ? PHASE_REVISION_V4_KEYS : PHASE_REVISION_KEYS;
    if (!exactRecord(value, keys) || (!revisionV1 && !revisionV2 && !revisionV3 && !revisionV4)) return false;
    if (!isTodoIdentifier(value.project_id) || !isTodoIdentifier(value.plan_key)) return false;
    if (!validPredecessor(value.predecessor) || !validateTodoPlan(value.desired_plan)
      || !(revisionV3
        ? ['lattice.todo_plan.v5', 'lattice.todo_plan.v7'].includes(value.desired_plan.schema)
        : value.desired_plan.schema === (revisionV2 ? 'lattice.todo_plan.v5'
          : revisionV4 ? 'lattice.todo_plan.v7' : 'lattice.todo_plan.v4'))
      || value.desired_plan.project_id !== value.project_id
      || value.desired_plan.plan_key !== value.plan_key
      || value.desired_plan.predecessor_plan_digest !== value.predecessor.plan_digest
      || !validTaskMigration(value.task_migration)
      || !validPhaseMigration(value.phase_migration, value.desired_plan)) return false;
    const backchainKeys = [
      'schema', 'authoring_ref', 'project_id', 'plan_key', 'plan_version',
      'goal', 'features', 'tasks', 'chain_digest',
    ];
    if (revisionV4 && (!(exactRecord(value.backchain, backchainKeys)
      || exactRecord(value.backchain, [...backchainKeys, 'continuity']))
      || value.backchain.schema !== 'lattice.plan_backchain.v1'
      || value.backchain.project_id !== value.project_id
      || value.backchain.plan_key !== value.plan_key
      || value.backchain.plan_version !== value.desired_plan.plan_version
      || (value.backchain.continuity !== undefined
        && (!Array.isArray(value.backchain.continuity)
          || value.backchain.continuity.length > 512
          || !value.backchain.continuity.every((entry) => exactRecord(entry,
            ['task_id', 'policy', 'reason']) && isTodoIdentifier(entry.task_id)
            && ['carry', 'reset', 'retire'].includes(entry.policy)
            && typeof entry.reason === 'string' && entry.reason.trim().length > 0)
          || new Set(value.backchain.continuity.map(({ task_id: id }) => id)).size
            !== value.backchain.continuity.length))
      || value.backchain.chain_digest !== todoSelfDigest(value.backchain, 'chain_digest')
      || canonicalizeForCompare(value.backchain.tasks.map(({ task_id: id }) => id))
        !== canonicalizeForCompare(value.desired_plan.tasks.map(({ task_id: id }) => id)))) return false;
    if (value.desired_plan.plan_version !== phaseTodoRevisionPlanVersion({
        projectId: value.project_id, planKey: value.plan_key, predecessor: value.predecessor,
        desiredPlan: value.desired_plan, taskMigration: value.task_migration,
        phaseMigration: value.phase_migration,
        ...(revisionV4 ? { featureGraphDigest: digestTodoArtifact({
          goal: value.backchain.goal, features: value.backchain.features,
          tasks: value.backchain.tasks,
        }) } : {}),
      })) return false;
    if (revisionV3) {
      if (!validRuntimeTaskMigration(value.runtime_task_migration)
        || !validRuntimeTodoProjection(value.runtime_task_migration, value.task_migration)
        || canonicalizeForCompare(value.runtime_task_migration.entries
          .flatMap(({ successor_task_ids: ids }) => ids))
          !== canonicalizeForCompare(value.desired_plan.tasks.map(({ task_id: id }) => id))
        || !validSourceInventory(value.source_inventory, value.desired_plan,
          { requireNarrativeRef: true })
        || !validSourceCutoverBatch(value.source_cutover_batch, value)
        || !exactRecord(value.reconciliation, [
          'predecessor_reconciliation_digest', 'source_inventory_digest', 'desired_plan_digest',
          'runtime_task_migration_digest', 'task_migration_digest', 'phase_migration_digest',
          'source_cutover_batch_digest', 'reconciliation_digest',
        ]) || !isTodoDigest(value.reconciliation.predecessor_reconciliation_digest)
        || value.reconciliation.source_inventory_digest !== todoSourceInventoryDigest(value.source_inventory)
        || value.reconciliation.desired_plan_digest !== value.desired_plan.plan_digest
        || value.reconciliation.runtime_task_migration_digest !== value.runtime_task_migration.migration_digest
        || value.reconciliation.task_migration_digest !== todoTaskMigrationDigest(value.task_migration)
        || value.reconciliation.phase_migration_digest !== digestTodoArtifact(value.phase_migration)
        || value.reconciliation.source_cutover_batch_digest !== value.source_cutover_batch.batch_digest
        || value.reconciliation.reconciliation_digest
          !== todoSelfDigest(value.reconciliation, 'reconciliation_digest')) return false;
    }
    return isTodoDigest(value.revision_digest)
      && value.revision_digest === todoSelfDigest(value, 'revision_digest');
  } catch { return false; }
}

function validSourceInventory(value, desiredPlan, { requireNarrativeRef = false } = {}) {
  if (!exactRecord(value, ['active', 'excluded_tombstones'])
    || !Array.isArray(value.active) || !Array.isArray(value.excluded_tombstones)
    || value.active.length > 512 || value.excluded_tombstones.length > 2_048
    || !value.active.every((entry) => exactRecord(entry, ['task_id', 'source_ref', 'source_digest'])
      && isTodoIdentifier(entry.task_id) && parseTodoSourceRef(entry.source_ref) !== null
      && isTodoDigest(entry.source_digest))
    || !value.excluded_tombstones.every((entry) => exactRecord(entry, [
      'source_ref', 'source_digest', 'exclusion_reason',
    ]) && parseTodoSourceRef(entry.source_ref) !== null && isTodoDigest(entry.source_digest)
      && boundedText(entry.exclusion_reason))) return false;
  const taskIds = desiredPlan.tasks.map(({ task_id }) => task_id);
  const activeIds = value.active.map(({ task_id }) => task_id);
  const activeRefs = value.active.map(({ source_ref }) => source_ref);
  const tombstoneRefs = value.excluded_tombstones.map(({ source_ref }) => source_ref);
  const activeRefSet = new Set(activeRefs);
  return taskIds.length === activeIds.length && taskIds.every((id, index) => id === activeIds[index])
    && (!requireNarrativeRef || value.active.every((entry) => desiredPlan.tasks
      .find(({ task_id }) => task_id === entry.task_id)?.narrative_ref === entry.source_ref))
    && activeRefSet.size === activeRefs.length
    && new Set(tombstoneRefs).size === tombstoneRefs.length
    && tombstoneRefs.every((ref) => !activeRefSet.has(ref))
    && value.excluded_tombstones.every((entry, index) => index === 0
      || compareText(value.excluded_tombstones[index - 1].source_ref, entry.source_ref) < 0);
}

export function validateTodoRevision(value) {
  try {
    const revisionV1 = value?.schema === 'lattice.todo_revision.v1';
    const revisionV2 = value?.schema === 'lattice.todo_revision.v2';
    const sourceCutoverBatch = revisionV2 ? value.source_cutover_batch : undefined;
    if ((!revisionV1 && !revisionV2)
      || !exactRecord(value, revisionV1 ? REVISION_V1_KEYS : REVISION_V2_KEYS)
      || !isTodoIdentifier(value.project_id) || !isTodoIdentifier(value.plan_key)
      || !validPredecessor(value.predecessor) || !validateTodoPlan(value.desired_plan)
      || !['lattice.todo_plan.v3', 'lattice.todo_plan.v6'].includes(value.desired_plan.schema)
      || value.desired_plan.project_id !== value.project_id
      || value.desired_plan.plan_key !== value.plan_key
      || value.desired_plan.predecessor_plan_digest !== value.predecessor.plan_digest
      || !validTaskMigration(value.task_migration)
      || !validSourceInventory(value.source_inventory, value.desired_plan)
      || value.desired_plan.plan_version !== todoRevisionPlanVersion({
        projectId: value.project_id, planKey: value.plan_key, predecessor: value.predecessor,
        desiredPlan: value.desired_plan, taskMigration: value.task_migration,
        sourceInventory: value.source_inventory, sourceCutoverBatch,
      }) || !exactRecord(value.reconciliation, [
        'predecessor_reconciliation_digest', 'source_inventory_digest', 'reconciliation_digest',
      ]) || !isTodoDigest(value.reconciliation.predecessor_reconciliation_digest)
      || value.reconciliation.source_inventory_digest !== todoSourceInventoryDigest(value.source_inventory)
      || value.reconciliation.reconciliation_digest !== todoReconciliationDigest({
        predecessorReconciliationDigest: value.reconciliation.predecessor_reconciliation_digest,
        sourceInventoryDigest: value.reconciliation.source_inventory_digest,
        predecessor: value.predecessor,
        desiredPlanDigest: value.desired_plan.plan_digest,
        taskMigration: value.task_migration, sourceCutoverBatch,
      })) return false;
    if (revisionV2 && !validSourceCutoverBatch(value.source_cutover_batch, value)) return false;
    const targets = new Set(value.desired_plan.tasks.map(({ task_id }) => task_id));
    if (value.task_migration.some(({ to_task_id }) => to_task_id !== 'removed' && !targets.has(to_task_id))) return false;
    return isTodoDigest(value.revision_digest)
      && value.revision_digest === todoSelfDigest(value, 'revision_digest');
  } catch { return false; }
}

const reject = (reason, path = '') => ({ valid: false, reason, path });

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 期待keyとの過不足を1件ずつ言い当てる。missing/unexpectedのどちらが先に見つかっても
 * そこで止め、複数の欠落を一度に説明しない——`exactRecord`のbooleanと違い、
 * 最初に見つかった違反fieldをpathへ刻む（ADR 0130の案内規律をrevision入口へ拡張）。
 */
function explainKeys(value, requiredKeys, at) {
  if (!plainObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return reject('not_an_object', at);
  }
  const actualKeys = new Set(Object.keys(value));
  for (const key of requiredKeys) {
    if (!actualKeys.has(key)) return reject('missing_required_key', `${at}/${key}`);
  }
  const requiredSet = new Set(requiredKeys);
  for (const key of actualKeys) {
    if (!requiredSet.has(key)) return reject('unexpected_key', `${at}/${key}`);
  }
  return { valid: true };
}

function explainPredecessor(value, at = '/predecessor') {
  const keyCheck = explainKeys(value, ['plan_digest', 'journal_head_digest', 'plan_version'], at);
  if (!keyCheck.valid) return keyCheck;
  if (!isTodoDigest(value.plan_digest)) return reject('invalid_digest', `${at}/plan_digest`);
  if (!isTodoDigest(value.journal_head_digest)) return reject('invalid_digest', `${at}/journal_head_digest`);
  if (!isTodoIdentifier(value.plan_version)) return reject('invalid_identifier', `${at}/plan_version`);
  return { valid: true };
}

/**
 * 実運用で最も時間を溶かした違反——配列のソート漏れ——を、壊れているindexを名指しして返す。
 * `validTaskMigration`と同じ規則（from_task_idの厳密昇順、from/toの重複禁止）を、
 * 可否を変えずに1件ずつ言い当てる。
 */
function explainTaskMigration(value, at = '/task_migration') {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    return reject('bounded_collection_violation', at);
  }
  for (const [index, entry] of value.entries()) {
    const entryAt = `${at}/${index}`;
    const keyCheck = explainKeys(entry, ['from_task_id', 'to_task_id', 'state_policy'], entryAt);
    if (!keyCheck.valid) return keyCheck;
    if (!isTodoIdentifier(entry.from_task_id)) return reject('invalid_identifier', `${entryAt}/from_task_id`);
    if (entry.to_task_id !== 'removed' && !isTodoIdentifier(entry.to_task_id)) {
      return reject('invalid_identifier', `${entryAt}/to_task_id`);
    }
    const validPolicy = (entry.state_policy === 'removed' && entry.to_task_id === 'removed')
      || (['carry', 'carry_reconciled_metadata', 'reset_pending', 'acquire_phase'].includes(entry.state_policy)
        && entry.to_task_id !== 'removed');
    if (!validPolicy) return reject('state_policy_disposition_mismatch', `${entryAt}/state_policy`);
  }
  if (new Set(value.map(({ from_task_id: fromTaskId }) => fromTaskId)).size !== value.length) {
    return reject('duplicate_from_task_id', at);
  }
  const activeTargets = value.filter(({ to_task_id: toTaskId }) => toTaskId !== 'removed')
    .map(({ to_task_id: toTaskId }) => toTaskId);
  if (new Set(activeTargets).size !== activeTargets.length) {
    return reject('duplicate_to_task_id', at);
  }
  for (let index = 1; index < value.length; index += 1) {
    if (compareText(value[index - 1].from_task_id, value[index].from_task_id) >= 0) {
      return reject('unsorted_or_duplicate_collection', `${at}/${index}/from_task_id`);
    }
  }
  return { valid: true };
}

function explainPhaseMigration(value, desiredPlan, at = '/phase_migration') {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    return reject('bounded_collection_violation', at);
  }
  for (const [index, entry] of value.entries()) {
    const entryAt = `${at}/${index}`;
    const keyCheck = explainKeys(entry, ['from_phase_id', 'to_phase_id', 'state_policy'], entryAt);
    if (!keyCheck.valid) return keyCheck;
    if (entry.from_phase_id !== null && !isTodoIdentifier(entry.from_phase_id)) {
      return reject('invalid_identifier', `${entryAt}/from_phase_id`);
    }
    if (entry.to_phase_id !== 'removed' && !isTodoIdentifier(entry.to_phase_id)) {
      return reject('invalid_identifier', `${entryAt}/to_phase_id`);
    }
    if (!['carry', 'reset', 'removed'].includes(entry.state_policy)) {
      return reject('invalid_state_policy', `${entryAt}/state_policy`);
    }
    if (entry.state_policy === 'carry'
      && (entry.from_phase_id === null || entry.to_phase_id === 'removed')) {
      return reject('state_policy_disposition_mismatch', entryAt);
    }
    if (entry.state_policy === 'removed'
      && (entry.from_phase_id === null || entry.to_phase_id !== 'removed')) {
      return reject('state_policy_disposition_mismatch', entryAt);
    }
    if (entry.state_policy === 'reset' && entry.to_phase_id === 'removed') {
      return reject('state_policy_disposition_mismatch', entryAt);
    }
  }
  const sources = value.filter(({ from_phase_id: fromPhaseId }) => fromPhaseId !== null)
    .map(({ from_phase_id: fromPhaseId }) => fromPhaseId);
  if (new Set(sources).size !== sources.length) return reject('duplicate_from_phase_id', at);
  const targets = value.filter(({ to_phase_id: toPhaseId }) => toPhaseId !== 'removed')
    .map(({ to_phase_id: toPhaseId }) => toPhaseId);
  if (new Set(targets).size !== targets.length) return reject('duplicate_to_phase_id', at);
  if (canonicalizeForCompare(targets)
    !== canonicalizeForCompare(desiredPlan.phases.map(({ phase_id: phaseId }) => phaseId))) {
    return reject('phase_migration_target_set_mismatch', at);
  }
  return { valid: true };
}

function explainRuntimeTaskMigration(value, taskMigration, desiredPlan, at = '/runtime_task_migration') {
  const keyCheck = explainKeys(value, ['schema', 'entries', 'migration_digest'], at);
  if (!keyCheck.valid) return keyCheck;
  if (value.schema !== 'lattice.runtime_task_migration.v1') return reject('schema_mismatch', `${at}/schema`);
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 512) {
    return reject('bounded_collection_violation', `${at}/entries`);
  }
  const targets = [];
  for (const [index, entry] of value.entries.entries()) {
    const entryAt = `${at}/entries/${index}`;
    const keys = ['predecessor_task_id', 'disposition', 'successor_task_ids', 'reason', 'evidence_digests'];
    const entryKeyCheck = explainKeys(entry, keys, entryAt);
    if (!entryKeyCheck.valid) return entryKeyCheck;
    if (!isTodoIdentifier(entry.predecessor_task_id)) {
      return reject('invalid_identifier', `${entryAt}/predecessor_task_id`);
    }
    if (!['carry', 'stay', 'replace', 'split', 'retire'].includes(entry.disposition)) {
      return reject('invalid_disposition', `${entryAt}/disposition`);
    }
    if (!Array.isArray(entry.successor_task_ids) || entry.successor_task_ids.length > 512
      || !entry.successor_task_ids.every(isTodoIdentifier)) {
      return reject('invalid_successor_task_ids', `${entryAt}/successor_task_ids`);
    }
    if (new Set(entry.successor_task_ids).size !== entry.successor_task_ids.length) {
      return reject('duplicate_successor_task_id', `${entryAt}/successor_task_ids`);
    }
    const successorTail = entry.successor_task_ids.slice(1);
    for (let tailIndex = 1; tailIndex < successorTail.length; tailIndex += 1) {
      if (compareText(successorTail[tailIndex - 1], successorTail[tailIndex]) >= 0) {
        return reject('unsorted_or_duplicate_collection', `${entryAt}/successor_task_ids/${tailIndex + 1}`);
      }
    }
    if (!boundedText(entry.reason)) return reject('invalid_text', `${entryAt}/reason`);
    if (!Array.isArray(entry.evidence_digests) || entry.evidence_digests.length === 0
      || entry.evidence_digests.length > 512 || !entry.evidence_digests.every(isTodoDigest)) {
      return reject('invalid_evidence_digests', `${entryAt}/evidence_digests`);
    }
    if (new Set(entry.evidence_digests).size !== entry.evidence_digests.length) {
      return reject('duplicate_evidence_digest', `${entryAt}/evidence_digests`);
    }
    for (let digestIndex = 1; digestIndex < entry.evidence_digests.length; digestIndex += 1) {
      if (compareText(entry.evidence_digests[digestIndex - 1], entry.evidence_digests[digestIndex]) >= 0) {
        return reject('unsorted_or_duplicate_collection', `${entryAt}/evidence_digests/${digestIndex}`);
      }
    }
    if (['carry', 'stay'].includes(entry.disposition)
      && (entry.successor_task_ids.length !== 1
        || entry.successor_task_ids[0] !== entry.predecessor_task_id)) {
      return reject('disposition_successor_mismatch', entryAt);
    }
    if (entry.disposition === 'retire' && entry.successor_task_ids.length !== 0) {
      return reject('disposition_successor_mismatch', entryAt);
    }
    if (['replace', 'split'].includes(entry.disposition) && entry.successor_task_ids.length === 0) {
      return reject('disposition_successor_mismatch', entryAt);
    }
    if (index > 0 && compareText(value.entries[index - 1].predecessor_task_id,
      entry.predecessor_task_id) >= 0) {
      return reject('unsorted_or_duplicate_collection', `${at}/entries/${index}/predecessor_task_id`);
    }
    targets.push(...entry.successor_task_ids);
  }
  if (new Set(targets).size !== targets.length) return reject('duplicate_successor_task_id_across_entries', `${at}/entries`);
  if (!isTodoDigest(value.migration_digest)) return reject('invalid_digest', `${at}/migration_digest`);
  const expectedMigrationDigest = todoSelfDigest(value, 'migration_digest');
  if (value.migration_digest !== expectedMigrationDigest) {
    return reject('migration_digest_mismatch', `${at}/migration_digest`);
  }
  if (!validRuntimeTodoProjection(value, taskMigration)) {
    return reject('runtime_task_migration_projection_mismatch', at);
  }
  if (canonicalizeForCompare(value.entries.flatMap(({ successor_task_ids: ids }) => ids))
    !== canonicalizeForCompare(desiredPlan.tasks.map(({ task_id: taskId }) => taskId))) {
    return reject('runtime_task_migration_target_set_mismatch', at);
  }
  return { valid: true };
}

function explainSourceInventory(value, desiredPlan, { requireNarrativeRef = false } = {}, at = '/source_inventory') {
  const keyCheck = explainKeys(value, ['active', 'excluded_tombstones'], at);
  if (!keyCheck.valid) return keyCheck;
  if (!Array.isArray(value.active) || value.active.length > 512) {
    return reject('bounded_collection_violation', `${at}/active`);
  }
  if (!Array.isArray(value.excluded_tombstones) || value.excluded_tombstones.length > 2_048) {
    return reject('bounded_collection_violation', `${at}/excluded_tombstones`);
  }
  for (const [index, entry] of value.active.entries()) {
    const entryAt = `${at}/active/${index}`;
    const entryKeyCheck = explainKeys(entry, ['task_id', 'source_ref', 'source_digest'], entryAt);
    if (!entryKeyCheck.valid) return entryKeyCheck;
    if (!isTodoIdentifier(entry.task_id)) return reject('invalid_identifier', `${entryAt}/task_id`);
    if (parseTodoSourceRef(entry.source_ref) === null) return reject('invalid_source_ref', `${entryAt}/source_ref`);
    if (!isTodoDigest(entry.source_digest)) return reject('invalid_digest', `${entryAt}/source_digest`);
  }
  for (const [index, entry] of value.excluded_tombstones.entries()) {
    const entryAt = `${at}/excluded_tombstones/${index}`;
    const entryKeyCheck = explainKeys(entry, ['source_ref', 'source_digest', 'exclusion_reason'], entryAt);
    if (!entryKeyCheck.valid) return entryKeyCheck;
    if (parseTodoSourceRef(entry.source_ref) === null) return reject('invalid_source_ref', `${entryAt}/source_ref`);
    if (!isTodoDigest(entry.source_digest)) return reject('invalid_digest', `${entryAt}/source_digest`);
    if (!boundedText(entry.exclusion_reason)) return reject('invalid_text', `${entryAt}/exclusion_reason`);
  }
  const taskIds = desiredPlan.tasks.map(({ task_id: taskId }) => taskId);
  const activeIds = value.active.map(({ task_id: taskId }) => taskId);
  if (taskIds.length !== activeIds.length || !taskIds.every((id, index) => id === activeIds[index])) {
    return reject('source_inventory_task_set_mismatch', `${at}/active`);
  }
  if (requireNarrativeRef) {
    for (const [index, entry] of value.active.entries()) {
      const task = desiredPlan.tasks.find(({ task_id: taskId }) => taskId === entry.task_id);
      if (task?.narrative_ref !== entry.source_ref) {
        return reject('source_inventory_narrative_ref_mismatch', `${at}/active/${index}/source_ref`);
      }
    }
  }
  const activeRefs = value.active.map(({ source_ref: sourceRef }) => sourceRef);
  if (new Set(activeRefs).size !== activeRefs.length) return reject('duplicate_source_ref', `${at}/active`);
  const tombstoneRefs = value.excluded_tombstones.map(({ source_ref: sourceRef }) => sourceRef);
  if (new Set(tombstoneRefs).size !== tombstoneRefs.length) {
    return reject('duplicate_source_ref', `${at}/excluded_tombstones`);
  }
  const activeRefSet = new Set(activeRefs);
  if (tombstoneRefs.some((ref) => activeRefSet.has(ref))) {
    return reject('tombstone_ref_still_active', `${at}/excluded_tombstones`);
  }
  for (let index = 1; index < value.excluded_tombstones.length; index += 1) {
    if (compareText(value.excluded_tombstones[index - 1].source_ref,
      value.excluded_tombstones[index].source_ref) >= 0) {
      return reject('unsorted_or_duplicate_collection', `${at}/excluded_tombstones/${index}/source_ref`);
    }
  }
  return { valid: true };
}

function explainSourceCutoverBatch(value, revision, at = '/source_cutover_batch') {
  const keyCheck = explainKeys(value, ['batch_id', 'archive_ref', 'operations', 'batch_digest'], at);
  if (!keyCheck.valid) return keyCheck;
  if (!isTodoIdentifier(value.batch_id)) return reject('invalid_identifier', `${at}/batch_id`);
  if (!isTodoRef(value.archive_ref) || !value.archive_ref.endsWith('.md')
    || parseTodoSourceRef(value.archive_ref) !== null) {
    return reject('invalid_archive_ref', `${at}/archive_ref`);
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > 512) {
    return reject('bounded_collection_violation', `${at}/operations`);
  }
  const sourceRefs = new Set();
  const activeTaskIds = new Set();
  for (const [index, operation] of value.operations.entries()) {
    const opAt = `${at}/operations/${index}`;
    const keys = ['task_id', 'disposition', 'source_ref', 'source_digest', 'live_replacement'];
    const opKeyCheck = explainKeys(operation, keys, opAt);
    if (!opKeyCheck.valid) return opKeyCheck;
    if (!['active', 'excluded'].includes(operation.disposition)) {
      return reject('invalid_disposition', `${opAt}/disposition`);
    }
    if (operation.disposition === 'active' ? !isTodoIdentifier(operation.task_id)
      : operation.task_id !== null) {
      return reject('task_id_disposition_mismatch', `${opAt}/task_id`);
    }
    if (parseTodoSourceRef(operation.source_ref) === null) return reject('invalid_source_ref', `${opAt}/source_ref`);
    if (!isTodoDigest(operation.source_digest)) return reject('invalid_digest', `${opAt}/source_digest`);
    if (!validLiveReplacement(operation.live_replacement)) {
      return reject('invalid_live_replacement', `${opAt}/live_replacement`);
    }
    if (sourceRefs.has(operation.source_ref)) return reject('duplicate_source_ref', `${opAt}/source_ref`);
    sourceRefs.add(operation.source_ref);
    if (index > 0 && compareText(value.operations[index - 1].source_ref, operation.source_ref) >= 0) {
      return reject('unsorted_or_duplicate_collection', `${opAt}/source_ref`);
    }
    const archivedSourceRef = todoCutoverArchiveSourceRef(value, index);
    if (operation.disposition === 'active') {
      if (activeTaskIds.has(operation.task_id)) return reject('duplicate_task_id', `${opAt}/task_id`);
      activeTaskIds.add(operation.task_id);
      const inventory = revision.source_inventory.active
        .find(({ task_id: taskId }) => taskId === operation.task_id);
      const task = revision.desired_plan.tasks.find(({ task_id: taskId }) => taskId === operation.task_id);
      if (inventory?.source_ref !== archivedSourceRef || inventory.source_digest !== operation.source_digest
        || task?.narrative_ref !== archivedSourceRef) {
        return reject('cutover_operation_not_bound_to_inventory', opAt);
      }
    } else {
      const tombstone = revision.source_inventory.excluded_tombstones.find((entry) => (
        entry.source_ref === archivedSourceRef && entry.source_digest === operation.source_digest
      ));
      if (tombstone === undefined) return reject('cutover_operation_not_bound_to_tombstone', opAt);
    }
  }
  if (!isTodoDigest(value.batch_digest)) return reject('invalid_digest', `${at}/batch_digest`);
  const expectedBatchDigest = todoSelfDigest(value, 'batch_digest');
  if (value.batch_digest !== expectedBatchDigest) return reject('batch_digest_mismatch', `${at}/batch_digest`);
  return { valid: true };
}

/**
 * `lattice todo revise`が受理する`lattice.todo_revision.v1/v2`を診断する。
 *
 * `validateTodoRevision`の可否は変えない。desired_plan自体のgraph整合
 * （task/phase閉包・topology digest）は`validateTodoPlan`任せの単一reasonへ丸め、
 * ここでは実運用で詰まった箇所——必須key・task_migrationのソート・各digestの不一致——
 * を優先して名指しする。
 */
export function explainTodoRevision(value) {
  try {
    if (!plainObject(value)) return reject('not_an_object', '');
    const revisionV1 = value.schema === 'lattice.todo_revision.v1';
    const revisionV2 = value.schema === 'lattice.todo_revision.v2';
    if (!revisionV1 && !revisionV2) return reject('schema_mismatch', '/schema');
    const keyCheck = explainKeys(value, revisionV1 ? REVISION_V1_KEYS : REVISION_V2_KEYS, '');
    if (!keyCheck.valid) return keyCheck;
    if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
    if (!isTodoIdentifier(value.plan_key)) return reject('invalid_identifier', '/plan_key');
    const predecessorCheck = explainPredecessor(value.predecessor);
    if (!predecessorCheck.valid) return predecessorCheck;
    if (!validateTodoPlan(value.desired_plan)) return reject('desired_plan_invalid', '/desired_plan');
    if (!['lattice.todo_plan.v3', 'lattice.todo_plan.v6'].includes(value.desired_plan.schema)) {
      return reject('desired_plan_schema_mismatch', '/desired_plan/schema');
    }
    if (value.desired_plan.project_id !== value.project_id) {
      return reject('desired_plan_project_id_mismatch', '/desired_plan/project_id');
    }
    if (value.desired_plan.plan_key !== value.plan_key) {
      return reject('desired_plan_plan_key_mismatch', '/desired_plan/plan_key');
    }
    if (value.desired_plan.predecessor_plan_digest !== value.predecessor.plan_digest) {
      return reject('desired_plan_predecessor_mismatch', '/desired_plan/predecessor_plan_digest');
    }
    const taskMigrationCheck = explainTaskMigration(value.task_migration);
    if (!taskMigrationCheck.valid) return taskMigrationCheck;
    const sourceCutoverBatch = revisionV2 ? value.source_cutover_batch : undefined;
    const sourceInventoryCheck = explainSourceInventory(value.source_inventory, value.desired_plan);
    if (!sourceInventoryCheck.valid) return sourceInventoryCheck;
    const expectedPlanVersion = todoRevisionPlanVersion({
      projectId: value.project_id, planKey: value.plan_key, predecessor: value.predecessor,
      desiredPlan: value.desired_plan, taskMigration: value.task_migration,
      sourceInventory: value.source_inventory, sourceCutoverBatch,
    });
    if (value.desired_plan.plan_version !== expectedPlanVersion) {
      return reject('plan_version_mismatch', '/desired_plan/plan_version');
    }
    const reconciliationCheck = explainKeys(value.reconciliation, [
      'predecessor_reconciliation_digest', 'source_inventory_digest', 'reconciliation_digest',
    ], '/reconciliation');
    if (!reconciliationCheck.valid) return reconciliationCheck;
    if (!isTodoDigest(value.reconciliation.predecessor_reconciliation_digest)) {
      return reject('invalid_digest', '/reconciliation/predecessor_reconciliation_digest');
    }
    const expectedSourceInventoryDigest = todoSourceInventoryDigest(value.source_inventory);
    if (value.reconciliation.source_inventory_digest !== expectedSourceInventoryDigest) {
      return reject('source_inventory_digest_mismatch', '/reconciliation/source_inventory_digest');
    }
    const expectedReconciliationDigest = todoReconciliationDigest({
      predecessorReconciliationDigest: value.reconciliation.predecessor_reconciliation_digest,
      sourceInventoryDigest: value.reconciliation.source_inventory_digest,
      predecessor: value.predecessor, desiredPlanDigest: value.desired_plan.plan_digest,
      taskMigration: value.task_migration, sourceCutoverBatch,
    });
    if (value.reconciliation.reconciliation_digest !== expectedReconciliationDigest) {
      return reject('reconciliation_digest_mismatch', '/reconciliation/reconciliation_digest');
    }
    if (revisionV2) {
      const cutoverCheck = explainSourceCutoverBatch(value.source_cutover_batch, value);
      if (!cutoverCheck.valid) return cutoverCheck;
    }
    const targets = new Set(value.desired_plan.tasks.map(({ task_id: taskId }) => taskId));
    const badTargetIndex = value.task_migration
      .findIndex(({ to_task_id: toTaskId }) => toTaskId !== 'removed' && !targets.has(toTaskId));
    if (badTargetIndex !== -1) {
      return reject('task_migration_target_unresolved', `/task_migration/${badTargetIndex}/to_task_id`);
    }
    if (!isTodoDigest(value.revision_digest)) return reject('invalid_digest', '/revision_digest');
    const expectedRevisionDigest = todoSelfDigest(value, 'revision_digest');
    if (value.revision_digest !== expectedRevisionDigest) {
      return reject('revision_digest_mismatch', '/revision_digest');
    }
    // ここまでの個別検査を全て通過したのに`validateTodoRevision`がfalseを返す状況は、
    // このexplainがまだ言い当てられない違反があるということ。捏造せず未特定と申告する。
    return { valid: true };
  } catch {
    return reject('diagnosis_failed', '');
  }
}

/**
 * `lattice todo revise-phase`が受理する`lattice.phase_todo_revision.v1/v2/v3`を診断する。
 * 方針は`explainTodoRevision`と同じ——desired_planのgraph整合は単一reasonへ丸め、
 * v3で増える`runtime_task_migration`・`source_cutover_batch`・8-key reconciliationの
 * 各digestを個別に名指しする。
 */
export function explainPhaseTodoRevision(value) {
  try {
    if (!plainObject(value)) return reject('not_an_object', '');
    const revisionV1 = value.schema === 'lattice.phase_todo_revision.v1';
    const revisionV2 = value.schema === 'lattice.phase_todo_revision.v2';
    const revisionV3 = value.schema === 'lattice.phase_todo_revision.v3';
    const revisionV4 = value.schema === 'lattice.phase_todo_revision.v4';
    if (!revisionV1 && !revisionV2 && !revisionV3 && !revisionV4) return reject('schema_mismatch', '/schema');
    const keyCheck = explainKeys(value, revisionV3 ? PHASE_REVISION_V3_KEYS
      : revisionV4 ? PHASE_REVISION_V4_KEYS : PHASE_REVISION_KEYS, '');
    if (!keyCheck.valid) return keyCheck;
    if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
    if (!isTodoIdentifier(value.plan_key)) return reject('invalid_identifier', '/plan_key');
    const predecessorCheck = explainPredecessor(value.predecessor);
    if (!predecessorCheck.valid) return predecessorCheck;
    if (!validateTodoPlan(value.desired_plan)) return reject('desired_plan_invalid', '/desired_plan');
    const expectedPlanSchemas = revisionV3 ? ['lattice.todo_plan.v5', 'lattice.todo_plan.v7']
      : [revisionV2 ? 'lattice.todo_plan.v5'
        : revisionV4 ? 'lattice.todo_plan.v7' : 'lattice.todo_plan.v4'];
    if (!expectedPlanSchemas.includes(value.desired_plan.schema)) {
      return reject('desired_plan_schema_mismatch', '/desired_plan/schema');
    }
    if (value.desired_plan.project_id !== value.project_id) {
      return reject('desired_plan_project_id_mismatch', '/desired_plan/project_id');
    }
    if (value.desired_plan.plan_key !== value.plan_key) {
      return reject('desired_plan_plan_key_mismatch', '/desired_plan/plan_key');
    }
    if (value.desired_plan.predecessor_plan_digest !== value.predecessor.plan_digest) {
      return reject('desired_plan_predecessor_mismatch', '/desired_plan/predecessor_plan_digest');
    }
    const taskMigrationCheck = explainTaskMigration(value.task_migration);
    if (!taskMigrationCheck.valid) return taskMigrationCheck;
    const phaseMigrationCheck = explainPhaseMigration(value.phase_migration, value.desired_plan);
    if (!phaseMigrationCheck.valid) return phaseMigrationCheck;
    const expectedPlanVersion = phaseTodoRevisionPlanVersion({
      projectId: value.project_id, planKey: value.plan_key, predecessor: value.predecessor,
      desiredPlan: value.desired_plan, taskMigration: value.task_migration,
      phaseMigration: value.phase_migration,
      ...(revisionV4 ? { featureGraphDigest: digestTodoArtifact({
        goal: value.backchain.goal, features: value.backchain.features,
        tasks: value.backchain.tasks,
      }) } : {}),
    });
    if (value.desired_plan.plan_version !== expectedPlanVersion) {
      return reject('plan_version_mismatch', '/desired_plan/plan_version');
    }
    if (revisionV3) {
      const runtimeCheck = explainRuntimeTaskMigration(
        value.runtime_task_migration, value.task_migration, value.desired_plan,
      );
      if (!runtimeCheck.valid) return runtimeCheck;
      const sourceInventoryCheck = explainSourceInventory(value.source_inventory, value.desired_plan, {
        requireNarrativeRef: true,
      });
      if (!sourceInventoryCheck.valid) return sourceInventoryCheck;
      const cutoverCheck = explainSourceCutoverBatch(value.source_cutover_batch, value);
      if (!cutoverCheck.valid) return cutoverCheck;
      const reconciliationKeys = [
        'predecessor_reconciliation_digest', 'source_inventory_digest', 'desired_plan_digest',
        'runtime_task_migration_digest', 'task_migration_digest', 'phase_migration_digest',
        'source_cutover_batch_digest', 'reconciliation_digest',
      ];
      const reconciliationCheck = explainKeys(value.reconciliation, reconciliationKeys, '/reconciliation');
      if (!reconciliationCheck.valid) return reconciliationCheck;
      if (!isTodoDigest(value.reconciliation.predecessor_reconciliation_digest)) {
        return reject('invalid_digest', '/reconciliation/predecessor_reconciliation_digest');
      }
      if (value.reconciliation.source_inventory_digest
        !== todoSourceInventoryDigest(value.source_inventory)) {
        return reject('source_inventory_digest_mismatch', '/reconciliation/source_inventory_digest');
      }
      if (value.reconciliation.desired_plan_digest !== value.desired_plan.plan_digest) {
        return reject('desired_plan_digest_mismatch', '/reconciliation/desired_plan_digest');
      }
      if (value.reconciliation.runtime_task_migration_digest !== value.runtime_task_migration.migration_digest) {
        return reject('runtime_task_migration_digest_mismatch', '/reconciliation/runtime_task_migration_digest');
      }
      if (value.reconciliation.task_migration_digest !== todoTaskMigrationDigest(value.task_migration)) {
        return reject('task_migration_digest_mismatch', '/reconciliation/task_migration_digest');
      }
      if (value.reconciliation.phase_migration_digest !== digestTodoArtifact(value.phase_migration)) {
        return reject('phase_migration_digest_mismatch', '/reconciliation/phase_migration_digest');
      }
      if (value.reconciliation.source_cutover_batch_digest !== value.source_cutover_batch.batch_digest) {
        return reject('source_cutover_batch_digest_mismatch', '/reconciliation/source_cutover_batch_digest');
      }
      const expectedReconciliationDigest = todoSelfDigest(value.reconciliation, 'reconciliation_digest');
      if (value.reconciliation.reconciliation_digest !== expectedReconciliationDigest) {
        return reject('reconciliation_digest_mismatch', '/reconciliation/reconciliation_digest');
      }
    }
    if (!isTodoDigest(value.revision_digest)) return reject('invalid_digest', '/revision_digest');
    const expectedRevisionDigest = todoSelfDigest(value, 'revision_digest');
    if (value.revision_digest !== expectedRevisionDigest) {
      return reject('revision_digest_mismatch', '/revision_digest');
    }
    return { valid: true };
  } catch {
    return reject('diagnosis_failed', '');
  }
}

/**
 * `lattice todo revise-set`が受理する`lattice.todo_revision_set.v1/v2/v3`を診断する。
 * 個々のrevision memberの中身は`explainTodoRevision`／`explainPhaseTodoRevision`へ委譲し、
 * setとして必要な件数・plan_key順序・自己digestだけをここで見る。
 */
export function explainTodoRevisionSet(value) {
  try {
    if (!plainObject(value)) return reject('not_an_object', '');
    const setV1 = value.schema === 'lattice.todo_revision_set.v1';
    const setV2 = value.schema === 'lattice.todo_revision_set.v2';
    const setV3 = value.schema === 'lattice.todo_revision_set.v3';
    if (!setV1 && !setV2 && !setV3) return reject('schema_mismatch', '/schema');
    const keyCheck = explainKeys(value, ['schema', 'project_id', 'revisions', 'revision_set_digest'], '');
    if (!keyCheck.valid) return keyCheck;
    if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
    if (!Array.isArray(value.revisions) || value.revisions.length < 2 || value.revisions.length > 64) {
      return reject('bounded_collection_violation', '/revisions');
    }
    for (const [index, revision] of value.revisions.entries()) {
      const entryAt = `/revisions/${index}`;
      const isPhaseMember = setV3 && ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2']
        .includes(revision?.schema);
      if (isPhaseMember) {
        const memberCheck = explainPhaseTodoRevision(revision);
        if (!memberCheck.valid) {
          return reject(memberCheck.reason, `${entryAt}${memberCheck.path}`);
        }
      } else {
        if (!setV2 && !setV3 && revision?.schema !== 'lattice.todo_revision.v1') {
          return reject('revision_set_v1_requires_todo_revision_v1', `${entryAt}/schema`);
        }
        const memberCheck = explainTodoRevision(revision);
        if (!memberCheck.valid) {
          return reject(memberCheck.reason, `${entryAt}${memberCheck.path}`);
        }
      }
      if (revision.project_id !== value.project_id) {
        return reject('revision_project_id_mismatch', `${entryAt}/project_id`);
      }
    }
    if (setV2 && !value.revisions.some((revision) => revision.schema === 'lattice.todo_revision.v2')) {
      return reject('revision_set_v2_requires_todo_revision_v2_member', '/revisions');
    }
    if (setV3 && !value.revisions.some((revision) => [
      'lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2',
    ].includes(revision.schema))) {
      return reject('revision_set_v3_requires_phase_todo_revision_member', '/revisions');
    }
    for (let index = 1; index < value.revisions.length; index += 1) {
      if (compareText(value.revisions[index - 1].plan_key, value.revisions[index].plan_key) >= 0) {
        return reject('unsorted_or_duplicate_collection', `/revisions/${index}/plan_key`);
      }
    }
    if (!isTodoDigest(value.revision_set_digest)) return reject('invalid_digest', '/revision_set_digest');
    const expectedDigest = todoSelfDigest(value, 'revision_set_digest');
    if (value.revision_set_digest !== expectedDigest) {
      return reject('revision_set_digest_mismatch', '/revision_set_digest');
    }
    return { valid: true };
  } catch {
    return reject('diagnosis_failed', '');
  }
}

export function validateTodoRevisionSet(value) {
  try {
    const setV1 = value?.schema === 'lattice.todo_revision_set.v1';
    const setV2 = value?.schema === 'lattice.todo_revision_set.v2';
    const setV3 = value?.schema === 'lattice.todo_revision_set.v3';
    return exactRecord(value, [
      'schema', 'project_id', 'revisions', 'revision_set_digest',
    ])
      && (setV1 || setV2 || setV3)
      && isTodoIdentifier(value.project_id)
      && Array.isArray(value.revisions)
      && value.revisions.length >= 2
      && value.revisions.length <= 64
      && value.revisions.every((revision) => (
        (validateTodoRevision(revision)
          && (setV2 || setV3 || revision.schema === 'lattice.todo_revision.v1'))
        || (setV3 && ['lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2']
          .includes(revision.schema) && validatePhaseTodoRevision(revision))
      ) && revision.project_id === value.project_id)
      && (!setV2 || value.revisions.some((revision) => revision.schema === 'lattice.todo_revision.v2'))
      && (!setV3 || value.revisions.some((revision) => [
        'lattice.phase_todo_revision.v1', 'lattice.phase_todo_revision.v2',
      ].includes(revision.schema)))
      && value.revisions.every((revision, index) => index === 0
        || compareText(value.revisions[index - 1].plan_key, revision.plan_key) < 0)
      && isTodoDigest(value.revision_set_digest)
      && value.revision_set_digest === todoSelfDigest(value, 'revision_set_digest');
  } catch { return false; }
}
