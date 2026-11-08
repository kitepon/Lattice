// seat契約: 旗は書込みの結果を変えない。書込みの出力は常にJSONなので`--json`は無害に受ける。

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { todoSelfDigest } from '../src/todo-contracts.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');

function run(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_TODO_ACTOR_HOST: 'h', LATTICE_TODO_ACTOR_SESSION: 's', LATTICE_TODO_ACTOR_AGENT: 'a' } });
}

async function workspace(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-write-json-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'base'], { cwd: root });
  const task = (task_id) => ({ task_id, title: task_id, lane: 'main', design_memo: 'NO_PLAN',
    narrative_ref: null, narrative_anchor: null, compile_binding: null, parent_task_id: null, phase_id: 'p1' });
  const input = {
    schema: 'lattice.plan_create_input.v4', project_id: 'probe', plan_key: 'main', plan_version: 'v1',
    actor: { host: 'h', session: 's', agent: 'a' }, recorded_at: new Date().toISOString(),
    tasks: [task('t1'), task('t2')], hard_dependencies: [], joins: [],
    phases: [{ phase_id: 'p1', title: 'P', gate_policy: 'heavy', predecessor_phase_ids: [],
      required_evidence_slots: ['gate'] }],
    phase_accept_dependencies: [], input_digest: '',
  };
  input.input_digest = todoSelfDigest(input, 'input_digest');
  await writeFile(path.join(root, 'plan.json'), `${JSON.stringify(input)}\n`);
  const created = run(root, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.status, 0, created.stderr);
  return root;
}

test('todo writes accept --json as a no-op wherever it is placed', async (context) => {
  const root = await workspace(context);
  for (const args of [
    ['start', '--plan', 'main', '--task', 't1', '--json'],
    ['done', '--plan', 'main', '--task', 't1', '--message', '閉じた', '--json'],
    ['start', '--json', '--plan', 'main', '--task', 't2'],
    ['block', '--plan', 'main', '--json', '--task', 't2', '--reason', '待ち'],
  ]) {
    const result = run(root, ['todo', ...args]);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).kind, args[0]);
  }
  const read = run(root, ['todo', 'show', '--plan', 'main', '--task', 't1', '--bogus', '--json']);
  assert.equal(read.status, 2);
  assert.equal(JSON.parse(read.stderr).message, 'todo_arguments_invalid');
});
