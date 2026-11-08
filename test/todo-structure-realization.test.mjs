import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { renderTodoGanttForProject } from '../src/todo-cli.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  TODO_STRUCTURE_REALIZATION_SCHEMA,
  TODO_STRUCTURE_SET_SCHEMA,
  digestTodoStructureTransform,
} from '../src/todo-structure-contracts.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
  readTodoStore,
  readTodoStructureRealizationChain,
  readTodoStructureSource,
  todoStructureFinalizationRef,
  todoStructureRealizationRef,
} from '../src/todo-store.mjs';
import { readTodoStructureFinalizationState } from '../src/todo-structure-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin/lattice.mjs');
const NOW = '2026-08-11T14:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function run(root, args) {
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

const parse = (text) => JSON.parse(text.trim().split('\n').at(-1));
const todoTask = (taskId) => ({
  task_id: taskId, title: taskId, lane: 'main', narrative_ref: null, compile_binding: null,
});

function transform(taskId, overrides = {}) {
  return {
    outcome: `${taskId}が実装を更新する`, inputs: [], operations: [], outputs: [],
    code_anchors: [{
      anchor_id: 'implementation', effect: 'modify', path: 'src/shared.mjs',
      symbol: null, expected_at: 'current',
    }],
    failures: ['実装更新失敗'], first_live_e2e: `${taskId}の実装を一件実行する`,
    non_goals: ['並列可否判定'], ...overrides,
  };
}

async function fixture(context, { secondExcluded = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-structure-realize-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'fixture']);
  await writeFile(path.join(root, '.gitignore'), [
    '.lattice/sensor/', '.lattice/test-inputs/', '.lattice/evidence/', '',
  ].join('\n'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const value = 1;\n');
  git(root, ['add', '.gitignore', 'src/shared.mjs']);
  git(root, ['commit', '--quiet', '-m', 'baseline']);
  const baselineSha = git(root, ['rev-parse', 'HEAD']);
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1', repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [todoTask('T1'), todoTask('T2')], hard_dependencies: [], joins: [],
      }, genesis: { actor: ACTOR, recorded_at: NOW },
    }], now: NOW,
  });
  const store = await readTodoStore({ repoRoot: root, now: NOW });
  const set = {
    schema: TODO_STRUCTURE_SET_SCHEMA, project_id: 'project-1', plan_key: 'main',
    plan_version: 'v1', topology_digest: store.members[0].plan.topology_digest,
    profile: 'code-dataflow', baseline_sha: baselineSha, external_contracts: [],
    tasks: [
      { task_id: 'T1', applicability: 'graph', planned: transform('T1') },
      secondExcluded
        ? { task_id: 'T2', applicability: 'excluded', excluded_reason: '構造を変更しない確認工程' }
        : { task_id: 'T2', applicability: 'graph', planned: transform('T2') },
    ],
    structure_set_digest: '',
  };
  set.structure_set_digest = todoSelfDigest(set, 'structure_set_digest');
  await writeFile(path.join(root, 'structure.json'), `${JSON.stringify(set)}\n`);
  const input = run(root, [
    'structure', 'input', '--plan', 'main', '--input', 'structure.json',
  ]);
  assert.equal(input.status, 0, input.stderr);
  git(root, ['add', '.lattice/todo', 'structure.json']);
  git(root, ['commit', '--quiet', '-m', 'structure source']);
  const sensor = spawnSync(process.execPath, [CLI, 'sensor', 'init', '.', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(sensor.status, 0, sensor.stderr);
  const compiled = run(root, [
    'structure', 'compile', '--plan', 'main', '--input', '.lattice/todo/structure/main.json',
  ]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(parse(compiled.stdout).enabled, true);
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const value = 2;\n');
  git(root, ['add', 'src/shared.mjs']);
  git(root, ['commit', '--quiet', '-m', 'implementation']);
  return {
    root, set, implementationCommit: git(root, ['rev-parse', 'HEAD']),
  };
}

function realization(fixture, taskId, overrides = {}) {
  const planned = fixture.set.tasks.find(({ task_id: id }) => id === taskId).planned;
  const value = {
    schema: TODO_STRUCTURE_REALIZATION_SCHEMA,
    project_id: fixture.set.project_id, plan_key: fixture.set.plan_key,
    plan_version: fixture.set.plan_version, task_id: taskId,
    sequence: 1, previous_digest: null,
    structure_set_digest: fixture.set.structure_set_digest,
    planned_digest: digestTodoStructureTransform(planned),
    head_sha: fixture.implementationCommit,
    commit_oids: [fixture.implementationCommit], realized: structuredClone(planned),
    supersedes: null, actor: ACTOR, recorded_at: NOW, realization_digest: '',
    ...overrides,
  };
  value.realization_digest = todoSelfDigest(value, 'realization_digest');
  return value;
}

async function writeInput(root, name, value) {
  await writeFile(path.join(root, name), `${JSON.stringify(value)}\n`);
  return name;
}

async function evidenceFile(root, taskId) {
  const directory = path.join(root, '.lattice/evidence');
  await mkdir(directory, { recursive: true });
  const evidenceRef = `.lattice/evidence/${taskId}.txt`;
  const bytes = Buffer.from(`${taskId} evidence\n`, 'utf8');
  await writeFile(path.join(root, evidenceRef), bytes);
  const oid = execFileSync('git', ['hash-object', '-w', evidenceRef], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const descriptor = {
    evidence_id: `${taskId}-evidence`, repo_id: 'self', path: evidenceRef,
    git_blob_oid: oid, content_digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  };
  const descriptorRef = `.lattice/evidence/${taskId}.json`;
  await writeFile(path.join(root, descriptorRef), `${JSON.stringify(descriptor)}\n`);
  return descriptorRef;
}


test('todo startは対象taskのcanonical planned構造とrealize案内を直接返す', async (context) => {
  const data = await fixture(context);
  const started = run(data.root, [
    'start', '--plan', 'main', '--task', 'T1', '--parallel-frontier',
  ]);
  assert.equal(started.status, 0, started.stderr);
  const result = parse(started.stdout);
  assert.equal(result.schema, 'lattice.todo_mutation_result.v5');
  assert.deepEqual(result.structure_context, {
    status: 'available', enabled: true, freshness: 'stale',
    stale_reasons: ['current_head_sha'],
    structure_set_digest: data.set.structure_set_digest,
    task: data.set.tasks[0],
    next_actions: [
      'lattice todo structure realize --plan main --task T1 --planned',
      'lattice todo structure realize --plan main --task T1 --realized <actual-structure.json>',
    ],
  });
});

test('todo startはexcluded taskにも除外理由を構造コンテキストとして渡す', async (context) => {
  const data = await fixture(context, { secondExcluded: true });
  const started = run(data.root, [
    'start', '--plan', 'main', '--task', 'T2', '--parallel-frontier',
  ]);
  assert.equal(started.status, 0, started.stderr);
  const structure = parse(started.stdout).structure_context;
  assert.equal(structure.status, 'available');
  assert.deepEqual(structure.task, data.set.tasks[1]);
  assert.deepEqual(structure.next_actions, []);
});

test('plannedどおりの実装はrealization envelopeを機械生成してHEADへ束縛する', async (context) => {
  const data = await fixture(context);
  const result = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--planned',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parse(result.stdout).history_length, 1);

  const source = await readTodoStructureSource({ repoRoot: data.root, planKey: 'main' });
  const [record] = await readTodoStructureRealizationChain({
    repoRoot: data.root, structureSet: source, taskId: 'T1',
  });
  assert.equal(record.sequence, 1);
  assert.equal(record.previous_digest, null);
  assert.equal(record.supersedes, null);
  assert.equal(record.head_sha, data.implementationCommit);
  assert.deepEqual(record.commit_oids, [data.implementationCommit]);
  assert.deepEqual(record.actor, ACTOR);
  assert.deepEqual(record.realized, data.set.tasks[0].planned);
  assert.equal(record.planned_digest, digestTodoStructureTransform(data.set.tasks[0].planned));
  assert.equal(record.realization_digest, todoSelfDigest(record, 'realization_digest'));
});

test('実体構造だけを渡すとmetadataと訂正chainを機械生成する', async (context) => {
  const data = await fixture(context);
  const first = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--planned', '--commit', 'HEAD',
  ]);
  assert.equal(first.status, 0, first.stderr);
  const firstDigest = parse(first.stdout).realization_digest;

  await writeFile(path.join(data.root, 'src/shared.mjs'), 'export const value = 3;\n');
  git(data.root, ['add', 'src/shared.mjs']);
  git(data.root, ['commit', '--quiet', '-m', 'correct implementation']);
  const correctionCommit = git(data.root, ['rev-parse', 'HEAD']);
  const actual = transform('T1', { outcome: 'T1が実体に合わせた構造へ更新する' });
  const actualRef = await writeInput(data.root, 'actual-structure.json', actual);
  const corrected = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1',
    '--realized', actualRef, '--commit', correctionCommit,
  ]);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(parse(corrected.stdout).history_length, 2);

  const source = await readTodoStructureSource({ repoRoot: data.root, planKey: 'main' });
  const chain = await readTodoStructureRealizationChain({
    repoRoot: data.root, structureSet: source, taskId: 'T1',
  });
  assert.equal(chain[1].sequence, 2);
  assert.equal(chain[1].previous_digest, firstDigest);
  assert.equal(chain[1].supersedes, firstDigest);
  assert.equal(chain[1].head_sha, correctionCommit);
  assert.deepEqual(chain[1].commit_oids, [correctionCommit]);
  assert.deepEqual(chain[1].realized, actual);
});

test('不正な実体構造やcommit refはrealization chainを変更せずtyped拒否する', async (context) => {
  const data = await fixture(context);
  const invalidRef = await writeInput(data.root, 'invalid-actual.json', { outcome: '不足' });
  const invalid = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--realized', invalidRef,
  ]);
  assert.equal(invalid.status, 1);
  assert.equal(parse(invalid.stderr).code, 'INVALID_TODO_STRUCTURE_TRANSFORM');

  const badCommit = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1',
    '--planned', '--commit', 'not-a-commit',
  ]);
  assert.equal(badCommit.status, 1);
  assert.equal(parse(badCommit.stderr).code, 'STRUCTURE_REALIZATION_COMMIT_REF_INVALID');
  const source = await readTodoStructureSource({ repoRoot: data.root, planKey: 'main' });
  assert.deepEqual(await readTodoStructureRealizationChain({
    repoRoot: data.root, structureSet: source, taskId: 'T1',
  }), []);
});

test('realizeはstale planned・unreachable commitを無変更で拒否する', async (context) => {
  const data = await fixture(context);
  const stale = realization(data, 'T1', { planned_digest: 'a'.repeat(64) });
  const staleRef = await writeInput(data.root, 'stale.json', stale);
  const staleResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', staleRef,
  ]);
  assert.equal(staleResult.status, 1);
  assert.equal(parse(staleResult.stderr).detail.reason, 'planned_digest_mismatch');

  const unreachable = realization(data, 'T1', { commit_oids: ['f'.repeat(40)] });
  const unreachableRef = await writeInput(data.root, 'unreachable.json', unreachable);
  const unreachableResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', unreachableRef,
  ]);
  assert.equal(unreachableResult.status, 1);
  assert.equal(parse(unreachableResult.stderr).code, 'STRUCTURE_REALIZATION_COMMIT_UNREACHABLE');

  const unboundTransform = transform('T1');
  unboundTransform.code_anchors[0].path = 'src/not-changed.mjs';
  const unbound = realization(data, 'T1', { realized: unboundTransform });
  const unboundRef = await writeInput(data.root, 'unbound.json', unbound);
  const unboundResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', unboundRef,
  ]);
  assert.equal(unboundResult.status, 1);
  assert.equal(parse(unboundResult.stderr).code, 'STRUCTURE_REALIZATION_ANCHOR_UNBOUND');
  const source = await readTodoStructureSource({ repoRoot: data.root, planKey: 'main' });
  assert.deepEqual(await readTodoStructureRealizationChain({
    repoRoot: data.root, structureSet: source, taskId: 'T1',
  }), []);
});

test('他taskがclaim済みのcommitを再利用させない', async (context) => {
  const data = await fixture(context);
  const first = realization(data, 'T1');
  const firstRef = await writeInput(data.root, 'first.json', first);
  assert.equal(run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', firstRef,
  ]).status, 0);
  const other = realization(data, 'T2');
  const otherRef = await writeInput(data.root, 'other.json', other);
  const result = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T2', '--input', otherRef,
  ]);
  assert.equal(result.status, 1);
  assert.equal(parse(result.stderr).code, 'STRUCTURE_REALIZATION_COMMIT_CLAIMED');
});

test('訂正はsupersedesで追記し、readは全履歴・最新effective・planned差分を返す', async (context) => {
  const data = await fixture(context);
  const first = realization(data, 'T1');
  const firstRef = await writeInput(data.root, 'first.json', first);
  const firstResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', firstRef,
  ]);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(parse(firstResult.stdout).history_length, 1);

  const broken = realization(data, 'T1', {
    sequence: 2, previous_digest: first.realization_digest,
    supersedes: 'e'.repeat(64),
  });
  const brokenRef = await writeInput(data.root, 'broken.json', broken);
  const brokenResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', brokenRef,
  ]);
  assert.equal(brokenResult.status, 1);
  assert.equal(parse(brokenResult.stderr).detail.reason, 'supersedes_target_missing');

  const correctedTransform = transform('T1', { outcome: 'T1が訂正版の実装を更新する' });
  const corrected = realization(data, 'T1', {
    sequence: 2, previous_digest: first.realization_digest,
    supersedes: first.realization_digest, realized: correctedTransform,
    recorded_at: '2026-08-11T14:01:00.000Z',
  });
  const correctedRef = await writeInput(data.root, 'corrected.json', corrected);
  const correctedResult = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--input', correctedRef,
  ]);
  assert.equal(correctedResult.status, 0, correctedResult.stderr);
  assert.equal(parse(correctedResult.stdout).history_length, 2);
  assert.deepEqual(parse(correctedResult.stdout).effective.changed_fields, ['outcome']);

  const projected = run(data.root, ['structure', '--plan', 'main', '--json']);
  assert.equal(projected.status, 0, projected.stderr);
  const body = parse(projected.stdout);
  assert.equal(body.effective.history.length, 2);
  assert.equal(body.effective.tasks[0].form, 'realized');
  assert.equal(body.effective.tasks[0].realization_digest, corrected.realization_digest);
  assert.deepEqual(body.effective.tasks[0].changed_fields, ['outcome']);
  assert.equal(body.effective.tasks[1].form, 'planned');
});

test('doneもterminal closeもrealization/finalization無しで通り、finalization状態はstatusに残る', async (context) => {
  const data = await fixture(context, { secondExcluded: true });
  assert.equal(run(data.root, [
    'start', '--plan', 'main', '--task', 'T1', '--parallel-frontier',
  ]).status, 0);
  assert.equal(run(data.root, [
    'start', '--plan', 'main', '--task', 'T2',
  ]).status, 0);
  const t1Evidence = await evidenceFile(data.root, 'T1');
  assert.equal(run(data.root, [
    'done', '--plan', 'main', '--task', 'T1', '--evidence', t1Evidence,
  ]).status, 0);
  const t2Evidence = await evidenceFile(data.root, 'T2');
  const excludedDone = run(data.root, [
    'done', '--plan', 'main', '--task', 'T2', '--evidence', t2Evidence,
  ]);
  assert.equal(excludedDone.status, 0, excludedDone.stderr);

  const pending = run(data.root, ['status']);
  assert.equal(pending.status, 0, pending.stderr);
  assert.deepEqual(parse(pending.stdout).structure_finalization_pending, [{
    plan_key: 'main', status: 'missing', reason: 'finalization_missing', stale_reasons: [],
    next_commands: ['lattice todo structure finalize --plan main --json'],
  }]);
  const auditPending = run(data.root, ['phase', 'status', '--plan', 'main']);
  assert.equal(auditPending.status, 0, auditPending.stderr);
  assert.deepEqual(parse(auditPending.stdout).structure_finalization, {
    enabled: true, required: true, status: 'missing', reason: 'finalization_missing',
    stale_reasons: [], next_command: 'lattice todo structure finalize --plan main --json',
  });
  assert.match(parse(auditPending.stdout).phases[0].guidance, /structure finalize/u);
  const closedWithoutFinalization = run(data.root, [
    'phase', 'close-unaudited', '--plan', 'main', '--phase', 'terminal-audit',
    '--reason', 'fixture close',
  ]);
  assert.equal(closedWithoutFinalization.status, 0, closedWithoutFinalization.stderr);

  const realized = run(data.root, [
    'structure', 'realize', '--plan', 'main', '--task', 'T1', '--planned',
  ]);
  assert.equal(realized.status, 0, realized.stderr);
  git(data.root, ['add', '.lattice/todo']);
  git(data.root, ['commit', '--quiet', '-m', 'complete todo store']);
  const sensor = spawnSync(process.execPath, [CLI, 'sensor', 'sync', '.', '--json'], {
    cwd: data.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(sensor.status, 0, sensor.stderr);
  const finalized = run(data.root, ['structure', 'finalize', '--plan', 'main', '--json']);
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.equal(parse(finalized.stdout).verdict, 'consistent');
  assert.equal(parse(finalized.stdout).finalized, true);
  const dashboard = await renderTodoGanttForProject({
    repoRoot: data.root, displayName: 'fixture', scope: 'all',
  });
  assert.match(dashboard.rendered.html, /data-show-structure>構造検査/u);
  assert.match(dashboard.rendered.html, /data-right-panel="structure" hidden/u);
  assert.match(dashboard.rendered.html, /<code>main<\/code><span class="structure-verdict verdict-consistent">consistent/u);
  assert.match(dashboard.rendered.html, /finalization: fresh/u);
  assert.match(dashboard.rendered.html, /data-structure-node-ref="task:T1"/u);
  assert.match(dashboard.rendered.html, new RegExp(`data-structure-node-ref="commit:${data.implementationCommit}"`, 'u'));
  const clear = run(data.root, ['status']);
  assert.equal(clear.status, 0, clear.stderr);
  assert.deepEqual(parse(clear.stdout).structure_finalization_pending, []);

  git(data.root, ['commit', '--quiet', '--allow-empty', '-m', 'move head']);
  const stale = await readTodoStructureFinalizationState({
    repoRoot: data.root, planKey: 'main',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.required, false);
  assert.deepEqual(stale.stale_reasons, ['current_head_sha']);
});
