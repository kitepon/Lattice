import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { selfDigest } from '../../src/runtime-contracts.mjs';
import { registerManagedDaemonFixture } from '../helpers/managed-daemon-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');
const CONTROLLER = path.join(ROOT, 'bin', 'lattice-scripted-adapter.mjs');

// 実daemonを起こす面はmacOSでのみ検証している（backlog「管理runtimeのLinux検証」）。
// skipは「Linuxで動く」という主張ではなく、未検証であることの印である。
const managedDaemon = {
  skip: process.platform === 'darwin' ? false : 'managed runtime daemon is verified on macOS only',
};

function invoke(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1',
      LATTICE_DASHBOARD_AUTOSTART: '0', ...extraEnv },
  });
  assert.equal(result.error, undefined);
  return result;
}

const cli = (args, cwd, extraEnv = {}) => invoke(process.execPath, [CLI, ...args], cwd, extraEnv);

function ok(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

function witness(symbol) {
  const writePath = `src/${symbol}.mjs`;
  return {
    owns: [{ kind: 'symbol', target: symbol }, { kind: 'path', target: writePath }],
    reads: [], writes: [writePath], resources: [], state_effects: [],
    sensor_provenance: { queries: [
      { query_id: `q-${symbol}`, expect: { kind: 'symbol', name: symbol, path: writePath } },
      { query_id: `q-${symbol}-affected`, expect: { kind: 'affected', path: writePath } },
    ] },
    affected_tests: [`test/${symbol}.test.mjs`], unknowns: [],
  };
}

const unitTest = (symbol) => `import assert from 'node:assert/strict';\nimport test from 'node:test';\n`
  + `import { ${symbol} } from '../src/${symbol}.mjs';\ntest('${symbol}', () => assert.ok(${symbol}));\n`;

// ADR 0143の実運転確認。**共有rootだった頃、io-sentinelは一度も発火しなかった。**
// 監視がdispatch後に張られ、書き込みはdispatch応答の前に終わり、帰属はrootから決まらなかった。
// worktree分離とworkerの非同期化で、実runの走行中に書き込みを観測できることを実測で固定する。
test('実runで、宣言scope外の書き込みを走行中に観測して警報する', managedDaemon, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-io-sentinel-live-'));
  registerManagedDaemonFixture(t, temporaryRoot);
  const repoRoot = path.join(temporaryRoot, 'repo');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, '.gitignore'), '.lattice/\n');
  await writeFile(path.join(repoRoot, 'src', 'alpha.mjs'), 'export const alpha = 1;\n');
  await writeFile(path.join(repoRoot, 'src', 'beta.mjs'), 'export const beta = 2;\n');
  await mkdir(path.join(repoRoot, 'test'), { recursive: true });
  await writeFile(path.join(repoRoot, 'test', 'alpha.test.mjs'), unitTest('alpha'));
  await writeFile(path.join(repoRoot, 'test', 'beta.test.mjs'), unitTest('beta'));
  // T2は`src/beta.mjs`だけを宣言するが、実際には`src/alpha.mjs`——T1の宣言scope——へも書く。
  // 宣言と実writeが食い違わない限り、実行時競合は原理的に一度も起きない。
  await writeFile(path.join(repoRoot, 'adapter-config.json'),
    `${JSON.stringify({ mode: 'deterministic', hold_ms: 15_000, extra_writes: ['src/alpha.mjs'] })}\n`);

  const git = (...args) => ok(invoke('git', ['-c', 'user.email=a@example.invalid',
    '-c', 'user.name=a', ...args], repoRoot), `git ${args[0]}`);
  ok(invoke('git', ['init', '--quiet', '--initial-branch=main'], repoRoot), 'git init');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const baseSha = ok(invoke('git', ['rev-parse', 'HEAD'], repoRoot), 'rev-parse').stdout.trim();
  ok(cli(['sensor', 'init', '.', '--json'], repoRoot), 'sensor init');

  const request = {
    schema: 'lattice.run_request.v1',
    request_id: 'io-sentinel-live',
    repo: { base_sha: baseSha, root_kind: 'git-worktree' },
    capacity: { executors: 2 },
    todos: [{ todo_id: 'T1' }, { todo_id: 'T2' }],
    manual_witness: { T1: witness('alpha'), T2: witness('beta') },
    sensor_query_set: { queries: [
      { id: 'q-status', operation: 'status' },
      { id: 'q-alpha', operation: 'query', target: 'alpha' },
      { id: 'q-alpha-affected', operation: 'affected', target: 'src/alpha.mjs' },
      { id: 'q-beta', operation: 'query', target: 'beta' },
      { id: 'q-beta-affected', operation: 'affected', target: 'src/beta.mjs' },
    ] },
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum',
    request_digest: '',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  const requestPath = path.join(temporaryRoot, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);

  ok(cli(['plan', 'compile', '--request', requestPath], repoRoot), 'plan compile');
  const started = ok(cli(['run', 'start', '--request', requestPath, '--executor', 'scripted'],
    repoRoot), 'run start');
  const runRef = JSON.parse(started.stdout).run_dir;

  await writeFile(path.join(temporaryRoot, 'adapter.json'), `${JSON.stringify({
    schema: 'lattice.runtime_adapter_registration_input.v1',
    adapter_kind: 'scripted', launch_kind: 'host_binary', binary_path: process.execPath,
    argv: [CONTROLLER], config_ref: 'adapter-config.json',
  })}\n`);
  ok(cli(['run', 'adapter', 'register', '--input', path.join(temporaryRoot, 'adapter.json')],
    repoRoot), 'adapter register');

  // 初回activation socketは外部workerの最終結果まで同じ接続で待つ。旧実装は5秒で切り、
  // 同一request_idの再照会へ逃げていたため、delayで旧timeoutを越えることを実測する。
  const startedAt = Date.now();
  ok(cli(['run', 'activate', '--run', runRef], repoRoot, {
    NODE_ENV: 'test', LATTICE_INTERNAL_TEST_ACTIVATION_DELAY_MS: '5500',
  }), 'run activate');
  const activateMs = Date.now() - startedAt;
  assert.ok(activateMs >= 5_000, `activationが旧5秒timeoutを越えて待っていない: ${activateMs}ms`);

  const runDir = path.join(repoRoot, ...runRef.split('/'));
  // 警報の記録は、probeとescalationを通ってから確定する。escalationはlifecycle lockを
  // 待つので、activateの応答より後になりうる。**待たずに読むと「出ていない」と誤読する。**
  const readControl = async () => JSON.parse(
    await readFile(path.join(runDir, 'control-events.json'), 'utf8'),
  ).filter((event) => event.kind === 'io_warning_observed');
  let warnings = [];
  const waitUntil = Date.now() + 30_000;
  for (;;) {
    warnings = await readControl();
    if (warnings.some((event) => event.payload.warning_kind === 'io_overlap_warning')) break;
    if (Date.now() >= waitUntil) break;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  const control = JSON.parse(await readFile(path.join(runDir, 'control-events.json'), 'utf8'));

  // ここが本題。共有rootの頃、この配列は常に空だった。
  assert.notEqual(warnings.length, 0,
    `実runで警報が1件も出ていない。control kinds: ${[...new Set(control.map((e) => e.kind))].join(',')}`);

  const overlap = warnings.find((event) => event.payload.warning_kind === 'io_overlap_warning');
  assert.notEqual(overlap, undefined,
    `重なり警報が無い: ${JSON.stringify(warnings.map((e) => e.payload))}`);
  assert.deepEqual(overlap.payload.todo_ids, ['T1', 'T2']);
  assert.equal(overlap.payload.path, 'src/alpha.mjs');

  // probeまで到達していること。fs eventだけで止める設計ではないので、
  // 「確かめていない（unprobed）」で終わっていたら早期警報は用を成していない。
  // probeまで到達し、実在と裁定していること。fs eventだけで止める設計ではないので、
  // unprobedで終わっていたら早期警報は用を成していない。
  assert.equal(overlap.payload.probe_outcome, 'observed',
    `probeが実在と裁定していない: ${JSON.stringify(overlap.payload)}`);

  // **これが走行中観測の証拠である。** 重なり警報は、当該pathが「他のrunning TODOの
  // 宣言scopeに入る」時にしか作られず、running集合はsentinelが監視中のTODOそのものである。
  // 監視はTODOがterminalになった時点で外れるので、T1とT2を名指す重なり警報は
  // **両者が同時に走っている最中にしか生成されない**。事後の観測では作れない。
  //
  // 一時fileの観測（transient裁定）も実測では出るが、fs.watchの取りこぼしは仕様なので
  // 受入条件にはしない——取りこぼしても判定はcheckpointが担う、という設計どおり。

  // escalationは判断まで到達し、理由を残していること。黙って見送る経路を作らない。
  const decided = control.filter((event) => event.kind === 'io_escalation_decided');
  assert.notEqual(decided.length, 0, 'escalationの判断が記録されていない');
  for (const event of decided) {
    assert.ok(event.payload.detail.length > 0, JSON.stringify(event.payload));
    assert.ok(['held', 'rejected', 'skipped'].includes(event.payload.outcome),
      JSON.stringify(event.payload));
  }

  // **早期警報からholdまで通ること。** probeのcheckpointがfindingの証拠になり、
  // findingがconflictへ、conflictがintake freezeへ、freezeがworkerの静止証明を経て
  // holdへ繋がる。事後のcheckpointを待たずに、走行中の作業がここで止まっている。
  const held = decided.find((event) => event.payload.outcome === 'held');
  assert.notEqual(held, undefined, JSON.stringify(decided.map((e) => e.payload)));
  assert.match(held.payload.finding_digest, /^[0-9a-f]{64}$/u);

  const runEvents = JSON.parse(await readFile(path.join(runDir, 'events.json'), 'utf8'));
  const kinds = runEvents.map((event) => event.kind);
  for (const kind of ['checkpoint_observed', 'conflict_found', 'intake_frozen', 'hold_decided']) {
    assert.ok(kinds.includes(kind), `${kind}が無い: ${kinds.join(',')}`);
  }
  // probeのcheckpointは由来の印を持つ。executorの申告境界と混ぜない。
  assert.notEqual(runEvents.find((event) => event.kind === 'checkpoint_observed'
    && event.payload?.observed_by === 'supervisor_probe'), undefined, '由来の印が無い');
  // workerは実際に止まった。静止の証明は「止まっているprocessを見た」ことである。
  assert.notEqual(control.find((event) => event.kind === 'executor_quiesced'), undefined,
    'executor_quiescedが無い');

  // 実writeは各workerの木の中だけで起きる。canonical repoは触られない。
  assert.equal(await readFile(path.join(repoRoot, 'src', 'alpha.mjs'), 'utf8'),
    'export const alpha = 1;\n');
  assert.equal(invoke('git', ['status', '--porcelain'], repoRoot).stdout, '');

  ok(cli(['run', 'abandon', '--run', runRef, '--reason', 'acceptance'], repoRoot), 'run abandon');
});
