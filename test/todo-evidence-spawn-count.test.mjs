// b11-evidence-git-spawn-per-write: reading a store whose done tasks carry more than 512 distinct evidence blobs starts git for
// the evidence in batches, not once per blob (the old 512-entry cache sent every extra blob, and every eviction, to its own spawn).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTodoStoreWriter, initializeTodoStore, readTodoStore } from '../src/todo-store.mjs';
import { appendTodoEvent } from './helpers/todo-authoring-store.mjs';

const NOW = '2026-11-15T00:00:00.000Z';
const ACTOR = Object.freeze({ host: 'host-1', session: 'session-1', agent: 'agent-1' });
const WRITER = createTodoStoreWriter({ caller: 'g5-authoring' });
const COUNT = 520;

test(`a store with ${COUNT} distinct evidence blobs reads them with batched cat-file spawns`, { timeout: 280000 }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-evidence-spawn-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const ids = Array.from({ length: COUNT }, (_, index) => `T${String(index).padStart(4, '0')}`);
  await initializeTodoStore({
    repoRoot: root, writer: createTodoStoreWriter({ caller: 'g4-migration' }), projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{ plan: { schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main', plan_version: 'v1',
      predecessor_plan_digest: null, hard_dependencies: [], joins: [],
      tasks: ids.map((id) => ({ task_id: id, title: id, lane: 'main', narrative_ref: null, compile_binding: null })) },
    genesis: { actor: ACTOR, recorded_at: NOW } }],
    now: NOW,
  });
  for (const id of ids) {
    const bytes = Buffer.from(`evidence ${id}\n`);
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: bytes, encoding: 'utf8' }).trim();
    const evidence = { evidence_id: `ev-${id}`, repo_id: 'self', path: `${id}.txt`, git_blob_oid: oid,
      content_digest: createHash('sha256').update(bytes).digest('hex'), media_type: 'text/plain', anchor_digest: null };
    for (const [kind, payload] of [['start', { override_reason: null }], ['done', { evidence }]]) {
      await appendTodoEvent({ repoRoot: root, writer: WRITER, planKey: 'main', now: NOW,
        event: { kind, task_id: id, actor: ACTOR, recorded_at: NOW, payload } });
    }
  }

  // A fresh process (empty cache) reads the store with a `git` that logs every call.
  const shim = await mkdtemp(path.join(tmpdir(), 'lattice-git-shim-'));
  context.after(() => rm(shim, { recursive: true, force: true }));
  const log = path.join(shim, 'calls.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(shim, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${realGit}" "$@"\n`);
  await chmod(path.join(shim, 'git'), 0o755);
  const reader = `import { readTodoStore } from ${JSON.stringify(path.resolve(import.meta.dirname, '../src/todo-store.mjs'))};
    const store = await readTodoStore({ repoRoot: ${JSON.stringify(root)}, now: ${JSON.stringify(NOW)} });
    console.log(store.members[0].tasks.filter((task) => task.status === 'done').length);`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', reader],
    { encoding: 'utf8', env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}` } });
  assert.equal(Number(output.trim()), COUNT);
  const calls = (await readFile(log, 'utf8')).split('\n').filter((line) => line.startsWith('cat-file'));
  assert.ok(calls.length <= Math.ceil(COUNT / 128) + 1, `${calls.length} cat-file spawns for ${COUNT} blobs`);
  assert.equal((await readTodoStore({ repoRoot: root, now: NOW })).members[0].tasks.length, COUNT);
});
