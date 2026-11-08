import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createHash } from 'node:crypto';

import { selfDigest } from '../../src/runtime-contracts.mjs';
import { registerManagedDaemonFixture } from '../helpers/managed-daemon-fixture.mjs';
import {
  canonicalizeTodoArtifact, digestTodoArtifact, todoSelfDigest,
} from '../../src/todo-contracts.mjs';
import {
  phaseTodoRevisionPlanVersion, todoCutoverArchiveSourceRef,
} from '../../src/todo-revision.mjs';
import { buildTodoPlan } from '../../src/todo-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');
const CONTROLLER = path.join(ROOT, 'bin', 'lattice-scripted-adapter.mjs');

// 実daemonを起こす面はmacOSでのみ検証している（backlog「管理runtimeのLinux検証」）。
const managedDaemon = {
  skip: process.platform === 'darwin' ? false : 'managed runtime daemon is verified on macOS only',
};

function invoke(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
  assert.equal(result.error, undefined);
  return result;
}

const cli = (args, cwd) => invoke(process.execPath, [CLI, ...args], cwd);

function ok(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

// 係争file。T1が`renderLeft`、T2が`CSS`を触る——同じfileの中の別symbolなので、面を分ければ
// 別々に所有できる。切れる種類の資源である。
const PAGE = [
  "const CSS = 'body { color: red; }';",
  '',
  'function renderLeft(value) {',
  '  return `<div>${String(value)}</div>`;',
  '}',
  '',
  'export function renderPage(value) {',
  '  return `<style>${CSS}</style>${renderLeft(value)}`;',
  '}',
  '',
].join('\n');

const PAGE_TEST = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { renderPage } from '../src/page.mjs';",
  "test('page', () => assert.match(renderPage('a'), /<div>a<\\/div>/));",
  '',
].join('\n');

function witness({ owns, writes, queries, tests }) {
  return {
    owns, reads: [], writes, resources: [], state_effects: [],
    sensor_provenance: { queries }, affected_tests: tests, unknowns: [],
  };
}

const pageWitness = () => witness({
  owns: [{ kind: 'path', target: 'src/page.mjs' }],
  writes: ['src/page.mjs'],
  queries: [{ query_id: 'q-page-aff', expect: { kind: 'affected', path: 'src/page.mjs' } }],
  tests: ['test/page.test.mjs'],
});

/** carry/stayだけを使うので、写像は素直な1対1になる。 */
function runtimeToTodoMigration(runtimeMigration) {
  return runtimeMigration.entries.map((entry) => ({
    from_task_id: entry.predecessor_task_id,
    to_task_id: entry.predecessor_task_id,
    state_policy: 'carry',
  })).sort((left, right) => left.from_task_id.localeCompare(right.from_task_id));
}

function todoMigrationDigest(taskMigration) {
  return todoSelfDigest({ task_migration: taskMigration, task_migration_digest: '' },
    'task_migration_digest');
}

/**
 * seam splitの再計画へ添える工程改訂を組む。
 *
 * **所有が変わるのはplan overlayではなく工程の改訂である。** だからseam_split modeは
 * phase revisionを必須にし、runtimeはそれをprojectのLattice TODO storeへcommitする
 * （`applyPhaseTodoRevision`）。つまり請求項8の実行時経路は、対象projectがLattice工程管理下に
 * あることを要求する——ここでもfixture repoへstoreを立ててから通す。
 */
function buildPhaseRevision({ projectId, planKey, predecessor, predecessorReconciliationDigest,
  runtimeTaskMigration, liveRef, archiveRef }) {
  const taskMigration = runtimeToTodoMigration(runtimeTaskMigration);
  const phaseMigration = [{ from_phase_id: 'phase-1', to_phase_id: 'phase-1', state_policy: 'carry' }];
  // cutoverは生きた計画行をarchiveへ移す操作である。移した後のtaskはarchive側を指し、
  // operationのsource_refは置き換えたlive側を指す。archive側のrefは`todoCutoverArchiveSourceRef`が
  // 決めるので、こちらで名前を作らない。
  const archived = (index) => todoCutoverArchiveSourceRef({ archive_ref: archiveRef }, index);
  const desiredInput = { schema: 'lattice.todo_plan.v7', project_id: projectId, plan_key: planKey,
    plan_version: 'pending', predecessor_plan_digest: predecessor.plan_digest,
    tasks: ['T1', 'T2'].map((taskId, index) => ({ task_id: taskId, title: taskId, lane: 'main',
      design_memo: `${taskId}が所有する面をseam split後も維持し、双方を再開する。`,
      narrative_ref: archived(index), narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase-1' })),
    phases: [{ phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [] };
  desiredInput.plan_version = phaseTodoRevisionPlanVersion({ projectId, planKey, predecessor,
    desiredPlan: desiredInput, taskMigration, phaseMigration });
  const desiredPlan = buildTodoPlan(desiredInput);
  // digestは行のbytesに対して取る。改行は行に含まれない（storeが0x0aで切っている）。
  const sourceDigests = ['- [ ] T1', '- [ ] T2']
    .map((line) => createHash('sha256').update(line).digest('hex'));
  const sourceCutoverBatch = { batch_id: 'cutoverseam', archive_ref: archiveRef,
    operations: ['T1', 'T2'].map((taskId, index) => ({ task_id: taskId, disposition: 'active',
      source_ref: `${liveRef}#L${index + 1}`, source_digest: sourceDigests[index],
      live_replacement: `- Lattice管理: ${taskId}` })), batch_digest: '' };
  sourceCutoverBatch.batch_digest = todoSelfDigest(sourceCutoverBatch, 'batch_digest');
  const sourceInventory = { active: ['T1', 'T2'].map((taskId, index) => ({ task_id: taskId,
    source_ref: archived(index), source_digest: sourceDigests[index] })),
    excluded_tombstones: [] };
  const revision = { schema: 'lattice.phase_todo_revision.v3', project_id: projectId,
    plan_key: planKey, predecessor, desired_plan: desiredPlan,
    runtime_task_migration: runtimeTaskMigration, task_migration: taskMigration,
    phase_migration: phaseMigration, source_inventory: sourceInventory,
    reconciliation: { predecessor_reconciliation_digest: predecessorReconciliationDigest,
      source_inventory_digest: digestTodoArtifact(sourceInventory),
      desired_plan_digest: desiredPlan.plan_digest,
      runtime_task_migration_digest: runtimeTaskMigration.migration_digest,
      task_migration_digest: todoMigrationDigest(taskMigration),
      phase_migration_digest: digestTodoArtifact(phaseMigration),
      source_cutover_batch_digest: sourceCutoverBatch.batch_digest,
      reconciliation_digest: '' },
    source_cutover_batch: sourceCutoverBatch, revision_digest: '' };
  revision.reconciliation.reconciliation_digest = todoSelfDigest(revision.reconciliation,
    'reconciliation_digest');
  revision.revision_digest = todoSelfDigest(revision, 'revision_digest');
  return revision;
}

// 請求項8の再開側。**双方を止め、限定的な変換を施し、双方を再開する。**
//
// 請求項7（片方を止め、他方を確定し、止めた方を再開する）は2026-07-28に実runで通った。
// こちらは止めた双方が、変換で生まれた新しい面をそれぞれ所有して動き出すところまでを見る。
//
// 変換の着地は装置がやらない。`run seam resolve`は後継baseを返すだけで、branchは動かさない
// ——どこへ着地させるかは操作するAIが決める（ADR 0141と同じ責務分担）。したがってこのtestも
// 着地と再indexを自分で行い、そのあとでseam_split modeの再計画を出す。
test('双方を止め、変換で生まれた面をそれぞれ所有させて双方を再開する', managedDaemon, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-hold-transform-'));
  registerManagedDaemonFixture(t, temporaryRoot);
  const repoRoot = path.join(temporaryRoot, 'repo');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'test'), { recursive: true });
  await writeFile(path.join(repoRoot, '.gitignore'), '.lattice/\n');
  await writeFile(path.join(repoRoot, 'src', 'page.mjs'), PAGE);
  await writeFile(path.join(repoRoot, 'test', 'page.test.mjs'), PAGE_TEST);
  // T2が宣言外の`src/page.mjs`——T1の領分——へ書く。実行時に初めて見える競合である。
  await writeFile(path.join(repoRoot, 'adapter-config.json'),
    `${JSON.stringify({ mode: 'deterministic', hold_ms: 20_000, extra_writes: ['src/page.mjs'] })}\n`);

  const git = (...args) => ok(invoke('git', ['-c', 'user.email=a@example.invalid',
    '-c', 'user.name=a', ...args], repoRoot), `git ${args.join(' ')}`);
  ok(invoke('git', ['init', '--quiet', '--initial-branch=main'], repoRoot), 'git init');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const baseSha = ok(invoke('git', ['rev-parse', 'HEAD'], repoRoot), 'rev-parse').stdout.trim();
  ok(cli(['sensor', 'init', '.', '--json'], repoRoot), 'sensor init');

  // planは競合を知らない。T1がpage、T2はwidgetを所有すると宣言している。
  await writeFile(path.join(repoRoot, 'src', 'widget.mjs'), 'export const widget = 1;\n');
  await writeFile(path.join(repoRoot, 'test', 'widget.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\n"
    + "import { widget } from '../src/widget.mjs';\ntest('widget', () => assert.ok(widget));\n");
  git('add', '.');
  git('commit', '--quiet', '-m', 'widget');
  // seam splitは工程の改訂なので、projectがLattice工程管理下にある必要がある。
  const planInput = { schema: 'lattice.plan_create_input.v4', project_id: 'seamproject',
    plan_key: 'main', plan_version: 'v1',
    actor: { host: 'fixture', session: 'fixture', agent: 'fixture' },
    recorded_at: '2026-07-28T00:00:00.000Z',
    // 既にcutover済みの形で立てる。
    tasks: ['T1', 'T2'].map((taskId, index) => ({ task_id: taskId, title: taskId, lane: 'main',
      design_memo: `${taskId}が所有する面をseam split後も維持し、双方を再開する。`,
      narrative_ref: `docs/archive/seam.md#L${index + 6}`, narrative_anchor: null,
      compile_binding: null, parent_task_id: null, phase_id: 'phase-1' })),
    phases: [{ phase_id: 'phase-1', title: 'Phase 1', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['heavy'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [], input_digest: '' };
  planInput.input_digest = todoSelfDigest(planInput, 'input_digest');
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'plan.md'), '- [ ] T1\n- [ ] T2\n');
  // archiveは作らない。cutoverが作る側なので、先に置くと`source_cutover_archive_exists`になる。
  // 入力はgitignore済みの`.lattice/`へ置く。変換は既知のbaseに対して測るので、working treeへ
  // 追跡外の残骸を残すと`run seam resolve`が正しく拒否する（実測でこれに当たった）。
  await writeFile(path.join(repoRoot, '.lattice', 'plan-create.json'),
    `${canonicalizeTodoArtifact(planInput)}\n`);
  ok(cli(['plan', 'create', '--input', '.lattice/plan-create.json'], repoRoot), 'plan create');
  git('add', '.');
  git('commit', '--quiet', '-m', 'plan narrative');
  const startSha = ok(invoke('git', ['rev-parse', 'HEAD'], repoRoot), 'rev-parse').stdout.trim();
  ok(cli(['sensor', 'sync', '.', '--json'], repoRoot), 'sensor sync');
  assert.equal(invoke('git', ['status', '--porcelain'], repoRoot).stdout, '',
    'working treeが汚れている');

  const widgetWitness = () => witness({
    owns: [{ kind: 'path', target: 'src/widget.mjs' }],
    writes: ['src/widget.mjs'],
    queries: [{ query_id: 'q-widget-aff', expect: { kind: 'affected', path: 'src/widget.mjs' } }],
    tests: ['test/widget.test.mjs'],
  });
  const querySet = { queries: [
    { id: 'q-status', operation: 'status' },
    { id: 'q-page-aff', operation: 'affected', target: 'src/page.mjs' },
    { id: 'q-widget-aff', operation: 'affected', target: 'src/widget.mjs' },
  ] };
  const request = {
    schema: 'lattice.run_request.v1', request_id: 'hold-transform-live',
    repo: { base_sha: startSha, root_kind: 'git-worktree' },
    capacity: { executors: 2 },
    todos: [{ todo_id: 'T1' }, { todo_id: 'T2' }],
    manual_witness: { T1: pageWitness(), T2: widgetWitness() },
    sensor_query_set: querySet,
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum', request_digest: '',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  const requestPath = path.join(temporaryRoot, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  ok(cli(['plan', 'compile', '--request', requestPath], repoRoot), 'plan compile');
  const runRef = JSON.parse(ok(cli(['run', 'start', '--request', requestPath,
    '--executor', 'scripted'], repoRoot), 'run start').stdout).run_dir;
  await writeFile(path.join(temporaryRoot, 'adapter.json'), `${JSON.stringify({
    schema: 'lattice.runtime_adapter_registration_input.v1',
    adapter_kind: 'scripted', launch_kind: 'host_binary', binary_path: process.execPath,
    argv: [CONTROLLER], config_ref: 'adapter-config.json',
  })}\n`);
  ok(cli(['run', 'adapter', 'register', '--input', path.join(temporaryRoot, 'adapter.json')],
    repoRoot), 'adapter register');
  ok(cli(['run', 'activate', '--run', runRef], repoRoot), 'run activate');

  const runDir = path.join(repoRoot, ...runRef.split('/'));
  const runEvents = JSON.parse(await readFile(path.join(runDir, 'events.json'), 'utf8'));

  // --- 双方が止まっている。
  const decided = runEvents.findLast((event) => event.kind === 'hold_decided');
  assert.notEqual(decided, undefined, runEvents.map((e) => e.kind).join(','));
  const conflict = runEvents.findLast((event) => event.kind === 'conflict_found');
  assert.equal(conflict.payload.kind, 'observed_write_conflict', JSON.stringify(conflict.payload));
  assert.deepEqual([...conflict.payload.todo_ids].sort(), ['T1', 'T2']);
  const pidOf = (todoId) => runEvents.findLast((event) => event.kind === 'executor_dispatched'
    && event.subject?.ref === todoId)?.payload?.direct_os_observation_binding?.process_pid;
  const stateOf = (pid) => invoke('ps', ['-o', 'stat=', '-p', String(pid)], repoRoot).stdout.trim();
  for (const todoId of ['T1', 'T2']) {
    assert.equal(stateOf(pidOf(todoId)).startsWith('T'), true, `止まっていない: ${todoId}`);
  }

  // --- 変換を試せると助言されている（ct-003）。
  const advice = JSON.parse(ok(cli(['run', 'status', '--run', runRef], repoRoot), 'run status')
    .stdout).runtime_projection.treatment_advice;
  assert.equal(advice.severability, 'code_seam', JSON.stringify(advice));
  assert.equal(advice.transform_attemptable, true);

  // --- 限定的な変換を施す。宣言するのは触るsymbolと新しい面の名前だけ。
  // 移行の根拠は観測した競合そのものである。工程側の契約は各entryへ証拠を1件以上要求する
  // ——「なぜこのtaskを次の版へ運ぶのか」を空にさせない。
  const migration = { schema: 'lattice.runtime_task_migration.v1',
    entries: ['T1', 'T2'].map((id) => ({ predecessor_task_id: id, disposition: 'stay',
      successor_task_ids: [id], reason: 'seam split',
      evidence_digests: [conflict.payload.finding_digest] })),
    migration_digest: '' };
  migration.migration_digest = selfDigest(migration, 'migration_digest');
  const declaration = {
    schema: 'lattice.runtime_seam_request.v1', run_id: request.request_id,
    finding_digest: conflict.payload.finding_digest,
    concern_symbols: { T1: ['renderLeft'], T2: ['CSS'] },
    path_names: { T1: 'src/page-left.mjs', T2: 'src/page-style.mjs', shared: 'src/page-shared.mjs' },
    task_migration_digest: migration.migration_digest, request_digest: '' };
  declaration.request_digest = todoSelfDigest(declaration, 'request_digest');
  const declarationPath = path.join(temporaryRoot, 'seam-request.json');
  await writeFile(declarationPath, `${JSON.stringify(declaration)}\n`);
  const resolved = ok(cli(['run', 'seam', 'resolve', '--run', runRef,
    '--finding', conflict.payload.finding_digest, '--input', declarationPath], repoRoot),
  'seam resolve');
  const resolution = JSON.parse(resolved.stdout);
  assert.equal(resolution.lane, 'seam_transform', JSON.stringify(resolution.reasons));
  // 実行時にしか見えない形だったので、宣言を観測へ合わせてから判定している（ct-002）。
  assert.deepEqual(resolution.reconciled.map(({ todo_id: id }) => id), ['T2']);

  // --- 着地は操作する側の仕事。装置はbranchを動かさない。
  assert.equal(invoke('git', ['rev-parse', 'HEAD'], repoRoot).stdout.trim(), startSha);
  git('merge', '--ff-only', '--quiet', resolution.successor_base_sha);
  ok(cli(['sensor', 'sync', '.', '--json'], repoRoot), 'sensor sync after transform');
  for (const owned of ['src/page-left.mjs', 'src/page-style.mjs']) {
    assert.equal(spawnSync('test', ['-f', path.join(repoRoot, owned)]).status, 0, owned);
  }

  // --- 双方が新しい面をそれぞれ所有して再開する。
  // 変換で変わるのは係争fileの面だけである。T2が元から持っていたwidgetの所有はそのまま残す
  // ——落とすと、seam splitが述べていない所有の消滅を後継が持つことになる。
  const ownedWitness = (target, queryId, extraOwns = [], extraQueries = [], extraTests = []) => witness({
    owns: [{ kind: 'path', target }, ...extraOwns],
    writes: [target, ...extraOwns.map(({ target: value }) => value)],
    queries: [{ query_id: queryId, expect: { kind: 'affected', path: target } }, ...extraQueries],
    tests: ['test/page.test.mjs', ...extraTests].sort(),
  });
  const successorQuerySet = { queries: [
    { id: 'q-status', operation: 'status' },
    { id: 'q-left-aff', operation: 'affected', target: 'src/page-left.mjs' },
    { id: 'q-style-aff', operation: 'affected', target: 'src/page-style.mjs' },
    { id: 'q-widget-aff', operation: 'affected', target: 'src/widget.mjs' },
  ] };
  const successor = { schema: 'lattice.run_request.v2', request_id: request.request_id,
    repo: { base_sha: resolution.successor_base_sha, root_kind: 'git-worktree' },
    capacity: request.capacity, todos: request.todos,
    manual_witness: {
      T1: ownedWitness('src/page-left.mjs', 'q-left-aff'),
      T2: ownedWitness('src/page-style.mjs', 'q-style-aff',
        [{ kind: 'path', target: 'src/widget.mjs' }],
        [{ query_id: 'q-widget-aff', expect: { kind: 'affected', path: 'src/widget.mjs' } }],
        ['test/widget.test.mjs']),
    },
    sensor_query_set: successorQuerySet,
    executor_capability: request.executor_capability, claim_mode: request.claim_mode,
    predecessor_request_digest: request.request_digest,
    task_migration_digest: migration.migration_digest, request_digest: '' };
  successor.request_digest = selfDigest(successor, 'request_digest');
  const frozen = runEvents.findLast((event) => event.kind === 'intake_frozen');
  const recompile = { schema: 'lattice.runtime_recompile_request.v1', request_id: 'seam-r1',
    run_id: request.request_id, predecessor_epoch: 1,
    frozen_event_digest: frozen.event_digest,
    hold_decision_digest: decided.payload.decision_digest,
    mode: 'seam_split', reason: 'runtime seam transform',
    successor_request: successor, task_migration: migration, phase_revision: null,
    // 下でbuildPhaseRevisionの結果へ差し替える（predecessorはstoreから読む）。
    seam_split: resolution.split, intentional_serial: null, request_digest: '' };
  // storeの現在地からpredecessorを読む。改訂は「今の版の後継」でなければ受理されない。
  const storePlan = JSON.parse(await readFile(
    path.join(repoRoot, '.lattice/todo/plans/main/v1/plan.json'), 'utf8'));
  const storeHead = JSON.parse(ok(cli(['todo', 'status', '--json'], repoRoot), 'todo status').stdout)
    .member_heads.find((entry) => entry.plan_key === 'main');
  // predecessorは3keyのexact recordである。照合用のreconciliation digestは別枠で渡す。
  const storePredecessor = {
    plan_version: storePlan.plan_version,
    plan_digest: storePlan.plan_digest,
    journal_head_digest: storeHead.journal_head_digest,
  };
  recompile.phase_revision = buildPhaseRevision({
    projectId: 'seamproject', planKey: 'main',
    predecessor: storePredecessor,
    predecessorReconciliationDigest: storeHead.reconciliation_digest,
    runtimeTaskMigration: migration,
    liveRef: 'docs/plan.md', archiveRef: 'docs/archive/seam.md',
  });
  recompile.request_digest = selfDigest(recompile, 'request_digest');
  const recompilePath = path.join(temporaryRoot, 'recompile.json');
  await writeFile(recompilePath, `${JSON.stringify(recompile)}\n`);
  const recompiled = ok(cli(['run', 'recompile', '--run', runRef, '--input', recompilePath],
    repoRoot), 'run recompile');
  assert.equal(JSON.parse(recompiled.stdout).outcome, 'recompiled');

  // **請求項7との違いはここである。** 請求項7は片方を止めて他方を確定し、止めた方だけを
  // 繋ぎ直す（carry-overのrebind）。請求項8は**双方を止める**ので繋ぎ直す相手がおらず、
  // 双方が新しい面を所有した後継epochで作り直される。
  const afterEvents = JSON.parse(await readFile(path.join(runDir, 'events.json'), 'utf8'));
  assert.ok(afterEvents.some((event) => event.kind === 'plan_recompiled'), '後継planが無い');
  for (const todoId of ['T1', 'T2']) {
    const invalidated = afterEvents.findLast((event) => event.kind === 'context_invalidated'
      && event.subject?.ref === todoId);
    assert.notEqual(invalidated, undefined, `contextが失効していない: ${todoId}`);
    assert.equal(invalidated.payload.reauthorized_via, 'redispatch',
      JSON.stringify(invalidated.payload));
  }
  const control = JSON.parse(await readFile(path.join(runDir, 'control-events.json'), 'utf8'));
  assert.notEqual(control.findLast((event) => event.kind === 'epoch_activated'), undefined,
    '後継epochがactivateされていない');
  assert.notEqual(afterEvents.findLast((event) => event.kind === 'intake_resumed'), undefined,
    'intakeが再開していない');

  // **双方が同じ波で動ける。** 変換が係争を消したので、直列化する理由が無くなっている。
  const resumed = JSON.parse(ok(cli(['run', 'resume', '--run', runRef], repoRoot), 'run resume').stdout);
  assert.deepEqual([...resumed.dispatchable].sort(), ['T1', 'T2'], JSON.stringify(resumed));

  ok(cli(['run', 'abandon', '--run', runRef, '--reason', 'acceptance'], repoRoot), 'run abandon');
});
