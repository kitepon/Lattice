import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { TODO_STRUCTURE_SET_SCHEMA } from '../src/todo-structure-contracts.mjs';
import { renderCliHelp } from '../src/cli-help.mjs';
import { canonicalizeTodoArtifact, todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
  todoStructureBindingRef,
  todoStructureSourceRef,
} from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-08-11T13:00:00.000Z';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).replace(/\r?\n$/u, '');
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, 'todo', ...args], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_TODO_ACTOR_HOST: ACTOR.host,
      LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
      LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
    },
  });
}

function runRootCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
  });
}

function runSensor(root, args) {
  return spawnSync(process.execPath, [CLI, 'sensor', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

const parse = (text) => JSON.parse(text.trim().split('\n').at(-1));

const task = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
});

async function workspace(context, { planCount = 1 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-structure-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'fixture']);
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  await writeFile(path.join(root, '.gitignore'), '.lattice/sensor/\n');
  git(root, ['add', 'README.md', '.gitignore']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: Array.from({ length: planCount }, (_, index) => ({
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1',
        plan_key: index === 0 ? 'main' : `other-${index}`,
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [task('T1'), task('T2')], hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    })),
    now: NOW,
  });
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  return { root, baselineSha, member: store.members[0] };
}

function planned() {
  return {
    outcome: '入力を整理して成果へ渡す', inputs: [], operations: [], outputs: [], code_anchors: [],
    failures: ['入力不足'], first_live_e2e: '実入力を一件処理する', non_goals: ['並列性を判定する'],
  };
}

function structureSet({ baselineSha, member }, overrides = {}) {
  const value = {
    schema: TODO_STRUCTURE_SET_SCHEMA,
    project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
    topology_digest: member.plan.topology_digest,
    profile: 'code-dataflow', baseline_sha: baselineSha,
    external_contracts: [],
    tasks: [
      { task_id: 'T1', applicability: 'graph', planned: planned() },
      { task_id: 'T2', applicability: 'excluded', excluded_reason: 'fixtureでは文書作業だけを行う' },
    ],
    structure_set_digest: '',
    ...overrides,
  };
  value.structure_set_digest = todoSelfDigest(value, 'structure_set_digest');
  return value;
}

async function writeDraft(root, value, name = 'structure-draft.json') {
  await writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
}

async function snapshotTree(root) {
  const result = {};
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else result[relative] = (await readFile(absolute)).toString('hex');
    }
  }
  await walk(root, '');
  return result;
}

test('structure input dry-runはplan identity・coverage・baselineを無変更で検査する', async (context) => {
  const fixture = await workspace(context);
  const inputRef = await writeDraft(fixture.root, structureSet(fixture));
  const before = await snapshotTree(path.join(fixture.root, '.lattice', 'todo'));

  const execution = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef, '--dry-run', '--json',
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  const result = parse(execution.stdout);
  assert.equal(result.schema, 'lattice.todo_structure_input_dry_run_result.v1');
  assert.equal(result.valid, true);
  assert.equal(result.current_head_sha, fixture.baselineSha);
  assert.equal(result.source_ref, '.lattice/todo/structure/main.json');
  assert.deepEqual(result.violations, []);
  assert.deepEqual(await snapshotTree(path.join(fixture.root, '.lattice', 'todo')), before);
  await assert.rejects(lstat(path.join(fixture.root, result.source_ref)), { code: 'ENOENT' });
});

test('structure inputは検査成功後だけcanonical sourceを保存しbindingを発行しない', async (context) => {
  const fixture = await workspace(context);
  const set = structureSet(fixture);
  const inputRef = await writeDraft(fixture.root, set);
  const execution = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef,
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  const result = parse(execution.stdout);
  assert.equal(result.schema, 'lattice.todo_structure_input_result.v1');
  assert.equal(result.enabled, false);
  assert.equal(result.source_ref, todoStructureSourceRef('main'));
  assert.equal(await readFile(path.join(fixture.root, result.source_ref), 'utf8'),
    `${canonicalizeTodoArtifact(set)}\n`);
  await assert.rejects(lstat(path.join(fixture.root, todoStructureBindingRef('main', 'v1'))), {
    code: 'ENOENT',
  });
});

test('coverage・plan identity違反はpointerを返しsource bytesを作らない', async (context) => {
  const fixture = await workspace(context);
  const set = structureSet(fixture, {
    plan_version: 'v2',
    tasks: [{ task_id: 'T1', applicability: 'graph', planned: planned() }],
  });
  const inputRef = await writeDraft(fixture.root, set);
  const dryRun = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef, '--dry-run', '--json',
  ]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const report = parse(dryRun.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.violations.some(({ code, path: pointer }) => code === 'plan_version_mismatch'
    && pointer === '/plan_version'), true);
  assert.equal(report.violations.some(({ code, path: pointer }) => code === 'coverage_missing'
    && pointer === '/tasks'), true);

  const write = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef,
  ]);
  assert.equal(write.status, 1);
  assert.equal(parse(write.stderr).code, 'INVALID_TODO_STRUCTURE_SET');
  await assert.rejects(lstat(path.join(fixture.root, todoStructureSourceRef('main'))), { code: 'ENOENT' });
});

test('baselineが実commitでもHEAD祖先でなければdry-runで区別する', async (context) => {
  const fixture = await workspace(context);
  const tree = git(fixture.root, ['write-tree']);
  const unrelated = git(fixture.root, ['commit-tree', tree, '-m', 'unrelated root']);
  const inputRef = await writeDraft(fixture.root, structureSet(fixture, { baseline_sha: unrelated }));
  const execution = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef, '--dry-run', '--json',
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  const result = parse(execution.stdout);
  assert.equal(result.valid, false);
  assert.equal(result.violations.some(({ code }) => code === 'baseline_not_ancestor'), true);
});

// a17: JSONの中身だけを読む入力は、repo外の絶対pathでも読む（拒んで守るものが無い）。
test('repo外inputも中身を読み、内容の不備はinput検査が返す', async (context) => {
  const fixture = await workspace(context);
  const outside = path.join(tmpdir(), `lattice-outside-${process.pid}.json`);
  await writeFile(outside, '{}\n');
  context.after(() => rm(outside, { force: true }));
  const execution = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', outside, '--dry-run', '--json',
  ]);
  assert.notEqual(execution.status, null, execution.stderr);
  assert.doesNotMatch(execution.stderr, /input_path_outside_repo/u);
  assert.equal(parse(execution.stdout).valid, false);
});

test('structure artifactの4種の破損をstatus/verifyで診断し、明示inputからcanonical復旧する', async (context) => {
  const cases = [
    ['pretty_json', (value) => `${JSON.stringify(value, null, 2)}\n`, 'non_canonical_or_duplicate_key'],
    ['trailing_bytes', (value) => `${canonicalizeTodoArtifact(value)}\nTRAILING`,
      'artifact_truncated_or_trailing_bytes'],
    ['truncated_json', (value) => canonicalizeTodoArtifact(value).slice(0, -8),
      'artifact_truncated_or_trailing_bytes'],
    ['schema_invalid', (value) => {
      const invalid = { ...value, schema: 'lattice.todo_structure_set.invalid' };
      return `${canonicalizeTodoArtifact(invalid)}\n`;
    }, 'schema_invalid'],
  ];
  for (const [name, encode, reason] of cases) {
    const fixture = await workspace(context);
    const set = structureSet(fixture);
    await mkdir(path.dirname(path.join(fixture.root, todoStructureSourceRef('main'))), {
      recursive: true,
    });
    await writeFile(path.join(fixture.root, todoStructureSourceRef('main')), encode(set));

    const status = runRootCli(fixture.root, ['status', '--json']);
    assert.equal(status.status, 1, `${name}: ${status.stderr}`);
    const statusError = parse(status.stdout);
    assert.equal(statusError.code, 'STRUCTURE_ARTIFACT_INVALID', name);
    const statusDiagnostic = statusError.detail.diagnostics.find(
      ({ plan_key }) => plan_key === 'main',
    );
    assert.equal(statusDiagnostic?.artifact_path, todoStructureSourceRef('main'), name);
    assert.equal(statusDiagnostic?.reason, reason, name);
    assert.equal(statusDiagnostic?.next_command,
      'lattice todo structure input --plan main --input <corrected-structure-set.json> --json', name);

    const verify = runCli(fixture.root, ['verify', '--json']);
    assert.equal(verify.status, 1, `${name}: ${verify.stdout}`);
    const verifyError = parse(verify.stderr);
    assert.equal(verifyError.code, 'STRUCTURE_ARTIFACT_INVALID', name);
    assert.equal(verifyError.detail.diagnostics[0].reason, reason, name);

    const inputRef = await writeDraft(fixture.root, set, `${name}-input.json`);
    const repaired = runCli(fixture.root, [
      'structure', 'input', '--plan', 'main', '--input', inputRef,
    ]);
    assert.equal(repaired.status, 0, `${name}: ${repaired.stderr}`);
    assert.equal(await readFile(path.join(fixture.root, todoStructureSourceRef('main')), 'utf8'),
      `${canonicalizeTodoArtifact(set)}\n`, name);
  }
});

test('valid binding後も同じplanned sourceのcanonical復旧だけを許す', async (context) => {
  const fixture = await workspace(context);
  const set = structureSet(fixture);
  const inputRef = await writeDraft(fixture.root, set);
  assert.equal(runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef,
  ]).status, 0);
  git(fixture.root, ['add', '.lattice/todo', inputRef]);
  git(fixture.root, ['commit', '--quiet', '-m', 'structure source']);
  assert.equal(runSensor(fixture.root, ['init', '.', '--json']).status, 0);
  const compile = runCli(fixture.root, [
    'structure', 'compile', '--plan', 'main', '--input', todoStructureSourceRef('main'),
  ]);
  assert.equal(compile.status, 0, compile.stderr);
  await writeFile(path.join(fixture.root, todoStructureSourceRef('main')),
    `${JSON.stringify(set, null, 2)}\n`);

  const execution = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef,
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(await readFile(path.join(fixture.root, todoStructureSourceRef('main')), 'utf8'),
    `${canonicalizeTodoArtifact(set)}\n`);

  const changed = structureSet(fixture);
  changed.tasks[0].planned.outcome = '別の成果へ変更する';
  changed.structure_set_digest = todoSelfDigest(changed, 'structure_set_digest');
  const changedRef = await writeDraft(fixture.root, changed, 'changed-structure.json');
  const rejected = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', changedRef,
  ]);
  assert.equal(rejected.status, 1);
  assert.equal(parse(rejected.stderr).code, 'STRUCTURE_ALREADY_ENABLED');
});

test('todo helpはstructure schema・dry-run・保存後も未有効であることを案内する', () => {
  const namespace = renderCliHelp(['todo', '--help']);
  assert.match(namespace, /structure --schema --json/u);
  assert.match(namespace, /structure input --plan <key> --input <file> --dry-run --json/u);
  assert.match(namespace, /structure compile --plan <key> --input <file>/u);
  assert.match(namespace, /structure realize --plan <key> --task <id> --input <file>/u);
  assert.match(namespace, /structure realize --plan <key> --task <id> \(--planned\|--realized/u);
  assert.match(namespace, /--realized <actual-structure\.json>/u);
  assert.match(namespace, /structure finalize --plan <key> --json/u);
  assert.match(namespace, /compile成功までは有効化しない/u);
  assert.equal(renderCliHelp(['todo', 'structure', '--help']),
    'Usage: lattice todo structure --schema --json | [--plan <key>] --json | input --plan <key> --input <file> [--dry-run --json] | compile --plan <key> --input <file> | realize --plan <key> --task <id> (--planned|--realized <actual-structure.json>) [--commit <HEAD|sha>]... | realize --plan <key> --task <id> --input <full-realization.json> | finalize --plan <key> --json\n');
});

test('structure readは未適用を空consistentへ丸めず、plan省略の曖昧さを拒否する', async (context) => {
  const fixture = await workspace(context);
  const missing = runCli(fixture.root, ['structure', '--plan', 'main', '--json']);
  assert.equal(missing.status, 0, missing.stderr);
  const projected = parse(missing.stdout);
  assert.equal(projected.coverage, 'missing');
  assert.equal(projected.verdict, null);
  assert.equal(projected.graph, null);

  const ambiguousFixture = await workspace(context, { planCount: 2 });
  const ambiguous = runCli(ambiguousFixture.root, ['structure', '--json']);
  assert.equal(ambiguous.status, 1);
  const error = parse(ambiguous.stderr);
  assert.equal(error.code, 'STRUCTURE_PLAN_AMBIGUOUS');
  assert.deepEqual(error.detail.plan_keys, ['main', 'other-1']);
  assert.equal(error.detail.next_action, 'rerun_with_plan_flag');
});

test('compileは実sensor・Git・DAGを結合し、readはsensor無しでfresh consistentを返す', async (context) => {
  const fixture = await workspace(context);
  const inputRef = await writeDraft(fixture.root, structureSet(fixture));
  const input = runCli(fixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inputRef,
  ]);
  assert.equal(input.status, 0, input.stderr);
  git(fixture.root, ['add', '.lattice/todo', inputRef]);
  git(fixture.root, ['commit', '--quiet', '-m', 'structure source']);

  const sensor = runSensor(fixture.root, ['init', '.', '--json']);
  assert.equal(sensor.status, 0, sensor.stderr);
  const compile = runCli(fixture.root, [
    'structure', 'compile', '--plan', 'main', '--input', '.lattice/todo/structure/main.json',
  ]);
  assert.equal(compile.status, 0, compile.stderr);
  const compiled = parse(compile.stdout);
  assert.equal(compiled.verdict, 'consistent');
  assert.equal(compiled.enabled, true);
  assert.match(compiled.artifact_ref, /structure\/compile\.json$/u);
  assert.match(compiled.binding_ref, /structure\/binding\.json$/u);

  await rm(path.join(fixture.root, '.lattice/sensor'), { recursive: true, force: true });
  const read = runCli(fixture.root, ['structure', '--plan', 'main', '--json']);
  assert.equal(read.status, 0, read.stderr);
  const projected = parse(read.stdout);
  assert.equal(projected.coverage, 'consistent');
  assert.equal(projected.freshness, 'fresh');
  assert.equal(projected.verdict, 'consistent');
  assert.equal(projected.enabled, true);

  await writeFile(path.join(fixture.root, 'README.md'), 'HEAD advanced\n');
  git(fixture.root, ['add', 'README.md']);
  git(fixture.root, ['commit', '--quiet', '-m', 'advance head']);
  const stale = parse(runCli(fixture.root, ['structure', '--plan', 'main', '--json']).stdout);
  assert.equal(stale.coverage, 'stale');
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.compiled_verdict, 'consistent');
  assert.equal(stale.verdict, null);
  assert.deepEqual(stale.stale_reasons, ['current_head_sha']);
});

test('compileとreadはunknown／inconsistentをmissingやconsistentと区別する', async (context) => {
  const unknownFixture = await workspace(context);
  const unknownSet = structureSet(unknownFixture);
  unknownSet.tasks[0].planned.code_anchors = [{
    anchor_id: 'baseline-only', effect: 'read', path: 'README.md',
    symbol: null, expected_at: 'baseline',
  }];
  unknownSet.structure_set_digest = todoSelfDigest(unknownSet, 'structure_set_digest');
  const unknownInput = await writeDraft(unknownFixture.root, unknownSet);
  assert.equal(runCli(unknownFixture.root, [
    'structure', 'input', '--plan', 'main', '--input', unknownInput,
  ]).status, 0);
  git(unknownFixture.root, ['add', '.lattice/todo', unknownInput]);
  git(unknownFixture.root, ['commit', '--quiet', '-m', 'unknown source']);
  const unknownCompile = runCli(unknownFixture.root, [
    'structure', 'compile', '--plan', 'main', '--input', '.lattice/todo/structure/main.json',
  ]);
  assert.equal(unknownCompile.status, 0, unknownCompile.stderr);
  assert.equal(parse(unknownCompile.stdout).verdict, 'unknown');
  assert.equal(parse(unknownCompile.stdout).enabled, false);
  const unknownRead = parse(runCli(unknownFixture.root,
    ['structure', '--plan', 'main', '--json']).stdout);
  assert.equal(unknownRead.coverage, 'unknown');
  assert.equal(unknownRead.verdict, 'unknown');
  assert.equal(unknownRead.enabled, false);

  const inconsistentFixture = await workspace(context);
  const invalidFlow = structureSet(inconsistentFixture);
  invalidFlow.tasks[0].planned.outputs = [{
    port_id: 'orphan-out', data_id: 'orphan-data',
    contract: {
      shape_id: 'orphan-shape', schema_ref: null, identity_fields: [],
      lifecycle: 'immutable_artifact', cardinality: 'one', compatible_shape_ids: [],
    },
    sinks: [],
  }];
  invalidFlow.structure_set_digest = todoSelfDigest(invalidFlow, 'structure_set_digest');
  const inconsistentInput = await writeDraft(inconsistentFixture.root, invalidFlow);
  assert.equal(runCli(inconsistentFixture.root, [
    'structure', 'input', '--plan', 'main', '--input', inconsistentInput,
  ]).status, 0);
  git(inconsistentFixture.root, ['add', '.lattice/todo', inconsistentInput]);
  git(inconsistentFixture.root, ['commit', '--quiet', '-m', 'inconsistent source']);
  const sensor = runSensor(inconsistentFixture.root, ['init', '.', '--json']);
  assert.equal(sensor.status, 0, sensor.stderr);
  const inconsistentCompile = runCli(inconsistentFixture.root, [
    'structure', 'compile', '--plan', 'main', '--input', '.lattice/todo/structure/main.json',
  ]);
  assert.equal(inconsistentCompile.status, 0, inconsistentCompile.stderr);
  const compiled = parse(inconsistentCompile.stdout);
  assert.equal(compiled.verdict, 'inconsistent');
  assert.equal(compiled.enabled, false);
  assert.equal(compiled.findings[0].code, 'STRUCTURE_OUTPUT_ORPHANED');
  const inconsistentRead = parse(runCli(inconsistentFixture.root,
    ['structure', '--plan', 'main', '--json']).stdout);
  assert.equal(inconsistentRead.coverage, 'inconsistent');
  assert.equal(inconsistentRead.verdict, 'inconsistent');
  assert.equal(inconsistentRead.enabled, false);
});
