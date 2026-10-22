import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BIN = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const ACTOR = { host: 'fixture', session: 'fixture', agent: 'fixture' };

async function repo(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'lattice-backchain-cli-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'plan.md'), '# 計画\n- 検索画面\n');
  execFileSync('git', ['add', 'plan.md'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, LATTICE_DASHBOARD_AUTOSTART: '0',
      LATTICE_RUNTIME_ERROR_REPORTING: '0', NO_COLOR: '1',
    },
  });
}

const ref = (planKey, taskId) => ({ project_id: 'example', plan_key: planKey, task_id: taskId });

function createInput() {
  return {
    schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'search',
    plan_version: 'v1', actor: ACTOR, recorded_at: new Date().toISOString(),
    tasks: [
      { task_id: 'index', title: '索引', lane: 'implementation', design_memo: '索引を作る。',
        narrative_ref: null, narrative_anchor: null, compile_binding: null,
        parent_task_id: null, phase_id: 'delivery' },
      { task_id: 'search', title: '検索', lane: 'implementation', design_memo: '検索を作る。',
        narrative_ref: null, narrative_anchor: null, compile_binding: null,
        parent_task_id: null, phase_id: 'delivery' },
    ],
    phases: [{ phase_id: 'delivery', title: '利用可能にする', gate_policy: 'heavy',
      predecessor_phase_ids: [], required_evidence_slots: ['proof'] }],
    hard_dependencies: [{ from: ref('search', 'index'), to: ref('search', 'search') }],
    joins: [], phase_accept_dependencies: [],
  };
}

function chain(planKey = 'search', authoringRef = 'plan.json', taskIds = ['index', 'search']) {
  const multi = taskIds.length === 2;
  return {
    schema: 'lattice.plan_backchain.v1', authoring_ref: authoringRef,
    project_id: 'example', plan_key: planKey, plan_version: 'v1',
    goal: {
      purpose: '利用者が必要な文書を見つける。', outcome: '検索結果から文書へ到達する。',
      acceptance: '利用者が検索語から対象文書へ移動できる。',
      required_feature_ids: [multi ? 'results' : 'archive'],
    },
    features: multi ? [
      { feature_id: 'index', capability: '文書を索引に登録する', acceptance: '検索対象へ入る',
        requires_feature_ids: [], provider: { kind: 'task', task_id: 'index' } },
      { feature_id: 'results', capability: '結果を表示する', acceptance: '一覧から文書を開ける',
        requires_feature_ids: ['index'], provider: { kind: 'task', task_id: 'search' } },
    ] : [{
      feature_id: 'archive', capability: '結果を保管する', acceptance: '保管した結果を読める',
      requires_feature_ids: [], provider: { kind: 'task', task_id: taskIds[0] },
    }],
    tasks: multi ? [
      { task_id: 'index', requires_feature_ids: [], provides_feature_ids: ['index'] },
      { task_id: 'search', requires_feature_ids: ['index'], provides_feature_ids: ['results'] },
    ] : [{ task_id: taskIds[0], requires_feature_ids: [], provides_feature_ids: ['archive'] }],
  };
}

test('逆算した初回工程を一回で作り、担当者へ目的・必要機能・後続用途を渡す', async (context) => {
  const root = await repo(context);
  await writeFile(path.join(root, 'plan.json'), `${JSON.stringify(createInput(), null, 2)}\n`);
  await writeFile(path.join(root, 'chain.json'), `${JSON.stringify(chain(), null, 2)}\n`);
  const schema = run(root, ['plan', 'backchain', '--schema', '--json']);
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).title, 'lattice.plan_backchain.v1');
  const preview = run(root, ['plan', 'backchain', '--input', 'chain.json', '--dry-run', '--json']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).valid, true);
  const created = run(root, ['plan', 'backchain', '--input', 'chain.json', '--json']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).authoring_result.schema, 'lattice.plan_create_result.v1');
  const binding = JSON.parse(await readFile(path.join(root,
    '.lattice/todo/plans/search/v1/backchain.json')));
  assert.equal(binding.schema, 'lattice.plan_backchain_binding.v1');
  const detail = run(root, ['todo', 'show', '--plan', 'search', '--task', 'index', '--json']);
  assert.equal(detail.status, 0, detail.stderr);
  const item = JSON.parse(detail.stdout);
  assert.equal(item.schema, 'lattice.todo_detail_result.v4');
  assert.equal(item.feature_context.goal.purpose, '利用者が必要な文書を見つける。');
  assert.deepEqual(item.feature_context.downstream_task_ids, ['search']);
  const started = run(root, ['todo', 'start', '--plan', 'search', '--task', 'index']);
  assert.equal(started.status, 0, started.stderr);
  const start = JSON.parse(started.stdout);
  assert.equal(start.schema, 'lattice.todo_mutation_result.v6');
  assert.equal(start.feature_context.provides[0].feature_id, 'index');
});

test('後続の必要機能を作る工程が無ければstoreを作らない', async (context) => {
  const root = await repo(context);
  const plan = createInput();
  plan.hard_dependencies = [];
  await writeFile(path.join(root, 'plan.json'), `${JSON.stringify(plan)}\n`);
  await writeFile(path.join(root, 'chain.json'), `${JSON.stringify(chain())}\n`);
  const result = run(root, ['plan', 'backchain', '--input', 'chain.json', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'PLAN_BACKCHAIN_INVALID');
  const status = run(root, ['status', '--json']);
  assert.equal(JSON.parse(status.stdout).state, 'uninitialized');
});

test('既存storeへのplan追加も同じ逆算入口で行う', async (context) => {
  const root = await repo(context);
  const base = createInput();
  base.plan_key = 'base';
  base.tasks = base.tasks.slice(0, 1);
  base.hard_dependencies = [];
  await writeFile(path.join(root, 'base.json'), `${JSON.stringify(base)}\n`);
  assert.equal(run(root, ['plan', 'create', '--input', 'base.json']).status, 0);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const extraction = {
    schema: 'lattice.todo_extraction.v4', project_id: 'example', plan_key: 'archive',
    plan_version: 'v1', actor: ACTOR, recorded_at: new Date().toISOString(),
    tasks: [{
      task_id: 'save', title: '保存', lane: 'implementation', design_memo: '保存する。',
      narrative_ref: 'plan.md', compile_binding: null, disposition: 'register_pending',
      start: null, completion: null,
      source: { origin_plan_ref: 'plan.md', origin_line: 2, source_commit: sourceCommit,
        heading_path: ['計画'], markdown_depth: 0, parent_task_id: null, checkbox_state: 'absent' },
      migration_context: { external_canonical_ref: null, carry_over_ref: null, h_required: false,
        condition: null, evidence_refs: [], notes: [] },
    }], hard_dependencies: [], joins: [],
  };
  await writeFile(path.join(root, 'extraction.json'), `${JSON.stringify(extraction)}\n`);
  await writeFile(path.join(root, 'chain.json'), `${JSON.stringify(chain('archive', 'extraction.json', ['save']))}\n`);
  const created = run(root, ['plan', 'backchain', '--input', 'chain.json', '--json']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).authoring_result.schema, 'lattice.todo_migrate_result.v4');
  const detail = JSON.parse(run(root, ['todo', 'show', '--plan', 'archive', '--task', 'save', '--json']).stdout);
  assert.equal(detail.feature_context.provides[0].feature_id, 'archive');
});
