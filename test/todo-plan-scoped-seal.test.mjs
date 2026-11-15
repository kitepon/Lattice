// s1-seal: the plan-scoped chain seals at a full segment instead of refusing every write (production outage
// 2026-11-15). docs/architecture/dfd-store-phase-revision.md "Plan-scoped chain sealing".

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_LIMITS } from '../src/todo-contracts.mjs';
import { projectTodoCrossPlanDependencies, readTodoStore } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_CHARTS_ROOT: path.dirname(cwd),
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
}

const planInput = (planKey, tasks) => JSON.stringify({
  schema: 'lattice.plan_create_input.v5', plan_key: planKey, phases: [{ phase_id: 'p', title: 'phase' }],
  tasks: tasks.map((id) => ({ task_id: id, title: id, phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
  hard_dependencies: [],
});

const sealedOf = async (chart, member) => readdir(path.join(chart, path.dirname(member.descriptor.journal_ref),
  'plan-scoped-sealed')).catch(() => []);

test('a plan-scoped chain past one segment seals and keeps accepting connect, start, block, mode and todo add', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-scoped-seal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chart = path.join(root, 'beta');
  await mkdir(chart);
  execFileSync('git', ['init', '--quiet'], { cwd: chart, stdio: 'pipe' });
  const ok = (args) => {
    const result = run(chart, args);
    assert.equal(result.status, 0, `${args.slice(0, 3).join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  // Largest reasons the contract allows, so few events fill a segment.
  const reason = 'x'.repeat(16_000);
  const sources = Array.from({ length: Math.ceil(TODO_LIMITS.journalSegmentBytes / reason.length) + 2 },
    (_, index) => `Q${index}`);
  for (const [planKey, tasks] of [['b', ['R', 'T', 'U']], ['c', sources]]) {
    await writeFile(path.join(chart, 'plan.json'), planInput(planKey, tasks));
    ok(['plan', 'create', '--input', 'plan.json']);
  }
  for (const source of sources) {
    ok(['todo', 'dependency', 'connect', '--from-plan', 'c', '--from-task', source,
      '--to-plan', 'b', '--to-task', 'R', '--reason', reason]);
  }
  const b = (store) => store.members.find(({ plan }) => plan.plan_key === 'b');
  const connected = await readTodoStore({ repoRoot: chart });
  assert.equal((await sealedOf(chart, b(connected))).length, 1, 'the active chain sealed once');
  const chain = b(connected).plan_scoped.events;
  assert.equal(chain.length, sources.length);
  assert.deepEqual(chain.map(({ sequence }) => sequence), sources.map((_, index) => index));
  assert.equal(projectTodoCrossPlanDependencies(connected.members).length, sources.length);
  // Replays the same: a second read gives the identical chain.
  assert.deepEqual(b(await readTodoStore({ repoRoot: chart })).plan_scoped.events, chain);

  // Every write that refused in production goes through.
  ok(['todo', 'start', '--plan', 'b', '--task', 'T']);
  ok(['todo', 'start', '--plan', 'b', '--task', 'U', '--parallel-frontier']);
  ok(['todo', 'block', '--plan', 'b', '--task', 'U', '--reason', 'waits']);
  ok(['todo', 'independence', 'mode', '--plan', 'b', '--set', 'conversation', '--reason', 'talk']);
  const declared = b(await readTodoStore({ repoRoot: chart }));
  assert.equal(declared.coordination.mode, 'conversation');
  assert.equal(declared.plan_scoped.events.length, sources.length + 1);

  // todo add: the successor's carried edges alone exceed a segment, so it seals too.
  ok(['todo', 'add', '--plan', 'b', '--task', 'N', '--title', 'N', '--phase', 'p',
    '--design-memo', 'NO_PLAN', '--reason', 'found later']);
  const added = await readTodoStore({ repoRoot: chart });
  assert.notEqual(b(added).plan.plan_version, 'v1');
  assert.equal((await sealedOf(chart, b(added))).length, 1, 'the successor sealed its carried edges');
  assert.equal(projectTodoCrossPlanDependencies(added.members).length, sources.length);
  assert.deepEqual(added.cross_plan_findings, []);
  ok(['todo', 'start', '--plan', 'b', '--task', 'N']);
});
