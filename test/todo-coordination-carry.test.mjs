// m1: a revision carries the plan's effective coordination declaration into its own plan-scoped chain, so a read of the new
// version finds it there instead of walking (and opening) every retained predecessor. docs/architecture/dfd-store-phase-revision.md
// "Coordination declaration travels with the plan".

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoStore } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_CHARTS_ROOT: path.dirname(cwd),
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
}

test('a revision carries the coordination declaration, so a read needs no retained predecessor', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-coordination-carry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chart = path.join(root, 'delta');
  await mkdir(chart);
  execFileSync('git', ['init', '--quiet'], { cwd: chart, stdio: 'pipe' });
  const ok = (args) => {
    const result = run(chart, args);
    assert.equal(result.status, 0, `${args.slice(0, 3).join(' ')}\n${result.stderr}\n${result.stdout}`);
  };
  await writeFile(path.join(chart, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'd', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [{ task_id: 'A', title: 'A', phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' }], hard_dependencies: [],
  }));
  ok(['plan', 'create', '--input', 'plan.json']);
  ok(['todo', 'independence', 'mode', '--plan', 'd', '--set', 'conversation', '--reason', 'talk first']);
  const declared = (await readTodoStore({ repoRoot: chart })).members[0].coordination;
  for (const task of ['B', 'C']) {
    ok(['todo', 'add', '--plan', 'd', '--task', task, '--title', task, '--phase', 'p', '--design-memo', 'NO_PLAN', '--reason', 'later']);
  }
  const base = path.join(chart, '.lattice/todo/plans/d');
  const [active] = (await readTodoStore({ repoRoot: chart })).members.map(({ plan }) => plan.plan_version);
  const retained = (await readdir(base)).filter((version) => version !== active);
  assert.equal(retained.length, 2, 'two retained predecessors');
  const carried = (await readTodoStore({ repoRoot: chart })).members[0];
  assert.equal(carried.plan_scoped.events.filter(({ kind }) => kind === 'coordination_mode').length, 1);
  assert.deepEqual({ ...carried.coordination, event_digest: null }, { ...declared, event_digest: null },
    'same mode, reason, author and time as the original declaration');
  // The declaration is in the version's own chain: no retained predecessor is needed to read it.
  for (const version of retained) await rm(path.join(base, version), { recursive: true });
  assert.equal((await readTodoStore({ repoRoot: chart })).members[0].coordination.mode, 'conversation');
});
