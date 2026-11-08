import { createHash } from 'node:crypto';
import {
  lstat, readFile, realpath,
} from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizeTodoArtifact,
  digestTodoArtifact,
  exactRecord,
  isTodoDesignMemo,
  isTodoDigest,
  isTodoIdentifier,
  isTodoRef,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { migrateWitnessSetTaskIds } from './todo-independence.mjs';
import { buildTodoPlan } from './todo-store.mjs';
import {
  parseTodoSourceRef,
  phaseTodoRevisionPlanVersion,
  todoCutoverArchiveSourceRef,
  todoLegacyReconciliationDigest,
  todoReconciliationDigest,
  todoRevisionPlanVersion,
  todoSourceInventoryDigest,
  todoTaskMigrationDigest,
  validatePhaseTodoRevision,
  validateTodoRevision,
} from './todo-revision.mjs';

const TODO_SPLIT_SCHEMA = 'lattice.todo_split.v1';
const SUPPORTED_PLAN_SCHEMAS = new Set(['lattice.todo_plan.v6', 'lattice.todo_plan.v7', 'lattice.todo_plan.v8']);
// v8 = v7 + task.done_condition。分割で生まれる子は終了条件を持たない（null）。
const isPhasedMemoPlan = (plan) => ['lattice.todo_plan.v7', 'lattice.todo_plan.v8'].includes(plan.schema);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export class TodoSplitError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TodoSplitError';
    this.code = 'TODO_SPLIT_INVALID';
    this.detail = detail;
  }
}

const boundedText = (value) => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value, 'utf8') <= 16_384 && !CONTROL.test(value);

function invalid(reason, pointer = '') {
  throw new TodoSplitError(reason, { reason, pointer });
}

export function validateTodoSplitProposal(value) {
  try {
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'task_id', 'reason', 'evidence_digests',
      'archive_ref', 'residual', 'extracted_tasks',
    ]) || value.schema !== TODO_SPLIT_SCHEMA
      || !isTodoIdentifier(value.project_id) || !isTodoIdentifier(value.plan_key)
      || !isTodoIdentifier(value.task_id) || !boundedText(value.reason)
      || !isTodoRef(value.archive_ref) || !value.archive_ref.endsWith('.md')
      || parseTodoSourceRef(value.archive_ref) !== null
      || !exactRecord(value.residual, ['title', 'lane', 'design_memo'])
      || !boundedText(value.residual.title) || !isTodoIdentifier(value.residual.lane)
      || !isTodoDesignMemo(value.residual.design_memo)
      || !Array.isArray(value.evidence_digests) || value.evidence_digests.length < 1
      || value.evidence_digests.length > 512 || !value.evidence_digests.every(isTodoDigest)
      || new Set(value.evidence_digests).size !== value.evidence_digests.length
      || !Array.isArray(value.extracted_tasks) || value.extracted_tasks.length < 1
      || value.extracted_tasks.length > 511) return false;
    const childIds = new Set();
    const sourceRefs = new Set();
    for (const child of value.extracted_tasks) {
      if (!exactRecord(child, [
        'task_id', 'title', 'lane', 'design_memo', 'source_ref', 'depends_on',
      ]) || !isTodoIdentifier(child.task_id) || child.task_id === value.task_id
        || childIds.has(child.task_id) || !boundedText(child.title)
        || !isTodoIdentifier(child.lane) || !isTodoDesignMemo(child.design_memo)
        || parseTodoSourceRef(child.source_ref) === null || sourceRefs.has(child.source_ref)
        || !Array.isArray(child.depends_on) || child.depends_on.length > 511
        || !child.depends_on.every(isTodoIdentifier)
        || new Set(child.depends_on).size !== child.depends_on.length
        || child.depends_on.includes(child.task_id)) return false;
      childIds.add(child.task_id);
      sourceRefs.add(child.source_ref);
    }
    return value.extracted_tasks.every(({ depends_on: dependencies }) => (
      dependencies.every((taskId) => childIds.has(taskId))
    ));
  } catch {
    return false;
  }
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index === bytes.length || bytes[index] === 0x0a) {
      lines.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return lines;
}

async function sourceLine(repoRoot, sourceRef, { checkbox = false } = {}) {
  const parsed = parseTodoSourceRef(sourceRef);
  if (parsed === null) invalid('source_ref_invalid', '/extracted_tasks/source_ref');
  const canonicalRoot = await realpath(repoRoot);
  const absolute = path.resolve(canonicalRoot, parsed.path);
  if (!within(canonicalRoot, absolute)) invalid('source_outside_repository', sourceRef);
  let metadata;
  try { metadata = await lstat(absolute); } catch { invalid('source_missing', sourceRef); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) invalid('source_path_unsafe', sourceRef);
  const resolved = await realpath(absolute);
  if (resolved !== absolute || !within(canonicalRoot, resolved)) invalid('source_path_alias', sourceRef);
  const line = splitLines(await readFile(resolved))[parsed.line - 1];
  if (line === undefined) invalid('source_line_missing', sourceRef);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(line); }
  catch { invalid('source_invalid_utf8', sourceRef); }
  const match = /^([\t ]*)([-+*]|\d+[A-Za-z]?\.|\d+\))[\t ]+\[[ xX]\](?:[\t ]+.*)?\r?$/u.exec(text);
  if (checkbox && match === null) invalid('source_item_not_todo', sourceRef);
  return {
    bytes: line,
    digest: createHash('sha256').update(line).digest('hex'),
    marker: match === null ? null : `${match[1]}${match[2]}`,
  };
}

const compareCanonical = (left, right) => {
  const leftBytes = canonicalizeTodoArtifact(left);
  const rightBytes = canonicalizeTodoArtifact(right);
  return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
};

function predecessorReconciliationDigest(member, phasePlan) {
  const genesis = member.journal.events[0];
  if (genesis.schema === 'lattice.todo_event.v2') return genesis.reconciliation_digest;
  if (phasePlan && isTodoDigest(member.revision?.reconciliation?.reconciliation_digest)) {
    return member.revision.reconciliation.reconciliation_digest;
  }
  return todoLegacyReconciliationDigest({
    planDigest: member.plan.plan_digest,
    journalHeadDigest: member.journal.events.at(-1).event_digest,
  });
}

async function existingSourceInventory(repoRoot, member) {
  const inheritedInventory = member.revision?.source_inventory !== undefined;
  const inherited = new Map((member.revision?.source_inventory?.active ?? [])
    .map((entry) => [entry.task_id, structuredClone(entry)]));
  const active = [];
  for (const task of member.plan.tasks) {
    const entry = inherited.get(task.task_id);
    if (entry !== undefined) {
      active.push(entry);
      continue;
    }
    if (typeof task.narrative_ref !== 'string' || parseTodoSourceRef(task.narrative_ref) === null) {
      invalid('predecessor_source_inventory_unavailable', `/tasks/${task.task_id}/narrative_ref`);
    }
    const source = await sourceLine(repoRoot, task.narrative_ref);
    active.push({ task_id: task.task_id, source_ref: task.narrative_ref, source_digest: source.digest });
  }
  return {
    active,
    excluded_tombstones: structuredClone(
      member.revision?.source_inventory?.excluded_tombstones ?? [],
    ),
    inherited: inheritedInventory,
  };
}

function localTaskRef(plan, taskId) {
  return { project_id: plan.project_id, plan_key: plan.plan_key, task_id: taskId };
}

async function compileSourceCutover(repoRoot, proposal, {
  existingTasks = [], reservedSourceRefs = [],
} = {}) {
  const definitions = [
    ...existingTasks.map((task) => ({
      task_id: task.task_id,
      title: task.task_id === proposal.task_id ? proposal.residual.title : task.title,
      source_ref: task.narrative_ref,
    })),
    ...proposal.extracted_tasks,
  ];
  const occupiedSourceRefs = new Set(reservedSourceRefs);
  const rows = [];
  for (const definition of definitions) {
    if (occupiedSourceRefs.has(definition.source_ref)) {
      invalid('source_ref_conflicts_with_predecessor', definition.source_ref);
    }
    occupiedSourceRefs.add(definition.source_ref);
    const line = await sourceLine(repoRoot, definition.source_ref, { checkbox: true });
    rows.push({ definition, line });
  }
  rows.sort((left, right) => left.definition.source_ref.localeCompare(right.definition.source_ref));
  const batch = {
    batch_id: `split-${digestTodoArtifact(proposal).slice(0, 24)}`,
    archive_ref: proposal.archive_ref,
    operations: rows.map(({ definition, line }) => ({
      task_id: definition.task_id,
      disposition: 'active',
      source_ref: definition.source_ref,
      source_digest: line.digest,
      live_replacement: `${line.marker} Lattice todo splitへ移行済み（${definition.task_id}）: ${definition.title}`,
    })),
    batch_digest: '',
  };
  batch.batch_digest = todoSelfDigest(batch, 'batch_digest');
  return { batch, archivedByTask: new Map(rows.map(({ definition }, index) => [
    definition.task_id,
    { source_ref: todoCutoverArchiveSourceRef(batch, index),
      source_digest: batch.operations[index].source_digest },
  ])) };
}

function compileTasks(plan, proposal, archivedByTask) {
  const residual = plan.tasks.find(({ task_id: taskId }) => taskId === proposal.task_id);
  const phasePlan = isPhasedMemoPlan(plan);
  const existing = plan.tasks.map((task) => {
    const updated = task.task_id === proposal.task_id ? {
      ...task,
      title: proposal.residual.title,
      lane: proposal.residual.lane,
      design_memo: proposal.residual.design_memo,
    } : task;
    const archived = archivedByTask.get(task.task_id);
    return archived === undefined ? updated : { ...updated, narrative_ref: archived.source_ref };
  });
  const children = [...proposal.extracted_tasks]
    .sort((left, right) => left.task_id.localeCompare(right.task_id))
    .map((child) => ({
      task_id: child.task_id,
      title: child.title,
      lane: child.lane,
      design_memo: child.design_memo,
      narrative_ref: archivedByTask.get(child.task_id).source_ref,
      narrative_anchor: null,
      compile_binding: null,
      parent_task_id: proposal.task_id,
      ...(phasePlan ? { phase_id: residual.phase_id } : {}),
      ...(plan.schema === 'lattice.todo_plan.v8' ? { done_condition: null } : {}),
    }));
  return [...existing, ...children]
    .sort((left, right) => left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0);
}

function compileDependencies(plan, proposal) {
  const edges = [...plan.hard_dependencies];
  for (const child of proposal.extracted_tasks) {
    for (const predecessorId of child.depends_on) {
      edges.push({
        from: localTaskRef(plan, predecessorId),
        to: localTaskRef(plan, child.task_id),
      });
    }
    edges.push({
      from: localTaskRef(plan, child.task_id),
      to: localTaskRef(plan, proposal.task_id),
    });
  }
  edges.sort(compareCanonical);
  if (new Set(edges.map(canonicalizeTodoArtifact)).size !== edges.length) {
    invalid('duplicate_dependency', '/extracted_tasks/depends_on');
  }
  return edges;
}

function compileTaskMigration(plan, taskId, reconciledTaskIds = new Set()) {
  return plan.tasks.map(({ task_id: currentTaskId }) => ({
    from_task_id: currentTaskId,
    to_task_id: currentTaskId,
    state_policy: currentTaskId === taskId ? 'reset_pending'
      : reconciledTaskIds.has(currentTaskId) ? 'carry_reconciled_metadata' : 'carry',
  })).sort((left, right) => left.from_task_id.localeCompare(right.from_task_id));
}

function compileRuntimeTaskMigration(plan, proposal) {
  const children = proposal.extracted_tasks.map(({ task_id: taskId }) => taskId).sort();
  const evidenceDigests = [...proposal.evidence_digests].sort();
  const value = {
    schema: 'lattice.runtime_task_migration.v1',
    entries: plan.tasks.map(({ task_id: taskId }) => taskId === proposal.task_id ? {
      predecessor_task_id: taskId,
      disposition: 'split',
      successor_task_ids: [taskId, ...children],
      reason: proposal.reason,
      evidence_digests: evidenceDigests,
    } : {
      predecessor_task_id: taskId,
      disposition: 'carry',
      successor_task_ids: [taskId],
      reason: 'splitの影響を受けないため状態を維持する',
      evidence_digests: evidenceDigests,
    }).sort((left, right) => left.predecessor_task_id.localeCompare(right.predecessor_task_id)),
    migration_digest: '',
  };
  value.migration_digest = todoSelfDigest(value, 'migration_digest');
  return value;
}

export async function compileTodoSplit({ repoRoot, member, proposal }) {
  if (!validateTodoSplitProposal(proposal)) invalid('proposal_schema_invalid');
  const plan = member?.plan;
  if (plan?.project_id !== proposal.project_id || plan?.plan_key !== proposal.plan_key) {
    invalid('proposal_plan_binding_mismatch');
  }
  if (!SUPPORTED_PLAN_SCHEMAS.has(plan.schema)) invalid('successor_schema_not_supported');
  const sourceTask = plan.tasks.find(({ task_id: taskId }) => taskId === proposal.task_id);
  if (sourceTask === undefined) invalid('source_task_not_active', '/task_id');
  const runtimeTask = member.tasks.find(({ task_id: taskId }) => taskId === proposal.task_id);
  if (runtimeTask?.status !== 'in-progress') invalid('source_task_not_in_progress', '/task_id');
  const existingIds = new Set(plan.tasks.map(({ task_id: taskId }) => taskId));
  const collision = proposal.extracted_tasks.find(({ task_id: taskId }) => existingIds.has(taskId));
  if (collision !== undefined) invalid('successor_task_id_already_active', `/extracted_tasks/${collision.task_id}`);

  const predecessor = {
    plan_digest: plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: plan.plan_version,
  };
  const previousInventory = await existingSourceInventory(repoRoot, member);
  const phasePlan = isPhasedMemoPlan(plan);
  // phase revisionのgenesisではpredecessor inventoryがまだrevisionへ保存されていない。
  // apply側は全既存sourceのarchive移送を差分として要求するため、既存taskも同じbatchへ載せる。
  const cutoverExistingTasks = phasePlan && !previousInventory.inherited ? plan.tasks : [];
  const reservedSourceRefs = cutoverExistingTasks.length === 0
    ? previousInventory.active.map(({ source_ref: sourceRef }) => sourceRef)
    : [];
  const { batch: sourceCutoverBatch, archivedByTask } = await compileSourceCutover(
    repoRoot, proposal, { existingTasks: cutoverExistingTasks, reservedSourceRefs },
  );
  const tasks = compileTasks(plan, proposal, archivedByTask);
  const hardDependencies = compileDependencies(plan, proposal);
  const taskMigration = compileTaskMigration(plan, proposal.task_id,
    new Set(cutoverExistingTasks.map(({ task_id: taskId }) => taskId)));
  const sourceInventory = {
    active: tasks.map(({ task_id: taskId }) => {
      const archived = archivedByTask.get(taskId);
      if (archived !== undefined) return { task_id: taskId, ...archived };
      return previousInventory.active
        .find(({ task_id: previousTaskId }) => previousTaskId === taskId);
    }),
    excluded_tombstones: previousInventory.excluded_tombstones,
  };
  const desiredSeed = {
    schema: plan.schema,
    project_id: plan.project_id,
    plan_key: plan.plan_key,
    predecessor_plan_digest: plan.plan_digest,
    tasks,
    hard_dependencies: hardDependencies,
    joins: plan.joins,
    ...(phasePlan ? {
      phases: plan.phases,
      phase_accept_dependencies: plan.phase_accept_dependencies,
    } : {}),
  };

  if (!phasePlan) {
    const planVersion = todoRevisionPlanVersion({
      projectId: plan.project_id,
      planKey: plan.plan_key,
      predecessor,
      desiredPlan: desiredSeed,
      taskMigration,
      sourceInventory,
      sourceCutoverBatch,
    });
    const desiredPlan = buildTodoPlan({ ...desiredSeed, plan_version: planVersion });
    const reconciliation = {
      predecessor_reconciliation_digest: predecessorReconciliationDigest(member, false),
      source_inventory_digest: todoSourceInventoryDigest(sourceInventory),
      reconciliation_digest: '',
    };
    reconciliation.reconciliation_digest = todoReconciliationDigest({
      predecessorReconciliationDigest: reconciliation.predecessor_reconciliation_digest,
      sourceInventoryDigest: reconciliation.source_inventory_digest,
      predecessor,
      desiredPlanDigest: desiredPlan.plan_digest,
      taskMigration,
      sourceCutoverBatch,
    });
    const revision = {
      schema: 'lattice.todo_revision.v2',
      project_id: plan.project_id,
      plan_key: plan.plan_key,
      predecessor,
      desired_plan: desiredPlan,
      task_migration: taskMigration,
      source_inventory: sourceInventory,
      reconciliation,
      source_cutover_batch: sourceCutoverBatch,
      revision_digest: '',
    };
    revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
    if (!validateTodoRevision(revision)) invalid('compiled_revision_invalid');
    return { revision, extracted_task_ids: proposal.extracted_tasks
      .map(({ task_id: taskId }) => taskId).sort() };
  }

  const runtimeTaskMigration = compileRuntimeTaskMigration(plan, proposal);
  const phaseMigration = plan.phases.map(({ phase_id: phaseId }) => ({
    from_phase_id: phaseId,
    to_phase_id: phaseId,
    state_policy: phaseId === sourceTask.phase_id ? 'reset' : 'carry',
  }));
  const planVersion = phaseTodoRevisionPlanVersion({
    projectId: plan.project_id,
    planKey: plan.plan_key,
    predecessor,
    desiredPlan: desiredSeed,
    taskMigration,
    phaseMigration,
  });
  const desiredPlan = buildTodoPlan({ ...desiredSeed, plan_version: planVersion });
  const reconciliation = {
    predecessor_reconciliation_digest: predecessorReconciliationDigest(member, true),
    source_inventory_digest: todoSourceInventoryDigest(sourceInventory),
    desired_plan_digest: desiredPlan.plan_digest,
    runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
    task_migration_digest: todoTaskMigrationDigest(taskMigration),
    phase_migration_digest: digestTodoArtifact(phaseMigration),
    source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
    reconciliation_digest: '',
  };
  reconciliation.reconciliation_digest = todoSelfDigest(reconciliation, 'reconciliation_digest');
  const revision = {
    schema: 'lattice.phase_todo_revision.v3',
    project_id: plan.project_id,
    plan_key: plan.plan_key,
    predecessor,
    desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration,
    task_migration: taskMigration,
    phase_migration: phaseMigration,
    source_inventory: sourceInventory,
    reconciliation,
    source_cutover_batch: sourceCutoverBatch,
    revision_digest: '',
  };
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  if (!validatePhaseTodoRevision(revision)) invalid('compiled_phase_revision_invalid');
  return { revision, extracted_task_ids: proposal.extracted_tasks
    .map(({ task_id: taskId }) => taskId).sort() };
}

/**
 * splitは既存taskを同じidへ写し、子taskは新規追加するだけなので、既存witness bytesを変えない。
 * apply前にこの不変条件を検査し、解決不能な宣言や将来の非identity migrationをstore更新前に止める。
 */
export function prepareTodoSplitWitnessMigration({ witnessSet, revision }) {
  const migration = migrateWitnessSetTaskIds({
    witnessSet,
    taskMigration: revision.task_migration,
    planTaskIds: revision.desired_plan.tasks.map(({ task_id: taskId }) => taskId),
  });
  if (migration.witnessSet.witness_set_digest !== witnessSet.witness_set_digest
    || canonicalizeTodoArtifact(migration.witnessSet) !== canonicalizeTodoArtifact(witnessSet)) {
    invalid('split_witness_migration_not_identity', '/task_migration');
  }
  return migration;
}
