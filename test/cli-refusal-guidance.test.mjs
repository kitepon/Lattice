// Every plan/todo CLI refusal names where (pointer), which rule (rule) and a concrete repair (next_action).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withRefusalGuidance } from '../src/cli-refusal-guidance.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { createTodoStoreWriter, initializeTodoStore } from '../src/todo-store.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const NOW = '2026-07-18T00:00:00.000Z';

const guide = (detail, context = {}, extra = {}) => withRefusalGuidance({
  code: 'INPUT_INVALID', message: 'plan_create_schema_invalid', detail, ...extra,
}, context);

test('unsorted names both values and the pointer', () => {
  const result = guide({
    violation_kind: 'unsorted', pointer: '/tasks/1/task_id',
    expected: { greater_than: 't2', order: 'ascending_unique' }, actual: 't1',
  });
  assert.equal(result.rule, 'unsorted');
  assert.equal(result.pointer, '/tasks/1/task_id');
  assert.match(result.next_action, /'t1'.*'t2'.*\/tasks\/1\/task_id/u);
});

test('unexpected_or_missing_keys lists the keys to add and to remove', () => {
  const result = guide({
    violation_kind: 'unexpected_or_missing_keys', pointer: '/actor',
    expected: { keys: ['agent', 'host', 'session'] }, actual: { keys: ['agent', 'host', 'extra'] },
  });
  assert.equal(result.next_action, 'At /actor add keys [session] and remove keys [extra].');
});

test('generic kinds name the accepted values, format or digest', () => {
  assert.match(guide({
    violation_kind: 'identifier_invalid', pointer: '/plan_key', actual: 'bad key',
  }).next_action, /\/plan_key.*'bad key'/u);
  assert.match(guide({
    violation_kind: 'const_mismatch', pointer: '/schema', expected: { one_of: ['a.v1', 'b.v2'] }, actual: 'x',
  }).next_action, /'a\.v1' or 'b\.v2'.*'x'/u);
  assert.match(guide({
    violation_kind: 'timestamp_invalid', pointer: '/recorded_at', actual: 'yesterday',
  }).next_action, /2026-11-08T12:00:00\.000Z/u);
  assert.match(guide({
    violation_kind: 'input_digest_mismatch', pointer: '/input_digest', expected: 'sha256:abc', actual: {},
  }).next_action, /'sha256:abc'/u);
  assert.match(guide({
    violation_kind: 'unknown_reference', pointer: '/tasks/0/phase_id', expected: { one_of: ['p1', 'p2'] }, actual: 'nope',
  }).next_action, /\[p1, p2\].*'nope'/u);
  assert.match(guide({
    violation_kind: 'not_authorable_at_create', pointer: '/tasks/0/compile_binding', expected: null, actual: 'x',
  }).next_action, /Set \/tasks\/0\/compile_binding to null/u);
  assert.match(guide({
    violation_kind: 'empty', pointer: '/phases', expected: { min_items: 1 }, actual: { length: 0 },
  }).next_action, /at least 1 item.*\/phases/u);
  assert.match(guide({
    violation_kind: 'type', pointer: '/tasks', expected: { type: 'array' }, actual: { type: 'object' },
  }).next_action, /type array.*'object'/u);
  assert.match(guide({
    violation_kind: 'too_large', pointer: '/tasks/0/design_memo',
    expected: { max_utf8_bytes: 100 }, actual: { byte_length: 250 },
  }).next_action, /100 UTF-8 bytes.*250/u);
});

test('a path from violation_path becomes the pointer, and the empty path is /', () => {
  assert.equal(guide({ violation_kind: 'schema_invalid', violation_path: '/tasks/0' }).pointer, '/tasks/0');
  // RFC 6901: '' is the document root and stays ''.
  assert.equal(guide({ violation_kind: 'schema_invalid', violation_path: '' }).pointer, '');
});

test('a placeholder next_action is replaced; a concrete one is kept', () => {
  const replaced = guide({
    violation_kind: 'unsorted', pointer: '/tasks/1/task_id', expected: { greater_than: 'a' }, actual: 'b',
    next_action: 'correct_the_reported_pointer_then_rerun_plan_create',
  });
  assert.doesNotMatch(replaced.next_action, /^[a-z_]+$/u);
  const kept = guide({
    violation_kind: 'unsorted', pointer: '/p', expected: { greater_than: 'a' }, actual: 'b',
    next_action: 'lattice plan create --schema --json',
  });
  assert.equal(kept.next_action, 'lattice plan create --schema --json');
});

test('existing keys survive, the input is not mutated, and pointer/rule/next_action are always set', () => {
  const detail = Object.freeze({ reason: 'store_locked', lock_path: '/x', pointer: null });
  const result = withRefusalGuidance({ code: 'STORE_WRITE_CONFLICT', message: 'store_locked', detail }, { command: 'done' });
  assert.equal(result.lock_path, '/x');
  assert.equal(result.reason, 'store_locked');
  assert.equal(result.pointer, null);
  assert.equal(result.rule, 'store_locked');
  assert.match(result.next_action, /rerun the same command/u);
  const bare = withRefusalGuidance({ code: 'X', message: 'boom' }, { command: 'start' });
  assert.deepEqual(bare, { pointer: null, rule: 'boom', next_action: 'lattice todo start --help' });
});

test('an unknown rule keeps its placeholder, else falls back to the command help', () => {
  assert.equal(guide({ reason: 'never_heard_of_it', next_action: 'do_the_thing' }).next_action, 'do_the_thing');
  assert.equal(guide({ reason: 'never_heard_of_it' }, { family: 'plan', command: 'revise' }).next_action,
    'lattice plan revise --help');
});

test('state rules name the command to run, from the CLI context', () => {
  const context = { plan: 'main', task: 'T1', command: 'done' };
  assert.match(guide({ reason: 'invalid_done_transition', cause: 'task_state' }, context).next_action,
    /lattice todo start --plan main --task T1/u);
  assert.match(guide({ reason: 'invalid_done_transition', cause: 'predecessor_unfinished' }, context).next_action,
    /lattice todo show --plan main --task T1/u);
  const named = guide({ reason: 'invalid_start_transition', cause: 'predecessor_unfinished',
    blocking_tasks: [{ plan_key: 'other', task_id: 'P1', status: 'in-progress' }] }, context).next_action;
  assert.match(named, /other\/P1 \(in-progress\)/u);
  assert.match(named, /lattice todo show --plan other --task P1 --json/u);
  assert.match(guide({ reason: 'invalid_start_transition', cause: 'acceptance_edge',
    blocking_phases: [{ plan_key: 'other', phase_id: 'ph1', status: 'active' }] }, context).next_action,
  /--plan other --phase ph1/u);
  assert.equal(guide({ reason: 'plan_not_active', plan_key: 'zz' }, context).pointer, '--plan');
  assert.equal(guide({ reason: 'plan_not_active', pointer: '/desired/plan_key' }, context).pointer, '/desired/plan_key');
  assert.equal(guide({ reason: 'task_not_found', requested_task_id: 'Tx' }, context).pointer, '--task');
  assert.match(guide({ reason: 'unknown_requires_evidence', task_ids: ['Q1', 'Q2'] }, context).next_action, /\[Q1, Q2\]/u);
  assert.match(guide({ reason: 'carry_semantics_changed', from_task_id: 'T9' }, context).next_action, /Task T9/u);
});

test('input reader rules point at the flag that carried the path', () => {
  const context = { command: 'done', flags: { evidence: 'missing.md', plan: 'main' } };
  const result = guide({ reason: 'input_missing', input_ref: 'missing.md', next_action: 'x_y' }, context);
  assert.equal(result.pointer, '--evidence');
  assert.match(result.next_action, /'missing\.md'.*--evidence/u);
});

test('plan backchain reasons get one repair per family', () => {
  const result = withRefusalGuidance({
    code: 'PLAN_BACKCHAIN_INVALID', message: 'task_invalid', detail: { reason: 'task_invalid', pointer: '/tasks/0' },
  }, { family: 'plan', command: 'backchain' });
  assert.match(result.next_action, /\/tasks\/0.*lattice plan backchain --schema --json/u);
});

async function workspace(context, { store = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-refusal-guidance-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  if (store) {
    await initializeTodoStore({
      repoRoot: root,
      writer: createTodoStoreWriter({ caller: 'g4-migration' }),
      projectId: 'project-1',
      repositories: [{ repo_id: 'self', path: '.' }],
      plans: [{
        plan: {
          schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
          predecessor_plan_digest: null,
          tasks: [{ task_id: 'T1', title: 'T1', lane: 'main', narrative_ref: null, compile_binding: null }],
          hard_dependencies: [], joins: [],
        },
        genesis: { actor: ACTOR, recorded_at: NOW },
      }],
      now: NOW,
    });
  }
  return root;
}

function lattice(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8',
    env: {
      ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_TODO_ACTOR_HOST: ACTOR.host, LATTICE_TODO_ACTOR_SESSION: ACTOR.session,
      LATTICE_TODO_ACTOR_AGENT: ACTOR.agent,
    },
  });
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr.trim().split('\n').at(-1)).detail;
}

function createDraft(mutate) {
  const task = {
    task_id: 't1', title: '仕事', lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
    narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'p1',
  };
  const value = mutate({
    schema: 'lattice.plan_create_input.v4', project_id: 'probe', plan_key: 'main',
    plan_version: 'v1', actor: ACTOR, recorded_at: new Date().toISOString(),
    tasks: [task], hard_dependencies: [], joins: [],
    phases: [{
      phase_id: 'p1', title: 'P', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'],
    }],
    phase_accept_dependencies: [], input_digest: '',
  });
  value.input_digest = todoSelfDigest(value, 'input_digest');
  return value;
}

test('plan create with a duplicate task_id names the pointer, the rule and the id', async (context) => {
  const root = await workspace(context);
  await writeFile(path.join(root, 'draft.json'), `${JSON.stringify(createDraft((value) => {
    const [first] = value.tasks;
    value.tasks = [first, { ...first, title: 'other' }];
    return value;
  }))}\n`);
  const detail = lattice(root, ['plan', 'create', '--input', 'draft.json']);
  assert.equal(detail.pointer, '/tasks/1/task_id');
  assert.equal(detail.rule, 'unsorted');
  assert.match(detail.next_action, /'t1' appears twice with different content/u);
});

test('todo done names a missing or unknown flag', async (context) => {
  const root = await workspace(context, { store: true });
  const missing = lattice(root, ['todo', 'done', '--plan', 'main', '--message', 'x']);
  assert.deepEqual([missing.pointer, missing.rule], ['--task', 'flag_missing']);
  const unknown = lattice(root, ['todo', 'done', '--plan', 'main', '--task', 'T1', '--bogus', 'x']);
  assert.deepEqual([unknown.pointer, unknown.rule], ['--bogus', 'flag_unknown']);
  const badId = lattice(root, ['todo', 'done', '--plan', 'bad id!', '--task', 'T1', '--message', 'x']);
  assert.deepEqual([badId.pointer, badId.rule], ['--plan', 'identifier_invalid']);
});

test('todo done on a pending task is a state refusal: pointer null, start command in next_action', async (context) => {
  const root = await workspace(context, { store: true });
  const detail = lattice(root, ['todo', 'done', '--plan', 'main', '--task', 'T1', '--message', 'x']);
  assert.equal(detail.rule, 'invalid_done_transition');
  assert.equal(detail.pointer, null);
  assert.match(detail.next_action, /lattice todo start --plan main --task T1/u);
});

test('todo start on an unknown plan points at --plan', async (context) => {
  const root = await workspace(context, { store: true });
  const detail = lattice(root, ['todo', 'start', '--plan', 'nope', '--task', 'T1']);
  assert.equal(detail.rule, 'plan_not_active');
  assert.equal(detail.pointer, '--plan');
  assert.match(detail.next_action, /lattice todo status --json/u);
});

test('plan create/revise/backchain argument refusals name the flag, rule and repair (exit 2)', async (context) => {
  const root = await workspace(context);
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stderr.trim());
    assert.equal(payload.schema, 'lattice.cli_error.v2');
    assert.equal(payload.code, 'INVALID_ARGUMENTS');
    return payload.detail;
  };
  const missingInput = run(['plan', 'create']);
  assert.equal(missingInput.pointer, '--input');
  assert.equal(missingInput.rule, 'flag_missing');
  assert.match(missingInput.next_action, /Add --input <value> to `lattice plan create`/u);
  const unknown = run(['plan', 'revise', '--input', 'x.json', '--bogus', '--json']);
  assert.equal(unknown.pointer, '--bogus');
  assert.equal(unknown.rule, 'flag_unknown');
  const missingJson = run(['plan', 'backchain', '--input', 'x.json']);
  assert.equal(missingJson.pointer, '--json');
  assert.equal(missingJson.rule, 'flag_missing');
  assert.match(missingJson.next_action, /Add --json to `lattice plan backchain`/u);
});
