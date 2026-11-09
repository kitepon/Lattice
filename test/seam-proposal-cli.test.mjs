import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { compileSeamProposalArtifact } from '../src/seam-proposal.mjs';
import {
  SEAM_PROPOSAL_PROJECTION_SCHEMA,
  validateSeamProposal,
  validateSeamProposalProjection,
} from '../src/seam-proposal-contracts.mjs';
import {
  TODO_INDEPENDENCE_SCHEMA,
  TODO_WITNESS_SET_SCHEMA,
} from '../src/todo-independence-contracts.mjs';
import {
  SEAM_PROPOSAL_GUIDANCE_CODES,
  selectSeamProposalGuidance,
} from '../src/todo-independence-guidance.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoIndependenceArtifact,
  readTodoSeamProposalArtifact,
  readTodoStore,
  todoSeamProposalRef,
  writeTodoIndependenceArtifact,
  writeTodoSeamProposalArtifact,
  writeTodoWitnessSet,
} from '../src/todo-store.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-26T00:00:00.000Z';

const task = (taskId) => ({
  task_id: taskId,
  title: taskId,
  lane: 'main',
  narrative_ref: null,
  compile_binding: null,
});

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const planFor = (tasks) => ({
  plan: {
    schema: 'lattice.todo_plan.v1',
    project_id: 'project-1',
    plan_key: 'main',
    plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: tasks.map(task),
    hard_dependencies: [],
    joins: [],
  },
  genesis: { actor: ACTOR, recorded_at: NOW },
});

async function workspace(context, { tasks = ['T1', 'T2'] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-seam-proposal-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'fixture']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), '.lattice/\n');
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const shared = 1;\n');
  await Promise.all(tasks.map((taskId) => writeFile(
    path.join(root, `test/${taskId.toLowerCase()}.test.mjs`),
    `import test from 'node:test';\nimport '../src/shared.mjs';\ntest('${taskId}', () => {});\n`,
  )));
  git(root, ['add', '.gitignore', 'README.md', 'src', 'test']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [planFor(tasks)],
    now: NOW,
  });
  return root;
}

function run(root, args) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    LATTICE_DASHBOARD_AUTOSTART: '0',
  };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
}

const parse = (text) => JSON.parse(text.trim().split('\n').at(-1));

function witnessFor(taskIds) {
  const witnessSet = {
    schema: TODO_WITNESS_SET_SCHEMA,
    project_id: 'project-1',
    plan_key: 'main',
    capacity: { executors: taskIds.length },
    sensor_query_set: {
      queries: [
        { id: 'q-affected-shared', operation: 'affected', target: 'src/shared.mjs' },
        { id: 'q-status', operation: 'status' },
      ],
    },
    manual_witness: Object.fromEntries(taskIds.map((taskId) => [taskId, {
      owns: [{ kind: 'path', target: 'src/shared.mjs' }],
      reads: [],
      writes: ['src/shared.mjs'],
      resources: [],
      state_effects: [],
      sensor_provenance: {
        queries: [{
          query_id: 'q-affected-shared',
          expect: { kind: 'affected', path: 'src/shared.mjs' },
        }],
      },
      affected_tests: taskIds.map((id) => `test/${id.toLowerCase()}.test.mjs`),
      unknowns: [],
    }])),
    witness_set_digest: '',
  };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  return witnessSet;
}

function independenceFor({
  plan,
  witnessSet,
  head,
  extraResource = false,
  compiledAt = NOW,
}) {
  const taskIds = Object.keys(witnessSet.manual_witness).sort();
  const pairwise = [];
  for (let left = 0; left < taskIds.length; left += 1) {
    for (let right = left + 1; right < taskIds.length; right += 1) {
      pairwise.push({
        task_ids: [taskIds[left], taskIds[right]],
        resource_id: 'own-path-shared',
      });
    }
  }
  if (extraResource) {
    pairwise.push({ task_ids: ['T1', 'T2'], resource_id: 'own-path-other' });
  }
  pairwise.sort((left, right) => (
    `${left.task_ids[0]}\0${left.task_ids[1]}\0${left.resource_id}`
      .localeCompare(`${right.task_ids[0]}\0${right.task_ids[1]}\0${right.resource_id}`)
  ));
  const artifact = {
    schema: TODO_INDEPENDENCE_SCHEMA,
    project_id: plan.project_id,
    plan_key: plan.plan_key,
    plan_version: plan.plan_version,
    topology_digest: plan.topology_digest,
    base_sha: head,
    witness_set_digest: witnessSet.witness_set_digest,
    compiled_at: compiledAt,
    task_ids: taskIds,
    task_boundaries: taskIds.map((taskId) => ({
      task_id: taskId,
      paths: ['src/shared.mjs'],
    })),
    conflict_resources: [
      ...(extraResource
        ? [{ resource_id: 'own-path-other', kind: 'path', target: 'src/other.mjs' }]
        : []),
      { resource_id: 'own-path-shared', kind: 'path', target: 'src/shared.mjs' },
    ],
    conflicts: pairwise,
    precedences: [],
    unknowns: [],
    wave_plan: {
      waves: taskIds.map((taskId) => ({ task_ids: [taskId] })),
      minimum_feasible_waves: taskIds.length,
    },
    outcome: 'compiled',
    result_digest: '',
  };
  artifact.scope_expanded = artifact.scope_expanded ?? (artifact.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  artifact.result_digest = todoSelfDigest(artifact, 'result_digest');
  return artifact;
}

async function recordedFixture(root, { taskIds = ['T1', 'T2'], extraResource = false } = {}) {
  const store = await readTodoStore({ repoRoot: root });
  const plan = store.members[0].plan;
  const witnessSet = witnessFor(taskIds);
  const independenceArtifact = independenceFor({
    plan,
    witnessSet,
    head: git(root, ['rev-parse', 'HEAD']),
    extraResource,
  });
  await writeTodoWitnessSet({ repoRoot: root, witnessSet });
  await writeTodoIndependenceArtifact({ repoRoot: root, artifact: independenceArtifact, now: NOW });
  const seamArtifact = compileSeamProposalArtifact({
    independenceArtifact,
    witnessSet,
    plan,
    compiledAt: NOW,
    sensorEvidence: {},
    evidence: {},
    rawCollected: {},
  });
  await writeTodoSeamProposalArtifact({ repoRoot: root, artifact: seamArtifact, now: NOW });
  return {
    plan, witnessSet, independenceArtifact, seamArtifact,
  };
}

test('記録が無いread入口はmissingとguidanceを返し、sensor初期化を要求しない', async (context) => {
  const root = await workspace(context);
  const result = run(root, ['todo', 'seam-proposal', '--plan', 'main', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const projection = parse(result.stdout);
  assert.equal(projection.schema, SEAM_PROPOSAL_PROJECTION_SCHEMA);
  assert.equal(validateSeamProposalProjection(projection), true);
  assert.equal(projection.coverage, 'missing');
  assert.equal(projection.component_count, null);
  assert.equal(projection.conflict_resource_count, null);
  assert.deepEqual(projection.components, []);
  assert.equal(projection.guidance.code, 'seam_proposal_unrecorded');
  assert.equal(projection.guidance.next_action, `lattice todo seam-proposal compile --plan ${projection.plan_key}`);
  assert.match(projection.guidance.message, /記録が存在しない/u);
});

test('projection validatorはshape違反・coverage矛盾・digest不一致を拒否する',
  async (context) => {
    const root = await workspace(context);
    const projection = parse(run(root, [
      'todo', 'seam-proposal', '--plan', 'main', '--json',
    ]).stdout);

    const unexpected = structuredClone(projection);
    unexpected.extra = true;
    unexpected.scope_expanded = unexpected.scope_expanded ?? (unexpected.task_ids ?? []).map((taskId) => ({
      task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
      path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
    }));
    unexpected.result_digest = todoSelfDigest(unexpected, 'result_digest');
    assert.equal(validateSeamProposalProjection(unexpected), false);

    const contradiction = structuredClone(projection);
    contradiction.coverage = 'verified';
    contradiction.guidance = selectSeamProposalGuidance({ coverage: 'verified' });
    contradiction.scope_expanded = contradiction.scope_expanded ?? (contradiction.task_ids ?? []).map((taskId) => ({
      task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
      path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
    }));
    contradiction.result_digest = todoSelfDigest(contradiction, 'result_digest');
    assert.equal(validateSeamProposalProjection(contradiction), false);

    const digestMismatch = structuredClone(projection);
    digestMismatch.result_digest = '0'.repeat(64);
    assert.equal(validateSeamProposalProjection(digestMismatch), false);
  });

test('projection validatorは載っているunknownと噛み合わない案内を拒否する',
  async (context) => {
    const root = await workspace(context);
    await recordedFixture(root);
    const projection = parse(run(root, [
      'todo', 'seam-proposal', '--plan', 'main', '--json',
    ]).stdout);
    assert.equal(projection.coverage, 'verified');
    assert.ok(projection.components.some(({ unknowns }) => unknowns.length > 0),
      'fixtureに束縛できなかったcomponentが無い');

    // shapeは正しく、codeもenumにある。噛み合っていないのは状況との対応だけ。
    const mismatched = structuredClone(projection);
    mismatched.guidance = selectSeamProposalGuidance({ coverage: 'verified' });
    mismatched.scope_expanded = mismatched.scope_expanded ?? (mismatched.task_ids ?? []).map((taskId) => ({
      task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
      path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
    }));
    mismatched.result_digest = todoSelfDigest(mismatched, 'result_digest');
    assert.equal(mismatched.guidance.code, 'seam_proposal_verified');
    assert.equal(validateSeamProposalProjection(mismatched), false);

    // 生成側が載せた案内はそのまま通る。
    assert.equal(validateSeamProposalProjection(projection), true);
  });

test('seam proposalの全codeはguidance単一正本から説明と次の一歩を得る', () => {
  // coverage（記録の鮮度）から出るcodeと、束縛失敗のunknownから出るcodeの2系統がある。
  const situationByCode = new Map([
    ['seam_proposal_unrecorded', { coverage: 'missing' }],
    ['seam_proposal_superseded', { coverage: 'superseded' }],
    ['seam_proposal_stale', { coverage: 'stale' }],
    ['seam_proposal_binding_overlap', {
      coverage: 'verified', unknownKinds: ['concern_anchor_overlap'],
    }],
    ['seam_proposal_binding_outside_resource', {
      coverage: 'verified', unknownKinds: ['concern_anchor_outside_resource'],
    }],
    ['seam_proposal_binding_symbol_unresolved', {
      coverage: 'verified', unknownKinds: ['concern_anchor_unresolved'],
    }],
    ['seam_proposal_binding_resource_unresolved', {
      coverage: 'verified', unknownKinds: ['concern_anchor_resource_unresolved'],
    }],
    ['seam_proposal_binding_ambiguous', {
      coverage: 'verified', unknownKinds: ['semantic_owner_binding_ambiguous'],
    }],
    ['seam_proposal_binding_missing', {
      coverage: 'verified', unknownKinds: ['semantic_owner_binding_missing'],
    }],
    ['seam_proposal_verified', { coverage: 'verified' }],
  ]);
  // 到達できないcodeを増やさない。codeを足したら、それが出る状況もここへ書く。
  assert.deepEqual([...situationByCode.keys()], [...SEAM_PROPOSAL_GUIDANCE_CODES]);
  for (const [code, situation] of situationByCode) {
    const guidance = selectSeamProposalGuidance(situation);
    assert.equal(guidance.code, code);
    assert.ok(guidance.message.length > 0);
    assert.ok(guidance.next_action.length > 0);
    assert.doesNotMatch(guidance.message, /すべき|しなさい|してください|must|should/u);
  }
});

test('producerは3-task同一resourceと複数resourceを一つの連結componentへ集約する',
  async (context) => {
    const root = await workspace(context, { tasks: ['T1', 'T2', 'T3'] });
    const store = await readTodoStore({ repoRoot: root });
    const plan = store.members[0].plan;
    const witnessSet = witnessFor(['T1', 'T2', 'T3']);
    const independenceArtifact = independenceFor({
      plan,
      witnessSet,
      head: git(root, ['rev-parse', 'HEAD']),
      extraResource: true,
    });

    const artifact = compileSeamProposalArtifact({
      independenceArtifact,
      witnessSet,
      plan,
      compiledAt: NOW,
      sensorEvidence: {},
      evidence: {},
      rawCollected: {},
    });

    assert.equal(validateSeamProposal(artifact), true);
    assert.equal(artifact.decisions.length, 1);
    assert.deepEqual(artifact.decisions[0].task_ids, ['T1', 'T2', 'T3']);
    assert.equal(artifact.decisions[0].conflicts.length, 2);
    assert.equal(artifact.decisions[0].conflicts
      .find(({ resource_id: id }) => id === 'own-path-shared').task_pairs.length, 3);
    assert.deepEqual(
      new Set(artifact.decisions[0].conflicts.map(({ resource_id: id }) => id)),
      new Set(['own-path-other', 'own-path-shared']),
    );
  });

test('storeはproposalをplan versionへ並置し、read投影はexact targetを返す', async (context) => {
  const root = await workspace(context);
  const { seamArtifact } = await recordedFixture(root);
  const stored = await readTodoSeamProposalArtifact({ repoRoot: root, planKey: 'main' });

  assert.deepEqual(stored, seamArtifact);
  assert.equal(todoSeamProposalRef('main', 'v1'),
    '.lattice/todo/plans/main/v1/seam-proposal.json');
  const result = run(root, ['todo', 'seam-proposal', '--plan', 'main', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const projection = parse(result.stdout);
  assert.equal(validateSeamProposalProjection(projection), true);
  assert.equal(projection.coverage, 'verified');
  assert.equal(projection.component_count, 1);
  assert.equal(projection.conflict_resource_count, 1);
  assert.equal(projection.components[0].conflicts[0].target, 'src/shared.mjs');
  assert.equal(projection.components[0].conflicts[0].kind, 'path');
  // 記録は現在と一致しているが、componentは所有者へ束縛できていない。鮮度だけを述べると
  // 「一致している」で終わり、束縛できなかった事実と次の一歩が読み手へ届かない。
  assert.equal(projection.guidance.code, 'seam_proposal_binding_missing');
  assert.equal(projection.guidance.next_action,
    `lattice todo independence compile --plan ${projection.plan_key} --input <file>`);

  const duplicate = structuredClone(projection);
  duplicate.components.push(structuredClone(duplicate.components[0]));
  duplicate.component_count = 2;
  duplicate.conflict_resource_count = 2;
  duplicate.scope_expanded = duplicate.scope_expanded ?? (duplicate.task_ids ?? []).map((taskId) => ({
    task_id: taskId, compared_witness_digest: null, first_seen_path_count: 0,
    path_count: 0, added_paths: [], removed_paths: [], growth_events: 0, gate_shape: false,
  }));
  duplicate.result_digest = todoSelfDigest(duplicate, 'result_digest');
  assert.equal(validateSeamProposalProjection(duplicate), false);
});

test('HEAD進行はstale、independence再compileはsupersededとして区別する', async (context) => {
  const staleRoot = await workspace(context);
  await recordedFixture(staleRoot);
  await writeFile(path.join(staleRoot, 'README.md'), 'fixture changed\n');
  git(staleRoot, ['add', 'README.md']);
  git(staleRoot, ['commit', '--quiet', '-m', 'advance']);
  const stale = parse(run(staleRoot, [
    'todo', 'seam-proposal', '--plan', 'main', '--json',
  ]).stdout);
  assert.equal(stale.coverage, 'stale');
  assert.equal(stale.guidance.code, 'seam_proposal_stale');

  const supersededRoot = await workspace(context);
  const fixture = await recordedFixture(supersededRoot);
  const replacement = independenceFor({
    plan: fixture.plan,
    witnessSet: fixture.witnessSet,
    head: fixture.independenceArtifact.base_sha,
    compiledAt: '2026-07-26T00:00:01.000Z',
  });
  await writeTodoIndependenceArtifact({
    repoRoot: supersededRoot,
    artifact: replacement,
    now: '2026-07-26T00:00:01.000Z',
  });
  const superseded = parse(run(supersededRoot, [
    'todo', 'seam-proposal', '--plan', 'main', '--json',
  ]).stdout);
  assert.equal(superseded.coverage, 'superseded');
  assert.equal(superseded.guidance.code, 'seam_proposal_superseded');
});

test('dirty worktreeではseam proposal compileをworktreeの汚れだけでは拒否しない', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'dirty.txt'), 'dirty\n');
  const result = run(root, ['todo', 'seam-proposal', 'compile', '--plan', 'main']);
  assert.equal(result.status, 1);
  const error = parse(result.stderr);
  assert.notEqual(error.code, 'INDEPENDENCE_WORKTREE_DIRTY');
});

test('compile入口は実sensorでindependence記録からartifactを生成し、readできる',
  { timeout: 120_000 }, async (context) => {
    const root = await workspace(context);
    const witnessSet = witnessFor(['T1', 'T2']);
    await writeFile(path.join(root, 'witness.json'), `${JSON.stringify(witnessSet)}\n`);
    git(root, ['add', 'witness.json']);
    git(root, ['commit', '--quiet', '-m', 'witness']);
    await writeTodoWitnessSet({ repoRoot: root, witnessSet });

    const initialized = run(root, ['sensor', 'init', '.', '--json']);
    assert.equal(initialized.status, 0, initialized.stderr);
    const independence = run(root, [
      'todo', 'independence', 'compile', '--plan', 'main', '--input', 'witness.json',
    ]);
    assert.equal(independence.status, 0, independence.stderr);
    const independenceResult = parse(independence.stdout);
    const independenceRecord = await readTodoIndependenceArtifact({
      repoRoot: root, planKey: 'main',
    });
    assert.equal(independenceResult.conflict_count, 1,
      JSON.stringify(independenceRecord.unknowns));

    const compiled = run(root, ['todo', 'seam-proposal', 'compile', '--plan', 'main']);
    assert.equal(compiled.status, 0, compiled.stderr);
    const compileResult = parse(compiled.stdout);
    assert.equal(compileResult.schema, 'lattice.seam_proposal_compile_result.v1');
    assert.equal(compileResult.component_count, 1);
    assert.equal(compileResult.conflict_resource_count, 1);
    assert.equal(compileResult.artifact_ref,
      '.lattice/todo/plans/main/v1/seam-proposal.json');

    const read = run(root, ['todo', 'seam-proposal', '--plan', 'main', '--json']);
    assert.equal(read.status, 0, read.stderr);
    const projection = parse(read.stdout);
    assert.equal(projection.coverage, 'verified');
    assert.equal(projection.components[0].conflicts[0].target, 'src/shared.mjs');
  });

test('helpとusageはbare noun readと配下compileを同じnamespaceに載せる', async (context) => {
  const root = await workspace(context);
  const namespace = run(root, ['todo', '--help']);
  assert.equal(namespace.status, 0);
  assert.match(namespace.stdout, /seam-proposal \[--plan <key>\] \[--json\]/u);
  assert.match(namespace.stdout, /seam-proposal compile --plan <key>/u);

  const subcommand = run(root, ['todo', 'seam-proposal', '--help']);
  assert.equal(subcommand.status, 0);
  assert.equal(subcommand.stdout,
    'Usage: lattice todo seam-proposal [--plan <key>] [--json] | compile --plan <key>\n');

  for (const args of [
    ['todo', 'seam-proposal', '--plan'],
    ['todo', 'seam-proposal', 'compile'],
    ['todo', 'seam-proposal', 'compile', '--plan'],
  ]) {
    const result = run(root, args);
    assert.equal(result.status, 2, `expected usage failure for ${args.join(' ')}`);
  }
});
