import assert from 'node:assert/strict';
import test from 'node:test';

import { createTodoReadiness, validateProspectiveEvent } from '../src/todo-readiness.mjs';
import { computeReadyFrontier } from '../src/todo-status.mjs';

const ref = (planKey, taskId) => ({ project_id: 'project-1', plan_key: planKey, task_id: taskId });
const phaseRef = (planKey) => ({ project_id: 'project-1', plan_key: planKey, phase_id: 'phase-1' });

function member(planKey, schema = 'lattice.todo_plan.v1', status = 'pending', phaseStatus = 'active') {
  const taskId = planKey === 'source' ? 'A' : 'B';
  const task = { task_id: taskId, title: taskId, phase_id: 'phase-1' };
  const phaseId = ['lattice.todo_plan.v1', 'lattice.todo_plan.v2', 'lattice.todo_plan.v3'].includes(schema)
    ? 'terminal-audit' : 'phase-1';
  return {
    descriptor: { plan_key: planKey },
    plan: {
      schema, project_id: 'project-1', plan_key: planKey, plan_version: 'v1',
      plan_digest: 'a'.repeat(64), tasks: [task], hard_dependencies: [], joins: [],
      phases: [{ phase_id: phaseId, required_evidence_slots: [] }], phase_accept_dependencies: [],
    },
    tasks: [{ task_id: taskId, status, blocked_reason: status === 'blocked' ? 'blocked' : null }],
    phases: [{ phase_id: phaseId, status: phaseStatus }],
    journal: { events: [{ schema: 'lattice.todo_event.v1', sequence: 0, event_digest: 'b'.repeat(64) }] },
    plan_scoped: { events: [] },
    // A canonical read-view fixture deliberately has no derived snapshot cache.
  };
}

function fixture(schema = 'lattice.todo_plan.v1') {
  const source = member('source', schema, 'done');
  const target = member('target', schema);
  const store = { schema: 'lattice.todo_store_read.v1', project_id: 'project-1', members: [source, target] };
  return { store, source, target };
}

function event(kind = 'start', payload = {}, fields = {}) {
  return { kind, task_id: 'B', payload: { override_reason: null,
    ...(kind === 'done' ? { done_mode: 'authored' } : {}), ...payload }, ...fields };
}

function validate(input, prospective = event()) {
  return validateProspectiveEvent({ store: input.store, member: input.target, event: prospective });
}

function refusal(reason, cause, detail = {}) {
  return { ok: false, code: 'STORE_INCONSISTENT', detail: { reason, cause, ...detail } };
}

function connect(input, kind = 'hard') {
  const from = ref('source', 'A');
  const to = ref('target', 'B');
  if (kind === 'hard') input.target.plan.hard_dependencies.push({ from, to });
  if (kind === 'join') input.target.plan.joins.push({ before: to, after: [from] });
  if (kind === 'dynamic') input.target.plan_scoped.events.push({
    kind: 'cross_plan_dependency', event_digest: 'c'.repeat(64), payload: { from, to },
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('status and prospective start share the task/phase/prerequisite truth table', () => {
  for (const schema of ['lattice.todo_plan.v1', 'lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7']) {
    for (const taskStatus of ['pending', 'in-progress', 'blocked', 'retired', 'done']) {
      for (const ownPhase of ['active', 'locked']) for (const predecessorStatus of ['pending', 'done']) {
        for (const predecessorPhase of ['active', 'accepted']) {
          const input = fixture(schema);
          input.source.tasks[0].status = predecessorStatus;
          input.source.phases[0].status = predecessorPhase;
          input.target.tasks[0].status = taskStatus;
          input.target.phases[0].status = ownPhase;
          connect(input);
          const expected = taskStatus === 'pending' && predecessorStatus === 'done'
            && (schema !== 'lattice.todo_plan.v4' || (ownPhase === 'active' && predecessorPhase === 'accepted'));
          assert.equal(validate(input).ok, expected, JSON.stringify({ schema, taskStatus, ownPhase,
            predecessorStatus, predecessorPhase }));
          assert.equal(computeReadyFrontier(input.store).some((task) => task.plan_key === 'target'), expected);
        }
      }
    }
  }
});

test('hard, join and connected edges all require completion; start override does not waive done', () => {
  for (const kind of ['hard', 'join', 'dynamic']) {
    const input = fixture();
    input.source.tasks[0].status = 'pending';
    connect(input, kind);
    assert.deepEqual(validate(input), refusal('invalid_start_transition', 'predecessor_unfinished'));
    assert.deepEqual(validate(input, event('start', { override_reason: 'work already started' })), { ok: true });
    input.target.tasks[0].status = 'in-progress';
    assert.deepEqual(validate(input, event('done', { override_reason: 'work already started' })),
      refusal('invalid_done_transition', 'predecessor_unfinished'));
  }
});

test('removed connected edges no longer block status, start, or reopen', () => {
  const input = fixture();
  connect(input, 'dynamic');
  input.target.plan_scoped.events.push({ kind: 'cross_plan_dependency_removed',
    payload: { target_event_digest: 'c'.repeat(64) } });
  input.source.tasks[0].status = 'pending';
  assert.deepEqual(validate(input), { ok: true });
  assert.equal(computeReadyFrontier(input.store).some((task) => task.plan_key === 'target'), true);
  input.target.tasks[0].status = 'in-progress';
  assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source,
    event: { ...event('reopen'), task_id: 'A' } }), { ok: true });
});

test('explicit acceptance edges cannot be waived by a start override and keep merged rejection priority', () => {
  for (const schema of ['lattice.todo_plan.v5', 'lattice.todo_plan.v7']) {
    const input = fixture(schema);
    input.source.tasks[0].status = 'pending';
    input.target.plan.phase_accept_dependencies.push({ from: phaseRef('source'), to: ref('target', 'B') });
    connect(input);
    for (const override_reason of [null, 'intentional early work']) {
      assert.deepEqual(validate(input, event('start', { override_reason })),
        refusal('invalid_start_transition', 'acceptance_edge'));
    }
    assert.deepEqual(validate(input, event('done')), refusal('invalid_done_transition', 'acceptance_edge'));
    assert.equal(computeReadyFrontier(input.store).some((task) => task.plan_key === 'target'), false);
    input.source.phases[0].status = 'accepted';
    assert.deepEqual(validate(input), refusal('invalid_start_transition', 'predecessor_unfinished'));
    input.source.tasks[0].status = 'done';
    assert.deepEqual(validate(input), { ok: true });
    assert.equal(computeReadyFrontier(input.store).some((task) => task.plan_key === 'target'), true);
  }
});

test('v4 predecessor phase acceptance retains its existing combined predecessor override', () => {
  const input = fixture('lattice.todo_plan.v4');
  connect(input);
  assert.deepEqual(validate(input), refusal('invalid_start_transition', 'acceptance_edge'));
  assert.deepEqual(validate(input, event('start', { override_reason: 'existing exception' })), { ok: true });
  input.source.phases[0].status = 'accepted';
  assert.deepEqual(validate(input), { ok: true });
});

test('same-phase v4 predecessor completion does not require accepting its own active phase', () => {
  const input = fixture('lattice.todo_plan.v4');
  input.target.plan.tasks.push({ task_id: 'C', title: 'C', phase_id: 'phase-1' });
  input.target.tasks.push({ task_id: 'C', status: 'done' });
  input.target.plan.hard_dependencies.push({ from: ref('target', 'C'), to: ref('target', 'B') });
  assert.deepEqual(validate(input), { ok: true });
});

test('own task and phase causes follow existing merged rejection priority', () => {
  const input = fixture('lattice.todo_plan.v4');
  input.target.tasks[0].status = 'blocked';
  input.target.phases[0].status = 'locked';
  assert.deepEqual(validate(input), refusal('invalid_start_transition', 'task_state'));
  input.target.tasks[0].status = 'pending';
  assert.deepEqual(validate(input), refusal('invalid_start_transition', 'phase_state'));
  assert.deepEqual(validate(input, event('done')), refusal('invalid_done_transition', 'task_state'));
  connect(input);
  input.source.tasks[0].status = 'pending';
  assert.deepEqual(validate(input), refusal('invalid_start_transition', 'predecessor_unfinished'));
});

test('historical/rebind starts, non-authored done, and unrelated event kinds retain merged bypasses', () => {
  const input = fixture('lattice.todo_plan.v4');
  input.target.phases[0].status = 'locked';
  input.source.tasks[0].status = 'pending';
  connect(input);
  for (const start_mode of ['historical_import', 'rebind']) {
    assert.deepEqual(validate(input, event('start', { start_mode })), { ok: true });
  }
  for (const done_mode of ['historical_import', 'evidence_promotion']) {
    assert.deepEqual(validate(input, event('done', { done_mode })), { ok: true });
  }
  for (const kind of ['block', 'unblock', 'retire', 'start_retracted', 'phase_review', 'phase_accept', 'phase_reject',
    'phase_close_unaudited']) assert.deepEqual(validate(input, event(kind)), { ok: true });
});

test('reopen rejects any started successor through every task edge and keeps next_action', () => {
  for (const kind of ['hard', 'join', 'dynamic']) {
    for (const successorStatus of ['in-progress', 'blocked', 'done', 'retired']) {
      const input = fixture();
      connect(input, kind);
      input.target.tasks[0].status = successorStatus;
      const prospective = { ...event('reopen'), task_id: 'A' };
      assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source, event: prospective }),
        refusal('reopen_has_started_successor', 'task_state', {
          next_action: 'lattice todo split --plan source --input <file>',
        }));
      prospective.payload.override_reason = 'invalidate deliberately';
      assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source, event: prospective }), { ok: true });
    }
  }
});

test('phase reopen preserves v4 task-successor and decoupled explicit-acceptance semantics', () => {
  for (const schema of ['lattice.todo_plan.v4', 'lattice.todo_plan.v5', 'lattice.todo_plan.v7']) {
    const input = fixture(schema);
    connect(input);
    if (schema !== 'lattice.todo_plan.v4') {
      // A task edge alone does not prevent reopening a decoupled phase.
      input.target.tasks[0].status = 'in-progress';
      assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source,
        event: event('phase_reopen', {}, { phase_id: 'phase-1' }) }), { ok: true });
      input.target.plan.phase_accept_dependencies.push({ from: phaseRef('source'), to: ref('target', 'B') });
    }
    for (const successorStatus of ['pending', 'in-progress', 'blocked', 'done', 'retired']) {
      input.target.tasks[0].status = successorStatus;
      const prospective = event('phase_reopen', {}, { phase_id: 'phase-1' });
      assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source, event: prospective }),
        successorStatus === 'pending' ? { ok: true } : refusal('phase_reopen_has_started_successor', 'task_state'));
      prospective.payload.override_reason = 'invalidate deliberately';
      assert.deepEqual(validateProspectiveEvent({ store: input.store, member: input.source, event: prospective }), { ok: true });
    }
  }
});

test('readiness uses canonical phases even with a contradictory snapshot and never changes its input', () => {
  const input = fixture('lattice.todo_plan.v4');
  input.target.snapshot = { phases: [{ phase_id: 'phase-1', status: 'locked' }] };
  const before = structuredClone(input.store);
  freeze(input.store);
  assert.deepEqual(validate(input), { ok: true });
  const readiness = createTodoReadiness(input.store);
  assert.equal(readiness.isReady(readiness.key(ref('target', 'B'))), true);
  assert.equal(computeReadyFrontier(input.store).some((task) => task.plan_key === 'target'), true);
  assert.deepEqual(input.store, before);
});
