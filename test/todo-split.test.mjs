import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { TODO_WITNESS_SET_SCHEMA } from '../src/todo-independence-contracts.mjs';
import { TodoIndependenceError } from '../src/todo-independence.mjs';
import { renderCliHelp } from '../src/cli-help.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';
import {
  buildTodoPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
  writeTodoWitnessSet,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';
import {
  compileTodoSplit,
  prepareTodoSplitWitnessMigration,
  TodoSplitError,
  validateTodoSplitProposal,
} from '../src/todo-split.mjs';
import { validatePhaseTodoRevision, validateTodoRevision } from '../src/todo-revision.mjs';

const DIGEST = 'a'.repeat(64);
const HEAD = 'b'.repeat(64);

const witness = (sourcePath) => ({
  owns: [{ kind: 'path', target: sourcePath }],
  reads: [],
  writes: [sourcePath],
  resources: [],
  state_effects: [],
  sensor_provenance: {
    queries: [{ query_id: 'q-target', expect: { kind: 'affected', path: sourcePath } }],
  },
  affected_tests: [],
  unknowns: [],
});

function witnessSet(manualWitness) {
  const value = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    capacity: { executors: 2 },
    sensor_query_set: {
      queries: [
        { id: 'q-status', operation: 'status' },
        { id: 'q-target', operation: 'affected', target: 'src/alpha.mjs' },
      ],
    },
    manual_witness: manualWitness,
    witness_set_digest: '',
  };
  value.witness_set_digest = todoSelfDigest(value, 'witness_set_digest');
  return value;
}

function stdio() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (chunk) => { out.push(chunk); } },
    stderr: { write: (chunk) => { err.push(chunk); } },
    out,
    err,
  };
}

function task(taskId, line, phaseId = undefined) {
  return {
    task_id: taskId,
    title: taskId,
    lane: 'main',
    design_memo: `${taskId}の設計`,
    narrative_ref: `docs/plan.md#L${line}`,
    narrative_anchor: null,
    compile_binding: null,
    parent_task_id: null,
    ...(phaseId === undefined ? {} : { phase_id: phaseId }),
  };
}

async function fixture({ phase = false } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'lattice-todo-split-'));
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs/plan.md'), [
    '- [ ] A original',
    '- [ ] B downstream',
    '- [ ] A1 extracted',
    '- [ ] A2 extracted',
    '',
  ].join('\n'));
  const plan = buildTodoPlan({
    schema: phase ? 'lattice.todo_plan.v7' : 'lattice.todo_plan.v6',
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [task('A', 1, phase ? 'phase-1' : undefined),
      task('B', 2, phase ? 'phase-1' : undefined)],
    hard_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'main', task_id: 'A' },
      to: { project_id: 'project-1', plan_key: 'main', task_id: 'B' },
    }],
    joins: [],
    ...(phase ? {
      phases: [{
        phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
        predecessor_phase_ids: [], required_evidence_slots: ['heavy'],
      }],
      phase_accept_dependencies: [],
    } : {}),
  });
  const member = {
    plan,
    revision: null,
    journal: { events: [{ schema: 'lattice.todo_event.v1', event_digest: HEAD }] },
    tasks: [
      { task_id: 'A', status: 'in-progress' },
      { task_id: 'B', status: 'pending' },
    ],
  };
  const proposal = {
    schema: 'lattice.todo_split.v1',
    project_id: 'project-1',
    plan_key: 'main',
    task_id: 'A',
    reason: '責務を独立した後続へ抽出する',
    evidence_digests: [DIGEST],
    archive_ref: 'docs/archive/split.md',
    residual: { title: 'A residual', lane: 'main', design_memo: '抽出後の残差を完了する' },
    extracted_tasks: [
      { task_id: 'A2', title: 'A2 extracted', lane: 'worker', design_memo: 'A1の後に実施する',
        source_ref: 'docs/plan.md#L4', depends_on: ['A1'] },
      { task_id: 'A1', title: 'A1 extracted', lane: 'worker', design_memo: '独立責務を実装する',
        source_ref: 'docs/plan.md#L3', depends_on: [] },
    ],
  };
  return { repoRoot, member, proposal };
}

async function cliFixture(t, { manualWitness = undefined } = {}) {
  const { repoRoot, member, proposal } = await fixture({ phase: true });
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
  await initializeTodoStore({
    repoRoot,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: member.plan.project_id,
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: member.plan,
      genesis: { actor: { host: 'test', session: 'test', agent: 'test' },
        recorded_at: '2026-08-09T00:00:00.000Z' },
    }],
    now: '2026-08-09T00:00:00.000Z',
  });
  await appendTodoEvent({
    repoRoot,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: 'main',
    now: '2026-08-09T00:00:01.000Z',
    event: {
      kind: 'start', task_id: 'A',
      actor: { host: 'test', session: 'test', agent: 'test' },
      recorded_at: '2026-08-09T00:00:01.000Z',
      payload: { override_reason: null },
    },
  });
  const declaredWitness = witnessSet(manualWitness ?? {
    A: witness('src/alpha.mjs'), B: witness('src/beta.mjs'),
  });
  await writeTodoWitnessSet({ repoRoot, witnessSet: declaredWitness });
  await writeFile(path.join(repoRoot, 'split.json'), `${JSON.stringify(proposal)}\n`);
  return { repoRoot, proposal, declaredWitness };
}

async function runSplitCli(repoRoot) {
  const io = stdio();
  const exitCode = await runTodoCli({
    argv: ['split', '--plan', 'main', '--input', 'split.json'],
    cwd: repoRoot,
    ...io,
    env: {
      ...process.env,
      LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_TODO_ACTOR_HOST: 'test',
      LATTICE_TODO_ACTOR_SESSION: 'test',
      LATTICE_TODO_ACTOR_AGENT: 'test',
    },
  });
  return { exitCode, out: io.out, err: io.err };
}

async function mutationBytes(repoRoot) {
  return {
    manifest: await readFile(path.join(repoRoot, '.lattice/todo/manifest.json')),
    plan: await readFile(path.join(repoRoot, '.lattice/todo/plans/main/v1/plan.json')),
    source: await readFile(path.join(repoRoot, 'docs/plan.md')),
    witness: await readFile(path.join(repoRoot, '.lattice/todo/witness/main.json')),
  };
}

test('phaseless split compiles extracted children before a pending residual', async () => {
  const { repoRoot, member, proposal } = await fixture();
  assert.equal(validateTodoSplitProposal(proposal), true);
  const { revision, extracted_task_ids: extractedTaskIds } = await compileTodoSplit({
    repoRoot, member, proposal,
  });
  assert.equal(validateTodoRevision(revision), true);
  assert.deepEqual(extractedTaskIds, ['A1', 'A2']);
  assert.equal(revision.task_migration.find(({ from_task_id: id }) => id === 'A').state_policy,
    'reset_pending');
  assert.equal(revision.desired_plan.tasks.find(({ task_id: id }) => id === 'A').title, 'A residual');
  assert.equal(revision.desired_plan.tasks.find(({ task_id: id }) => id === 'A1').parent_task_id, 'A');
  const dependencyPairs = revision.desired_plan.hard_dependencies
    .map(({ from, to }) => `${from.task_id}->${to.task_id}`);
  assert.deepEqual(dependencyPairs.sort(), ['A->B', 'A1->A', 'A1->A2', 'A2->A'].sort());
  assert.deepEqual(revision.source_cutover_batch.operations.map(({ task_id: id }) => id), ['A1', 'A2']);
});

test('phase split records plural runtime lineage and resets only the source phase', async () => {
  const { repoRoot, member, proposal } = await fixture({ phase: true });
  const { revision } = await compileTodoSplit({ repoRoot, member, proposal });
  assert.equal(validatePhaseTodoRevision(revision), true);
  const split = revision.runtime_task_migration.entries
    .find(({ predecessor_task_id: id }) => id === 'A');
  assert.equal(split.disposition, 'split');
  assert.deepEqual(split.successor_task_ids, ['A', 'A1', 'A2']);
  assert.deepEqual(revision.phase_migration, [{
    from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'reset',
  }]);
  assert.equal(revision.task_migration.find(({ from_task_id: id }) => id === 'B').state_policy,
    'carry_reconciled_metadata');
  assert.equal(revision.desired_plan.tasks.find(({ task_id: id }) => id === 'A2').phase_id,
    'phase-1');
  assert.deepEqual(revision.source_cutover_batch.operations.map(({ task_id: id }) => id),
    ['A', 'B', 'A1', 'A2']);
  for (const taskId of ['A', 'B', 'A1', 'A2']) {
    assert.match(revision.desired_plan.tasks.find(({ task_id: id }) => id === taskId).narrative_ref,
      /^docs\/archive\/split\.md#L\d+$/u);
  }
});

test('splitは既存taskと同じsource_refを持つ子をsource書換え前に拒否する', async () => {
  const { repoRoot, member, proposal } = await fixture();
  proposal.extracted_tasks[0].source_ref = 'docs/plan.md#L1';
  const sourcePath = path.join(repoRoot, 'docs/plan.md');
  const before = await readFile(sourcePath);

  await assert.rejects(compileTodoSplit({ repoRoot, member, proposal }), (error) => (
    error instanceof TodoSplitError
    && error.detail.reason === 'source_ref_conflicts_with_predecessor'
  ));
  assert.deepEqual(await readFile(sourcePath), before);
});

test('splitのwitness移行は既存宣言のcanonical bytesとdigestを変えない', async () => {
  const { repoRoot, member, proposal } = await fixture();
  const { revision } = await compileTodoSplit({ repoRoot, member, proposal });
  const before = witnessSet({ A: witness('src/alpha.mjs'), B: witness('src/beta.mjs') });
  const migration = prepareTodoSplitWitnessMigration({ witnessSet: before, revision });

  assert.equal(canonicalizeTodoArtifact(migration.witnessSet), canonicalizeTodoArtifact(before));
  assert.equal(migration.witnessSet.witness_set_digest, before.witness_set_digest);
  assert.equal(migration.migrated_count, 0);
  assert.equal(migration.removed_count, 0);
  assert.equal(migration.unchanged_count, 2);
});

test('splitのwitnessに解決不能taskがあればapply前preflightで止める', async () => {
  const { repoRoot, member, proposal } = await fixture();
  const { revision } = await compileTodoSplit({ repoRoot, member, proposal });

  assert.throws(() => prepareTodoSplitWitnessMigration({
    witnessSet: witnessSet({ A: witness('src/alpha.mjs'), GHOST: witness('src/ghost.mjs') }),
    revision,
  }), (error) => error instanceof TodoIndependenceError
    && error.code === 'WITNESS_MIGRATION_UNRESOLVED'
    && error.detail.task_ids[0] === 'GHOST');
});

test('公開CLIのphase splitはgenesis inventory全件をcutoverしてrevisionをapplyする', async (t) => {
  const { repoRoot, declaredWitness } = await cliFixture(t);
  const witnessBefore = await readFile(path.join(repoRoot, '.lattice/todo/witness/main.json'));
  const { exitCode, out, err } = await runSplitCli(repoRoot);

  assert.equal(exitCode, 0, err.join(''));
  const result = JSON.parse(out.join(''));
  assert.equal(result.schema, 'lattice.todo_split_result.v1');
  const member = (await readTodoStore({ repoRoot })).members[0];
  assert.deepEqual(member.plan.tasks.map(({ task_id: taskId }) => taskId), ['A', 'A1', 'A2', 'B']);
  assert.equal(member.revision.source_cutover_batch.operations.length, 4);
  assert.match(await readFile(path.join(repoRoot, 'docs/plan.md'), 'utf8'),
    /Lattice todo splitへ移行済み（A）/u);
  const witnessAfter = await readFile(path.join(repoRoot, '.lattice/todo/witness/main.json'));
  assert.deepEqual(witnessAfter, witnessBefore);
  assert.equal(JSON.parse(witnessAfter).witness_set_digest, declaredWitness.witness_set_digest);
});

test('公開CLIはsource_ref衝突時にplan/source/witnessを一切更新しない', async (t) => {
  const { repoRoot, proposal } = await cliFixture(t);
  proposal.extracted_tasks[0].source_ref = 'docs/plan.md#L1';
  await writeFile(path.join(repoRoot, 'split.json'), `${JSON.stringify(proposal)}\n`);
  const before = await mutationBytes(repoRoot);
  const { exitCode, err } = await runSplitCli(repoRoot);

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(err.join('')).detail.reason, 'source_ref_conflicts_with_predecessor');
  assert.deepEqual(await mutationBytes(repoRoot), before);
});

test('公開CLIはGHOST witnessをrevision apply前に拒否して全bytesを維持する', async (t) => {
  const { repoRoot } = await cliFixture(t, { manualWitness: {
    A: witness('src/alpha.mjs'), GHOST: witness('src/ghost.mjs'),
  } });
  const before = await mutationBytes(repoRoot);
  const { exitCode, err } = await runSplitCli(repoRoot);

  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(err.join('')).code, 'WITNESS_MIGRATION_UNRESOLVED');
  assert.deepEqual(await mutationBytes(repoRoot), before);
});

test('split rejects an empty expansion and is exposed in CLI help', async () => {
  const { proposal } = await fixture();
  assert.equal(validateTodoSplitProposal({ ...proposal, extracted_tasks: [] }), false);
  assert.match(renderCliHelp(['todo', 'split', '--help']),
    /todo split --plan <key> --input <file>/u);
});
