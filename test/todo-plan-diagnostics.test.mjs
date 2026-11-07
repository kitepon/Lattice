import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { explainTodoPlan, todoSelfDigest, validateTodoPlan } from '../src/todo-contracts.mjs';
import { explainTodoExtraction, validateTodoExtraction } from '../src/todo-migration.mjs';
import { buildTodoPlan } from '../src/todo-store.mjs';

const ref = (task_id) => ({ project_id: 'project', plan_key: 'plan', task_id });

function plan(version = 7) {
  const phased = [4, 5, 7].includes(version);
  const tasks = ['a', 'b', 'c'].map((task_id) => ({
    task_id, title: task_id, lane: 'main', narrative_ref: null, compile_binding: null,
    ...(version >= 2 ? { narrative_anchor: null } : {}),
    ...(version >= 3 ? { parent_task_id: null } : {}),
    ...(version >= 6 ? { design_memo: 'NO_PLAN' } : {}),
    ...(phased ? { phase_id: 'p' } : {}),
  }));
  return buildTodoPlan({
    schema: `lattice.todo_plan.v${version}`, project_id: 'project', plan_key: 'plan',
    plan_version: 'v1', predecessor_plan_digest: null, tasks,
    hard_dependencies: [{ from: ref('a'), to: ref('c') }, { from: ref('b'), to: ref('c') }],
    joins: [{ id: 'j', after: [ref('a'), ref('b')], before: ref('c') }],
    ...(phased ? { phases: [{ phase_id: 'p', title: 'phase', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['gate'] }] } : {}),
    ...([5, 7].includes(version) ? { phase_accept_dependencies: [] } : {}),
  });
}

test('plan diagnosis preserves all seven plan versions and rejects malformed input without throwing', () => {
  for (let version = 1; version <= 7; version += 1) {
    const value = plan(version);
    const before = structuredClone(value);
    Object.freeze(value);
    assert.equal(explainTodoPlan(value), null);
    assert.equal(validateTodoPlan(value), true);
    assert.deepEqual(value, before);
    for (const field of Object.keys(value)) {
      const missing = { ...value };
      delete missing[field];
      assert.notEqual(explainTodoPlan(missing), null, `${version}/${field}`);
      assert.equal(validateTodoPlan(missing), false, `${version}/${field}`);
    }
    const reversed = structuredClone(value);
    reversed.hard_dependencies.reverse();
    assert.equal(validateTodoPlan(reversed), false);
    assert.equal(explainTodoPlan(reversed).path, '/hard_dependencies/1');
  }
  for (const value of [null, [], 1, {}, { schema: 'unknown' }]) {
    assert.equal(validateTodoPlan(value), false);
    assert.notEqual(explainTodoPlan(value), null);
  }
});

test('plan failures identify edge ordering, duplicates, nested join order and digest rules', () => {
  for (const [mutate, pointer, reason] of [
    [(p) => p.hard_dependencies.reverse(), '/hard_dependencies/1', 'unsorted_or_duplicate_collection'],
    [(p) => p.hard_dependencies.push(p.hard_dependencies[1]), '/hard_dependencies/2', 'unsorted_or_duplicate_collection'],
    [(p) => p.joins[0].after.reverse(), '/joins/0/after/1', 'unsorted_or_duplicate_collection'],
    [(p) => { p.hard_dependencies[0].from = null; }, '/hard_dependencies/0', 'edge_shape_invalid'],
    [(p) => { p.tasks[1].parent_task_id = 'missing'; }, '/tasks', 'parent_graph_invalid'],
    [(p) => { p.tasks[0].phase_id = 'missing'; }, '/tasks/0/phase_id', 'unknown_phase_reference'],
    [(p) => { p.topology_digest = 'f'.repeat(64); }, '/topology_digest', 'topology_digest_mismatch'],
    [(p) => { p.plan_digest = 'f'.repeat(64); }, '/plan_digest', 'plan_digest_mismatch'],
  ]) {
    const value = plan();
    mutate(value);
    const before = structuredClone(value);
    assert.equal(validateTodoPlan(value), false);
    const failure = explainTodoPlan(value);
    assert.equal(failure.path, pointer);
    assert.equal(failure.reason, reason);
    assert.deepEqual(value, before);
    if (reason === 'unsorted_or_duplicate_collection') {
      assert.equal(failure.expected.order, 'ascending_unique');
      assert.ok(failure.actual <= failure.expected.greater_than);
    }
  }
});

test('migration reports the extraction index and the same ordering rule before import', async () => {
  const value = JSON.parse(await readFile(new URL('./fixtures/todo-migration/valid.json', import.meta.url)));
  const [edge] = value.hard_dependencies;
  value.hard_dependencies = [edge, structuredClone(edge)];
  value.extraction_digest = todoSelfDigest(value, 'extraction_digest');
  assert.equal(validateTodoExtraction(value), false);
  const failure = explainTodoExtraction(value);
  assert.equal(failure.path, '/hard_dependencies/1');
  assert.equal(failure.reason, 'unsorted_or_duplicate_collection');
  assert.equal(failure.expected.order, 'ascending_unique');
});
