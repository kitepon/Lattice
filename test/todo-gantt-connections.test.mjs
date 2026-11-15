// 接続 on the screens (docs/architecture/dfd-connect.md): one area per task, each entry labelled 他条件に接続 or
// 優先接続; a task on another chart is never a tree edge.
import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { renderConnectionArea, renderConnectionChips } from '../src/todo-gantt-html-shared.mjs';

const connections = [
  { kind: 'task', ref: 'alpha/a/P', state: 'open', reason: 'R uses P', since: '2026-11-15T10:00:00.000Z', event_digest: 'a'.repeat(64) },
  { kind: 'schedule', ref: 'ci-run-1', state: 'settled', reason: 'wait for CI', since: '2026-11-15T10:01:00.000Z', settled_at: '2026-11-15T10:20:00.000Z', evidence: 'CI green', event_digest: 'b'.repeat(64) },
  { kind: 'schedule', ref: 'nightly', state: 'open', reason: 'time', since: '2026-11-15T10:02:00.000Z', state_reason: 'chart_not_read', event_digest: 'c'.repeat(64) },
  { kind: 'priority', agent: 'bot-b', since: '2026-11-15T10:03:00.000Z', reason: 'idle until P lands' },
];

test('one 接続 area lists 他条件に接続 and 優先接続 together, each entry labelled', () => {
  const area = renderConnectionArea(connections);
  assert.equal(area.match(/<section class="connections"/gu).length, 1);
  assert.equal(area.match(/他条件に接続/gu).length, 3);
  assert.equal(area.match(/優先接続/gu).length, 1);
  assert.match(area, /alpha\/a\/P.*開いている/u);
  assert.match(area, /ci-run-1.*成立.*CI green/u);
  assert.match(area, /開いている（その工程表を読めません）/u);
  assert.match(area, /bot-b/u);
  assert.equal(renderConnectionArea([]), '');
  assert.doesNotMatch(area, /待ち/u);
});

test('the chip row counts the open 他条件に接続 and marks 優先接続', () => {
  const chips = renderConnectionChips(connections);
  assert.match(chips, /他条件に接続 2/u);
  assert.match(chips, /優先接続/u);
  assert.equal(renderConnectionChips([connections[1]]), '');
});

test('a 接続 to a task on another chart is not a tree edge; a 前工程 inside one chart is', () => {
  const ref = (project, plan, task) => ({ project_id: project, plan_key: plan, task_id: task });
  const member = (planKey, taskIds, events = []) => ({
    plan: { schema: 'lattice.todo_plan.v3', project_id: 'beta', plan_key: planKey,
      tasks: taskIds.map((id) => ({ task_id: id, title: id, lane: 'main' })), hard_dependencies: [], joins: [] },
    tasks: taskIds.map((id) => ({ task_id: id, status: 'pending', blocked_reason: null })),
    plan_scoped: { events },
  });
  const edge = (from, to) => ({ kind: 'cross_plan_dependency', actor: { host: 'h', session: 's', agent: 'a' },
    recorded_at: '2026-11-15T00:00:00.000Z', event_digest: 'd'.repeat(64), payload: { from, to, reason: 'x' } });
  const read = { schema: 'lattice.todo_store_read.v1', project_id: 'beta', members: [
    member('b', ['Q']),
    member('c', ['R'], [edge(ref('beta', 'b', 'Q'), ref('beta', 'c', 'R')), edge(ref('alpha', 'a', 'P'), ref('beta', 'c', 'R'))]),
  ] };
  const layout = layoutTodoGantt(read, { scope: 'all' });
  assert.deepEqual(layout.edges.map(({ from, to }) => [from.plan_key, to.plan_key]), [['b', 'c']]);
  assert.equal((layout.notices ?? []).filter(({ code }) => code === 'TODO_LAYOUT_INVALID_INPUT').length, 0);
});
