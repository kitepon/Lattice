// memo-no-fabrication (2026-11-12): a missing design memo is never recorded as NO_PLAN. plan create, plan revise
// and todo add refuse it at the field with the NO_PLAN prompt; a written NO_PLAN is still recorded as written.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_DESIGN_MEMO_PROMPT } from '../src/todo-contracts.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
}
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function refusal(root, args) {
  const result = run(root, args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should refuse\n${result.stdout}`);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}

const plan = (tasks) => ({ plan_key: 'dev', phases: [{ phase_id: 'p', title: 'p' }],
  tasks: tasks.map(([id, memo]) => ({ task_id: id, title: id, phase_id: 'p', ...(memo === undefined ? {} : { design_memo: memo }) })) });

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-memo-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '.lattice/\n*.json\n');
  return root;
}
const memos = (root) => Object.fromEntries(success(root, ['plan', 'show', 'dev', '--json']).tasks
  .map(({ task_id: id, design_memo: memo }) => [id, memo]));

test('plan create refuses an omitted or blank memo at its pointer and records nothing', async (context) => {
  const root = await repo(context);
  for (const [memo, kind] of [[undefined, 'type'], [null, 'type'], ['  ', 'blank']]) {
    await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan([['A', 'NO_PLAN'], ['B', memo]])));
    const refused = refusal(root, ['plan', 'create', '--input', 'plan.json']);
    assert.deepEqual([refused.code, refused.detail.pointer, refused.detail.violation_kind],
      ['DESIGN_MEMO_REQUIRED', '/tasks/1/design_memo', kind]);
    assert.equal(refused.detail.prompt, TODO_DESIGN_MEMO_PROMPT);
  }
  assert.equal(success(root, ['status', '--json']).active_plans.length, 0);
});

test('a written NO_PLAN is recorded; plan revise and todo add refuse a missing memo the same way', async (context) => {
  const root = await repo(context);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan([['A', 'NO_PLAN'], ['B', '## memo']])));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  assert.deepEqual(memos(root), { A: 'NO_PLAN', B: '## memo' });

  await writeFile(path.join(root, 'rev.json'), JSON.stringify(plan([['A', 'NO_PLAN'], ['B', '## memo'], ['C', undefined]])));
  const revised = refusal(root, ['plan', 'revise', '--input', 'rev.json']);
  assert.deepEqual([revised.code, revised.detail.pointer], ['DESIGN_MEMO_REQUIRED', '/tasks/2/design_memo']);

  for (const extra of [[], ['--design-memo', ' ']]) {
    const added = refusal(root, ['todo', 'add', '--plan', 'dev', '--task', 'D', '--title', 'D', '--phase', 'p', ...extra]);
    assert.deepEqual([added.code, added.detail.pointer], ['DESIGN_MEMO_REQUIRED', '--design-memo']);
    assert.equal(added.detail.prompt, TODO_DESIGN_MEMO_PROMPT);
    assert.match(added.detail.next_action, /todo add --plan dev --task D .*--design-memo/u);
  }
  assert.deepEqual(memos(root), { A: 'NO_PLAN', B: '## memo' });

  success(root, ['todo', 'add', '--plan', 'dev', '--task', 'D', '--title', 'D', '--phase', 'p', '--design-memo', 'NO_PLAN']);
  assert.equal(memos(root).D, 'NO_PLAN');
});
