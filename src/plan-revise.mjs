import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalizeTodoArtifact, exactRecord, isTodoIdentifier, todoSelfDigest } from './todo-contracts.mjs';
import { gitSync } from './git-process.mjs';
import { readAuthoringJsonFile, repairAuthoringArtifact } from './todo-authoring-input.mjs';
import { validatePlanCreateInput } from './project-cli.mjs';
import {
  compilePhaseMigration, planSeed, readPlanBackchainBinding, rebindCarriedWork,
} from './plan-backchain.mjs';
import {
  applyPhaseTodoRevision, buildTodoPlan, createTodoStoreWriter, readTodoStore, TodoStoreError,
} from './todo-store.mjs';
import { phaseTodoRevisionPlanVersion, validatePhaseTodoRevision } from './todo-revision.mjs';

const INPUT_SCHEMA = 'lattice.plan_revise_input.v1';

function fail(reason, pointer, detail = {}) {
  throw new TodoStoreError('INPUT_INVALID', reason, undefined, { pointer, ...detail });
}

export function compilePlanRevision({ member, input }) {
  if (!exactRecord(input, ['schema', 'desired', 'continuity']) || input.schema !== INPUT_SCHEMA) {
    fail('plan_revise_schema_invalid', '/', { expected: INPUT_SCHEMA });
  }
  const desired = repairAuthoringArtifact(input.desired);
  try { validatePlanCreateInput(desired); }
  catch (error) {
    if (typeof error?.detail?.pointer === 'string') {
      error.detail.pointer = `/desired${error.detail.pointer === '/' ? '' : error.detail.pointer}`;
    }
    throw error;
  }
  if (member === undefined) fail('plan_not_active', '/desired/plan_key');
  if (member.plan.schema === 'lattice.todo_plan.v6'
    || member.journal.events[0].schema === 'lattice.todo_event.v2'
    || [...member.plan.tasks, ...desired.tasks].some((task) => task.narrative_anchor !== null)) {
    fail('plan_revise_requires_source_revision', '/desired/tasks', {
      next_action: `lattice todo revise-phase --plan ${desired.plan_key} --input <phase-revision.json>`,
    });
  }
  if (member.plan.schema !== 'lattice.todo_plan.v7') {
    fail('predecessor_plan_schema_unsupported', '/desired/plan_key');
  }
  if (desired.project_id !== member.plan.project_id || desired.plan_key !== member.plan.plan_key) {
    fail('plan_revise_identity_mismatch', '/desired/plan_key');
  }
  if (!Array.isArray(input.continuity) || input.continuity.length !== member.plan.tasks.length) {
    fail('plan_revise_continuity_incomplete', '/continuity', {
      expected: { task_ids: member.plan.tasks.map(({ task_id }) => task_id) },
    });
  }
  const oldIds = new Set(member.plan.tasks.map(({ task_id }) => task_id));
  const decisions = new Map();
  for (const [index, entry] of input.continuity.entries()) {
    if (!exactRecord(entry, ['task_id', 'policy', 'reason']) || !isTodoIdentifier(entry.task_id)
      || !['carry', 'reset', 'retire'].includes(entry.policy)
      || typeof entry.reason !== 'string' || entry.reason.trim().length === 0
      || !oldIds.has(entry.task_id) || decisions.has(entry.task_id)) {
      fail('plan_revise_continuity_invalid', `/continuity/${index}`);
    }
    decisions.set(entry.task_id, entry.policy);
  }
  const desiredIds = new Set(desired.tasks.map(({ task_id }) => task_id));
  const taskMigration = member.plan.tasks.map(({ task_id: id }) => {
    const policy = decisions.get(id);
    if ((policy === 'retire') === desiredIds.has(id)) {
      fail('plan_revise_removed_task_mismatch', '/continuity', { task_id: id });
    }
    return { from_task_id: id, to_task_id: policy === 'retire' ? 'removed' : id,
      state_policy: policy === 'retire' ? 'removed'
        : policy === 'carry' ? 'carry_reconciled_metadata' : 'reset_pending' };
  });
  const predecessor = {
    plan_digest: member.plan.plan_digest,
    journal_head_digest: member.journal.events.at(-1).event_digest,
    plan_version: member.plan.plan_version,
  };
  const seed = planSeed(desired, predecessor.plan_digest);
  const phaseMigration = compilePhaseMigration(member.plan, seed, taskMigration);
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

export async function planReviseSchema() {
  return JSON.parse(await readFile(new URL('../docs/schemas/lattice.plan_revise_input.v1.schema.json', import.meta.url)));
}

export async function runPlanRevise({ cwd, inputRef, stdout, dryRun = false, env = process.env }) {
  let repoRoot;
  try {
    repoRoot = path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch { throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved'); }
  const input = await readAuthoringJsonFile(repoRoot, inputRef, { invalidCode: 'INPUT_INVALID' });
  const store = await readTodoStore({ repoRoot });
  const member = store.members.find(({ plan }) => plan.plan_key === input?.desired?.plan_key);
  const revision = compilePlanRevision({ member, input });
  if (await readPlanBackchainBinding({ repoRoot, plan: member.plan }) !== null) {
    fail('plan_revise_requires_backchain', '/desired/plan_key', {
      next_action: 'lattice plan backchain --input <file> --json',
    });
  }
  const unchanged = input.continuity.every(({ policy }) => policy === 'carry')
    && canonicalizeTodoArtifact(planSeed(input.desired, null))
      === canonicalizeTodoArtifact(planSeed(member.plan, null));
  if (!unchanged && !validatePhaseTodoRevision(revision)) fail('plan_revise_artifact_invalid', '/');
  if (!unchanged) {
    const { todoTaskCarrySemantics } = await import('./todo-store-view.mjs');
    const idMap = new Map(revision.task_migration.map(({ from_task_id, to_task_id }) => [from_task_id, to_task_id]));
    const removedTaskIds = new Set(revision.task_migration.filter(({ state_policy }) => state_policy === 'removed')
      .map(({ from_task_id }) => from_task_id));
    for (const [index, entry] of input.continuity.entries()) {
      if (entry.policy !== 'carry') continue;
      const before = todoTaskCarrySemantics(member.plan, entry.task_id, idMap,
        { reconciliationMetadata: true, includeDesignMemo: false, removedTaskIds });
      const after = todoTaskCarrySemantics(revision.desired_plan, entry.task_id, new Map(),
        { reconciliationMetadata: true, includeDesignMemo: false });
      if (canonicalizeTodoArtifact(before) !== canonicalizeTodoArtifact(after)) {
        throw new TodoStoreError('REVISION_INVALID', 'carry_semantics_changed', undefined, {
          pointer: `/continuity/${index}`, task_id: entry.task_id,
          expected: { policy: 'reset' }, actual: { policy: 'carry' },
          next_action: 'set_the_reported_continuity_policy_to_reset_then_rerun_plan_revise_dry_run',
        });
      }
    }
  }
  let applied = null;
  let reboundTaskIds = [];
  if (!dryRun) {
    if (!unchanged) {
      applied = await applyPhaseTodoRevision({ repoRoot,
        writer: createTodoStoreWriter({ caller: 'g5-authoring' }), revision,
        actor: input.desired.actor, recordedAt: input.desired.recorded_at,
      });
    }
    try {
      reboundTaskIds = await rebindCarriedWork({ repoRoot, planKey: revision.plan_key, env,
        reason: '工程改訂後のplan versionへ作業中ToDoを結び直す',
        failureCode: 'PLAN_REBIND_PENDING' });
    } catch (error) {
      if (error instanceof TodoStoreError && error.code === 'PLAN_REBIND_PENDING') {
        error.detail = { ...error.detail, revision_applied: !unchanged,
          revision_digest: unchanged ? null : revision.revision_digest };
      }
      throw error;
    }
  }
  const result = {
    schema: unchanged ? 'lattice.plan_revise_unchanged.v1' : 'lattice.plan_revise_result.v1',
    project_id: revision.project_id, plan_key: revision.plan_key,
    plan_version: unchanged ? member.plan.plan_version : revision.desired_plan.plan_version,
    dry_run: dryRun, revision: unchanged ? null : revision, applied,
    continuity: input.continuity, rebound_task_ids: reboundTaskIds, result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
