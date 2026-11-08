import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import { projectStatusFailure, runProjectStatus, validateProjectStatus } from '../src/project-cli.mjs';
import { renderTodoGanttForProject } from '../src/todo-cli.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-project-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

function run(root, args, env = {}) {
  const childEnv = {
    ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', ...env,
  };
  delete childEnv.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', env: childEnv,
  });
}

function createInput() {
  const value = {
    schema: 'lattice.plan_create_input.v4', project_id: 'sample-project',
    plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [{
      task_id: 'T1', title: '最初の仕事', lane: 'main', design_memo: '最初の仕事を実装し検証する。', narrative_ref: null,
      narrative_anchor: null, compile_binding: null, parent_task_id: null,
      phase_id: 'phase-1',
    }],
    phases: [{ phase_id: 'phase-1', title: '実装', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

test('status --jsonは未初期化repoを成功として発見し実在する次commandを返す', async (context) => {
  const root = await workspace(context);
  const execution = run(root, ['status', '--json']);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, '');
  const result = JSON.parse(execution.stdout);
  assert.equal(result.schema, 'lattice.project_status.v1');
  assert.equal(result.cli.available, true);
  assert.match(result.cli.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(result.project.root, await realpath(root));
  assert.equal(result.project.project_id, null);
  assert.equal(result.state, 'uninitialized');
  assert.equal(result.store.ref, '.lattice/todo');
  assert.equal(result.can_create_plan, true);
  assert.equal(result.next_action.command, 'lattice plan create --input .lattice/plan-create.json');
  assert.equal(result.next_action.input_schema, 'lattice.plan_create_input.v4');
  assert.equal(result.next_action.schema_command, 'lattice plan create --schema-version 4 --json');
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
  assert.equal(validateProjectStatus(result), true);

  const schemaExecution = run(root, ['plan', 'create', '--schema-version', '4', '--json']);
  assert.equal(schemaExecution.status, 0, schemaExecution.stderr);
  assert.equal(JSON.parse(schemaExecution.stdout).title, 'lattice.plan_create_input.v4');
});

test('plan create --schema --jsonは版指定なしで最新v4を返し、旧schemaは参照用に取得できる', async (context) => {
  const root = await workspace(context);
  const bare = run(root, ['plan', 'create', '--schema', '--json']);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stderr, '');
  assert.equal(JSON.parse(bare.stdout).title, 'lattice.plan_create_input.v4');

  const legacy = run(root, ['plan', 'create', '--schema-version', '1', '--json']);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).title, 'lattice.plan_create_input.v1');
});

test('旧plan create入力(v1)は拒否せず、旧plan schemaのplanとして作る(u03p A79)', async (context) => {
  const root = await workspace(context);
  const legacy = {
    schema: 'lattice.plan_create_input.v1', project_id: 'legacy-project',
    plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [{ task_id: 'T1', title: '未計画', lane: 'main', narrative_ref: null,
      narrative_anchor: null, compile_binding: null, parent_task_id: null }],
    hard_dependencies: [], joins: [], input_digest: '',
  };
  legacy.input_digest = todoSelfDigest(legacy, 'input_digest');
  await writeFile(path.join(root, 'legacy.json'), `${canonicalizeTodoArtifact(legacy)}\n`);
  const execution = run(root, ['plan', 'create', '--input', 'legacy.json']);
  assert.equal(execution.status, 0, execution.stderr);
  const plan = JSON.parse(await readFile(path.join(root, JSON.parse(execution.stdout).plan_ref), 'utf8'));
  assert.equal(plan.schema, 'lattice.todo_plan.v3');
});

test('plan createは設計メモ違反を本文非露出のpointer付きdiagnosticで返す', async (context) => {
  const root = await workspace(context);
  const input = createInput();
  input.tasks[0].design_memo = 'a\u0000b';
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, 'bad-memo.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const execution = run(root, ['plan', 'create', '--input', 'bad-memo.json']);
  assert.equal(execution.status, 1);
  const failure = JSON.parse(execution.stderr);
  assert.equal(failure.code, 'DESIGN_MEMO_REQUIRED');
  assert.equal(failure.detail.violation_kind, 'forbidden_control');
  assert.equal(failure.detail.pointer, '/tasks/0/design_memo');
  assert.deepEqual(failure.detail.actual, { byte_length: 3, contains_forbidden_control: true });
  assert.match(failure.detail.prompt, /`NO_PLAN`/u);
});

test('空の設計メモは機械がNO_PLANにして作成する(u03p A80)', async (context) => {
  const root = await workspace(context);
  const input = createInput();
  input.tasks[0].design_memo = '   ';
  await writeFile(path.join(root, 'blank-memo.json'), `${JSON.stringify(input)}\n`);
  const execution = run(root, ['plan', 'create', '--input', 'blank-memo.json']);
  assert.equal(execution.status, 0, execution.stderr);
  const plan = JSON.parse(await readFile(path.join(root, JSON.parse(execution.stdout).plan_ref), 'utf8'));
  assert.equal(plan.tasks[0].design_memo, 'NO_PLAN');
});

test('PROJECT_ROOT_CONFLICTのstatus失敗はcodeを一般化せずadopt導線を返す', async (context) => {
  const root = await workspace(context);
  let stdout = '';
  const error = new Error('project id is already owned by another canonical root');
  error.code = 'PROJECT_ROOT_CONFLICT';
  const exitCode = projectStatusFailure({
    cwd: root, stdout: { write: (chunk) => { stdout += chunk; } }, cliVersion: '0.39.0', error,
  });
  assert.equal(exitCode, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.state, 'invalid');
  assert.deepEqual(result.next_action, {
    command: 'lattice todo dashboard adopt --json', reason: 'project_root_conflict',
  });
  assert.equal(validateProjectStatus(result), true);
});

test('dashboard adoptとgantt serveは個別helpへ到達する', async (context) => {
  const root = await workspace(context);
  for (const args of [
    ['todo', 'dashboard', 'adopt', '--help'],
    ['todo', 'gantt', 'serve', '--help'],
  ]) {
    const execution = run(root, args);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /^Usage: lattice todo /u);
  }
});

test('status --jsonはSHA-256 Git HEADもtyped projectとして返す', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-project-sha256-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--object-format=sha256'], { cwd: root });
  execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  const execution = run(root, ['status', '--json']);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.state, 'uninitialized');
  assert.match(result.project.git_head, /^[0-9a-f]{64}$/u);
  assert.equal(validateProjectStatus(result), true);
});

// Windowsは末尾空白のディレクトリ自体をOSが作らせないため、この性質はPOSIXだけで検証できる。
test('status --jsonは末尾空白を含むrepo rootを改変しない',
  { skip: process.platform === 'win32' }, async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'lattice-project-space-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo ');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const result = JSON.parse(run(root, ['status', '--json']).stdout);
  assert.equal(result.project.root, await realpath(root));
  assert.equal(result.store.absolute_path, path.join(await realpath(root), '.lattice', 'todo'));
});

test('status --jsonはsymlink .latticeを未初期化へ丸めない', async (context) => {
  const root = await workspace(context);
  const outside = await mkdtemp(path.join(tmpdir(), 'lattice-project-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, '.lattice'));
  const execution = run(root, ['status', '--json']);
  assert.equal(execution.status, 1);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.state, 'invalid');
  assert.equal(result.can_create_plan, false);
  assert.equal(result.next_action.reason, 'lattice_root_invalid');
});

test('plan createはcanonical inputから初期storeを作りstatusをreadyへ遷移させる', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice'));
  const input = createInput();
  await writeFile(path.join(root, '.lattice', 'plan-create.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', '.lattice/plan-create.json']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.stderr, '');
  const createResult = JSON.parse(created.stdout);
  assert.equal(createResult.schema, 'lattice.plan_create_result.v1');
  assert.equal(createResult.project_id, 'sample-project');
  assert.equal(createResult.plan_key, 'main');
  assert.deepEqual(createResult.dispatch_shape, {
    task_count: 1, critical_path_length: 1, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
  assert.equal(createResult.terminal_audit_required, false);
  assert.equal(createResult.result_digest, todoSelfDigest(createResult, 'result_digest'));

  // store生成はEOL保護を消費者repoへ同梱する（Windows autocrlf checkoutでのstore全滅防止）
  const attributes = await readFile(path.join(root, '.lattice', '.gitattributes'), 'utf8');
  assert.match(attributes, /^\* -text$/mu);

  const status = run(root, ['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const result = JSON.parse(status.stdout);
  assert.equal(result.state, 'ready');
  assert.equal(result.project.project_id, 'sample-project');
  assert.deepEqual(result.active_plans, [{ plan_key: 'main', plan_version: 'v1' }]);
  assert.equal(result.can_create_plan, true);
  assert.equal(result.next_action.command, 'lattice todo start --plan main --task T1');

  const started = run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1'], {
    LATTICE_TODO_ACTOR_HOST: 'host-1',
    LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1',
  });
  assert.equal(started.status, 0, started.stderr);
  const active = JSON.parse(run(root, ['status', '--json']).stdout);
  assert.equal(active.state, 'active_run');
  assert.equal(active.can_create_plan, true);
  assert.deepEqual(active.active_runs, [{ plan_key: 'main', task_id: 'T1', label: '最初の仕事' }]);
  assert.equal(active.next_action.command, 'lattice todo status');
  assert.equal(validateProjectStatus(active), true);
});

test('plan create v4は設計メモ付きPhaseとphase accept依存を作る', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice'));
  const schemaExecution = run(root, ['plan', 'create', '--schema-version', '4', '--json']);
  assert.equal(schemaExecution.status, 0, schemaExecution.stderr);
  assert.equal(JSON.parse(schemaExecution.stdout).title, 'lattice.plan_create_input.v4');
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'phase-project', plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'T1', title: '設計', lane: 'main', design_memo: '仕様を確定し証拠を残す。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
      { task_id: 'T2', title: '実装', lane: 'main', design_memo: '設計Phaseのaccept後に実装する。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
    ],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'dotagents-heavy', predecessor_phase_ids: [], required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'dotagents-heavy', predecessor_phase_ids: ['phase-1'], required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [],
    phase_accept_dependencies: [{
      from: { project_id: 'phase-project', plan_key: 'main', phase_id: 'phase-1' },
      to: { project_id: 'phase-project', plan_key: 'main', task_id: 'T2' },
    }],
    input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'phase-plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', '.lattice/phase-plan.json']);
  assert.equal(created.status, 0, created.stderr);
  // Phaseを宣言したplanは既存のPhase gateが重監査を担うので、終端監査の追加通知は要らない。
  assert.equal(JSON.parse(created.stdout).terminal_audit_required, false);
  const status = JSON.parse(run(root, ['todo', 'status', '--json']).stdout);
  assert.deepEqual(status.next_ready.map(({ task_id }) => task_id), ['T1']);
  const phases = run(root, ['todo', 'phase', 'status', '--plan', 'main']);
  assert.equal(phases.status, 0, phases.stderr);
  assert.deepEqual(JSON.parse(phases.stdout).phases.map(({ phase_id, status: phaseStatus }) => [phase_id, phaseStatus]),
    [['phase-1', 'active'], ['phase-2', 'locked']]);

  const actorEnv = {
    LATTICE_TODO_ACTOR_HOST: 'host-1', LATTICE_TODO_ACTOR_SESSION: 'session-1',
    LATTICE_TODO_ACTOR_AGENT: 'agent-1',
  };
  const evidenceBytes = Buffer.from('phase heavy check\n');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: evidenceBytes, encoding: 'utf8',
  }).trim();
  const evidence = { evidence_id: 'phase-heavy', repo_id: 'self', path: 'phase-heavy.txt',
    git_blob_oid: oid, content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null };
  await writeFile(path.join(root, '.lattice', 'evidence.json'), `${JSON.stringify(evidence)}\n`);
  assert.equal(run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1'], actorEnv).status, 0);
  assert.equal(run(root, ['todo', 'done', '--plan', 'main', '--task', 'T1',
    '--evidence', '.lattice/evidence.json'], actorEnv).status, 0);
  const review = run(root, ['todo', 'phase', 'review', '--plan', 'main', '--phase', 'phase-1',
    '--reason', '重い検証'], actorEnv);
  assert.equal(review.status, 0, review.stderr);
  const decision = {
    schema: 'lattice.phase_accept_input.v1', review_event_digest: JSON.parse(review.stdout).event_digest,
    decision_evidence: evidence, evidence_slots: [{ slot_id: 'heavy', evidence }], input_digest: '',
  };
  decision.input_digest = todoSelfDigest(decision, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'phase-accept.json'), `${canonicalizeTodoArtifact(decision)}\n`);
  const accepted = run(root, ['todo', 'phase', 'accept', '--plan', 'main', '--phase', 'phase-1',
    '--input', '.lattice/phase-accept.json'], actorEnv);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).status, 'accepted');
  const after = JSON.parse(run(root, ['todo', 'status', '--json']).stdout);
  assert.deepEqual(after.next_ready.map(({ task_id }) => task_id), ['T2']);
  const { rendered: { html } } = await renderTodoGanttForProject({ repoRoot: root });
  assert.match(html, /Phase進捗/u);
  assert.match(html, /phase-1/u);
  assert.match(html, /accepted/u);
});

test('plan create v4は設計メモを保持しPhase監査順とToDo実行順を分離する', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice'));
  const schemaExecution = run(root, ['plan', 'create', '--schema-version', '4', '--json']);
  assert.equal(schemaExecution.status, 0, schemaExecution.stderr);
  assert.equal(JSON.parse(schemaExecution.stdout).title, 'lattice.plan_create_input.v4');
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'phase-project', plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'T1', title: '設計', lane: 'main', design_memo: '設計内容を検証可能に記録する。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
      { task_id: 'T2', title: '実装', lane: 'main', design_memo: '設計と独立に着手可能な実装を進める。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
    ],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'], required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'phase-plan-v3.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', '.lattice/phase-plan-v3.json']);
  assert.equal(created.status, 0, created.stderr);
  const status = JSON.parse(run(root, ['todo', 'status', '--json']).stdout);
  assert.deepEqual(status.next_ready.map(({ task_id }) => task_id), ['T1', 'T2']);
  assert.equal(status.schema, 'lattice.todo_status_result.v9');
  assert.equal(status.dispatch_frontier.recommended_parallelism, 2);
  assert.equal(status.dispatch_frontier.subset_requires_reason, true);
  const discovery = JSON.parse(run(root, ['status', '--json']).stdout);
  assert.equal(discovery.next_action.command,
    'lattice todo start --plan main --task T1 --parallel-frontier');
  assert.equal(discovery.next_action.reason, 'parallel_frontier_present');
  const phases = JSON.parse(run(root, ['todo', 'phase', 'status', '--plan', 'main']).stdout);
  assert.deepEqual(phases.phases.map(({ phase_id, status: phaseStatus }) => [phase_id, phaseStatus]),
    [['phase-1', 'active'], ['phase-2', 'locked']]);
});

test('壊れたstore配置はMarkdown fallbackせずtyped invalidを返す', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice', 'todo'), { recursive: true });
  await writeFile(path.join(root, '.lattice', 'todo', 'unknown-data'), 'preserve');
  const execution = run(root, ['status', '--json']);
  assert.equal(execution.status, 1);
  assert.equal(execution.stderr, '');
  const result = JSON.parse(execution.stdout);
  assert.equal(result.state, 'invalid');
  assert.equal(result.can_create_plan, false);
  assert.equal(result.next_action.reason, 'store_layout_invalid');
  assert.equal(result.next_action.command, 'lattice todo verify');
});

test('空のstore directoryは未初期化と案内し、初期authoringへ戻れる', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice', 'todo'), { recursive: true });
  const status = run(root, ['status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const result = JSON.parse(status.stdout);
  assert.equal(result.state, 'uninitialized');
  assert.equal(result.can_create_plan, true);
  assert.equal(result.next_action.input_schema, 'lattice.plan_create_input.v4');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(createInput()));
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
});

test('v4追加planは要求したmemberを返し、既存の作業中状態とjournalを保つ', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'first.json'), JSON.stringify(createInput()));
  const created = run(root, ['plan', 'create', '--input', 'first.json']);
  assert.equal(created.status, 0, created.stderr);
  const first = JSON.parse(created.stdout);
  const started = run(root, ['todo', 'start', '--plan', 'main', '--task', 'T1']);
  assert.equal(started.status, 0, started.stderr);
  const oldRefs = [first.plan_ref, first.journal_ref, first.snapshot_ref];
  const oldBytes = await Promise.all(oldRefs.map((ref) => readFile(path.join(root, ref), 'utf8')));

  const input = createInput();
  input.plan_key = 'a-before-main';
  await writeFile(path.join(root, 'additional.json'), JSON.stringify(input));
  const added = run(root, ['plan', 'create', '--input', 'additional.json']);
  assert.equal(added.status, 0, added.stderr);
  const result = JSON.parse(added.stdout);
  assert.equal(result.plan_key, input.plan_key);
  const addedPlan = JSON.parse(await readFile(path.join(root, result.plan_ref), 'utf8'));
  assert.equal(addedPlan.schema, 'lattice.todo_plan.v7');
  assert.deepEqual(addedPlan.phases, input.phases);
  const genesis = JSON.parse((await readFile(path.join(root, result.journal_ref), 'utf8')).trim());
  assert.equal(genesis.payload.historical_import, undefined);
  assert.deepEqual(await Promise.all(oldRefs.map((ref) => readFile(path.join(root, ref), 'utf8'))), oldBytes);
  const manifestRef = path.join(root, '.lattice', 'todo', 'manifest.json');
  const manifest = await readFile(manifestRef, 'utf8');
  assert.deepEqual(JSON.parse(manifest).members.map(({ plan_key }) => plan_key), ['a-before-main', 'main']);

  const duplicate = run(root, ['plan', 'create', '--input', 'additional.json']);
  assert.notEqual(duplicate.status, 0);
  assert.equal(JSON.parse(duplicate.stderr).code, 'STORE_WRITE_CONFLICT');
  assert.equal(await readFile(manifestRef, 'utf8'), manifest);
  input.project_id = 'wrong-project';
  input.plan_key = 'wrong-project-plan';
  await writeFile(path.join(root, 'mismatch.json'), JSON.stringify(input));
  const mismatch = run(root, ['plan', 'create', '--input', 'mismatch.json']);
  assert.notEqual(mismatch.status, 0);
  assert.equal(await readFile(manifestRef, 'utf8'), manifest);
});

test('Windows checkoutでCRLF化された旧storeはそのまま読め、正規repairでworktreeもLFへ戻る', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  await writeFile(path.join(root, 'user.txt'), 'baseline\n');
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const planRef = '.lattice/todo/plans/main/v1/plan.json';
  const planPath = path.join(root, planRef);
  await rm(path.join(root, '.lattice', '.gitattributes'));
  const canonical = await readFile(planPath, 'utf8');
  await writeFile(planPath, canonical.replaceAll('\n', '\r\n'));
  await writeFile(path.join(root, 'user.txt'), 'user dirty change\n');

  assert.equal(JSON.parse(run(root, ['status', '--json']).stdout).state, 'ready');

  const repaired = run(root, ['todo', 'repair-eol', '--json']);
  assert.equal(repaired.status, 0, repaired.stderr);
  const result = JSON.parse(repaired.stdout);
  assert.equal(result.schema, 'lattice.todo_eol_repair_result.v1');
  assert.equal(result.project_id, 'sample-project');
  assert.deepEqual(result.repaired_refs, [planRef]);
  assert.equal(result.repaired_count, 1);
  assert.equal(result.protection_created, true);
  assert.match(await readFile(path.join(root, '.lattice', '.gitattributes'), 'utf8'),
    /^\* -text$/mu);
  assert.equal((await readFile(planPath)).includes(13), false);
  assert.equal(execFileSync('git', ['diff-files', '--quiet', '--', planRef], {
    cwd: root, encoding: 'utf8',
  }), '');
  assert.deepEqual(execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
    .trim().split(/\r?\n/u), ['M user.txt']);
  assert.equal(JSON.parse(run(root, ['status', '--json']).stdout).state, 'ready');
});

test('repair-eolは純粋なCRLF変換でない破損を変更せず拒否する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  const planPath = path.join(root, '.lattice', 'todo', 'plans', 'main', 'v1', 'plan.json');
  await rm(path.join(root, '.lattice', '.gitattributes'));
  const before = Buffer.concat([await readFile(planPath), Buffer.from('\r')]);
  await writeFile(planPath, before);

  const repaired = run(root, ['todo', 'repair-eol', '--json']);
  assert.equal(repaired.status, 1);
  const failure = JSON.parse(repaired.stderr);
  assert.equal(failure.code, 'STORE_EOL_REPAIR_UNSAFE');
  assert.equal(failure.detail.reason, 'artifact_not_pure_crlf_conversion');
  assert.equal(await readFile(planPath, 'utf8'), before.toString('utf8'));
  assert.equal(await readFile(path.join(root, '.lattice', '.gitattributes'), 'utf8')
    .catch((error) => error.code), 'ENOENT');
});

test('repair-eolはstaged artifactを変更前に拒否しindexとworktreeを保持する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const planRef = '.lattice/todo/plans/main/v1/plan.json';
  const planPath = path.join(root, planRef);
  await rm(path.join(root, '.lattice', '.gitattributes'));
  const canonical = await readFile(planPath, 'utf8');
  const staged = canonical.replace('"project_id":"sample-project"', '"project_id":"staged-edit"');
  await writeFile(planPath, staged);
  execFileSync('git', ['add', '--', planRef], { cwd: root });
  const stagedBefore = execFileSync('git', ['show', `:${planRef}`], { cwd: root });
  const converted = Buffer.from(canonical.replaceAll('\n', '\r\n'));
  await writeFile(planPath, converted);

  const repaired = run(root, ['todo', 'repair-eol', '--json']);
  assert.equal(repaired.status, 1);
  const failure = JSON.parse(repaired.stderr);
  assert.equal(failure.code, 'STORE_EOL_REPAIR_UNSAFE');
  assert.equal(failure.detail.reason, 'artifact_staged_change_present');
  assert.equal(failure.detail.ref, planRef);
  assert.deepEqual(execFileSync('git', ['show', `:${planRef}`], { cwd: root }), stagedBefore);
  assert.deepEqual(await readFile(planPath), converted);
  assert.equal(await readFile(path.join(root, '.lattice', '.gitattributes'), 'utf8')
    .catch((error) => error.code), 'ENOENT');
});

test('repair-eolは内容が同じstaged mode変更をrefresh対象から外して保持する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const planRef = '.lattice/todo/plans/main/v1/plan.json';
  execFileSync('git', ['config', 'core.filemode', 'true'], { cwd: root });
  execFileSync('git', ['update-index', '--chmod=+x', '--', planRef], { cwd: root });
  const stagedBefore = execFileSync('git', ['diff', '--cached', '--summary', '--', planRef], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(stagedBefore, /100644 => 100755/u);

  const repaired = run(root, ['todo', 'repair-eol', '--json']);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).repaired_count, 0);
  assert.equal(execFileSync('git', ['diff', '--cached', '--summary', '--', planRef], {
    cwd: root, encoding: 'utf8',
  }), stagedBefore);
});

test('repair-eolはstore root junctionを辿らずrepo外artifactを変更しない', async (context) => {
  if (process.platform !== 'win32') context.skip('junction is Windows only');
  const root = await workspace(context);
  const outside = await mkdtemp(path.join(tmpdir(), 'lattice-project-cli-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
    'commit', '--quiet', '-m', 'fixture'], { cwd: root });

  const planRef = '.lattice/todo/plans/main/v1/plan.json';
  const canonical = await readFile(path.join(root, planRef), 'utf8');
  const outsidePlan = path.join(outside, 'plans', 'main', 'v1', 'plan.json');
  await mkdir(path.dirname(outsidePlan), { recursive: true });
  const outsideBefore = Buffer.from(canonical.replaceAll('\n', '\r\n'));
  await writeFile(outsidePlan, outsideBefore);
  const storeRoot = path.join(root, '.lattice', 'todo');
  await rm(storeRoot, { recursive: true, force: true });
  await symlink(outside, storeRoot, 'junction');

  const repaired = run(root, ['todo', 'repair-eol', '--json']);
  assert.equal(repaired.status, 1);
  const failure = JSON.parse(repaired.stderr);
  assert.equal(failure.code, 'STORE_EOL_REPAIR_UNSAFE');
  assert.equal(failure.detail.reason, 'unsafe_artifact_path');
  assert.equal(failure.detail.ref, '.lattice/todo');
  assert.deepEqual(await readFile(outsidePlan), outsideBefore);
});

test('snapshotとjournalのCRLF変換もそのまま読める', async (context) => {
  for (const ref of [
    '.lattice/todo/plans/main/v1/snapshot.json',
    '.lattice/todo/plans/main/v1/journal/active.jsonl',
  ]) {
    const root = await workspace(context);
    await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
    assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Lattice Test', '-c', 'user.email=lattice@example.invalid',
      'commit', '--quiet', '-m', 'fixture'], { cwd: root });
    await rm(path.join(root, '.lattice', '.gitattributes'));
    const absolute = path.join(root, ref);
    await writeFile(absolute, (await readFile(absolute, 'utf8')).replaceAll('\n', '\r\n'));

    const status = run(root, ['status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'ready');
  }
});

test('plan createはpretty-print入力を受理してstoreを作る', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${JSON.stringify(createInput(), null, 2)}\n`);
  const execution = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(execution.status, 0, execution.stderr);
  const status = JSON.parse(run(root, ['status', '--json']).stdout);
  assert.equal(status.state, 'ready');
});

test('plan createのmissing inputはENOENTを漏らさずtyped INPUT_INVALIDを返す', async (context) => {
  const root = await workspace(context);
  const execution = run(root, ['plan', 'create', '--input', 'missing.json']);
  assert.equal(execution.status, 1);
  assert.equal(execution.stdout, '');
  const failure = JSON.parse(execution.stderr);
  assert.equal(failure.code, 'INPUT_INVALID');
  assert.equal(failure.detail.reason, 'input_missing');
});

test('plan createは上限超過inputを全量parseせずtyped拒否する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'large.json'), Buffer.alloc(8_388_609, 0x20));
  const execution = run(root, ['plan', 'create', '--input', 'large.json']);
  assert.equal(execution.status, 1);
  const failure = JSON.parse(execution.stderr);
  assert.equal(failure.code, 'INPUT_INVALID');
  assert.equal(failure.detail.reason, 'input_size_limit_exceeded');
});

test('plan createはunsafe .latticeで失敗してもstagingを残さない', async (context) => {
  const root = await workspace(context);
  const input = createInput();
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  await writeFile(path.join(root, '.lattice'), 'not-a-directory\n');
  const execution = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(execution.status, 1);
  const failure = JSON.parse(execution.stderr);
  assert.equal(failure.code, 'STORE_INCONSISTENT');
  assert.equal(failure.detail.reason, 'unsafe_lattice_root');
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.lattice-todo-authoring-')), []);
});

function chainInput({ projectId = 'chain-project', taskCount = 6 } = {}) {
  const taskIds = Array.from({ length: taskCount }, (_, index) => `T${index + 1}`);
  const value = {
    schema: 'lattice.plan_create_input.v4', project_id: projectId,
    plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: taskIds.map((taskId) => ({
      task_id: taskId, title: taskId, lane: 'main', design_memo: `${taskId}を順番に実装する。`,
      narrative_ref: null, narrative_anchor: null, compile_binding: null,
      parent_task_id: null, phase_id: 'phase-1',
    })),
    phases: [{ phase_id: 'phase-1', title: '実装', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: taskIds.slice(1).map((taskId, index) => ({
      from: { project_id: projectId, plan_key: 'main', task_id: taskIds[index] },
      to: { project_id: projectId, plan_key: 'main', task_id: taskId },
    })),
    joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

test('critical pathがほぼ一直線のplan createはdispatch_shapeを載せて通り、'
  + '--serialization-reviewedは不要', async (context) => {
  const root = await workspace(context);
  const input = chainInput({ taskCount: 6 });
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);

  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  const createResult = JSON.parse(created.stdout);
  assert.deepEqual(createResult.dispatch_shape, {
    task_count: 6, critical_path_length: 6, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
  const statusAfterCreate = JSON.parse(run(root, ['status', '--json']).stdout);
  assert.equal(statusAfterCreate.state, 'ready');
});

test('task数が閾値未満の一直線plan createはdispatch_shape gateを素通りする', async (context) => {
  const root = await workspace(context);
  const input = chainInput({ projectId: 'small-chain-project', taskCount: 3 });
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  const createResult = JSON.parse(created.stdout);
  assert.deepEqual(createResult.dispatch_shape, {
    task_count: 3, critical_path_length: 3, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
});

test('plan show --jsonはtask・依存本数・topologyを投影し、未知keyをtyped errorにする', async (context) => {
  const root = await workspace(context);
  const input = chainInput({ projectId: 'show-project', taskCount: 3 });
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);

  const shown = run(root, ['plan', 'show', 'main', '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  const result = JSON.parse(shown.stdout);
  assert.equal(result.schema, 'lattice.plan_show_result.v1');
  assert.equal(result.project_id, 'show-project');
  assert.equal(result.plan_key, 'main');
  assert.equal(result.plan_version, 'v1');
  assert.equal(result.plan_schema, 'lattice.todo_plan.v7');
  assert.equal(result.has_phases, true);
  assert.deepEqual(result.phases.map(({ phase_id, status }) => [phase_id, status]),
    [['phase-1', 'active']]);
  assert.deepEqual(result.tasks.map(({ task_id, lane, phase_id, state, depends_on_count }) => (
    [task_id, lane, phase_id, state, depends_on_count]
  )), [
    ['T1', 'main', 'phase-1', 'pending', 0],
    ['T2', 'main', 'phase-1', 'pending', 1],
    ['T3', 'main', 'phase-1', 'pending', 1],
  ]);
  assert.deepEqual(result.topology, {
    task_count: 3, critical_path_length: 3, max_frontier_width: 1, serialization_ratio: '1.0000',
  });
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));

  const missing = run(root, ['plan', 'show', 'no-such-plan', '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  const failure = JSON.parse(missing.stderr);
  assert.equal(failure.schema, 'lattice.cli_error.v2');
  assert.equal(failure.code, 'STORE_INCONSISTENT');
  assert.equal(failure.message, 'plan_not_active');
  assert.equal(failure.detail.plan_key, 'no-such-plan');
  assert.match(failure.detail.next_action, /lattice todo status --json/u);
  assert.equal(failure.detail.rule, 'plan_not_active');
  assert.equal(failure.detail.pointer, '--plan');
});

test('plan show --jsonはPhase定義とPhase状態を併せて投影する', async (context) => {
  const root = await workspace(context);
  await mkdir(path.join(root, '.lattice'));
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'show-phase-project', plan_key: 'main', plan_version: 'v1',
    actor: { host: 'host-1', session: 'session-1', agent: 'agent-1' },
    recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'T1', title: '設計', lane: 'main', design_memo: '設計を確定する。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-1' },
      { task_id: 'T2', title: '実装', lane: 'main', design_memo: '設計に沿って実装する。', narrative_ref: null,
        narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase-2' },
    ],
    phases: [
      { phase_id: 'phase-1', title: '設計', gate_policy: 'heavy', predecessor_phase_ids: [], required_evidence_slots: ['heavy'] },
      { phase_id: 'phase-2', title: '実装', gate_policy: 'heavy', predecessor_phase_ids: ['phase-1'], required_evidence_slots: ['heavy'] },
    ],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, '.lattice', 'phase-plan-show.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', '.lattice/phase-plan-show.json']);
  assert.equal(created.status, 0, created.stderr);

  const shown = JSON.parse(run(root, ['plan', 'show', 'main', '--json']).stdout);
  assert.equal(shown.plan_schema, 'lattice.todo_plan.v7');
  assert.equal(shown.has_phases, true);
  assert.deepEqual(shown.phases.map(({ phase_id, status }) => [phase_id, status]), [
    ['phase-1', 'active'], ['phase-2', 'locked'],
  ]);
  assert.deepEqual(shown.tasks.map(({ task_id, phase_id }) => [task_id, phase_id]), [
    ['T1', 'phase-1'], ['T2', 'phase-2'],
  ]);
});

test('status discoveryはactor環境がなくてもactive projectをdashboardへ登録する', async (context) => {
  const root = await workspace(context);
  const input = createInput();
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  let output = '';
  let activity = null;

  const code = await runProjectStatus({
    cwd: root, cliVersion: 'test', env: {}, stdout: { write: (chunk) => { output += chunk; } },
    ensureDashboardActivity: async (options) => { activity = options; },
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(output).project.project_id, 'sample-project');
  assert.equal(activity.projectId, 'sample-project');
  assert.equal(activity.displayName, 'sample-project');
  assert.match(activity.sessionId, /^status-\d+$/u);
  assert.equal(await realpath(activity.repoRoot), await realpath(root));
});

test('statusは公開未設定をstderrへ返し、既存の工程状態契約を維持する', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'plan.json'), `${canonicalizeTodoArtifact(createInput())}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'plan.json']).status, 0);
  let stdout = ''; let stderr = '';
  const code = await runProjectStatus({ cwd: root, cliVersion: 'test',
    env: { LATTICE_CONFIG_DIR: path.join(root, 'bridge-config') },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    ensureDashboardActivity: async () => ({ projectId: 'sample-project' }),
  });
  assert.equal(code, 0);
  assert.equal(validateProjectStatus(JSON.parse(stdout)), true);
  // a15: a seat without a bridge gets no delivery line on stderr.
  assert.equal(stderr, '');
});
