import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOUNDED_SEAM_CANDIDATE_SCHEMA,
  buildSeamDerivationQuerySet,
  deriveBoundedSeamCandidate,
} from '../src/seam-derivation.mjs';

// ADR 0137・0138。提案は所有面しか持たない。実行可能にするには共有面と残余面まで決まっている
// 必要があり、共有面から所有面へ辺が入る構成は循環を作るので候補にしない。

const DIGEST = (character) => character.repeat(64);
const BASE_SHA = 'a'.repeat(40);
const SOURCE = 'src/shared.mjs';

const base = (overrides = {}) => ({
  sourcePath: SOURCE,
  taskRefs: [{ plan_key: 'main', task_id: 'T1' }, { plan_key: 'main', task_id: 'T2' }],
  ownedSymbolsByTask: { T1: ['renderLeft'], T2: ['renderRight'] },
  proposedPathByTask: { T1: 'src/shared.seam-left.mjs', T2: 'src/shared.seam-right.mjs' },
  sharedPath: 'src/shared.seam-common.mjs',
  // 未照会と「calleeが無い」は別物なので、空配列を明示する。
  calleesBySymbol: { renderLeft: [], renderRight: [] },
  affectedTests: ['test/shared.test.mjs'],
  baseSha: BASE_SHA,
  manifestDigest: DIGEST('1'),
  findingDigest: DIGEST('2'),
  candidateId: 'seam-candidate-1',
  ...overrides,
});

test('宣言が依存する未宣言symbolは共有面へ集まり、原pathは残余面になる', () => {
  const { candidate, reasons } = deriveBoundedSeamCandidate(base({
    calleesBySymbol: {
      // helperのhelperまで推移的に辿る。1段で止めると共有面から原pathへの辺が残る。
      renderLeft: [{ name: 'escapeText', path: SOURCE }],
      escapeText: [{ name: 'CONTROL', path: SOURCE }],
      CONTROL: [],
      renderRight: [{ name: 'escapeText', path: SOURCE }],
    },
  }));
  assert.deepEqual(reasons, []);
  assert.equal(candidate.schema, BOUNDED_SEAM_CANDIDATE_SCHEMA);
  for (const key of [
    'require_behavior_equivalence', 'require_fresh_sensor', 'require_overlap_reduction',
    'require_no_new_conflict_pairs', 'require_parallelism_improvement',
  ]) assert.equal(candidate.verification_policy[key], true, key);

  const byRole = Object.fromEntries(candidate.surfaces.map((s) => [
    `${s.role}:${s.owner_task_ids.join(',')}`, s,
  ]));
  assert.deepEqual(byRole['task_owned:T1'].symbols, ['renderLeft']);
  assert.deepEqual(byRole['task_owned:T2'].symbols, ['renderRight']);
  assert.deepEqual(byRole['shared:'].symbols, ['CONTROL', 'escapeText']);
  // 残余は補集合なので列挙しない。
  assert.deepEqual(byRole['residual:'].symbols, []);
  assert.equal(byRole['residual:'].path, SOURCE);

  // 原pathと所有面は必ず変わる。共有面は変わらない構成もありうるので必須にしない。
  assert.deepEqual(candidate.required_paths,
    ['src/shared.mjs', 'src/shared.seam-left.mjs', 'src/shared.seam-right.mjs']);
  assert.equal(candidate.allowed_paths.includes('src/shared.seam-common.mjs'), true);
});

test('同一file外へ解決したcalleeは共有面へ引き込まない', () => {
  // sensorのsymbol解決は同名の別fileへ寄ることがある。pathのexact一致で絞らないと、
  // 無関係なsymbolが共有面に混ざって変換対象が膨らむ。
  const { candidate } = deriveBoundedSeamCandidate(base({
    calleesBySymbol: {
      renderLeft: [
        { name: 'escapeText', path: SOURCE },
        { name: 'escapeText', path: 'src/elsewhere.mjs' },
        { name: 'unrelated', path: 'sensor/scripts/other.mjs' },
      ],
      escapeText: [],
      renderRight: [],
    },
  }));
  const shared = candidate.surfaces.find(({ role }) => role === 'shared');
  assert.deepEqual(shared.symbols, ['escapeText']);
});

test('共有面から所有面へ辺が入る構成は候補にしない', () => {
  const { candidate, reasons } = deriveBoundedSeamCandidate(base({
    calleesBySymbol: {
      renderLeft: [{ name: 'dispatch', path: SOURCE }],
      // 共有へ回ったdispatchが所有面のrenderRightを呼ぶ。切ると循環importになる。
      dispatch: [{ name: 'renderRight', path: SOURCE }],
      renderRight: [],
    },
  }));
  assert.equal(candidate, null);
  assert.deepEqual(reasons, ['shared_depends_on_owned:dispatch->renderRight']);
});

test('依存が無ければ共有面を作らず、二面だけの候補になる', () => {
  const { candidate } = deriveBoundedSeamCandidate(base());
  assert.deepEqual(candidate.surfaces.map(({ role }) => role).sort(),
    ['residual', 'task_owned', 'task_owned']);
});

test('宣言の無いtaskがある構成は所有面を作れない', () => {
  const { candidate, reasons } = deriveBoundedSeamCandidate(base({
    ownedSymbolsByTask: { T1: ['renderLeft'] },
  }));
  assert.equal(candidate, null);
  assert.deepEqual(reasons, ['owned_symbols_missing:T2']);
});

test('同じsymbolを2 taskが所有する構成は移動先が決まらない', () => {
  const { candidate, reasons } = deriveBoundedSeamCandidate(base({
    ownedSymbolsByTask: { T1: ['renderLeft'], T2: ['renderLeft'] },
  }));
  assert.equal(candidate, null);
  assert.deepEqual(reasons, ['owned_symbol_claimed_twice']);
});

test('calleeを照会していないsymbolがあれば、閉包を閉じたことにしない', () => {
  // 未照会を「calleeが無い」と同一視すると閉包が黙って浅くなる。移動先で参照だけが宙に浮き、
  // 構文は通るので実行するまで壊れたと分からない。実データで踏んだ欠陥をここで固定する。
  const { candidate, reasons } = deriveBoundedSeamCandidate(base({
    calleesBySymbol: {
      renderLeft: [{ name: 'renderIndex', path: SOURCE }],
      renderRight: [],
      // renderIndexのcalleeを引いていない。
    },
  }));
  assert.equal(candidate, null);
  assert.deepEqual(reasons, ['callee_data_missing:renderIndex']);
});

test('導出queryは宣言symbolのcalleeだけを引く', () => {
  const { queries } = buildSeamDerivationQuerySet(['renderRight', 'renderLeft', 'renderLeft']);
  assert.deepEqual(queries.map(({ operation }) => operation), ['status', 'callees', 'callees']);
  assert.deepEqual(queries.slice(1).map(({ target }) => target), ['renderLeft', 'renderRight']);
});
