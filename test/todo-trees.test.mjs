import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTodoTrees } from '../src/todo-trees.mjs';

const ref = (planKey, taskId, projectId = 'chart') => ({ project_id: projectId, plan_key: planKey, task_id: taskId });

function member(planKey, tasks, { hard = [], states = {}, events = [] } = {}) {
  return {
    plan: { project_id: 'chart', plan_key: planKey, tasks, hard_dependencies: hard, joins: [] },
    tasks: tasks.map(({ task_id: id }) => ({ task_id: id, status: states[id] ?? 'pending' })),
    plan_scoped: { events },
  };
}

test('trees: cross-plan edge, parent link, singleton, retired finished, external predecessor stays out', () => {
  const crossPlan = (digest, from, to) => ({ kind: 'cross_plan_dependency', event_digest: digest, payload: { from, to } });
  const store = { project_id: 'chart', members: [
    member('a', [{ task_id: 'a1' }, { task_id: 'a2' }, { task_id: 'a3' }], {
      hard: [{ from: ref('a', 'a1'), to: ref('a', 'a2') }, { from: ref('a', 'gone'), to: ref('a', 'a3') }],
      states: { a1: 'done', a2: 'retired' },
    }),
    member('b', [{ task_id: 'b1' }, { task_id: 'b2', parent_task_id: 'b1' }, { task_id: 'b3' }], {
      events: [
        crossPlan('d1', ref('a', 'a2'), ref('b', 'b1')),
        // A predecessor on another chart never joins; a removed edge (tombstone) and a malformed event are skipped.
        crossPlan('d2', ref('a', 'a3', 'other-chart'), ref('b', 'b3')),
        crossPlan('d3', ref('a', 'a3'), ref('b', 'b3')),
        { kind: 'cross_plan_dependency_removed', event_digest: 'd4', payload: { target_event_digest: 'd3' } },
        { kind: 'cross_plan_dependency', event_digest: 'd5' },
      ],
    }),
  ] };
  assert.deepEqual(projectTodoTrees(store), [
    { tree_id: 'a/a1', tasks: [ref('a', 'a1'), ref('a', 'a2'), ref('b', 'b1'), ref('b', 'b2')]
      .map(({ plan_key, task_id }) => ({ plan_key, task_id })), total: 4, finished: 2 },
    { tree_id: 'a/a3', tasks: [{ plan_key: 'a', task_id: 'a3' }], total: 1, finished: 0 },
    { tree_id: 'b/b3', tasks: [{ plan_key: 'b', task_id: 'b3' }], total: 1, finished: 0 },
  ]);
  assert.deepEqual(projectTodoTrees(null), []);
});
