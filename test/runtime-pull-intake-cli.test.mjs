import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeTest from 'node:test';

const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;

import { observeManagedProcessStartIdentity } from '../src/runtime-managed-supervisor.mjs';
import { detectCheckpointFindings } from '../src/runtime-diff-observer.mjs';
import { TODO_INDEPENDENCE_SCHEMA } from '../src/todo-independence-contracts.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';
import {
   createTodoStoreWriter, initializeTodoStore, readTodoStore,
  writeTodoIndependenceArtifact, writeTodoWitnessSet,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'mac', session: 'seat-a', agent: 'seat-a' });
const ACTOR_ENV = Object.freeze({
  LATTICE_TODO_ACTOR_HOST: ACTOR.host,
  LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
  LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
  LATTICE_DASHBOARD_AUTOSTART: '0',
});
const PLAN_KEY = 'pull-plan';
const NOW = '2026-08-09T00:00:00.000Z';

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runCli(root, args, environment = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...ACTOR_ENV, ...environment },
  });
}

function parsed(result, expectedStatus = 0) {
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  const stream = expectedStatus === 0 ? result.stdout : result.stderr;
  return JSON.parse(stream.trim().split('\n').at(-1));
}

function task(taskId) {
  return { task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null };
}

function ref(taskId) {
  return { project_id: 'pull-project', plan_key: PLAN_KEY, task_id: taskId };
}

function witness(taskId, source, writePath) {
  return {
    owns: [{ kind: 'path', target: writePath }],
    reads: [], writes: [writePath], resources: [], state_effects: [],
    sensor_provenance: { queries: [] }, affected_tests: [`test/${source}.test.mjs`], unknowns: [],
  };
}

async function workspace(context, { conflict = false, precedence = false,
  outcome = 'compiled' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-pull-intake-'));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.lattice/runs/\n');
  await writeFile(path.join(root, 'README.md'), 'base\n');
  await writeFile(path.join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'src', 'b.mjs'), 'export const b = 1;\n');
  await writeFile(path.join(root, 'src', 'shared.mjs'), 'export const shared = 1;\n');
  await writeFile(path.join(root, 'test', 'a.test.mjs'), '// fixture\n');
  await writeFile(path.join(root, 'test', 'b.test.mjs'), '// fixture\n');
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);

  const plan = {
    schema: 'lattice.todo_plan.v1', project_id: 'pull-project', plan_key: PLAN_KEY,
    plan_version: 'v1', predecessor_plan_digest: null,
    tasks: [task('A'), task('B')],
    hard_dependencies: precedence ? [{ from: ref('A'), to: ref('B') }] : [], joins: [],
  };
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'pull-project', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan, genesis: { actor: ACTOR, recorded_at: NOW } }], now: NOW,
  });
  const writeA = conflict ? 'src/shared.mjs' : 'src/a.mjs';
  const writeB = conflict ? 'src/shared.mjs' : 'src/b.mjs';
  const witnessSet = {
    schema: 'lattice.todo_witness_set.v5', project_id: 'pull-project', plan_key: PLAN_KEY,
    capacity: { executors: 2 }, sensor_query_set: { queries: [{ id: 'status', operation: 'status' }] },
    manual_witness: { A: witness('A', 'a', writeA), B: witness('B', 'b', writeB) },
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await writeTodoWitnessSet({ repoRoot: root, witnessSet });
  const member = (await readTodoStore({ repoRoot: root })).members[0];
  const conflictResource = 'own-path-shared-fixture';
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA, project_id: 'pull-project', plan_key: PLAN_KEY,
    plan_version: 'v1', topology_digest: member.plan.topology_digest, base_sha: baseSha,
    witness_set_digest: witnessSet.witness_set_digest, compiled_at: NOW,
    task_ids: ['A', 'B'],
    task_boundaries: [
      { task_id: 'A', paths: [writeA, 'test/a.test.mjs'] },
      { task_id: 'B', paths: [writeB, 'test/b.test.mjs'] },
    ],
    conflicts: conflict ? [{ resource_id: conflictResource, task_ids: ['A', 'B'] }] : [],
    conflict_resources: conflict
      ? [{ resource_id: conflictResource, kind: 'path', target: 'src/shared.mjs' }] : [],
    precedences: precedence
      ? [{ from_task_id: 'A', to_task_id: 'B', reason: 'hard_dependency' }] : [],
    unknowns: [],
    scope_expanded: ['A', 'B'].map((taskId) => ({
      task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
      path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
    })),
    wave_plan: outcome === 'unknown' ? null : { waves: conflict || precedence
      ? [{ task_ids: ['A'] }, { task_ids: ['B'] }]
      : [{ task_ids: ['A', 'B'] }], minimum_feasible_waves: conflict || precedence ? 2 : 1 },
    outcome, result_digest: '',
  };
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact });
  return { root, baseSha, writeA, writeB, artifact, witnessSet };
}

async function startTask(root, taskId, timestamp, overrideReason = null) {
  return appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: PLAN_KEY, now: timestamp,
    event: { kind: 'start', task_id: taskId, actor: ACTOR, recorded_at: timestamp,
      payload: { override_reason: overrideReason } },
  });
}

async function declareCoordination(root, mode, reason, timestamp) {
  return appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: PLAN_KEY, now: timestamp,
    event: {
      kind: 'coordination_mode', actor: ACTOR, recorded_at: timestamp,
      payload: { mode, reason },
    },
  });
}

async function doneTask(root, taskId, timestamp, actor = ACTOR) {
  const bytes = Buffer.from(`${taskId} evidence\n`);
  const oid = git(root, ['hash-object', '-w', '--stdin'], { input: bytes });
  const evidence = {
    evidence_id: `${taskId.toLowerCase()}-evidence`, repo_id: 'self', path: `evidence/${taskId}.txt`,
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  };
  return appendTodoEvent({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: PLAN_KEY, now: timestamp,
    event: { kind: 'done', task_id: taskId, actor, recorded_at: timestamp,
      payload: { evidence } },
  });
}

function startPull(root, runId = 'pull-run') {
  return runCli(root, [
    'run', 'start', '--selection', 'pull', '--id', runId,
    '--plan', PLAN_KEY, '--equipment', 'detached-worktree',
  ]);
}

test('u03 C11/X1: start撤回はruns/の迷いentryで止まらず、bound intakeを記録付きで解放する',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intake = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    // 撤回と無関係な迷いentry: 通常file、識別子でない名前、壊れたrun。
    await writeFile(path.join(root, '.lattice', 'runs', 'stray.txt'), 'x\n');
    await mkdir(path.join(root, '.lattice', 'runs', 'not a run'));
    await mkdir(path.join(root, '.lattice', 'runs', 'broken'));
    await writeFile(path.join(root, '.lattice', 'runs', 'broken', 'run-meta.json'), '{');

    const retraction = runCli(root, [
      'todo', 'retract', '--plan', PLAN_KEY, '--task', 'A', '--reason', '誤着手',
    ]);
    const retracted = parsed(retraction);
    assert.match(retraction.stderr, /LATTICE_RETRACT_RUNS_SKIPPED.*\.lattice\/runs\/broken/u);
    assert.equal(retracted.kind, 'start_retracted');
    assert.equal(retracted.status, 'pending');
    const events = JSON.parse(await readFile(
      path.join(root, '.lattice', 'runs', 'pull-run', 'pull-events.json'), 'utf8'));
    const released = events.at(-1);
    assert.equal(released.kind, 'intake_released');
    assert.equal(released.task_id, 'A');
    assert.equal(released.payload.reason, 'start_retracted');
    assert.equal(released.payload.target_start_digest, intake.activation_event_digest);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'INTAKE_NOT_FOUND');
  });

test('u03 A14r: in-progressのretireはbound intakeをtask_retiredで解放してから閉じる',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intake = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));

    const retired = parsed(runCli(root, [
      'todo', 'retire', '--plan', PLAN_KEY, '--task', 'A', '--reason', '不要になった',
    ]));
    assert.equal(retired.kind, 'retire');
    assert.equal(retired.status, 'retired');
    const events = JSON.parse(await readFile(
      path.join(root, '.lattice', 'runs', 'pull-run', 'pull-events.json'), 'utf8'));
    const released = events.at(-1);
    assert.equal(released.kind, 'intake_released');
    assert.equal(released.task_id, 'A');
    assert.equal(released.payload.reason, 'task_retired');
    assert.equal(released.payload.target_start_digest, intake.activation_event_digest);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'INTAKE_NOT_FOUND');
  });

test('u03 A14r: reopen後のin-progressのretireも元のstartに束ねたintakeをtask_retiredで解放する',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intake = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(parsed(runCli(root, [
      'todo', 'done', '--plan', PLAN_KEY, '--task', 'A', '--message', '一度終えた',
    ])).status, 'done');
    assert.equal(parsed(runCli(root, [
      'todo', 'reopen', '--plan', PLAN_KEY, '--task', 'A', '--reason', 'やり直す',
    ])).status, 'in-progress');

    assert.equal(parsed(runCli(root, [
      'todo', 'retire', '--plan', PLAN_KEY, '--task', 'A', '--reason', '不要になった',
    ])).status, 'retired');
    const events = JSON.parse(await readFile(
      path.join(root, '.lattice', 'runs', 'pull-run', 'pull-events.json'), 'utf8'));
    const released = events.at(-1);
    assert.equal(released.kind, 'intake_released');
    assert.equal(released.payload.reason, 'task_retired');
    assert.equal(released.payload.target_start_digest, intake.activation_event_digest);
  });

test('intake 0件のpull runは着地0件を明示してcloseでき、active listから外れる',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root, 'empty-pull-run'));
    const activeBefore = parsed(runCli(root, ['run', 'list', '--json'])).active_runs;
    assert.equal(activeBefore.some((entry) => entry.run_id === 'empty-pull-run'), true);

    const closed = parsed(runCli(root, [
      'run', 'close', '--run', '.lattice/runs/empty-pull-run',
    ]));
    assert.equal(closed.already_closed, false);
    assert.equal(closed.intake_count, 0);
    assert.equal(closed.landing.landed, false);
    assert.deepEqual(closed.landing.accepted_receipts, []);
    assert.equal(parsed(runCli(root, [
      'run', 'close', '--run', '.lattice/runs/empty-pull-run',
    ])).already_closed, true);

    const activeAfter = parsed(runCli(root, ['run', 'list', '--json'])).active_runs;
    assert.equal(activeAfter.some((entry) => entry.run_id === 'empty-pull-run'), false);
  });

test('pull startはtodos/baseを要求せず、run後startした未列挙taskをintake時HEADへ束縛する',
  async (context) => {
    const { root, baseSha } = await workspace(context);
    const started = parsed(startPull(root));
    assert.equal(started.schema, 'lattice.pull_run_start_result.v2');
    assert.equal(started.selection, 'pull');
    assert.deepEqual(
      [started.intake_readiness.code, started.intake_readiness.plan_binding_ready,
        started.intake_readiness.next_action],
      ['pull_independence_ready', true, 'none'],
    );
    assert.equal(parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'TASK_NOT_STARTED');

    await writeFile(path.join(root, 'README.md'), 'advanced after run start\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '--quiet', '-m', 'advance']);
    const intakeHead = git(root, ['rev-parse', 'HEAD']);
    assert.notEqual(intakeHead, baseSha);
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intaked = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(intaked.already_intaked, false);
    assert.equal(intaked.base_sha, intakeHead);
    assert.equal(intaked.intervention.state, 'none');
    assert.equal(intaked.intervention.lease_state, 'granted');
    assert.deepEqual(intaked.actor, ACTOR);
    assert.equal(git(intaked.worktree_path, ['rev-parse', 'HEAD']), intakeHead);
    const retried = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(retried.already_intaked, true);
    assert.equal(retried.refreshed, false);
    const status = parsed(runCli(root, ['run', 'status', '--run', '.lattice/runs/pull-run']));
    assert.deepEqual(status.intakes.map(({ task_id: taskId }) => taskId), ['A']);
  });

test('conversation planのpull startとboundary holdは同じtyped next actionを返す',
  async (context) => {
    const { root } = await workspace(context);
    await declareCoordination(
      root, 'conversation', '会話で調整する', '2026-08-09T00:00:30.000Z',
    );
    await rm(path.join(
      root, '.lattice', 'todo', 'plans', PLAN_KEY, 'v1', 'independence.json',
    ));

    const started = parsed(startPull(root));
    assert.equal(started.schema, 'lattice.pull_run_start_result.v2');
    assert.deepEqual(
      [started.intake_readiness.code, started.intake_readiness.plan_binding_ready,
        started.intake_readiness.coordination_mode,
        started.intake_readiness.next_action],
      ['pull_independence_required', false, 'conversation',
        'compile_independence_or_choose_non_pull_execution'],
    );

    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const held = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual(
      [held.intervention.state, held.intervention.reason,
        held.intervention.next_action, held.intervention.lease_state],
      ['hold', 'boundary_unverified',
        started.intake_readiness.next_action, 'withheld'],
    );
  });

test('後着planning conflictはhold/lease withheldとなり、未intake自動選択は無く、closeは残りを記録して解放する',
  async (context) => {
    const { root, artifact } = await workspace(context, { conflict: true });
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    await startTask(root, 'B', '2026-08-09T00:02:00.000Z');
    const first = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    const second = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B',
    ]));
    assert.equal(first.intervention.state, 'none');
    assert.deepEqual([second.intervention.state, second.intervention.reason,
      second.intervention.lease_state], ['hold', 'planning_conflict', 'withheld']);
    const eventCount = parsed(runCli(root, [
      'run', 'status', '--run', '.lattice/runs/pull-run',
    ])).event_count;
    const changedArtifact = structuredClone(artifact);
    changedArtifact.conflicts = [];
    changedArtifact.conflict_resources = [];
    changedArtifact.wave_plan = { waves: [{ task_ids: ['A', 'B'] }], minimum_feasible_waves: 1 };
    changedArtifact.result_digest = todoSelfDigest(changedArtifact, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: changedArtifact });
    const retried = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B',
    ]));
    assert.deepEqual([retried.already_intaked, retried.intervention.state,
      retried.intervention.reason, retried.refreshed], [true, 'none', null, true]);
    assert.equal(parsed(runCli(root, [
      'run', 'status', '--run', '.lattice/runs/pull-run',
    ])).event_count, eventCount + 1);
    const close = parsed(runCli(root, ['run', 'close', '--run', '.lattice/runs/pull-run']));
    assert.equal(close.outcome, 'closed');
    assert.deepEqual(close.released_task_ids, ['A', 'B']);
  });

test('compile baseが到達不能でもisolated worktreeを供給してversion drift holdへ閉じる',
  async (context) => {
    const { root, artifact } = await workspace(context);
    const unreachable = structuredClone(artifact);
    unreachable.base_sha = 'f'.repeat(40);
    unreachable.result_digest = todoSelfDigest(unreachable, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: unreachable });
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intaked = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual([intaked.intervention.state, intaked.intervention.reason,
      intaked.intervention.lease_state], ['hold', 'version_drift', 'withheld']);
    assert.equal(git(intaked.worktree_path, ['rev-parse', 'HEAD']), intaked.base_sha);
  });

test('independence outcome unknownはtask局所unknownが空でもboundary holdへ閉じる',
  async (context) => {
    const { root } = await workspace(context, { outcome: 'unknown' });
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intaked = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual([intaked.intervention.state, intaked.intervention.reason,
      intaked.intervention.detail.cause, intaked.intervention.lease_state],
    ['hold', 'boundary_unverified', 'independence_outcome_unknown', 'withheld']);
  });

test('pull intakeは先行holdの原因をplaceholder manifestで上書きしない', async (context) => {
  const { root, artifact, witnessSet } = await workspace(context);
  const witnessRef = path.join(root, '.lattice', 'todo', 'witness', `${PLAN_KEY}.json`);
  parsed(startPull(root));
  await startTask(root, 'A', '2026-08-09T00:01:00.000Z');

  await rm(witnessRef);
  const first = parsed(runCli(root, [
    'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([first.already_intaked, first.intervention.state,
    first.intervention.detail.cause], [false, 'hold', 'artifact_binding_mismatch']);

  await writeTodoWitnessSet({ repoRoot: root, witnessSet });
  const released = parsed(runCli(root, [
    'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([released.already_intaked, released.intervention.state], [true, 'none']);

  await rm(witnessRef);
  const refreshed = parsed(runCli(root, [
    'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([refreshed.already_intaked, refreshed.intervention.state,
    refreshed.intervention.detail.cause], [true, 'hold', 'artifact_binding_mismatch']);

  const missingTaskWitness = structuredClone(witnessSet);
  delete missingTaskWitness.manual_witness.A;
  missingTaskWitness.witness_set_digest = todoSelfDigest(
    missingTaskWitness, 'witness_set_digest',
  );
  const matchingArtifact = structuredClone(artifact);
  matchingArtifact.witness_set_digest = missingTaskWitness.witness_set_digest;
  matchingArtifact.result_digest = todoSelfDigest(matchingArtifact, 'result_digest');
  await writeTodoWitnessSet({ repoRoot: root, witnessSet: missingTaskWitness });
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact: matchingArtifact });
  const actualMissing = parsed(runCli(root, [
    'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([actualMissing.intervention.state, actualMissing.intervention.reason,
    actualMissing.intervention.detail.cause], ['hold', 'boundary_unverified', 'BOUNDARY_UNVERIFIED']);
});

test('再intakeはequipment identity不変で実効manifestを更新し、境界変更はholdする',
  async (context) => {
    const { root, baseSha, artifact, witnessSet } = await workspace(context, { outcome: 'unknown' });
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const held = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(held.intervention.reason, 'boundary_unverified');

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const identity = await observeManagedProcessStartIdentity(child.pid);
    const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    const attachPath = path.join(root, 'refresh-attach.json');
    await writeFile(attachPath, `${JSON.stringify({
      schema: 'lattice.pull_worker_attach_input.v1', name: ACTOR.agent, session: ACTOR.session,
      pid: child.pid, started_identity: identity.started_identity,
      argv_digest: createHash('sha256').update(argv, 'utf8').digest('hex'), recorded_at: NOW,
    })}\n`);
    const attached = parsed(runCli(root, [
      'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A',
      '--input', attachPath,
    ]));
    assert.equal(attached.stopped, true);

    const refreshedWitness = structuredClone(witnessSet);
    refreshedWitness.manual_witness.A = witness('A', 'a', 'src/shared.mjs');
    refreshedWitness.manual_witness.A.owns[0].creates = true;
    refreshedWitness.witness_set_digest = todoSelfDigest(refreshedWitness, 'witness_set_digest');
    await writeTodoWitnessSet({ repoRoot: root, witnessSet: refreshedWitness });
    await writeFile(path.join(root, 'README.md'), 'boundary declared after intake\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '--quiet', '-m', 'declare boundary']);
    const compiledBase = git(root, ['rev-parse', 'HEAD']);

    const compiled = structuredClone(artifact);
    compiled.base_sha = compiledBase;
    compiled.witness_set_digest = refreshedWitness.witness_set_digest;
    compiled.task_boundaries = compiled.task_boundaries.map((entry) => (
      entry.task_id === 'A' ? { task_id: 'A', paths: ['src/shared.mjs', 'test/a.test.mjs'] } : entry
    ));
    compiled.outcome = 'compiled';
    compiled.wave_plan = { waves: [{ task_ids: ['A', 'B'] }], minimum_feasible_waves: 1 };
    compiled.result_digest = todoSelfDigest(compiled, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: compiled });

    const released = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual([released.already_intaked, released.refreshed,
      released.intervention.state, released.intervention.detail.base_relation],
    [true, true, 'none', 'compiled_after_intake']);
    assert.equal(released.worker_stopped, false);
    assert.equal(execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], {
      encoding: 'utf8',
    }).trim().startsWith('T'), false);
    assert.equal(released.base_sha, baseSha);
    assert.notEqual(released.manifest_digest, held.manifest_digest);
    assert.equal(released.packet_digest, held.packet_digest);
    assert.equal(released.worktree_path, held.worktree_path);
    const observed = parsed(runCli(root, [
      'run', 'observe', '--run', '.lattice/runs/pull-run',
    ])).intakes[0];
    assert.deepEqual([observed.manifest_digest, observed.packet_digest,
      observed.witness_set_digest, observed.independence_result_digest],
    [released.manifest_digest, released.packet_digest,
      refreshedWitness.witness_set_digest, compiled.result_digest]);
    assert.deepEqual(detectCheckpointFindings({
      todoId: 'A', checkpoint: { diff: { entries: [{ path: 'src/shared.mjs' }] } },
      packets: { A: { scope: { writes: [] } } },
      manifests: { A: { writes: ['src/shared.mjs'] } }, runningTodoIds: ['A'],
    }).findings, []);

    await writeFile(path.join(root, 'src', 'shared.mjs'), 'export const shared = 2;\n');
    git(root, ['add', 'src/shared.mjs']);
    git(root, ['commit', '--quiet', '-m', 'change declared boundary']);
    const intersecting = structuredClone(compiled);
    intersecting.base_sha = git(root, ['rev-parse', 'HEAD']);
    intersecting.result_digest = todoSelfDigest(intersecting, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: intersecting });
    const reheld = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual([reheld.refreshed, reheld.intervention.state,
      reheld.intervention.reason, reheld.intervention.detail.cause, reheld.worker_stopped],
    [true, 'hold', 'version_drift', 'boundary_intersecting_drift', true]);

    await doneTask(root, 'A', '2026-08-09T00:04:00.000Z');
    const postDoneWitness = structuredClone(refreshedWitness);
    postDoneWitness.manual_witness.A = witness('A', 'a', 'src/a.mjs');
    postDoneWitness.witness_set_digest = todoSelfDigest(postDoneWitness, 'witness_set_digest');
    await writeTodoWitnessSet({ repoRoot: root, witnessSet: postDoneWitness });
    const postDoneArtifact = structuredClone(intersecting);
    postDoneArtifact.witness_set_digest = postDoneWitness.witness_set_digest;
    postDoneArtifact.task_boundaries = postDoneArtifact.task_boundaries.map((entry) => (
      entry.task_id === 'A' ? { task_id: 'A', paths: ['src/a.mjs', 'test/a.test.mjs'] } : entry
    ));
    postDoneArtifact.result_digest = todoSelfDigest(postDoneArtifact, 'result_digest');
    await writeTodoIndependenceArtifact({ repoRoot: root, artifact: postDoneArtifact });
    const postDoneRelease = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.deepEqual([postDoneRelease.intervention.state, postDoneRelease.worker_stopped],
      ['none', false]);
  });

test('override startされた後続taskは未accepted predecessorのprecedenceでserial holdになる',
  async (context) => {
    const { root } = await workspace(context, { precedence: true });
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    await startTask(root, 'B', '2026-08-09T00:02:00.000Z', 'precedence negative fixture');
    const successor = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B',
    ]));
    assert.deepEqual([successor.intervention.state, successor.intervention.reason,
      successor.intervention.next_action, successor.intervention.lease_state],
    ['hold', 'planning_precedence', 'wait_for_predecessor_accept', 'withheld']);
  });

test('run外でliteral done済みのpredecessorは後続だけのopen membership intakeを塞がない',
  async (context) => {
    const { root } = await workspace(context, { precedence: true });
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    await doneTask(root, 'A', '2026-08-09T00:02:00.000Z');
    await startTask(root, 'B', '2026-08-09T00:03:00.000Z');
    parsed(startPull(root));
    const successor = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B',
    ]));
    assert.deepEqual([successor.intervention.state, successor.intervention.reason,
      successor.intervention.lease_state], ['none', null, 'granted']);
  });

test('同runのpredecessor intakeはTodo done後もacceptまで後続leaseを解放しない',
  async (context) => {
    const { root } = await workspace(context, { precedence: true });
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    parsed(startPull(root));
    parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    await doneTask(root, 'A', '2026-08-09T00:02:00.000Z');
    await startTask(root, 'B', '2026-08-09T00:03:00.000Z');
    const successor = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B',
    ]));
    assert.deepEqual([successor.intervention.state, successor.intervention.reason,
      successor.intervention.lease_state], ['hold', 'planning_precedence', 'withheld']);
  });

test('acceptはsame-version literal doneと独立worktree観測へ束縛しlanding/closeを冪等投影する',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intaked = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    await writeFile(path.join(intaked.worktree_path, 'src', 'a.mjs'), 'export const a = 2;\n');
    git(intaked.worktree_path, ['add', 'src/a.mjs']);
    git(intaked.worktree_path, ['commit', '--quiet', '-m', 'result']);
    const resultHead = git(intaked.worktree_path, ['rev-parse', 'HEAD']);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'accept', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'TASK_NOT_DONE');
    const done = await doneTask(root, 'A', '2026-08-09T00:03:00.000Z');
    const accepted = parsed(runCli(root, [
      'run', 'intake', 'accept', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(accepted.head_sha, resultHead);
    assert.equal(accepted.done_event_digest, done.event.event_digest);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'INTAKE_ALREADY_ACCEPTED');
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'accept', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ])).already_accepted, true);
    const landing = parsed(runCli(root, ['run', 'landing', '--run', '.lattice/runs/pull-run']));
    assert.equal(landing.accepted_receipts[0].head_sha, resultHead);
    assert.equal(landing.accepted_receipts[0].receipt_id, done.event.event_digest);
    assert.equal(parsed(runCli(root, ['run', 'close', '--run', '.lattice/runs/pull-run'])).already_closed,
      false);
    assert.equal(parsed(runCli(root, ['run', 'close', '--run', '.lattice/runs/pull-run'])).already_closed,
      true);
  });

test('acceptはintake actorと異なるdone actorのsame-version literal doneを束縛できる',
  async (context) => {
    const auditor = Object.freeze({ host: 'mac', session: 'auditor', agent: 'auditor' });
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    const intaked = parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    await writeFile(path.join(intaked.worktree_path, 'src', 'a.mjs'), 'export const a = 2;\n');
    git(intaked.worktree_path, ['add', 'src/a.mjs']);
    git(intaked.worktree_path, ['commit', '--quiet', '-m', 'result']);
    const resultHead = git(intaked.worktree_path, ['rev-parse', 'HEAD']);
    const done = await doneTask(root, 'A', '2026-08-09T00:03:00.000Z', auditor);
    const accepted = parsed(runCli(root, [
      'run', 'intake', 'accept', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]));
    assert.equal(accepted.head_sha, resultHead);
    assert.equal(accepted.done_event_digest, done.event.event_digest);
  });

test('attachはexpected lstart/argv digestを再認証し、raw argv、decoy、同一pidの複数active intakeを拒否する',
  async (context) => {
    const { root } = await workspace(context);
    parsed(startPull(root));
    await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
    await startTask(root, 'B', '2026-08-09T00:02:00.000Z');
    for (const taskId of ['A', 'B']) parsed(runCli(root, [
      'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', taskId,
    ]));
    const secretMarker = 'pull-worker-secret-marker';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', secretMarker], {
      detached: true, stdio: 'ignore',
    });
    context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const identity = await observeManagedProcessStartIdentity(child.pid);
    const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    const attachInput = {
      schema: 'lattice.pull_worker_attach_input.v1', name: ACTOR.agent, session: ACTOR.session,
      pid: child.pid, started_identity: identity.started_identity,
      argv_digest: createHash('sha256').update(argv, 'utf8').digest('hex'),
      recorded_at: NOW,
    };
    const inputPath = path.join(root, 'attach.json');
    await writeFile(inputPath, `${JSON.stringify(attachInput)}\n`);
    const decoy = structuredClone(attachInput);
    decoy.started_identity = `${identity.started_identity} decoy`;
    const decoyPath = path.join(root, 'attach-decoy.json');
    await writeFile(decoyPath, `${JSON.stringify(decoy)}\n`);
    const rawArgv = { ...attachInput, argv };
    delete rawArgv.argv_digest;
    const rawArgvPath = path.join(root, 'attach-raw-argv.json');
    await writeFile(rawArgvPath, `${JSON.stringify(rawArgv)}\n`);
    const rejectedRawArgv = runCli(root, [
      'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A',
      '--input', rawArgvPath,
    ]);
    assert.equal(parsed(rejectedRawArgv, 1).code, 'INVALID_WORKER_ATTACH_INPUT');
    assert.equal(rejectedRawArgv.stderr.includes(secretMarker), false);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A',
      '--input', decoyPath,
    ]), 1).code, 'WORKER_IDENTITY_MISMATCH');
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A',
      '--input', inputPath,
    ])).stopped, false);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
    ]), 1).code, 'INTAKE_WORKER_ATTACHED');
    const afterRejectedRelease = parsed(runCli(root, [
      'run', 'status', '--run', '.lattice/runs/pull-run',
    ]));
    assert.equal(afterRejectedRelease.intakes.find(({ task_id: taskId }) => taskId === 'A')
      .worker_attached, true);
    assert.equal((await readFile(path.join(
      root, '.lattice', 'runs', 'pull-run', 'pull-events.json',
    ), 'utf8')).includes(secretMarker), false);
    assert.equal(parsed(runCli(root, [
      'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'B',
      '--input', inputPath,
    ]), 1).code, 'WORKER_ALREADY_ATTACHED');
  });

test('legacy schema surfaceとpull storeは混在fallbackせず別経路を保つ', async (context) => {
  const { root } = await workspace(context);
  const schema = parsed(runCli(root, ['run', 'start', '--schema', '--json']));
  assert.equal(schema.title, 'lattice.run_request.v1');
  parsed(startPull(root));
  assert.equal(parsed(runCli(root, [
    'run', 'abandon', '--run', '.lattice/runs/pull-run', '--reason', 'unsupported',
  ]), 1).code, 'RUN_MODE_MISMATCH');
  assert.equal(parsed(runCli(root, [
    'event', 'verify', '--run', '.lattice/runs/pull-run',
  ]), 1).code, 'RUN_MODE_MISMATCH');
  await writeFile(path.join(root, '.lattice', 'runs', 'pull-run', 'request.json'), '{}\n');
  const observed = parsed(runCli(root, ['run', 'observe', '--run', '.lattice/runs/pull-run']), 1);
  assert.equal(observed.code, 'MIXED_RUN_STORE');

  parsed(startPull(root, 'reverse-mixed'));
  await writeFile(path.join(root, '.lattice', 'runs', 'reverse-mixed', 'run-meta.json'),
    '{"schema":"lattice.run_meta.v2"}\n');
  const reverse = parsed(runCli(root, [
    'run', 'observe', '--run', '.lattice/runs/reverse-mixed',
  ]), 1);
  assert.equal(reverse.code, 'MIXED_RUN_STORE');
});

test('解けないholdの席はdetachで解放でき、release→closeでrunを退役できる', async (context) => {
  // 2026-08-10報告の閉じた循環。索引対象コードが1本も無いrepoでboundaryが永久に
  // 検証できず、holdが解けないままworkerがSIGSTOPで凍り、closeもreleaseもabandonも
  // 拒否した。releaseのnext_actionは「detachできる正規経路」を名指ししていたが、
  // その操作は存在しなかった。
  const { root } = await workspace(context, { outcome: 'unknown' });
  parsed(startPull(root));
  await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
  const held = parsed(runCli(root, [
    'run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.equal(held.intervention.reason, 'boundary_unverified');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const identity = await observeManagedProcessStartIdentity(child.pid);
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  const attachPath = path.join(root, 'deadlock-attach.json');
  await writeFile(attachPath, `${JSON.stringify({
    schema: 'lattice.pull_worker_attach_input.v1', name: ACTOR.agent, session: ACTOR.session,
    pid: child.pid, started_identity: identity.started_identity,
    argv_digest: createHash('sha256').update(argv, 'utf8').digest('hex'), recorded_at: NOW,
  })}\n`);
  assert.equal(parsed(runCli(root, [
    'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A', '--input', attachPath,
  ])).stopped, true);
  const stat = () => execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], {
    encoding: 'utf8' }).trim();
  assert.equal(stat().startsWith('T'), true, 'holdは席をSIGSTOPで止める');
  // 凍った席から見えるのは「holdの解き方」だけだった。解けない時の出口も要る。
  assert.match(parsed(runCli(root, [
    'run', 'intake', 'intervention', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ])).recovery, /run intake detach/u);

  // releaseとabandonの扉は閉じたまま。出口はdetachと、u03以降のclose（別試験）。
  const blocked = parsed(runCli(root, [
    'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]), 1);
  assert.equal(blocked.code, 'INTAKE_WORKER_ATTACHED');
  assert.match(blocked.detail.next_action, /run intake detach/u,
    'next_actionは実在する操作を名指ししなければならない');
  assert.equal(parsed(runCli(root, [
    'run', 'abandon', '--run', '.lattice/runs/pull-run', '--reason', 'stuck',
  ]), 1).code, 'RUN_MODE_MISMATCH');

  // detachはSIGCONTで解放してからbindingを外す。順序が逆だと、二度と誰も
  // そのpidを名指しできないまま止まったprocessが残る。
  const detached = parsed(runCli(root, [
    'run', 'intake', 'detach', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([detached.outcome, detached.pid, detached.resumed],
    ['detached', child.pid, true]);
  assert.equal(stat().startsWith('T'), false, 'detachは席を止めたまま放置しない');
  const afterDetach = parsed(runCli(root, [
    'run', 'intake', 'intervention', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.deepEqual([afterDetach.worker_attached, afterDetach.worker_stopped], [false, false]);
  assert.equal(afterDetach.recovery, null, '席が居ない状態で脱出口を案内しない');

  // 復旧するのは凍った席ではない別のoperatorである。席自身のactorを要求すると
  // 「凍った席だけが自分を解放できる」という同じ罠に戻る。
  const released = parsed(runCli(root, [
    'run', 'intake', 'release', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ], { LATTICE_TODO_ACTOR_SESSION: 'operator-seat', LATTICE_TODO_ACTOR_AGENT: 'operator-seat' }));
  assert.equal(released.outcome, 'released');
  const closed = parsed(runCli(root, ['run', 'close', '--run', '.lattice/runs/pull-run']));
  assert.equal(closed.outcome, 'closed');
});

test('u03 C18: holdで止まった席が残るpull runもcloseでき、再開・detach・解放を記録する', async (context) => {
  const { root } = await workspace(context, { outcome: 'unknown' });
  parsed(startPull(root));
  await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
  parsed(runCli(root, ['run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A']));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const identity = await observeManagedProcessStartIdentity(child.pid);
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  const attachPath = path.join(root, 'close-attach.json');
  await writeFile(attachPath, `${JSON.stringify({
    schema: 'lattice.pull_worker_attach_input.v1', name: ACTOR.agent, session: ACTOR.session,
    pid: child.pid, started_identity: identity.started_identity,
    argv_digest: createHash('sha256').update(argv, 'utf8').digest('hex'), recorded_at: NOW,
  })}\n`);
  assert.equal(parsed(runCli(root, [
    'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A', '--input', attachPath,
  ])).stopped, true);
  const stat = () => execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(child.pid)], {
    encoding: 'utf8' }).trim();
  assert.equal(stat().startsWith('T'), true);

  const closed = parsed(runCli(root, ['run', 'close', '--run', '.lattice/runs/pull-run']));
  assert.deepEqual([closed.outcome, closed.released_task_ids], ['closed', ['A']]);
  assert.equal(stat().startsWith('T'), false, 'closeは止めた席を止めたまま手放さない');
  const events = JSON.parse(await readFile(
    path.join(root, '.lattice', 'runs', 'pull-run', 'pull-events.json'), 'utf8'));
  assert.deepEqual(events.slice(-4).map((event) => event.kind),
    ['worker_resumed', 'worker_detached', 'intake_released', 'run_closed']);
  assert.deepEqual([events.at(-3).payload.reason, events.at(-3).payload.signal], ['run_closed', 'sent']);
  assert.equal(events.at(-2).payload.reason, 'run_closed');
  assert.deepEqual(events.at(-1).payload, { accepted_task_ids: [], released_task_ids: ['A'] });
});

test('detachはattach bindingと一致しないprocessへsignalを送らない', async (context) => {
  const { root } = await workspace(context, { outcome: 'unknown' });
  parsed(startPull(root));
  await startTask(root, 'A', '2026-08-09T00:01:00.000Z');
  parsed(runCli(root, ['run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'A']));

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  context.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const identity = await observeManagedProcessStartIdentity(child.pid);
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  const attachPath = path.join(root, 'identity-attach.json');
  await writeFile(attachPath, `${JSON.stringify({
    schema: 'lattice.pull_worker_attach_input.v1', name: ACTOR.agent, session: ACTOR.session,
    pid: child.pid, started_identity: identity.started_identity,
    argv_digest: createHash('sha256').update(argv, 'utf8').digest('hex'), recorded_at: NOW,
  })}\n`);
  parsed(runCli(root, [
    'run', 'intake', 'attach', '--run', '.lattice/runs/pull-run', '--task', 'A', '--input', attachPath,
  ]));

  // workerが死んだ（またはpidが再利用された）状況。SIGCONTを無関係な相手へ送らず、
  // かつ死んだworkerのbindingがdetachを恒久に塞がない——signalは「配達先なし」でskipし、
  // detach自体は通る（worker_resumedは刻まれない）。
  process.kill(child.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const detached = parsed(runCli(root, [
    'run', 'intake', 'detach', '--run', '.lattice/runs/pull-run', '--task', 'A',
  ]));
  assert.equal(detached.outcome, 'detached');
  assert.equal(detached.resumed, false);

  // attach済みworkerが無いintakeへのdetachは、成功へ丸めずtypedに落とす。
  await startTask(root, 'B', '2026-08-09T00:02:00.000Z');
  parsed(runCli(root, ['run', 'intake', '--run', '.lattice/runs/pull-run', '--task', 'B']));
  assert.equal(parsed(runCli(root, [
    'run', 'intake', 'detach', '--run', '.lattice/runs/pull-run', '--task', 'B',
  ]), 1).code, 'INTAKE_WORKER_ABSENT');
});
