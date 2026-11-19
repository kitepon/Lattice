// g1: a revision genesis carries every task's migrated state in one line. ADR 0201 bounds a plan by bytes, so that line can pass
// journalSegmentBytes (production outage 2026-11-20: bellteam-dev-added, 1,383 tasks). A segment that is exactly one
// sequence-0 plan_genesis may reach snapshotBytes; docs/architecture/dfd-store-phase-revision.md "Oversize genesis segment".

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TODO_LIMITS } from '../src/todo-contracts.mjs';
import { readTodoStore } from '../src/todo-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_CHARTS_ROOT: path.dirname(cwd),
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a' } });
}

test('a revision whose genesis passes one segment is written, read, sealed by the next event and verified', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-genesis-segment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chart = path.join(root, 'gamma');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(chart));
  execFileSync('git', ['init', '--quiet'], { cwd: chart, stdio: 'pipe' });
  const ok = (args) => {
    const result = run(chart, args);
    assert.equal(result.status, 0, `${args.slice(0, 3).join(' ')}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  // Longest identifiers the contract allows, so few tasks fill a segment: each id appears in task_migration and state_migration.
  const tasks = Array.from({ length: 1900 }, (_, index) => `${String(index).padStart(5, '0')}${'t'.repeat(122)}`);
  await writeFile(path.join(chart, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'g', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: tasks.map((id) => ({ task_id: id, title: 'x', phase_id: 'p', lane: 'bot-c', design_memo: 'NO_PLAN' })),
    hard_dependencies: [],
  }));
  ok(['plan', 'create', '--input', 'plan.json']);
  ok(['todo', 'add', '--plan', 'g', '--task', 'N', '--title', 'N', '--phase', 'p', '--design-memo', 'NO_PLAN', '--reason', 'found later']);

  const added = await readTodoStore({ repoRoot: chart });
  const member = added.members.find(({ plan }) => plan.plan_key === 'g');
  const active = path.join(chart, member.descriptor.journal_ref);
  const genesisBytes = (await stat(active)).size;
  assert.ok(genesisBytes > TODO_LIMITS.journalSegmentBytes, `genesis is ${genesisBytes} bytes`);
  assert.ok(genesisBytes <= TODO_LIMITS.snapshotBytes);
  ok(['todo', 'verify', '--plan', 'g', '--json']);

  // The next event seals the oversize genesis alone and starts a new active segment.
  ok(['todo', 'start', '--plan', 'g', '--task', 'N']);
  ok(['todo', 'note', '--plan', 'g', '--task', 'N', '--message', 'after the oversize genesis']);
  const sealed = await readdir(path.join(path.dirname(active), 'sealed'));
  assert.equal(sealed.length, 1);
  assert.ok((await stat(path.join(path.dirname(active), 'sealed', sealed[0]))).size > TODO_LIMITS.journalSegmentBytes);
  assert.ok((await stat(active)).size < TODO_LIMITS.journalSegmentBytes);
  ok(['todo', 'verify', '--plan', 'g', '--json']);
  ok(['todo', 'done', '--plan', 'g', '--task', 'N', '--message', 'done']);
  const finished = (await readTodoStore({ repoRoot: chart })).members.find(({ plan }) => plan.plan_key === 'g');
  assert.equal(finished.tasks.find(({ task_id: id }) => id === 'N').status, 'done');
});
