// sweep-list: `todo nudge` returns the ready set by lane, each task prompted to fire and, if it cannot move, to stop.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function success(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' } });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function root(context) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lattice-nudge-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' });
  return dir;
}
const nudge = (dir) => success(dir, ['todo', 'nudge', '--json']);
const ids = (result) => result.lanes.map(({ lane, tasks }) => [lane, tasks.map(({ task_id: id }) => id)]);

test('the ready set by lane; started, blocked and waiting tasks are not listed; enforced plans declare first', async (context) => {
  const dir = await root(context);
  // No Store yet: an empty list, not a refusal.
  assert.deepEqual([nudge(dir).project_id, nudge(dir).lanes], [null, []]);
  await writeFile(path.join(dir, 'a.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'a', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [['P', 'bot-a'], ['Q', 'bot-b'], ['R', 'bot-a'], ['S', null]].map(([task_id, lane]) => ({
      task_id, title: task_id, phase_id: 'p', ...(lane === null ? {} : { lane }), design_memo: 'NO_PLAN' })),
    hard_dependencies: [{ from: { task_id: 'P' }, to: { task_id: 'Q' } }],
  }));
  success(dir, ['plan', 'create', '--input', 'a.json']);
  const first = nudge(dir);
  assert.equal(first.schema, 'lattice.todo_nudge_result.v1');
  // Q waits on P: not listed. A task with no lane given gets the plan's default lane `main`.
  assert.deepEqual(ids(first), [['bot-a', ['P', 'R']], ['main', ['S']]]);
  const [p] = first.lanes[0].tasks;
  assert.deepEqual(p.fire_actions, ['lattice todo start --plan a --task P']);
  assert.equal(p.stop_action, 'lattice todo block --plan a --task P --reason <why it cannot move>');
  assert.equal(p.prompt, 'a/P 「P」: its predecessors are finished and it is not started.'
    + ' Fire it: `lattice todo start --plan a --task P`.'
    + ' If it cannot move once fired, set a stop: `lattice todo block --plan a --task P --reason <why it cannot move>`.');

  // Fired then stopped: P leaves the list (blocked is not ready); R started leaves too.
  success(dir, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  success(dir, ['todo', 'block', '--plan', 'a', '--task', 'P', '--reason', 'cannot move']);
  success(dir, ['todo', 'start', '--plan', 'a', '--task', 'R']);
  assert.deepEqual(ids(nudge(dir)), [['main', ['S']]]);
  // P finished: Q, whose predecessor is now done, is listed for its lane.
  success(dir, ['todo', 'unblock', '--plan', 'a', '--task', 'P']);
  success(dir, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']);
  assert.deepEqual(ids(nudge(dir)), [['bot-b', ['Q']], ['main', ['S']]]);

  // Enforced plan without Q's witness row: the declare command comes first; once declared, start alone.
  success(dir, ['todo', 'independence', 'mode', '--plan', 'a', '--set', 'enforced', '--reason', 'gates']);
  const [q] = nudge(dir).lanes[0].tasks;
  assert.deepEqual(q.fire_actions, ['lattice todo independence witness declare --plan a --task Q --owns <path>[,<path>...]',
    'lattice todo start --plan a --task Q']);
  assert.match(q.prompt, /Fire it: `lattice todo independence witness declare [^`]+` then `lattice todo start --plan a --task Q`\./u);
  success(dir, ['todo', 'independence', 'witness', 'declare', '--plan', 'a', '--task', 'Q', '--owns', 'src/q.js']);
  assert.deepEqual(nudge(dir).lanes[0].tasks[0].fire_actions, ['lattice todo start --plan a --task Q']);
});
