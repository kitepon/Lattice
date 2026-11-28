// n3: who added each task rides activity.tasks[] of the compact and open display reads, and todo show.
// docs/architecture/dfd-store-display-read.md#who-added-a-task-added-n3-2026-11-28
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

async function chart(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-added-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const ok = (args, agent = 'bot-creator') => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
        LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'p', phases: [{ phase_id: 'ph', title: 'phase' }],
    tasks: [{ task_id: 'A', title: 'A', phase_id: 'ph', lane: 'bot-c', design_memo: 'NO_PLAN' }], hard_dependencies: [],
  }));
  ok(['plan', 'create', '--input', 'plan.json']);
  const add = (id, agent) => ok(['todo', 'add', '--plan', 'p', '--task', id, '--title', id, '--phase', 'ph', '--design-memo', 'NO_PLAN'], agent);
  const activity = (flag) => Object.fromEntries(ok(['todo', 'display', 'read', flag, '--json']).store.members[0].activity.tasks
    .map(({ task_id: id, added, started, changed_at: changedAt }) => [id, { added, started, changedAt }]));
  return { ok, add, activity };
}

test('a todo add by agent X is added.agent X in the compact and open reads and in todo show; plan create is its creator; a task with no event is listed', async (context) => {
  const { ok, add, activity } = await chart(context);
  ok(['todo', 'start', '--plan', 'p', '--task', 'A']);
  add('B', 'bot-x');
  for (const flag of ['--compact', '--open']) {
    const seen = activity(flag);
    assert.equal(seen.A.added.agent, 'bot-creator', 'a task from plan create: the plan creator');
    assert.equal(seen.B.added.agent, 'bot-x', 'B has no event yet and is listed');
    assert.match(seen.B.added.at, /^\d{4}-\d\d-\d\dT/u);
    assert.equal(seen.B.started, null);
    assert.equal(seen.B.changedAt, seen.B.added.at);
  }
  assert.equal(ok(['todo', 'show', '--plan', 'p', '--task', 'B', '--json']).task.added.agent, 'bot-x');
  assert.equal(ok(['todo', 'show', '--plan', 'p', '--task', 'A', '--json']).task.added.agent, 'bot-creator');
  // later revisions carry the record; notes and events do not change it
  const first = activity('--open').B.added;
  add('C', 'bot-y');
  ok(['todo', 'note', '--plan', 'p', '--task', 'B', '--message', 'a note']);
  ok(['todo', 'start', '--plan', 'p', '--task', 'B'], 'bot-z');
  const later = activity('--open');
  assert.deepEqual(later.B.added, first);
  assert.equal(later.C.added.agent, 'bot-y');
  assert.equal(later.B.started.agent, 'bot-z');
  assert.deepEqual(activity('--compact').B.added, first);
});
