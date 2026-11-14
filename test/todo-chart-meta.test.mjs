// a101 K4/K5 Store side: chart identity `.lattice/chart.json`. docs/architecture/dfd-charts-read.md

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildTodoPlan, createTodoStoreWriter, initializeAuthoredTodoStore, readTodoChartMeta, readTodoStore,
  writeTodoChartMeta,
} from '../src/todo-store.mjs';

const EMPTY = { name: null, created_by: null, created_at: null, repo: null };

async function chartDir(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-chart-meta-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

const createStore = (repoRoot, chartCreator) => initializeAuthoredTodoStore({
  repoRoot, writer: createTodoStoreWriter({ caller: 'g5-authoring' }), projectId: 'project',
  repositories: [{ repo_id: 'self', path: '.' }], ...(chartCreator === undefined ? {} : { chartCreator }),
  plan: buildTodoPlan({
    schema: 'lattice.todo_plan.v7', project_id: 'project', plan_key: 'main', plan_version: 'v1',
    predecessor_plan_digest: null,
    tasks: [{ task_id: 'a', title: 'a', lane: 'main', design_memo: 'NO_PLAN', narrative_ref: null,
      narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'phase' }],
    phases: [{ phase_id: 'phase', title: 'Phase', gate_policy: 'heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['gate'] }],
    hard_dependencies: [], joins: [], phase_accept_dependencies: [],
  }),
  genesis: { actor: { host: 'h', session: 's', agent: 'a' }, recorded_at: '2026-11-14T00:00:00.000Z' },
});

test('identity before the first plan: written atomically, creator recorded once, then Store creation keeps it', async (context) => {
  const root = await chartDir(context);
  assert.deepEqual(await readTodoChartMeta({ repoRoot: root }), EMPTY);

  const named = await writeTodoChartMeta({ repoRoot: root, patch: { name: '工程表' } });
  assert.equal(named.unchanged, false);
  assert.deepEqual({ ...named.meta, created_at: null }, { ...EMPTY, name: '工程表' });
  assert.match(named.meta.created_at, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(JSON.parse(await readFile(path.join(root, '.lattice/chart.json'), 'utf8')).schema, 'lattice.chart_meta.v1');
  assert.deepEqual(await writeTodoChartMeta({ repoRoot: root, patch: { name: '工程表' } }), { meta: named.meta, unchanged: true });

  // created_by applies only while unrecorded; the Store-creating run is that first recorder.
  await createStore(root, 'bot-first');
  assert.equal((await readTodoStore({ repoRoot: root })).project_id, 'project');
  const created = await readTodoChartMeta({ repoRoot: root });
  assert.deepEqual(created, { ...named.meta, created_by: 'bot-first' });
  await writeTodoChartMeta({ repoRoot: root, patch: { created_by: 'bot-second' } });
  assert.equal((await readTodoChartMeta({ repoRoot: root })).created_by, 'bot-first');

  const repo = { url: 'https://example.invalid/r.git', branch: 'main', accepted_tip: null };
  assert.deepEqual((await writeTodoChartMeta({ repoRoot: root, patch: { repo } })).meta.repo, repo);
  assert.equal((await writeTodoChartMeta({ repoRoot: root, patch: { repo: null } })).meta.repo, null);
  assert.equal((await readTodoChartMeta({ repoRoot: root })).name, '工程表');
  await assert.rejects(writeTodoChartMeta({ repoRoot: root, patch: { created_at: 'x' } }), TypeError);
});

test('a Store created with no seat id still records created_at; a fresh git-inited dir needs nothing else', async (context) => {
  const root = await chartDir(context);
  await createStore(root);
  const meta = await readTodoChartMeta({ repoRoot: root });
  assert.equal(meta.created_by, null);
  assert.match(meta.created_at, /^\d{4}-\d\d-\d\dT/u);
});

test('a malformed chart.json is chart_meta_invalid; a newer one asks for an upgrade', async (context) => {
  const root = await chartDir(context);
  await mkdir(path.join(root, '.lattice'));
  await writeFile(path.join(root, '.lattice/chart.json'), '{"schema":"lattice.chart_meta.v1","name":1}\n');
  await assert.rejects(readTodoChartMeta({ repoRoot: root }), { code: 'STORE_INCONSISTENT', detail: { ref: '.lattice/chart.json', reason: 'chart_meta_invalid' } });
  await assert.rejects(writeTodoChartMeta({ repoRoot: root, patch: { name: 'x' } }), { code: 'STORE_INCONSISTENT' });
  await writeFile(path.join(root, '.lattice/chart.json'), '{"schema":"lattice.chart_meta.v2"}\n');
  await assert.rejects(readTodoChartMeta({ repoRoot: root }), (error) => error.code === 'UNSUPPORTED_SCHEMA' && error.detail.reason === 'newer_lattice_value');
});
