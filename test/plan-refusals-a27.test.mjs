// a27: each plan refusal names the offending value or task and a next command that works,
// and help matches the real arguments (0.85.1 walkthrough A2, B1, B3, B4, B6, B8, B9).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lattice.mjs', import.meta.url));

function run(cwd, args, configDir) {
  const env = { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_CONFIG_DIR: configDir };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
}

const refusal = (result) => JSON.parse(result.stderr);

async function workspace(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'lattice-a27-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const config = path.join(base, 'config');
  const cli = (args, cwd = root) => run(cwd, args, config);
  const printed = JSON.parse(cli(['plan', 'create', '--template', '--json']).stdout);
  // The template's memos are blank; the author writes them (memo-no-fabrication).
  const template = { ...printed, tasks: printed.tasks.map((task) => ({ ...task, design_memo: 'NO_PLAN' })) };
  const write = async (name, value) => {
    await writeFile(path.join(root, name), `${JSON.stringify(value)}\n`);
    return name;
  };
  assert.equal(cli(['plan', 'create', '--input', await write('tpl.json', template)]).status, 0);
  return { base, root, cli, template, write };
}

test('plan createの入力の誤りは、作業と値を名指すINPUT_INVALIDで返る（B1・B3）', async (t) => {
  const { cli, template, write } = await workspace(t);
  const existing = refusal(cli(['plan', 'create', '--input', 'tpl.json']));
  assert.equal(existing.detail.plan_key, 'repo');
  assert.match(existing.detail.next_action, /^Plan key 'repo' already exists/u);

  const dangling = refusal(cli(['plan', 'create', '--input', await write('dangling.json', {
    ...template, plan_key: 'p2',
    hard_dependencies: [...template.hard_dependencies, { from: { task_id: 't1' }, to: { task_id: 'zz' } }],
  })]));
  assert.equal(dangling.code, 'INPUT_INVALID');
  assert.equal(dangling.detail.pointer, '/hard_dependencies/1/to/task_id');
  assert.equal(dangling.detail.next_action, "Set /hard_dependencies/1/to/task_id to one of [t1, t2, t3]; it is 'zz'.");

  const cycle = refusal(cli(['plan', 'create', '--input', await write('cycle.json', {
    ...template, plan_key: 'p3',
    hard_dependencies: [...template.hard_dependencies, { from: { task_id: 't3' }, to: { task_id: 't1' } }],
  })]));
  assert.equal(cycle.code, 'INPUT_INVALID');
  assert.deepEqual(cycle.detail.cycle, ['t1', 't3', 't1']);
  assert.match(cycle.detail.next_action, /^Tasks t1 -> t3 -> t1 form a cycle/u);

  const duplicate = refusal(cli(['plan', 'create', '--input', await write('dup.json', {
    ...template, plan_key: 'p4', tasks: [...template.tasks, { ...template.tasks[0], title: 'again' }],
  })]));
  assert.equal(duplicate.detail.violation_kind, 'duplicate');
  assert.equal(duplicate.detail.actual, 't1');

  const missingPlan = refusal(cli(['plan', 'show', 'nope', '--json']));
  assert.equal(missingPlan.code, 'PLAN_NOT_FOUND');
  assert.match(missingPlan.detail.next_action, /lattice plan show <plan_key> --json/u);
  assert.equal(refusal(cli(['todo', 'start', '--plan', 'nope', '--task', 't1'])).code, 'PLAN_NOT_FOUND');
});

test('backchainはauthoring_refの誤りを入力のpathと取り違えず、形の違反を一覧で返す（A2）', async (t) => {
  const { cli, write } = await workspace(t);
  const chain = {
    schema: 'lattice.plan_backchain.v1', project_id: 'repo', plan_key: 'repo', plan_version: 'v1',
    goal: {}, features: [], tasks: [], chain_digest: '',
  };
  const noRef = refusal(cli(['plan', 'backchain', '--input', await write('bc.json', chain)]));
  assert.equal(noRef.code, 'PLAN_BACKCHAIN_INVALID');
  assert.equal(noRef.detail.reason, 'schema_invalid');
  assert.deepEqual(noRef.detail.problems.map(({ pointer }) => pointer), ['/', '/authoring_ref']);
  assert.deepEqual(noRef.detail.missing_keys, ['authoring_ref']);

  const badRef = refusal(cli(['plan', 'backchain', '--input',
    await write('bc2.json', { ...chain, authoring_ref: '../outside.json' })]));
  assert.equal(badRef.detail.pointer, '/authoring_ref');
  assert.match(badRef.detail.next_action, /^Set \/authoring_ref to the repo path/u);
});

test('読めないreviewとrepoの外は、原因と通るコマンドを示す（B4）', async (t) => {
  const { base, cli } = await workspace(t);
  const review = refusal(cli(['plan', 'scope-review', '--plan-input', 'tpl.json', '--review', 'nofile.json', '--json']));
  assert.equal(review.detail.reason, 'input_missing');
  assert.equal(review.detail.pointer, '--review');
  assert.ok(typeof review.detail.repo_root === 'string');

  const outside = path.join(base, 'outside');
  await mkdir(outside);
  assert.match(refusal(cli(['plan', 'show', 'x', '--json'], outside)).detail.next_action, /`git init`/u);
  assert.equal(JSON.parse(cli(['status', '--json'], outside).stdout).next_action.command, 'git init');
});

test('verifyのnext_actionはnoneに揃い、記録済みmemoへ促しを繰り返さない（B6・B8）', async (t) => {
  const { cli } = await workspace(t);
  const verify = JSON.parse(cli(['todo', 'verify', '--json']).stdout);
  assert.deepEqual(verify.verified_members.map((member) => member.reconciliation_guidance.next_action), ['none']);
  const started = JSON.parse(cli(['todo', 'start', '--plan', 'repo', '--task', 't1', '--parallel-frontier']).stdout);
  assert.deepEqual(started.design_memo, { status: 'available', markdown: 'NO_PLAN', prompt: null });

  for (const version of ['4', '5']) {
    const schema = JSON.parse(await readFile(new URL(
      `../docs/schemas/lattice.plan_create_input.v${version}.schema.json`, import.meta.url), 'utf8'));
    assert.doesNotMatch(schema.description, /設計メモ/u);
    assert.match(schema.$defs.task.properties.design_memo.description, /NO_PLAN/u);
  }
});

test('planのhelpと欠けたflagの文は実際の引数どおり（B9）', async (t) => {
  const { cli } = await workspace(t);
  assert.match(cli(['plan', 'revise', '--help']).stdout, /--input <file> \[--dry-run\] \[--json\]/u);
  assert.match(cli(['plan', '--help']).stdout, /backchain --input <file> \[--dry-run\] \[--json\]/u);
  assert.equal(refusal(cli(['plan', 'revise'])).detail.next_action, 'Add --input <file> to `lattice plan revise`.');
  assert.equal(refusal(cli(['plan', 'scope-review'])).detail.next_action,
    'Add --plan-input <file> to `lattice plan scope-review`.');
});
