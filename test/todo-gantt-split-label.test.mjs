// b6 (ADR 0205 §7): the gantt draws 分割待ち / 関数分割 as a chip beside the status, in the task index and in the detail pane.
import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutTodoGantt } from '../src/todo-gantt-layout.mjs';
import { renderTodoGanttHtml } from '../src/todo-gantt-html.mjs';

const task = (task_id, extra = {}) => ({ task_id, title: task_id, lane: 'main', narrative_ref: null, compile_binding: null, ...extra });
const state = (task_id, status) => ({ task_id, status, started_at: null, done_at: null, blocked_reason: null, evidence: null, evidence_unverified: false });
const read = (splitStatus) => ({
  schema: 'lattice.todo_store_read.v1', project_id: 'project-1',
  members: [{
    descriptor: { plan_key: 'dev' },
    plan: { project_id: 'project-1', plan_key: 'dev', hard_dependencies: [], joins: [],
      tasks: [task('U'), task('T'), task('S', { function_split: { path: 'a.js', symbol: 'f', start_line: 1, end_line: 3, members: ['T', 'U'] } })] },
    tasks: [state('U', 'in-progress'), state('T', 'pending'), state('S', splitStatus)],
  }],
});
const html = (model) => renderTodoGanttHtml({ readModel: model, layout: layoutTodoGantt(model) }).html;
const chips = (page, label) => page.split(`<span class="connection-chip">${label}</span>`).length - 1;

test('an open split puts a chip beside the status of every member and of S, in the index and the detail pane', () => {
  const page = html(read('pending'));
  assert.equal(chips(page, '分割待ち'), 4, 'U and T, each in the index and the detail pane');
  assert.equal(chips(page, '関数分割'), 2);
  assert.match(page, /作業中/u, 'the in-progress status is still shown');
});

test('a closed split leaves no chip', () => {
  const page = html(read('done'));
  assert.equal(chips(page, '分割待ち') + chips(page, '関数分割'), 0);
});
