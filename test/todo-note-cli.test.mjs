import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTodoStoreWriter, initializeTodoStore } from '../src/todo-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/lattice.mjs');
const ACTOR = { host: 'host-1', session: 'session-1', agent: 'agent-1' };
const NOW = '2026-08-01T00:00:00.000Z';
// 名乗りなしの操作が端末の識別子を作る置き場。本物の`~/.lattice`を使わせない。
const TERMINAL_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'lattice-todo-note-terminal-'));
process.on('exit', () => rmSync(TERMINAL_CONFIG_DIR, { recursive: true, force: true }));

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-note-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: root }).status, 0);
  await initializeTodoStore({
    repoRoot: root,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    projectId: 'project-1',
    repositories: [{ repo_id: 'self', path: '.' }],
    plans: [{
      plan: {
        schema: 'lattice.todo_plan.v1', project_id: 'project-1', plan_key: 'main',
        plan_version: 'v1', predecessor_plan_digest: null,
        tasks: [{ task_id: 'T1', title: 'Task 1', lane: 'main', narrative_ref: null,
          compile_binding: null }],
        hard_dependencies: [], joins: [],
      },
      genesis: { actor: ACTOR, recorded_at: NOW },
    }],
    now: NOW,
  });
  return root;
}

function run(root, args, actor = true) {
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0' };
  delete env.FORCE_COLOR;
  if (actor) {
    env.LATTICE_TODO_ACTOR_HOST = ACTOR.host;
    env.LATTICE_TODO_ACTOR_SESSION = ACTOR.session;
    env.LATTICE_TODO_ACTOR_AGENT = ACTOR.agent;
  } else {
    delete env.LATTICE_TODO_ACTOR_HOST;
    delete env.LATTICE_TODO_ACTOR_SESSION;
    delete env.LATTICE_TODO_ACTOR_AGENT;
    // 既定のhostは端末の識別子から導く（ADR 0197）。識別子を本物の`~/.lattice`へ作らせない。
    env.LATTICE_CONFIG_DIR = TERMINAL_CONFIG_DIR;
  }
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
}

test('note append/listをtyped CLIで提供しlifecycle artifactを変更しない', async (t) => {
  const root = await workspace(t);
  const refs = [
    '.lattice/todo/manifest.json',
    '.lattice/todo/plans/main/v1/journal/active.jsonl',
    '.lattice/todo/plans/main/v1/snapshot.json',
  ];
  const before = await Promise.all(refs.map((ref) => readFile(path.join(root, ref))));
  const added = run(root, ['todo', 'note', '--plan', 'main', '--task', 'T1', '--message', '方針を固定']);
  assert.equal(added.status, 0, added.stderr);
  const appendResult = JSON.parse(added.stdout);
  assert.equal(appendResult.schema, 'lattice.todo_note_append_result.v2');
  assert.equal(appendResult.note_context.notes[0].body, '方針を固定');

  const listed = run(root, ['todo', 'note', 'list', '--plan', 'main', '--task', 'T1', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  const listResult = JSON.parse(listed.stdout);
  assert.equal(listResult.schema, 'lattice.todo_note_list_result.v2');
  assert.equal(listResult.notes.length, 1);
  assert.equal(listResult.notes[0].origin_task_id, 'T1');
  assert.deepEqual(await Promise.all(refs.map((ref) => readFile(path.join(root, ref)))), before);
});

test('messageとinputは排他的で、actor欠落はdefaultしtask不在はtyped failureにする', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'note.md'), '入力note');
  assert.equal(run(root, ['todo', 'note', '--plan', 'main', '--task', 'T1', '--input', 'note.md']).status, 0);
  const noActor = run(root,
    ['todo', 'note', '--plan', 'main', '--task', 'T1', '--message', 'default-actor'], false);
  assert.equal(noActor.status, 0, noActor.stderr);
  const missing = run(root,
    ['todo', 'note', '--plan', 'main', '--task', 'missing', '--message', 'x']);
  assert.equal(JSON.parse(missing.stderr).code, 'NOTE_TASK_NOT_FOUND');
});

test('note破損時はtodo verifyがNOTE_LOG_CORRUPTを返し空成功へ丸めない', async (t) => {
  const root = await workspace(t);
  assert.equal(run(root,
    ['todo', 'note', '--plan', 'main', '--task', 'T1', '--message', 'x']).status, 0);
  const active = path.join(root, '.lattice/todo/notes/main/active.jsonl');
  await writeFile(active, ` ${await readFile(active, 'utf8')}`);
  const verified = run(root, ['todo', 'verify', '--plan', 'main', '--json']);
  assert.equal(verified.status, 1);
  assert.equal(JSON.parse(verified.stderr).code, 'NOTE_LOG_CORRUPT');
});
