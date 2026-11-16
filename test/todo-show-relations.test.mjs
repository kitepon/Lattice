// a5c (ADR 0204 §5): the function-level relations a declaration recorded are shown to the member who starts or reads the
// task: `todo start` (advisory.relations), `todo show` (relations) and `session-context` (independence[].function_conflicts).
// Projection only: no refusal, nothing added to a plan that has no relations.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ENV = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' };
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: ENV });
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-a5c-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n');
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: ['P', 'Q', 'R'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN' })) }));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  return root;
}
const declare = (root, taskId, ...flags) => success(root, ['todo', 'independence', 'witness', 'declare', '--plan', 'dev', '--task', taskId, ...flags]);

test('a plan with no relations shows none: show, start and session-context are unchanged', async (context) => {
  const root = await repo(context);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'Q', '--owns', 'src/a.js#beta');
  assert.equal('relations' in success(root, ['todo', 'show', '--plan', 'dev', '--task', 'P']), false);
  assert.equal('relations' in success(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']).advisory, false);
  const entries = success(root, ['session-context']).independence;
  assert.ok(entries.every((entry) => !('function_conflicts' in entry)));
});

test('a recorded conflict is shown on todo show, todo start and session-context, for both tasks of the pair only', async (context) => {
  const root = await repo(context);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'R', '--owns', 'src/a.js#alpha');
  declare(root, 'Q', '--owns', 'src/a.js#beta');
  const shown = success(root, ['todo', 'show', '--plan', 'dev', '--task', 'R']).relations;
  assert.deepEqual(shown.open.map(({ with: other, path: where }) => [other, where]), [['P', 'src/a.js']]);
  assert.equal(shown.open[0].overlaps[0].self.symbol, 'alpha');
  assert.equal(shown.plan_relation_count, 1);
  assert.deepEqual(success(root, ['todo', 'show', '--plan', 'dev', '--task', 'P']).relations.open.map(({ with: other }) => other), ['R']);
  assert.deepEqual(success(root, ['todo', 'show', '--plan', 'dev', '--task', 'Q']).relations.open, []);
  const started = success(root, ['todo', 'start', '--plan', 'dev', '--task', 'R']);
  assert.deepEqual(started.advisory.relations.open.map(({ with: other }) => other), ['P']);
  const entry = success(root, ['session-context']).independence.find(({ plan_key: key }) => key === 'dev');
  assert.equal(entry.function_conflicts.relation_count, 1);
});

test('an unreadable relation record is named, never a refusal', async (context) => {
  const root = await repo(context);
  declare(root, 'P', '--owns', 'src/a.js#alpha');
  declare(root, 'R', '--owns', 'src/a.js#alpha');
  await writeFile(path.join(root, '.lattice/todo/relations/dev/summary.json'), '{not json\n');
  assert.equal(typeof success(root, ['todo', 'show', '--plan', 'dev', '--task', 'P']).relations.unreadable, 'string');
  assert.equal(success(root, ['todo', 'start', '--plan', 'dev', '--task', 'P']).status, 'in-progress');
});
