// blockers-list: `todo blockers` returns every blocked task with its full reason, who stopped it and when, and the
// unblock command; any seat may unblock.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function success(root, args, agent = 'fixture') {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: agent, LATTICE_TODO_ACTOR_AGENT: agent } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test('every blocked task with title, lane, full reason, when and by whom; any seat unblocks', async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lattice-blockers-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
  const blockers = () => success(dir, ['todo', 'blockers', '--json']);
  // No Store yet: an empty list, not a refusal.
  assert.deepEqual([blockers().project_id, blockers().blockers], [null, []]);

  for (const key of ['b', 'a']) {
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify({
      schema: 'lattice.plan_create_input.v5', plan_key: key, phases: [{ phase_id: 'p', title: 'phase' }],
      tasks: [['T', 'bot-a'], ['U', 'bot-b']].map(([task_id, lane]) => ({
        task_id, title: `${key} ${task_id}`, phase_id: 'p', lane, design_memo: 'NO_PLAN' })),
    }));
    success(dir, ['plan', 'create', '--input', `${key}.json`]);
  }
  assert.deepEqual(blockers().blockers, []);
  const long = `cannot move: ${'x'.repeat(300)}`;
  for (const [key, task, agent] of [['b', 'U', 'bot-b'], ['a', 'T', 'bot-a']]) {
    success(dir, ['todo', 'start', '--plan', key, '--task', task], agent);
    success(dir, ['todo', 'block', '--plan', key, '--task', task, '--reason', long], agent);
  }
  success(dir, ['todo', 'start', '--plan', 'a', '--task', 'U'], 'bot-b');
  const first = blockers();
  assert.equal(first.schema, 'lattice.todo_blockers_result.v1');
  assert.deepEqual(first.blockers.map(({ blocked_at: at, ...rest }) => (assert.ok(!Number.isNaN(Date.parse(at))), rest)), [
    { plan_key: 'a', task_id: 'T', title: 'a T', lane: 'bot-a', reason: long,
      blocked_by: { host: 'fixture', session: 'bot-a', agent: 'bot-a' },
      unblock_action: 'lattice todo unblock --plan a --task T' },
    { plan_key: 'b', task_id: 'U', title: 'b U', lane: 'bot-b', reason: long,
      blocked_by: { host: 'fixture', session: 'bot-b', agent: 'bot-b' },
      unblock_action: 'lattice todo unblock --plan b --task U' },
  ]);

  // Another seat lifts a stop with the listed command; blocked again, the newest block event is shown.
  success(dir, ['todo', 'unblock', '--plan', 'a', '--task', 'T'], 'owner');
  success(dir, ['todo', 'block', '--plan', 'a', '--task', 'T', '--reason', 'again'], 'bot-c');
  const again = blockers().blockers;
  assert.deepEqual(again.map(({ task_id: id, reason, blocked_by: by }) => [id, reason, by.agent]),
    [['T', 'again', 'bot-c'], ['U', long, 'bot-b']]);
  success(dir, ['todo', 'unblock', '--plan', 'a', '--task', 'T'], 'owner');
  success(dir, ['todo', 'unblock', '--plan', 'b', '--task', 'U'], 'bot-c');
  assert.deepEqual(blockers().blockers, []);
});
