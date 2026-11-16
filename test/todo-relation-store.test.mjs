// ADR 0204 a4: per-plan relation record (Store). docs/architecture/dfd-store-relations.md
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';
import { readTodoRelationSummary, readTodoTaskRelations, transactTodoRelations } from '../src/todo-relation-store.mjs';
import { createTodoStoreWriter, initializeTodoStore, readTodoWitnessSet } from '../src/todo-store.mjs';

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'bin/lattice.mjs');
const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const NOW = '2026-11-16T00:00:00.000Z';
const writer = createTodoStoreWriter({ caller: 'todo-relations' });
const entry = (symbol, access, start = 10, end = 20) => ({ symbol, start_line: start, end_line: end, access });
const overlap = (symbol = 'f') => [{ a: entry(symbol, 'write'), b: entry(symbol, 'read') }];
const relation = (a, b, symbol) => ({ task_a: a, task_b: b, path: 'src/x.mjs', overlaps: overlap(symbol) });

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-relations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  const task = (id) => ({ task_id: id, title: id, lane: 'main', narrative_ref: null, compile_binding: null });
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      predecessor_plan_digest: null, tasks: [task('A'), task('B'), task('C')], hard_dependencies: [], joins: [] },
    genesis: { actor: ACTOR, recorded_at: NOW } }],
    now: NOW,
  });
  return root;
}

const transact = (root, update) => transactTodoRelations({ repoRoot: root, planKey: 'main', writer, update });

function cli(root, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env,
    NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_TODO_ACTOR_HOST: ACTOR.host,
    LATTICE_TODO_ACTOR_SESSION: ACTOR.session, LATTICE_TODO_ACTOR_AGENT: ACTOR.agent } });
  assert.equal(result.status, 0, result.stderr);
}

test('no records: the summary is null, a no-op call writes nothing', async (t) => {
  const root = await workspace(t);
  assert.equal(await readTodoRelationSummary({ repoRoot: root, planKey: 'main' }), null);
  const seen = [];
  const result = await transact(root, (input) => { seen.push(input); return {}; });
  assert.deepEqual(seen[0], { witnessSet: null, openRelations: [], logSequence: 0, unfinishedTaskIds: ['A', 'B', 'C'] });
  assert.equal(result.summary, null);
  assert.equal(await readTodoRelationSummary({ repoRoot: root, planKey: 'main' }), null);
});

test('append, replace, identical no-op, gone by key; summary tracks the open set', async (t) => {
  const root = await workspace(t);
  const first = await transact(root, () => ({ relations: [relation('A', 'B', 'f'), relation('A', 'C', 'g')],
    headSha: 'sha1', unresolvedCount: 1, computedAt: NOW }));
  assert.equal(first.appended, 2);
  assert.deepEqual(first.summary, await readTodoRelationSummary({ repoRoot: root, planKey: 'main' }));
  assert.equal(first.summary.relation_count, 2);
  assert.equal(first.summary.unresolved_count, 1);
  assert.equal(first.summary.head_sha, 'sha1');
  assert.equal(first.summary.log_sequence, 2);
  assert.equal(first.summary.open_relations[0].task_b, 'C');   // newest first

  // identical content is a no-op; changed content replaces (old closed, one open per key)
  const again = await transact(root, () => ({ relations: [relation('A', 'B', 'f')], headSha: 'sha1' }));
  assert.equal(again.appended, 0);
  assert.equal(again.summary.log_sequence, 2);
  const replaced = await transact(root, () => ({ relations: [relation('A', 'B', 'h')], headSha: 'sha2' }));
  assert.deepEqual([replaced.appended, replaced.gone], [1, 1]);
  assert.equal(replaced.summary.relation_count, 2);
  assert.equal(replaced.summary.head_sha, 'sha2');
  assert.equal((await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'B' })).open[0].overlaps[0].a.symbol, 'h');

  const closed = await transact(root, () => ({ gone: [{ task_a: 'A', task_b: 'C', path: 'src/x.mjs' },
    { task_a: 'B', task_b: 'C', path: 'nope' }] }));
  assert.equal(closed.summary.relation_count, 1);
  assert.equal(closed.summary.head_sha, 'sha2');            // kept when the call gives none
  assert.equal(closed.summary.unresolved_count, 1);
  const history = (await readFile(path.join(root, '.lattice/todo/relations/main/log.jsonl'), 'utf8')).trim().split('\n')
    .map((entry) => JSON.parse(entry));
  assert.deepEqual(history.map(({ sequence, kind }) => [sequence, kind]),
    [[1, 'relation'], [2, 'relation'], [3, 'gone'], [4, 'relation'], [5, 'gone']]);
});

test('a finished task closes its relations by itself and is never related again', async (t) => {
  const root = await workspace(t);
  await transact(root, () => ({ relations: [relation('A', 'B', 'f'), relation('B', 'C', 'g')], headSha: 'h' }));
  cli(root, ['todo', 'start', '--plan', 'main', '--task', 'C']);
  cli(root, ['todo', 'done', '--plan', 'main', '--task', 'C', '--message', 'done']);
  const result = await transact(root, ({ unfinishedTaskIds }) => {
    assert.deepEqual(unfinishedTaskIds, ['A', 'B']);
    return { relations: [relation('A', 'C', 'late')] };
  });
  assert.deepEqual([result.appended, result.summary.relation_count], [0, 1]);
  assert.equal(result.summary.open_relations[0].task_b, 'B');
});

test('the summary is bounded at 20 and says it is truncated', async (t) => {
  const root = await workspace(t);
  const many = Array.from({ length: 25 }, (_, index) => ({ task_a: 'A', task_b: 'B', path: `src/f${index}.mjs`,
    overlaps: overlap() }));
  const result = await transact(root, () => ({ relations: many }));
  assert.equal(result.summary.relation_count, 25);
  assert.equal(result.summary.open_relations.length, 20);
  assert.equal(result.summary.open_truncated, true);
});

test('witness set and relations go in one call; two calls cannot both read the same old state', async (t) => {
  const root = await workspace(t);
  const witnessSet = { schema: 'lattice.todo_witness_set.v5', project_id: 'project-1', plan_key: 'main',
    capacity: { executors: 2 }, sensor_query_set: { queries: [{ id: 'status', operation: 'status' }] },
    manual_witness: { A: { owns: [{ kind: 'path', target: 'src/x.mjs' }], reads: [], writes: ['src/x.mjs'], resources: [],
      state_effects: [], sensor_provenance: { queries: [] }, affected_tests: ['test/a.test.mjs'], unknowns: [] } },
    witness_set_digest: '' };
  witnessSet.witness_set_digest = todoSelfDigest(witnessSet, 'witness_set_digest');
  await transact(root, () => ({ witnessSet, relations: [relation('A', 'B', 'f')] }));
  assert.deepEqual(await readTodoWitnessSet({ repoRoot: root, planKey: 'main' }), witnessSet);

  // an invalid witness set is refused before the log or summary change
  await assert.rejects(transact(root, () => ({ witnessSet: { schema: 'x' }, relations: [relation('A', 'C', 'g')] })),
    { code: 'INVALID_TODO_WITNESS_SET' });
  assert.equal((await readTodoRelationSummary({ repoRoot: root, planKey: 'main' })).relation_count, 1);

  // Processes serialize on the lock: each one sees the others' relations. (The same process re-entering is refused at once.)
  const script = `import { transactTodoRelations } from ${JSON.stringify(new URL('../src/todo-relation-store.mjs', import.meta.url).href)};
import { createTodoStoreWriter } from ${JSON.stringify(new URL('../src/todo-store.mjs', import.meta.url).href)};
const n = process.argv[1];
await transactTodoRelations({ repoRoot: process.argv[2], planKey: 'main', writer: createTodoStoreWriter({ caller: 'todo-relations' }),
  update: async ({ logSequence }) => { await new Promise((r) => setTimeout(r, 150));
    return { relations: [{ task_a: 'B', task_b: 'C', path: 'src/p' + n + '.mjs',
      overlaps: [{ a: { symbol: 'f', start_line: 1, end_line: 2, access: 'write' }, b: { symbol: 'f', start_line: 1, end_line: 2, access: 'read' } }] }] }; } });`;
  const children = [1, 2, 3].map((n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(n), root], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  }));
  await Promise.all(children);
  const summary = await readTodoRelationSummary({ repoRoot: root, planKey: 'main' });
  assert.equal(summary.relation_count, 4);
  assert.equal(summary.log_sequence, 4);
});

test('bad input is refused; a damaged or newer file is typed, not silently read', async (t) => {
  const root = await workspace(t);
  const refused = (result) => assert.rejects(transact(root, () => result), TypeError);
  await refused({ relations: [relation('B', 'A', 'f')] });                       // pair order
  await refused({ relations: [{ ...relation('A', 'B', 'f'), overlaps: [] }] });  // empty overlap
  await refused({ relations: [relation('A', 'B', 'f'), relation('A', 'B', 'g')] }); // duplicate key
  await refused({ unknown: true });
  await assert.rejects(transactTodoRelations({ repoRoot: root, planKey: 'nope', writer, update: () => ({}) }), TypeError);
  await assert.rejects(transactTodoRelations({ repoRoot: root, planKey: 'main', writer: { caller: 'x' }, update() {} }),
    TypeError);

  await transact(root, () => ({ relations: [relation('A', 'B', 'f')], headSha: null }));
  const summaryPath = path.join(root, '.lattice/todo/relations/main/summary.json');
  const good = await readFile(summaryPath, 'utf8');
  await writeFile(summaryPath, good.replace('"lattice.todo_relation_summary.v1"', '"lattice.todo_relation_summary.v2"'));
  await assert.rejects(readTodoRelationSummary({ repoRoot: root, planKey: 'main' }), { code: 'UNSUPPORTED_SCHEMA' });
  await writeFile(summaryPath, '{"schema":"lattice.todo_relation_summary.v1"}\n');
  await assert.rejects(readTodoRelationSummary({ repoRoot: root, planKey: 'main' }),
    { code: 'STORE_INCONSISTENT', detail: { reason: 'relation_summary_invalid', ref: '.lattice/todo/relations/main/summary.json' } });
  await writeFile(summaryPath, good);
  await writeFile(path.join(root, '.lattice/todo/relations/main/open/A.json'), '{"nope":1}\n');
  await assert.rejects(readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'A' }),
    { code: 'STORE_INCONSISTENT',
      detail: { reason: 'relation_log_invalid', ref: '.lattice/todo/relations/main/open/A.json' } });
});

test('a crash between the task files and the summary heals on the next write', async (t) => {
  const root = await workspace(t);
  await transact(root, () => ({ relations: [relation('A', 'B', 'f')], headSha: 'h' }));
  const summaryPath = path.join(root, '.lattice/todo/relations/main/summary.json');
  const good = JSON.parse(await readFile(summaryPath, 'utf8'));
  await writeFile(summaryPath, `${JSON.stringify({ ...good, log_sequence: 0, relation_count: 0, open_relations: [],
    open_truncated: false })}\n`);
  const healed = await transact(root, () => ({}));
  assert.equal(healed.summary.log_sequence, 1);
  assert.equal(healed.summary.relation_count, 1);
});

const relDir = (root) => path.join(root, '.lattice/todo/relations/main');

test('a4c: the history is never read or rewritten, so it can never stop recording', async (t) => {
  const root = await workspace(t);
  await transact(root, () => ({ relations: [relation('A', 'B', 'f')], headSha: 'h' }));
  // a history far past the old 64 MB stop, and a line that is not even JSON: neither a read nor a write opens it
  const log = path.join(relDir(root), 'log.jsonl');
  const before = await readFile(log, 'utf8');
  await writeFile(log, `${'x'.repeat(70 * 1024 * 1024)}\n${before}`);
  const next = await transact(root, () => ({ relations: [relation('A', 'C', 'g')], headSha: 'h' }));
  assert.equal(next.appended, 1);
  assert.equal(next.summary.relation_count, 2);
  const read = await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'A' });
  assert.deepEqual(read.open.map(({ task_b: other }) => other), ['B', 'C']);
  // the oversize history was sealed whole, never read; the new line starts a fresh log
  assert.equal((await stat(path.join(relDir(root), 'log-1.jsonl'))).size > 70 * 1024 * 1024, true);
  assert.equal(JSON.parse(await readFile(log, 'utf8')).task_b, 'C');
});

test('a4c: a task reads its own open relations and the plan counts from two small files', async (t) => {
  const root = await workspace(t);
  assert.equal(await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'A' }), null);   // no record
  await transact(root, () => ({ relations: [relation('A', 'B', 'f'), relation('B', 'C', 'g')], headSha: 'sha', unresolvedCount: 3 }));
  assert.deepEqual(await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'B' }), {
    relation_count: 2, unresolved_count: 3, head_sha: 'sha',
    open: [relation('A', 'B', 'f'), relation('B', 'C', 'g')].map(({ task_a: a, task_b: b, path: where, overlaps }) => ({
      task_a: a, task_b: b, path: where, overlaps })) });
  const none = await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'D' });
  assert.deepEqual([none.relation_count, none.open], [2, []]);
  // another task's damaged file is never opened
  await writeFile(path.join(relDir(root), 'open/C.json'), 'not json');
  assert.equal((await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'A' })).open.length, 1);
  await assert.rejects(readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'C' }), { code: 'STORE_INCONSISTENT' });
  await assert.rejects(readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'a b' }), TypeError);
  // a plan whose last relation closed reads as "none"
  const root2 = await workspace(t);
  await transact(root2, () => ({ relations: [relation('A', 'B', 'f')], headSha: 'h' }));
  await transact(root2, () => ({ gone: [{ task_a: 'A', task_b: 'B', path: 'src/x.mjs' }] }));
  assert.equal(await readTodoTaskRelations({ repoRoot: root2, planKey: 'main', taskId: 'A' }), null);
  await assert.rejects(readFile(path.join(relDir(root2), 'open/A.json')), { code: 'ENOENT' });   // no empty file left
});

test('a4c: a relation written to one task only is completed, and a full history log is sealed', async (t) => {
  const root = await workspace(t);
  await transact(root, () => ({ relations: [relation('A', 'B', 'f')], headSha: 'h' }));
  await rm(path.join(relDir(root), 'open/B.json'));                                  // the crash left only A's side
  const healed = await transact(root, () => ({}));
  assert.equal(healed.appended, 0);
  assert.equal((await readTodoTaskRelations({ repoRoot: root, planKey: 'main', taskId: 'B' })).open.length, 1);

  await writeFile(path.join(relDir(root), 'log.jsonl'), 'y'.repeat(4 * 1024 * 1024));
  await transact(root, () => ({ relations: [relation('A', 'C', 'g')] }));
  const sealed = (await readdir(relDir(root))).filter((name) => name.startsWith('log-'));
  assert.deepEqual(sealed, ['log-1.jsonl']);
  assert.equal((await readFile(path.join(relDir(root), 'log.jsonl'), 'utf8')).trim().split('\n').length, 1);
});
