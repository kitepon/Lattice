import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { runTodoCli } from '../src/todo-cli.mjs';
import { appendTodoExtraction, compileTodoExtraction } from '../src/todo-migration.mjs';
import { computeReadyFrontier } from '../src/todo-status.mjs';
import {
  appendImportedPlan,
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-08-13T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const WRITER = createTodoStoreWriter({ caller: 'g4-migration' });
const AUTHOR = createTodoStoreWriter({ caller: 'g5-authoring' });

const task = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
});

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-companion-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await writeFile(path.join(root, 'plan.md'), '# companion\n- [ ] R\n');
  await writeFile(path.join(root, 'evidence.md'), '# evidence\n');
  execFileSync('git', ['add', 'plan.md', 'evidence.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

  await initializeTodoStore({
    repoRoot: root, writer: WRITER, projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('T')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

async function workspaceWithTwoPlans(context) {
  const root = await workspace(context);
  await appendImportedPlan({
    repoRoot: root, writer: WRITER,
    plan: {
      schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'repair', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('R')], hard_dependencies: [], joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: NOW },
  });
  return root;
}

async function extraction(root, reason = 'repairを先に完了する') {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const target = store.members.find(({ plan }) => plan.plan_key === 'main');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const value = {
    schema: 'lattice.todo_extraction.v4', project_id: 'project-1', plan_key: 'companion', plan_version: 'v1',
    actor: ACTOR, recorded_at: NOW,
    tasks: [{
      task_id: 'R', title: 'repair', lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
      compile_binding: null, disposition: 'register_pending', start: null, completion: null,
      source: {
        origin_plan_ref: 'plan.md', origin_line: 2, source_commit: sourceCommit,
        heading_path: ['companion'], markdown_depth: 0, parent_task_id: null, checkbox_state: 'unchecked',
      },
      migration_context: {
        external_canonical_ref: null, carry_over_ref: null, h_required: false, condition: null,
        evidence_refs: [], notes: [],
      },
    }],
    hard_dependencies: [{
      from: { project_id: 'project-1', plan_key: 'companion', task_id: 'R' },
      to: {
        project_id: 'project-1', plan_key: 'main', task_id: 'T',
        expected_topology_digest: target.plan.topology_digest,
      },
      reason,
    }],
    joins: [], extraction_digest: '',
  };
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

async function existingConnectionExtraction(root, reason = '既存repairを先に完了する') {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const repair = store.members.find(({ plan }) => plan.plan_key === 'repair');
  const target = store.members.find(({ plan }) => plan.plan_key === 'main');
  const value = {
    schema: 'lattice.todo_extraction.v4', project_id: 'project-1', plan_key: 'repair', plan_version: 'v1',
    actor: ACTOR, recorded_at: NOW, tasks: [],
    hard_dependencies: [{
      from: {
        project_id: 'project-1', plan_key: 'repair', task_id: 'R',
        expected_topology_digest: repair.plan.topology_digest,
      },
      to: {
        project_id: 'project-1', plan_key: 'main', task_id: 'T',
        expected_topology_digest: target.plan.topology_digest,
      },
      reason,
    }],
    joins: [], extraction_digest: '',
  };
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

async function connectionExtraction(root, { sourcePlan, sourceTask, reason }) {
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const source = store.members.find(({ plan }) => plan.plan_key === sourcePlan);
  const target = store.members.find(({ plan }) => plan.plan_key === 'main');
  const value = {
    schema: 'lattice.todo_extraction.v4', project_id: 'project-1',
    plan_key: source.plan.plan_key, plan_version: source.plan.plan_version,
    actor: ACTOR, recorded_at: NOW, tasks: [],
    hard_dependencies: [{
      from: {
        project_id: 'project-1', plan_key: sourcePlan, task_id: sourceTask,
        expected_topology_digest: source.plan.topology_digest,
      },
      to: {
        project_id: 'project-1', plan_key: 'main', task_id: 'T',
        expected_topology_digest: target.plan.topology_digest,
      },
      reason,
    }],
    joins: [], extraction_digest: '',
  };
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  return value;
}

function childCrash(root, stage, inputName = 'companion.json') {
  const source = `
    import { compileTodoExtraction } from ${JSON.stringify(new URL('../src/todo-migration.mjs', import.meta.url).href)};
    import { appendImportedPlan } from ${JSON.stringify(new URL('../src/todo-store.mjs', import.meta.url).href)};
    import { readFile } from 'node:fs/promises';
    const extraction = JSON.parse(await readFile(${JSON.stringify(inputName)}, 'utf8'));
    const originalExit = process.exit;
    const request = compileTodoExtraction(extraction, process.cwd());
    request.onProtocolStage = (current) => { if (current === process.env.CRASH_STAGE) originalExit(91); };
    await appendImportedPlan(request);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: root,
    env: { ...process.env, CRASH_STAGE: stage },
    encoding: 'utf8',
  });
}

async function writeStaleWriteLock(root) {
  const exited = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import {withStoreLock} from ${JSON.stringify(new URL('../src/store-lock.mjs', import.meta.url).href)};
    await withStoreLock({lockPath:${JSON.stringify(path.join(root, '.lattice/todo/.write.lock'))}},()=>process.exit(0));
  `], { encoding: 'utf8' });
  assert.equal(exited.status, 0, exited.stderr);
}

function evidence(root) {
  const content = readFile(path.join(root, 'evidence.md'));
  const gitBlobOid = execFileSync('git', ['rev-parse', 'HEAD:evidence.md'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return content.then((bytes) => ({
    evidence_id: 'fixture', repo_id: 'self', path: 'evidence.md', git_blob_oid: gitBlobOid,
    content_digest: createHash('sha256').update(bytes).digest('hex'), media_type: 'text/markdown',
    anchor_digest: null,
  }));
}

test('v4 companion edgeはreasonをedgeへ保持し、target側chainとready frontierへ投影する', async (context) => {
  const root = await workspace(context);
  const input = await extraction(root);
  const imported = await appendTodoExtraction({ repoRoot: root, extraction: input });
  assert.equal(imported.crossPlanDependencies.length, 1);
  assert.equal(imported.crossPlanDependencies[0].payload.reason, 'repairを先に完了する');

  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const companion = store.members.find(({ plan }) => plan.plan_key === 'companion');
  const target = store.members.find(({ plan }) => plan.plan_key === 'main');
  assert.deepEqual(companion.plan.hard_dependencies, [{
    from: { project_id: 'project-1', plan_key: 'companion', task_id: 'R' },
    to: { project_id: 'project-1', plan_key: 'main', task_id: 'T',
      expected_topology_digest: target.plan.topology_digest },
  }]);
  assert.equal(target.plan_scoped.events.length, 1);
  assert.equal(target.plan_scoped.events[0].payload.reason, 'repairを先に完了する');
  assert.deepEqual(computeReadyFrontier(store), [{ plan_key: 'companion', task_id: 'R', label: 'repair' }]);
});

test('v3 reasoned companion edgeは既存契約のままtarget側chainへcompileする', async (context) => {
  const root = await workspace(context);
  const input = await extraction(root);
  input.schema = 'lattice.todo_extraction.v3';
  input.extraction_digest = todoSelfDigest(input, 'extraction_digest');
  const imported = await appendTodoExtraction({ repoRoot: root, extraction: input });
  assert.equal(imported.crossPlanDependencies.length, 1);
  assert.equal(imported.crossPlanDependencies[0].payload.reason, 'repairを先に完了する');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events[0].payload.reason,
    'repairを先に完了する');
});

test('companion repair完了後はtargetがreadyへ戻る', async (context) => {
  const root = await workspace(context);
  await appendTodoExtraction({ repoRoot: root, extraction: await extraction(root) });
  await appendTodoEvent({
    repoRoot: root, writer: AUTHOR, planKey: 'companion', now: NOW,
    event: { kind: 'start', task_id: 'R', actor: ACTOR, recorded_at: NOW,
      payload: { override_reason: null } },
  });
  await appendTodoEvent({
    repoRoot: root, writer: AUTHOR, planKey: 'companion', now: NOW,
    event: { kind: 'done', task_id: 'R', actor: ACTOR, recorded_at: NOW,
      payload: { done_mode: 'authored', imported: false, evidence: await evidence(root) } },
  });
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(computeReadyFrontier(store), [{ plan_key: 'main', task_id: 'T', label: 'T' }]);
});

for (const stage of ['manifest_activated', 'cross_plan_dependencies_activated']) {
  test(`cross-plan ${stage}後の失敗は新planとtarget edgeを同時にrollbackする`, async (context) => {
    const root = await workspace(context);
    const input = await extraction(root);
    const request = compileTodoExtraction(input, root);
    request.onProtocolStage = async (observed) => {
      if (observed === stage) throw new Error(`after-${stage}`);
    };
    await assert.rejects(() => appendImportedPlan(request), new RegExp(`after-${stage}`, 'u'));
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.deepEqual(store.members.map(({ plan }) => plan.plan_key), ['main']);
    assert.deepEqual(store.members[0].plan_scoped.events, []);
    await assert.rejects(stat(path.join(root, '.lattice', 'todo', 'plans', 'companion', 'v1')), {
      code: 'ENOENT',
    });
  });
}

test('migrate resultはcompanionの接続、frontier、次の操作をtypedに返す', async (context) => {
  const root = await workspace(context);
  const input = await extraction(root);
  await writeFile(path.join(root, 'companion.json'), `${JSON.stringify(input)}\n`);
  let stdout = '';
  let stderr = '';
  const exit = await runTodoCli({
    argv: ['migrate', '--input', 'companion.json'], cwd: root,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: {
      ...process.env, LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1', LATTICE_TODO_ACTOR_AGENT: 'agent-1',
      LATTICE_DASHBOARD_AUTOSTART: '0',
    },
  });
  assert.equal(exit, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.schema, 'lattice.todo_migrate_result.v4');
  assert.equal(result.companion.repair.task_id, 'R');
  assert.equal(result.companion.target.task_id, 'T');
  assert.equal(result.companion.reason, 'repairを先に完了する');
  assert.deepEqual(result.companion.connected_frontier, [
    { plan_key: 'companion', task_id: 'R', label: 'repair' },
  ]);
  assert.equal(result.companion.next_action,
    'lattice todo revise-phase --plan companion --input <phase-revision.json>');
});

test('v4 normal migrateのdry-runと結果は固定shapeを返す', async (context) => {
  const root = await workspace(context);
  const input = await extraction(root);
  input.hard_dependencies = [];
  input.extraction_digest = todoSelfDigest(input, 'extraction_digest');
  await writeFile(path.join(root, 'normal-v4.json'), `${JSON.stringify(input)}\n`);

  let dryRunStdout = '';
  let dryRunStderr = '';
  const dryRunExit = await runTodoCli({
    argv: ['migrate', '--input', 'normal-v4.json', '--dry-run', '--json'], cwd: root,
    stdout: { write: (chunk) => { dryRunStdout += chunk; } },
    stderr: { write: (chunk) => { dryRunStderr += chunk; } },
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(dryRunExit, 0, dryRunStderr);
  const dryRun = JSON.parse(dryRunStdout);
  assert.equal(dryRun.schema, 'lattice.todo_migrate_dry_run_result.v2');
  assert.equal(dryRun.valid, true);
  assert.equal(dryRun.planned.connection_only, false);

  let stdout = '';
  let stderr = '';
  const exit = await runTodoCli({
    argv: ['migrate', '--input', 'normal-v4.json'], cwd: root,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: {
      ...process.env, LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1', LATTICE_TODO_ACTOR_AGENT: 'agent-1',
      LATTICE_DASHBOARD_AUTOSTART: '0',
    },
  });
  assert.equal(exit, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.schema, 'lattice.todo_migrate_result.v4');
  assert.equal(result.companion, null);
});

test('migrate actualとdry-runは公開v3/v4以外の入力schemaを受理しない', async (context) => {
  const root = await workspace(context);
  for (const schema of ['lattice.todo_extraction.v1', 'lattice.todo_extraction.v2']) {
    const inputRef = `legacy-${schema.at(-1)}.json`;
    await writeFile(path.join(root, inputRef), `${JSON.stringify({ schema })}\n`);

    let stdout = '';
    let stderr = '';
    const actualExit = await runTodoCli({
      argv: ['migrate', '--input', inputRef], cwd: root,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
      env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    assert.equal(actualExit, 1);
    assert.equal(stdout, '');
    const actualError = JSON.parse(stderr);
    assert.equal(actualError.code, 'INVALID_TODO_EXTRACTION');
    assert.equal(actualError.detail.reason, 'todo_extraction_schema_unsupported');

    let dryRunStdout = '';
    let dryRunStderr = '';
    const dryRunExit = await runTodoCli({
      argv: ['migrate', '--input', inputRef, '--dry-run', '--json'], cwd: root,
      stdout: { write: (chunk) => { dryRunStdout += chunk; } },
      stderr: { write: (chunk) => { dryRunStderr += chunk; } },
      env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    assert.equal(dryRunExit, 0, dryRunStderr);
    const dryRun = JSON.parse(dryRunStdout);
    assert.equal(dryRun.schema, 'lattice.todo_migrate_dry_run_result.v2');
    assert.equal(dryRun.valid, false);
    assert.equal(dryRun.violations[0].code, 'schema_retired');
  }
});

test('既存task同士はtasks空の同じmigrate入口で接続し、新planを作らない', async (context) => {
  const root = await workspaceWithTwoPlans(context);
  const input = await existingConnectionExtraction(root);
  await writeFile(path.join(root, 'existing-connection.json'), `${JSON.stringify(input)}\n`);
  let dryRunStdout = '';
  let dryRunStderr = '';
  const dryRunExit = await runTodoCli({
    argv: ['migrate', '--input', 'existing-connection.json', '--dry-run', '--json'], cwd: root,
    stdout: { write: (chunk) => { dryRunStdout += chunk; } },
    stderr: { write: (chunk) => { dryRunStderr += chunk; } },
    env: { ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(dryRunExit, 0, dryRunStderr);
  const dryRun = JSON.parse(dryRunStdout);
  assert.equal(dryRun.schema, 'lattice.todo_migrate_dry_run_result.v2');
  assert.equal(dryRun.valid, true);
  assert.equal(dryRun.planned.connection_only, true);
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members
    .find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 0);
  let stdout = '';
  let stderr = '';
  const exit = await runTodoCli({
    argv: ['migrate', '--input', 'existing-connection.json'], cwd: root,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    env: {
      ...process.env, LATTICE_TODO_ACTOR_HOST: 'host-1',
      LATTICE_TODO_ACTOR_SESSION: 'session-1', LATTICE_TODO_ACTOR_AGENT: 'agent-1',
      LATTICE_DASHBOARD_AUTOSTART: '0',
    },
  });
  assert.equal(exit, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.schema, 'lattice.todo_migrate_result.v4');
  assert.equal(result.imported_task_count, 0);
  assert.equal(result.dispatch_shape, null);
  assert.equal(result.phase_guidance, null);
  assert.equal(result.companion.repair.plan_key, 'repair');
  assert.equal(result.companion.target.plan_key, 'main');
  assert.equal(result.companion.next_action, 'lattice todo status --json');
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(store.members.map(({ plan }) => plan.plan_key), ['main', 'repair']);
  assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
});

test('v4 migrationは複数のcross-plan dependencyを登録前に拒否する', async (context) => {
  const root = await workspace(context);
  await appendImportedPlan({
    repoRoot: root, writer: WRITER,
    plan: {
      schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'other', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('O')], hard_dependencies: [], joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: NOW }, now: NOW,
  });
  const input = await extraction(root);
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const other = store.members.find(({ plan }) => plan.plan_key === 'other');
  input.hard_dependencies.push({
    from: { project_id: 'project-1', plan_key: 'companion', task_id: 'R' },
    to: {
      project_id: 'project-1', plan_key: 'other', task_id: 'O',
      expected_topology_digest: other.plan.topology_digest,
    },
    reason: 'second edge must be rejected',
  });
  input.hard_dependencies.sort((left, right) => {
    const leftKey = `${left.from.project_id}\0${left.from.plan_key}\0${left.from.task_id}\0${left.to.project_id}\0${left.to.plan_key}\0${left.to.task_id}`;
    const rightKey = `${right.from.project_id}\0${right.from.plan_key}\0${right.from.task_id}\0${right.to.project_id}\0${right.to.plan_key}\0${right.to.task_id}`;
    return leftKey.localeCompare(rightKey);
  });
  input.extraction_digest = todoSelfDigest(input, 'extraction_digest');

  await assert.rejects(() => appendTodoExtraction({ repoRoot: root, extraction: input }), (error) => error
    && error.code === 'INVALID_TODO_EXTRACTION'
    && error.detail?.violation_reason === 'cross_plan_dependency_limit_exceeded');
  const after = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(after.members.map(({ plan }) => plan.plan_key), ['main', 'other']);
  assert.deepEqual(after.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events, []);
});

for (const stage of ['cross_plan_connection_validated', 'cross_plan_connection_activated']) {
  test(`既存task接続の実process停止後${stage}はstale lockを回収して収束する`, async (context) => {
    const root = await workspaceWithTwoPlans(context);
    const input = await existingConnectionExtraction(root);
    await writeFile(path.join(root, 'existing-connection.json'), `${JSON.stringify(input)}\n`);
    const crashed = childCrash(root, stage, 'existing-connection.json');
    assert.equal(crashed.status, 91, crashed.stderr);

    let retryError = null;
    try { await appendTodoExtraction({ repoRoot: root, extraction: input }); }
    catch (error) { retryError = error; }
    if (stage === 'cross_plan_connection_validated') {
      assert.equal(retryError, null);
    } else {
      assert.equal(retryError?.code, 'DEPENDENCY_EXISTS');
      assert.equal(retryError?.detail.reason, 'cross_plan_dependency_duplicate');
    }
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
    await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.write.lock')), { code: 'ENOENT' });
  });
}

test('回収claim所有processの停止後も次のretryがstale claimとlockを回収する', async (context) => {
  const root = await workspaceWithTwoPlans(context);
  const input = await existingConnectionExtraction(root);
  await writeFile(path.join(root, 'existing-connection.json'), `${JSON.stringify(input)}\n`);
  await writeStaleWriteLock(root);
  const crashed = childCrash(root, 'cross_plan_lock_recovery_mutex_acquired',
    'existing-connection.json');
  assert.equal(crashed.status, 91, crashed.stderr);

  await appendTodoExtraction({ repoRoot: root, extraction: input });
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
  await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.write.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.cross-plan-recovery')), {
    code: 'ENOENT',
  });
});

test('同時cross-plan stale-lock回収はmutexの所有者だけをwriterへ進める', async (context) => {
  const root = await workspaceWithTwoPlans(context);
  const input = await existingConnectionExtraction(root);
  await writeStaleWriteLock(root);
  let releaseRecovery;
  let recoveryClaimed;
  const recoveryReleased = new Promise((resolve) => { releaseRecovery = resolve; });
  const recoveryClaimedPromise = new Promise((resolve) => { recoveryClaimed = resolve; });
  const first = compileTodoExtraction(input, root);
  first.onProtocolStage = async (stage) => {
    if (stage === 'cross_plan_lock_recovery_mutex_acquired') {
      recoveryClaimed();
      await recoveryReleased;
    }
  };
  const firstImport = appendImportedPlan(first);
  await recoveryClaimedPromise;
  const second = compileTodoExtraction(input, root);
  await assert.rejects(appendImportedPlan(second), (error) => error?.code === 'STORE_WRITE_CONFLICT'
    && error?.detail.reason === 'store_locked');
  releaseRecovery();
  await firstImport;
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
  await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.write.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.cross-plan-recovery')), { code: 'ENOENT' });
});

test('通常import writerも完全なPID/start/host lockを公開する', async (context) => {
  const root = await workspace(context);
  let lockBytes = null;
  await appendImportedPlan({
    repoRoot: root, writer: WRITER,
    plan: {
      schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'standalone', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('S')], hard_dependencies: [], joins: [],
    },
    genesis: { actor: ACTOR, recorded_at: NOW }, now: NOW,
    onProtocolStage: async (stage) => {
      if (stage === 'manifest_validated') {
        lockBytes = await readFile(path.join(root, '.lattice', 'todo', '.write.lock'));
      }
    },
  });
  const owner = JSON.parse(lockBytes.toString('utf8'));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.process_start.identity.length > 0);
  assert.ok(owner.host.length > 0);
});

test('transaction marker durable前の実process停止はstoreを変えず同一入力で再試行できる', async (context) => {
  const root = await workspace(context);
  const input = await extraction(root);
  await writeFile(path.join(root, 'companion.json'), `${JSON.stringify(input)}\n`);
  const crashed = childCrash(root, 'cross_plan_dependencies_staged');
  assert.equal(crashed.status, 91, crashed.stderr);

  const unchanged = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(unchanged.members.map(({ plan }) => plan.plan_key), ['main']);
  assert.deepEqual(unchanged.members[0].plan_scoped.events, []);
  const retry = await appendTodoExtraction({ repoRoot: root, extraction: input });
  assert.equal(retry.recovered, undefined);
  const finalStore = await readTodoStore({ repoRoot: root, now: NOW });
  assert.deepEqual(finalStore.members.map(({ plan }) => plan.plan_key), ['companion', 'main']);
  assert.equal(finalStore.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
});

for (const stage of [
  'cross_plan_transaction_durable', 'plan_directory_renamed',
  'manifest_activated', 'cross_plan_dependencies_activated',
]) {
  test(`実process停止後の${stage}は再読・再試行でplanとedgeを収束する`, async (context) => {
    const root = await workspace(context);
    const input = await extraction(root);
    await writeFile(path.join(root, 'companion.json'), `${JSON.stringify(input)}\n`);
    const crashed = childCrash(root, stage);
    assert.equal(crashed.status, 91, crashed.stderr);

    const visible = ['manifest_activated', 'cross_plan_dependencies_activated'].includes(stage);
    const reopened = await readTodoStore({ repoRoot: root, now: NOW });
    assert.deepEqual(reopened.members.map(({ plan }) => plan.plan_key), visible ? ['companion', 'main'] : ['main']);
    if (stage === 'cross_plan_transaction_durable') {
      await assert.rejects(stat(path.join(root, '.lattice', 'todo', 'plans', 'companion', 'v1')), {
        code: 'ENOENT',
      });
    }
    if (visible) {
      await assert.rejects(appendTodoExtraction({ repoRoot: root, extraction: input }),
        (error) => error.code === 'STORE_WRITE_CONFLICT' && error.detail.reason === 'plan_key_already_imported');
    } else {
      const retry = await appendTodoExtraction({ repoRoot: root, extraction: input });
      assert.equal(retry.crossPlanDependencies.length, 1);
    }
    const finalStore = await readTodoStore({ repoRoot: root, now: NOW });
    assert.deepEqual(finalStore.members.map(({ plan }) => plan.plan_key), ['companion', 'main']);
    assert.equal(finalStore.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 1);
    await appendImportedPlan({
      repoRoot: root, writer: WRITER,
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'followup', plan_version: 'v1',
        predecessor_plan_digest: null, tasks: [task('F')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW }, now: NOW,
    });
    await appendTodoExtraction({
      repoRoot: root,
      extraction: await connectionExtraction(root, {
        sourcePlan: 'followup', sourceTask: 'F', reason: 'recovery後の追加edge',
      }),
    });
    const afterFollowup = await readTodoStore({ repoRoot: root, now: NOW });
    assert.equal(afterFollowup.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length, 2);
    await assert.rejects(stat(path.join(root, '.lattice', 'todo', '.write.lock')), { code: 'ENOENT' });
  });
}

for (const stage of ['plan_directory_renamed', 'manifest_activated']) {
  test(`a different import resolves the abandoned ${stage} transaction before writing`, async (context) => {
    const root = await workspace(context);
    const input = await extraction(root);
    await writeFile(path.join(root, 'companion.json'), `${JSON.stringify(input)}\n`);
    const crashed = childCrash(root, stage);
    assert.equal(crashed.status, 91, crashed.stderr);
    await appendImportedPlan({ repoRoot: root, writer: WRITER, now: NOW,
      plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'different',
        plan_version: 'v1', predecessor_plan_digest: null, tasks: [task('D')],
        hard_dependencies: [], joins: [] }, genesis: { actor: ACTOR, recorded_at: NOW } });
    const store = await readTodoStore({ repoRoot: root, now: NOW });
    assert.deepEqual(store.members.map(({ plan }) => plan.plan_key), stage === 'manifest_activated'
      ? ['companion', 'different', 'main'] : ['different', 'main']);
    assert.equal(store.members.find(({ plan }) => plan.plan_key === 'main').plan_scoped.events.length,
      stage === 'manifest_activated' ? 1 : 0);
  });
}
