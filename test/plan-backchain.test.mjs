import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachBackchainMemos, backchainTaskMemo, validatePlanBackchain,
} from '../src/plan-backchain.mjs';
import { todoSelfDigest } from '../src/todo-contracts.mjs';

const ref = (taskId) => ({ project_id: 'example', plan_key: 'search', task_id: taskId });

function authoring() {
  return {
    schema: 'lattice.plan_create_input.v4', project_id: 'example', plan_key: 'search',
    plan_version: 'v1', tasks: [
      { task_id: 'index', design_memo: '文書を索引に載せる。' },
      { task_id: 'search', design_memo: '検索画面を作る。' },
    ],
    hard_dependencies: [{ from: ref('index'), to: ref('search') }],
    input_digest: '0'.repeat(64),
  };
}

function chain() {
  const result = {
    schema: 'lattice.plan_backchain.v1', authoring_ref: 'plan.json',
    project_id: 'example', plan_key: 'search', plan_version: 'v1',
    goal: {
      purpose: '利用者が必要な文書を見つけられるようにする。',
      outcome: '検索画面から文書へ到達できる。',
      acceptance: '検索語に合う文書が一覧に出る。',
      required_feature_ids: ['results'],
    },
    features: [
      { feature_id: 'index', capability: '文書を索引に入れる', acceptance: '文書が検索対象になる',
        requires_feature_ids: [], provider: { kind: 'task', task_id: 'index' } },
      { feature_id: 'results', capability: '検索結果を表示する', acceptance: '索引にある文書へ移動できる',
        requires_feature_ids: ['index'], provider: { kind: 'task', task_id: 'search' } },
    ],
    tasks: [
      { task_id: 'index', requires_feature_ids: [], provides_feature_ids: ['index'] },
      { task_id: 'search', requires_feature_ids: ['index'], provides_feature_ids: ['results'] },
    ],
    chain_digest: '',
  };
  result.chain_digest = todoSelfDigest(result, 'chain_digest');
  return result;
}

function resign(value) {
  value.chain_digest = todoSelfDigest(value, 'chain_digest');
  return value;
}

test('最終成果から逆算した機能と工程依存を照合し、担当者へ目的と後続用途を渡す', () => {
  const input = chain();
  const plan = authoring();
  validatePlanBackchain(input, plan);
  const memo = backchainTaskMemo(input, 'index');
  assert.match(memo, /全体の目的: 利用者が必要な文書/u);
  assert.match(memo, /後続: search/u);
  const enriched = attachBackchainMemos(input, plan);
  assert.match(enriched.tasks[1].design_memo, /必要とする機能:[\s\S]*index/u);
  assert.notEqual(enriched.input_digest, plan.input_digest);
});

test('後続が必要とする機能の工程依存が欠けたら登録前に拒否する', () => {
  const plan = authoring();
  plan.hard_dependencies = [];
  assert.throws(() => validatePlanBackchain(chain(), plan), (error) =>
    error.code === 'PLAN_BACKCHAIN_INVALID' && error.message === 'dependency_missing'
      && error.detail.from_task_id === 'index' && error.detail.to_task_id === 'search');
});

test('最終成果へつながらない機能を余計な工程として検出する', () => {
  const input = chain();
  input.goal.required_feature_ids = ['index'];
  resign(input);
  assert.throws(() => validatePlanBackchain(input, authoring()), (error) =>
    error.code === 'PLAN_BACKCHAIN_INVALID' && error.message === 'orphan_feature');
});

test('機能前提の循環を検出する', () => {
  const input = chain();
  input.features[0].requires_feature_ids = ['results'];
  input.tasks[0].requires_feature_ids = ['results'];
  resign(input);
  assert.throws(() => validatePlanBackchain(input, authoring()), (error) =>
    error.code === 'PLAN_BACKCHAIN_INVALID' && error.message === 'feature_cycle');
});

test('未知の提供元は問いを明示して工程作成を続けられる', () => {
  const input = chain();
  input.features.unshift({
    feature_id: 'format', capability: '文書形式を読む', acceptance: '対象形式が読める',
    requires_feature_ids: [],
    provider: { kind: 'unknown', reason: '対象形式が未確定', question: '対象形式は何か' },
  });
  input.features.find(({ feature_id }) => feature_id === 'index').requires_feature_ids = ['format'];
  input.tasks[0].requires_feature_ids = ['format'];
  resign(input);
  validatePlanBackchain(input, authoring());
  assert.match(backchainTaskMemo(input, 'index'), /未解決（対象形式が未確定。確認すること: 対象形式は何か）/u);
});

test('工程が明示した追加の必要機能も最終成果から逆算した関係に含める', () => {
  const input = chain();
  input.features.push({
    feature_id: 'format', capability: '既存の文書形式を読む', acceptance: '既存形式を扱える',
    requires_feature_ids: [], provider: { kind: 'existing', evidence_ref: 'docs/format.md' },
  });
  input.tasks[0].requires_feature_ids = ['format'];
  resign(input);
  validatePlanBackchain(input, authoring());
});
