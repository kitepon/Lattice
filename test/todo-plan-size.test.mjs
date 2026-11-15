// k1-drop-count-caps (ADR 0201): a plan has no task, edge, join or phase count cap; its size is bounded by bytes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTodoStore } from '../src/todo-store.mjs';
import { TODO_LIMITS } from '../src/todo-contracts.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

test('a 600-task plan with 150 joins and 3000 edges accepts todo add and replays', { timeout: 120000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-plan-size-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  const run = (args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
        LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr.slice(0, 600)}\n${result.stdout.slice(0, 600)}`);
    return JSON.parse(result.stdout);
  };
  const ids = Array.from({ length: 600 }, (_, index) => `t${String(index).padStart(4, '0')}`);
  const ref = (id) => ({ task_id: id });
  // 3000 edges: each of t0010..t0600 depends on up to five earlier tasks; the first ten stay roots.
  const edges = [];
  for (let index = 10; index < 600 && edges.length < 3000; index += 1) {
    for (let back = 1; back <= 5 && edges.length < 3000; back += 1) edges.push({ from: ref(ids[index - back]), to: ref(ids[index]) });
  }
  assert.equal(edges.length, 2950);
  for (let index = 590; edges.length < 3000; index -= 1) edges.push({ from: ref(ids[index - 20]), to: ref(ids[index]) });
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'big', phases: [{ phase_id: 'ph', title: 'phase' }],
    tasks: ids.map((id) => ({ task_id: id, title: id, phase_id: 'ph', lane: 'bot-c', design_memo: 'NO_PLAN' })),
    hard_dependencies: edges,
    joins: Array.from({ length: 150 }, (_, index) => ({ id: `j${index}`, after: [ref(ids[index]), ref(ids[index + 1])], before: ref(ids[index + 300]) })),
  }));
  run(['plan', 'create', '--input', 'plan.json']);
  const added = run(['todo', 'add', '--plan', 'big', '--task', 'extra', '--title', 'extra', '--phase', 'ph', '--lane', 'bot-c',
    '--after', 't0599', '--design-memo', 'NO_PLAN']);
  assert.ok(added);
  const store = await readTodoStore({ repoRoot: root });
  const [member] = store.members;
  assert.equal(member.plan.tasks.length, 601);
  assert.ok(member.plan.hard_dependencies.length > 2048);
  assert.equal(member.tasks.length, 601);
  assert.ok(member.plan.joins.length > 128);
  assert.equal(run(['todo', 'status', '--json']).schema, 'lattice.todo_status_result.v10');
  // Size stays bounded by bytes, not by count: the plan file is far below the 8 MiB read cap.
  const bytes = (await stat(path.join(root, member.descriptor.plan_ref))).size;
  assert.ok(bytes < TODO_LIMITS.snapshotBytes, `${bytes} bytes`);
  context.diagnostic(`600 tasks + 3000 edges: plan.json ${bytes} bytes of ${TODO_LIMITS.snapshotBytes}`);
});
