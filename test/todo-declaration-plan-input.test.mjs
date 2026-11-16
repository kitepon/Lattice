// a3c (ADR 0204 §6): plan create/revise input v6 carries `tasks[].touches`; the claims go to the witness set only,
// the stored plan and its digest stay the v5 ones, and an unresolved name never undoes the create or revise.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { splitTouches } from '../src/todo-declaration.mjs';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ENV = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
  LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'fixture' };
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: ENV });
function success(root, args) {
  const result = run(root, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const SOURCE = 'export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n';
const plan = (schema, touches) => ({
  schema, plan_key: 'dev', phases: [{ phase_id: 'p', title: 'phase' }],
  tasks: ['P', 'Q'].map((task_id) => ({ task_id, title: task_id, phase_id: 'p', design_memo: 'NO_PLAN',
    ...(touches[task_id] === undefined ? {} : { touches: touches[task_id] }) })),
});

async function repo(context) {
  // Same directory name every time: the project id comes from it, and the plan digest includes it.
  const parent = await mkdtemp(path.join(tmpdir(), 'lattice-a3c-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'proj');
  await mkdir(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  await mkdir(path.join(root, 'src'));
  for (const name of ['a', 'b']) await writeFile(path.join(root, 'src', `${name}.js`), SOURCE);
  git('add', '.');
  git('-c', 'user.name=f', '-c', 'user.email=f@f', 'commit', '--quiet', '-m', 'base');
  return root;
}
const write = (root, name, value) => writeFile(path.join(root, name), JSON.stringify(value));
const readSet = async (root) => JSON.parse(await readFile(path.join(root, '.lattice/todo/witness/dev.json'), 'utf8'));

test('splitTouches: v6 becomes v5 without touches; bad shapes are refused at their pointer; other schemas pass through', () => {
  const input = plan('lattice.plan_create_input.v6', { P: { owns: ['src/a.js#alpha'], reads: ['src/b.js'] }, Q: { owns: [] } });
  const { input: v5, touches } = splitTouches(input);
  assert.equal(v5.schema, 'lattice.plan_create_input.v5');
  assert.ok(v5.tasks.every((task) => !('touches' in task)));
  assert.deepEqual(touches, [{ task_id: 'P', owns: ['src/a.js#alpha'], reads: ['src/b.js'] }]);
  const v5Input = plan('lattice.plan_create_input.v5', {});
  assert.equal(splitTouches(v5Input).input, v5Input);
  assert.throws(() => splitTouches(plan('lattice.plan_create_input.v6', { Q: { owns: 'src/a.js', extra: 1 } }), '/desired'),
    (error) => error.detail.pointer === '/desired/tasks/1/touches' && error.detail.reason === 'plan_create_touches_invalid');
});

test('plan create v6 declares touches: plan equals the v5 one, row recorded, unresolved name reported without undoing the create', async (context) => {
  const withTouches = await repo(context);
  await write(withTouches, 'plan.json', plan('lattice.plan_create_input.v6', {
    P: { owns: ['src/a.js#alpha'], reads: ['src/b.js#beta'] }, Q: { owns: ['src/a.js#alpa'] } }));
  const created = success(withTouches, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.declarations.P.written, true);
  assert.equal(created.declarations.Q.written, false);
  assert.ok(created.declarations.Q.unresolved[0].nearest.includes('alpha'));
  const set = await readSet(withTouches);
  assert.equal(set.schema, 'lattice.todo_witness_set.v6');
  assert.deepEqual(Object.keys(set.manual_witness), ['P']);
  assert.deepEqual(set.manual_witness.P.read_anchors[0].symbols, ['beta']);

  // The stored plan is byte-for-byte what the same input without touches makes.
  const plain = await repo(context);
  await write(plain, 'plan.json', plan('lattice.plan_create_input.v5', {}));
  const reference = success(plain, ['plan', 'create', '--input', 'plan.json']);
  assert.equal(created.plan_digest, reference.plan_digest);
  assert.equal(reference.declarations, undefined);
});

test('plan create v6 refuses a malformed touches at its pointer; v5 refuses the key', async (context) => {
  const root = await repo(context);
  await write(root, 'bad.json', plan('lattice.plan_create_input.v6', { Q: { owns: 'src/a.js' } }));
  const bad = run(root, ['plan', 'create', '--input', 'bad.json']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr + bad.stdout, /plan_create_touches_invalid[\s\S]*\/tasks\/1\/touches|\/tasks\/1\/touches[\s\S]*plan_create_touches_invalid/u);
  await write(root, 'v5.json', plan('lattice.plan_create_input.v5', { Q: { owns: ['src/a.js'] } }));
  assert.notEqual(run(root, ['plan', 'create', '--input', 'v5.json']).status, 0);
});

test('plan revise v6 declares touches, also when the plan itself is unchanged; dry-run writes nothing', async (context) => {
  const root = await repo(context);
  await write(root, 'plan.json', plan('lattice.plan_create_input.v5', {}));
  success(root, ['plan', 'create', '--input', 'plan.json']);
  await write(root, 'revise.json', plan('lattice.plan_create_input.v6', { P: { owns: ['src/a.js#beta'] } }));
  const dry = success(root, ['plan', 'revise', '--input', 'revise.json', '--dry-run']);
  assert.equal(dry.declarations, undefined);
  await assert.rejects(readFile(path.join(root, '.lattice/todo/witness/dev.json')), { code: 'ENOENT' });
  const revised = success(root, ['plan', 'revise', '--input', 'revise.json']);
  assert.equal(revised.schema, 'lattice.plan_revise_unchanged.v1');
  assert.equal(revised.declarations.P.written, true);
  assert.deepEqual((await readSet(root)).manual_witness.P.concern_anchors[0].symbols, ['beta']);
});

test('plan create --schema-version 6 prints the v6 input schema with touches', async (context) => {
  const root = await repo(context);
  const schema = success(root, ['plan', 'create', '--schema-version', '6', '--json']);
  assert.equal(schema.title, 'lattice.plan_create_input.v6');
  assert.deepEqual(Object.keys(schema.$defs.task.properties.touches.properties), ['owns', 'reads']);
});
