// wait-impl: a lane that stopped work to wait for a task is named on that task's notice, so delivery must wake it;
// the wait is a host-local record that survives processes and clears itself on start or retire.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args, agent) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: agent } });
}
function success(root, args, agent = 'bot-a') {
  const result = run(root, args, agent);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-wait-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  await writeFile(path.join(root, 'a.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'a', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [['P', 'bot-a'], ['Q', 'bot-b'], ['S', 'bot-b']]
      .map(([task_id, lane]) => ({ task_id, title: task_id, phase_id: 'p', lane, design_memo: 'NO_PLAN' })),
    hard_dependencies: [{ from: { task_id: 'P' }, to: { task_id: 'Q' } }],
  }));
  success(root, ['plan', 'create', '--input', 'a.json']);
  return root;
}
const wait = (task, ...flags) => ['todo', 'wait', '--plan', 'a', '--task', task, ...flags];

test('a waiting lane is named on the notice; a wait added after an ack re-opens it for the uncovered only', async (context) => {
  const root = await fixture(context);
  const waiting = success(root, wait('Q', '--reason', 'idle until P lands'), 'bot-b');
  assert.equal(waiting.schema, 'lattice.todo_wait_result.v1');
  assert.deepEqual([waiting.state, waiting.agent, waiting.reason], ['waiting', 'bot-b', 'idle until P lands']);
  // Repeating keeps since and takes the new reason.
  const again = success(root, wait('Q', '--reason', 'still idle'), 'bot-b');
  assert.deepEqual([again.state, again.since, again.reason], ['waiting', waiting.since, 'still idle']);
  // Host-local and git-ignored, flat beside the ack sets.
  assert.deepEqual((await readdir(path.join(root, '.lattice/todo/notices'))).filter((name) => name.startsWith('wait-')).length, 1);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.lattice/todo/notices'], { cwd: root, encoding: 'utf8' }), '');

  success(root, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const [notice] = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']).notices;
  assert.equal(notice.task_id, 'Q');
  assert.deepEqual(notice.waiting, [{ agent: 'bot-b', since: waiting.since, reason: 'still idle' }]);
  assert.match(notice.waiting_digest, /^[0-9a-f]{64}$/u);
  assert.match(notice.summary, /^a\/Q 「Q」 can start now\. bot-b waiting since /u);
  assert.deepEqual(notice.acked_recipients, []);
  // Another process reads the same waiter (the record survives the process that wrote it).
  const list = success(root, ['todo', 'notice', 'list'], 'bot-z');
  const [listed] = list.notices;
  assert.deepEqual([listed.notice_id, listed.waiting, listed.acked], [notice.notice_id, notice.waiting, false]);
  assert.deepEqual(list.wait_unreadable, []);

  success(root, ['todo', 'notice', 'ack', '--lane', 'bot-b', '--notice', notice.notice_id], 'bot-z');
  assert.deepEqual(success(root, ['todo', 'notice', 'list', '--lane', 'bot-b']).notices, []);
  // Q is startable now: a new wait records nothing and answers with the open notice.
  const late = success(root, wait('Q'), 'bot-c');
  assert.deepEqual([late.state, late.notice.notice_id, late.next_action],
    ['startable_now', notice.notice_id, 'lattice todo start --plan a --task Q']);
  assert.equal(success(root, ['todo', 'notice', 'list', '--lane', 'bot-b']).notices.length, 0);

  // Starting Q clears the wait; a retract does not bring it back.
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'Q'], 'bot-b');
  success(root, ['todo', 'retract', '--plan', 'a', '--task', 'Q', '--reason', 'not yet'], 'bot-b');
  const [back] = success(root, ['todo', 'notice', 'list', '--include-acked']).notices;
  assert.deepEqual([back.notice_id, back.waiting, back.acked], [notice.notice_id, [], false]);
  // The earlier ack still covers the lane and the old waiter: delivery skips them.
  assert.deepEqual(back.acked_recipients, ['bot-b']);
});

test('wait answers a state instead of refusing; --cancel removes it; a summary without waiters says information', async (context) => {
  const root = await fixture(context);
  assert.deepEqual(success(root, wait('S')).state, 'startable_now');
  success(root, ['todo', 'start', '--plan', 'a', '--task', 'P']);
  const busy = success(root, wait('P'));
  assert.deepEqual([busy.state, busy.status], ['not_pending', 'in-progress']);
  assert.equal(success(root, wait('Q'), 'bot-b').state, 'waiting');
  const cancelled = success(root, wait('Q', '--cancel'), 'bot-b');
  assert.deepEqual([cancelled.state, cancelled.cancelled], ['cancelled', true]);
  assert.equal(success(root, wait('Q', '--cancel'), 'bot-b').cancelled, false);
  const [notice] = success(root, ['todo', 'done', '--plan', 'a', '--task', 'P', '--message', 'merged']).notices;
  assert.deepEqual(notice.waiting, []);
  assert.match(notice.summary, /Information, not a request: whether and when to start is the lane's call\.$/u);
  const refused = run(root, wait('Q', '--cancel', '--reason', 'x'), 'bot-b');
  assert.notEqual(refused.status, 0);
});
