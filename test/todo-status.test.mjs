import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, readdir, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';
import {
  TODO_STATUS_CAPTURE_LIMIT,
  TODO_STATUS_LABEL_LIMIT,
  TODO_STATUS_LIST_LIMIT,
  TODO_STATUS_REASON_LIMIT,
  TodoStatusProjectionError,
  isTodoStatusBoundedText,
  projectTodoStatus,
  validateTodoStatusResult,
} from '../src/todo-status.mjs';
import {
  createTodoStoreWriter,
  initializeTodoStore,
} from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-18T00:00:00.000Z';

function task(taskId, title = taskId) {
  return { task_id: taskId, title, lane: 'main', narrative_ref: null, compile_binding: null };
}

function ref(taskId, planKey = 'main', projectId = 'project-1') {
  return { project_id: projectId, plan_key: planKey, task_id: taskId };
}

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-status-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
        predecessor_plan_digest: null,
        tasks: [
          task('A', 'Active work'), task('B', 'Blocked work'), task('C', 'Ready work'),
          task('D', 'Waiting work'), task('E', 'Completed prerequisite'),
        ],
        hard_dependencies: [
          { from: ref('A'), to: ref('D') },
          { from: ref('E'), to: ref('C') },
        ],
        joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  const writer = createTodoStoreWriter({ caller: 'g5-authoring' });
  const append = (taskId, kind, recordedAt, payload) => appendTodoEvent({
    repoRoot: root, writer, planKey: 'main', now: recordedAt,
    event: { task_id: taskId, kind, actor: ACTOR, recorded_at: recordedAt, payload },
  });
  await append('A', 'start', '2026-07-18T00:01:00.000Z', { override_reason: null });
  await append('B', 'start', '2026-07-18T00:02:00.000Z', { override_reason: null });
  await append('B', 'block', '2026-07-18T00:03:00.000Z', { reason: 'Waiting for owner approval' });
  await append('E', 'start', '2026-07-18T00:04:00.000Z', { override_reason: null });
  const evidenceBytes = Buffer.from('status fixture evidence\n');
  const object = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: root, input: evidenceBytes, encoding: 'utf8',
  });
  assert.equal(object.status, 0, object.stderr);
  await append('E', 'done', '2026-07-18T00:05:00.000Z', { evidence: {
    evidence_id: 'status-fixture', repo_id: 'self', path: 'evidence.txt',
    git_blob_oid: object.stdout.trim(),
    content_digest: createHash('sha256').update(evidenceBytes).digest('hex'),
    media_type: 'text/plain', anchor_digest: null,
  } });
  return root;
}

function runStatus(root) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, [CLI, 'todo', 'status'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(result.error, undefined);
  return result;
}

async function storeDigest(root) {
  const entries = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const refValue = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), refValue);
      else entries.push([refValue, await readFile(path.join(directory, entry.name))]);
    }
  }
  await visit(path.join(root, '.lattice', 'todo'));
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const hash = createHash('sha256');
  for (const [refValue, bytes] of entries) hash.update(refValue).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

function assertExactKeys(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

test('todo statusはactive/next-ready/blockedを混在投影しstore bytesを変えない', async (context) => {
  const root = await workspace(context);
  const before = await storeDigest(root);
  const execution = runStatus(root);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stderr, '');
  assert.match(execution.stdout, /^\{.*\}\n$/u);
  assert.equal(await storeDigest(root), before);
  const result = JSON.parse(execution.stdout);
  assertExactKeys(result, [
    'schema', 'project_id', 'active_set', 'next_ready', 'dispatch_frontier',
    'blocked', 'audit_pending', 'structure_finalization_pending', 'plan_notes',
    'coordination', 'parallel_candidates',
    'member_heads', 'result_digest',
  ]);
  assert.equal(result.schema, 'lattice.todo_status_result.v7');
  // このstoreはまだ全taskがdoneではない(Phaseはactive)ので監査待ちは無い。
  assert.deepEqual(result.audit_pending, []);
  assert.deepEqual(result.active_set, [{
    plan_key: 'main', task_id: 'A', label: 'Active work', unmet_dependencies: [],
  }]);
  assert.deepEqual(result.next_ready, [{ plan_key: 'main', task_id: 'C', label: 'Ready work', done_condition: null }]);
  assert.deepEqual(result.dispatch_frontier, {
    schema: 'lattice.todo_dispatch_frontier.v1',
    selection_source: 'next_ready',
    policy: 'all_ready_parallel_by_default',
    recommended_parallelism: 1,
    subset_requires_reason: false,
    parallel_start_flag: '--parallel-frontier',
    frontier_digest: result.dispatch_frontier.frontier_digest,
  });
  assert.match(result.dispatch_frontier.frontier_digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.blocked, [{
    plan_key: 'main', task_id: 'B', reason: 'Waiting for owner approval',
  }]);
  assert.equal(result.member_heads.length, 1);
  assertExactKeys(result.member_heads[0], [
    'plan_key', 'plan_version', 'through_sequence', 'journal_head_digest',
    'reconciliation_state', 'revision_digest', 'reconciliation_digest',
  ]);
  assert.equal(result.member_heads[0].plan_key, 'main');
  assert.equal(result.member_heads[0].plan_version, 'v1');
  assert.equal(result.member_heads[0].through_sequence, 5);
  assert.equal(result.member_heads[0].reconciliation_state, 'registered_unreconciled');
  assert.equal(result.member_heads[0].revision_digest, null);
  assert.match(result.member_heads[0].journal_head_digest, /^[0-9a-f]{64}$/u);
  assert.match(result.member_heads[0].reconciliation_digest, /^[0-9a-f]{64}$/u);
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
  assert.equal(validateTodoStatusResult(result), true);
});

test('依存未達のin-progressはactiveのまま未完predecessorを明示する', async (context) => {
  const root = await workspace(context);
  await appendTodoEvent({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g5-authoring' }),
    planKey: 'main',
    now: '2026-07-18T00:06:00.000Z',
    event: {
      task_id: 'D', kind: 'start', actor: ACTOR, recorded_at: '2026-07-18T00:06:00.000Z',
      payload: { override_reason: 'Dependency state imported from existing work' },
    },
  });

  const execution = runStatus(root);
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.deepEqual(result.active_set, [
    { plan_key: 'main', task_id: 'A', label: 'Active work', unmet_dependencies: [] },
    {
      plan_key: 'main', task_id: 'D', label: 'Waiting work',
      unmet_dependencies: [{ plan_key: 'main', task_id: 'A' }],
    },
  ]);
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
  assert.equal(validateTodoStatusResult(result), true);
});

test('空store projectionは全list空の固定digest resultを返す', () => {
  const result = projectTodoStatus({
    schema: 'lattice.todo_store_read.v1', project_id: 'empty-project', members: [],
  }, { parallelCandidates: [], planNotes: [] });
  assert.deepEqual(result.active_set, []);
  assert.deepEqual(result.next_ready, []);
  assert.equal(result.dispatch_frontier.recommended_parallelism, 0);
  assert.equal(result.dispatch_frontier.subset_requires_reason, false);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.member_heads, []);
  assert.equal(result.result_digest, todoSelfDigest(result, 'result_digest'));
  assert.equal(validateTodoStatusResult(result), true);
});

test('空のtodo store directoryはtyped errorでfail closedしbytesを変えない', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-todo-status-empty-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await mkdir(path.join(root, '.lattice', 'todo'), { recursive: true });
  const before = await storeDigest(root);
  const execution = runStatus(root);
  assert.equal(execution.status, 1);
  assert.equal(execution.stdout, '');
  assert.match(execution.stderr, /^\{.*\}\n$/u);
  assert.deepEqual(JSON.parse(execution.stderr), {
    schema: 'lattice.cli_error.v2',
    code: 'STORE_INCONSISTENT',
    message: 'artifact_missing',
    detail: { reason: 'artifact_missing', ref: '.lattice/todo/manifest.json' },
  });
  assert.equal(await storeDigest(root), before);
});

function syntheticReadModel(activeCount) {
  const members = [];
  for (let offset = 0; offset < activeCount; offset += 500) {
    const memberIndex = members.length;
    const planKey = `p${String(memberIndex).padStart(3, '0')}`;
    const count = Math.min(500, activeCount - offset);
    const tasks = Array.from({ length: count }, (_, index) => task(`t${String(index).padStart(3, '0')}`, 'x'));
    members.push({
      descriptor: { plan_key: planKey },
      phases: [], // Canonical projected view; synthetic fixtures need no snapshot cache.
      plan: {
        project_id: 'scale-project', plan_key: planKey, plan_version: 'v1',
        plan_digest: 'c'.repeat(64), tasks,
        hard_dependencies: [], joins: [],
      },
      tasks: tasks.map(({ task_id: taskId }) => ({
        task_id: taskId, status: 'in-progress', blocked_reason: null,
      })),
      journal: { events: [{ schema: 'lattice.todo_event.v1', sequence: 0,
        event_digest: 'a'.repeat(64) }] },
    });
  }
  return { schema: 'lattice.todo_store_read.v1', project_id: 'scale-project', members };
}

function syntheticStatusResult(activeCount) {
  const result = {
    schema: 'lattice.todo_status_result.v7',
    project_id: 'scale-project',
    active_set: Array.from({ length: activeCount }, (_, index) => ({
      plan_key: 'main', task_id: `t${String(index).padStart(4, '0')}`, label: 'x', unmet_dependencies: [],
    })),
    next_ready: [],
    dispatch_frontier: {
      schema: 'lattice.todo_dispatch_frontier.v1', selection_source: 'next_ready',
      policy: 'all_ready_parallel_by_default', recommended_parallelism: 0,
      subset_requires_reason: false, parallel_start_flag: '--parallel-frontier',
      frontier_digest: todoSelfDigest({
        schema: 'lattice.todo_dispatch_frontier.v1', project_id: 'scale-project', tasks: [],
        frontier_digest: '',
      }, 'frontier_digest'),
    },
    blocked: [],
    audit_pending: [],
    structure_finalization_pending: [],
    plan_notes: [],
    coordination: [],
    parallel_candidates: [],
    member_heads: [],
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

test('list上限2000とconsumer capture上限64 KiBをそれぞれfail closedにする', () => {
  assert.equal(validateTodoStatusResult(syntheticStatusResult(TODO_STATUS_LIST_LIMIT)), true);
  assert.equal(validateTodoStatusResult(syntheticStatusResult(TODO_STATUS_LIST_LIMIT + 1)), false);
  assert.throws(() => projectTodoStatus(syntheticReadModel(TODO_STATUS_LIST_LIMIT + 1), { parallelCandidates: [], planNotes: [] }),
    (error) => error instanceof TodoStatusProjectionError
      && error.code === 'TODO_SCALE_EXCEEDED'
      && error.detail.list === 'active_set'
      && error.detail.count === 2_001
      && error.detail.limit === 2_000);
  assert.throws(() => projectTodoStatus(syntheticReadModel(TODO_STATUS_LIST_LIMIT), { parallelCandidates: [], planNotes: [] }),
    (error) => error instanceof TodoStatusProjectionError
      && error.code === 'TODO_SCALE_EXCEEDED'
      && error.detail.reason === 'todo_status_result_size_limit_exceeded'
      && error.detail.result_bytes > TODO_STATUS_CAPTURE_LIMIT
      && error.detail.result_limit === 65_536);
  const capturable = projectTodoStatus(syntheticReadModel(500), { parallelCandidates: [], planNotes: [] });
  assert.ok(Buffer.byteLength(`${JSON.stringify(capturable)}\n`) <= TODO_STATUS_CAPTURE_LIMIT);
});

test('consumer境界はPython同様code point数・control拒否・safe integerを使う', () => {
  assert.equal(isTodoStatusBoundedText('😀'.repeat(TODO_STATUS_LABEL_LIMIT), TODO_STATUS_LABEL_LIMIT), true);
  assert.equal(isTodoStatusBoundedText('😀'.repeat(TODO_STATUS_LABEL_LIMIT + 1), TODO_STATUS_LABEL_LIMIT), false);
  assert.equal(isTodoStatusBoundedText('x'.repeat(TODO_STATUS_REASON_LIMIT), TODO_STATUS_REASON_LIMIT), true);
  assert.equal(isTodoStatusBoundedText('line\nbreak', TODO_STATUS_REASON_LIMIT), false);
  assert.equal(isTodoStatusBoundedText('\x7f', TODO_STATUS_REASON_LIMIT), false);

  const maximumSequence = projectTodoStatus({
    schema: 'lattice.todo_store_read.v1', project_id: 'sequence-project',
    members: [{
      descriptor: { plan_key: 'main' },
      plan: { project_id: 'sequence-project', plan_key: 'main', plan_version: 'v1',
        plan_digest: 'c'.repeat(64), tasks: [], hard_dependencies: [], joins: [] },
      tasks: [], journal: { events: [{ schema: 'lattice.todo_event.v1',
        sequence: Number.MAX_SAFE_INTEGER, event_digest: 'b'.repeat(64) }] },
    }],
  }, { parallelCandidates: [], planNotes: [] });
  assert.equal(maximumSequence.member_heads[0].through_sequence, 9_007_199_254_740_991);
  assert.equal(validateTodoStatusResult(maximumSequence), true);
  const invalid = structuredClone(maximumSequence);
  invalid.member_heads[0].through_sequence = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(validateTodoStatusResult(invalid), false);
  invalid.member_heads[0].through_sequence = 0;
  invalid.extra = true;
  invalid.result_digest = todoSelfDigest(invalid, 'result_digest');
  assert.equal(validateTodoStatusResult(invalid), false);
});
