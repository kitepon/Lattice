import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { selfDigest } from '../../src/runtime-contracts.mjs';

// RC3-J integration（ADR 0044 Decision 8 完全実装・Decision 10.1 run store）。
// disposable repo＋実CLI processで、run start/observe/status・event verifyの
// exit契約とrun event storeの生成・再検証を固定する。

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'lattice.mjs');

import { invokeSensorCli } from '../../src/sensor-runtime.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' } });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
}

let temporaryRoot;
let repoRoot;
let baseSha;
let requestPath;

test.before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-rc3-run-cli-'));
  repoRoot = path.join(temporaryRoot, 'repo');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'test'), { recursive: true });
  await writeFile(path.join(repoRoot, '.gitignore'), '.lattice/runs/\n');
  await writeFile(path.join(repoRoot, 'src', 'alpha.mjs'), 'export const alpha = 1;\n');
  await writeFile(path.join(repoRoot, 'src', 'beta.mjs'), 'export const beta = 2;\n');
  await writeFile(path.join(repoRoot, 'test', 'alpha.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { alpha } from '../src/alpha.mjs';\n\ntest('alpha', () => { assert.equal(alpha, 1); });\n");
  await writeFile(path.join(repoRoot, 'test', 'beta.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { beta } from '../src/beta.mjs';\n\ntest('beta', () => { assert.equal(beta, 2); });\n");
  run('git', ['init', '--quiet', '--initial-branch=main'], repoRoot);
  run('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', 'add', '.'], repoRoot);
  run('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', 'commit', '--quiet', '-m', 'base'], repoRoot);
  baseSha = run('git', ['rev-parse', 'HEAD'], repoRoot).trim();
  invokeSensorCli(run, ['init', '.'], repoRoot);

  const request = {
    schema: 'lattice.run_request.v1',
    request_id: 'run-cli-01',
    repo: { base_sha: baseSha, root_kind: 'git-worktree' },
    capacity: { executors: 2 },
    todos: [{ todo_id: 'T1' }, { todo_id: 'T2' }],
    manual_witness: {
      T1: witness('alpha'),
      T2: witness('beta'),
    },
    sensor_query_set: {
      queries: [
        { id: 'q-status', operation: 'status' },
        { id: 'q-T1', operation: 'query', target: 'alpha' },
        { id: 'q-T1-aff', operation: 'affected', target: 'src/alpha.mjs' },
        { id: 'q-T2', operation: 'query', target: 'beta' },
        { id: 'q-T2-aff', operation: 'affected', target: 'src/beta.mjs' },
      ],
    },
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  requestPath = path.join(temporaryRoot, 'run-request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
});

test.after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

function witness(name) {
  return {
    owns: [{ kind: 'symbol', target: name }, { kind: 'path', target: `src/${name}.mjs` }],
    reads: [],
    writes: [`src/${name}.mjs`],
    resources: [],
    state_effects: [],
    sensor_provenance: {
      queries: [
        { query_id: `q-${name === 'alpha' ? 'T1' : 'T2'}`, expect: { kind: 'symbol', name, path: `src/${name}.mjs` } },
        { query_id: `q-${name === 'alpha' ? 'T1' : 'T2'}-aff`, expect: { kind: 'affected', path: `src/${name}.mjs` } },
      ],
    },
    affected_tests: [`test/${name}.test.mjs`],
    unknowns: [],
  };
}

test('run startはrun event storeを生成しstart resultを返す', () => {
  const result = runCli(['run', 'start', '--request', requestPath, '--executor', 'scripted'], repoRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'lattice.run_start_result.v1');
  assert.equal(output.run_id, 'run-cli-01');
  assert.equal(output.executor_adapter, 'scripted');
  assert.match(output.plan_digest, /^[0-9a-f]{64}$/);
  assert.equal(output.run_dir, path.join('.lattice', 'runs', 'run-cli-01'));
});

test('run observe/statusは保存event storeから状態を再構成する', () => {
  const runDir = path.join('.lattice', 'runs', 'run-cli-01');
  // cwdではなくGit rootへbindするため、subdirectoryからも同じrunを参照できる。
  const observe = runCli(['run', 'observe', '--run', runDir], path.join(repoRoot, 'src'));
  assert.equal(observe.status, 0, observe.stderr);
  const observation = JSON.parse(observe.stdout);
  assert.equal(observation.schema, 'lattice.run_observation.v1');
  assert.equal(observation.closed, false);
  assert.equal(observation.freeze_active, false);

  const status = runCli(['run', 'status', '--run', runDir], repoRoot);
  assert.equal(status.status, 0, status.stderr);
  const statusOutput = JSON.parse(status.stdout);
  assert.equal(statusOutput.schema, 'lattice.run_status.v1');
  // genesis直後はconflictなしの2 TODOがdispatchable。
  assert.deepEqual(statusOutput.dispatchable, ['T1', 'T2']);
  const listed = runCli(['run', 'list', '--json'], path.join(repoRoot, 'test'));
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).active_runs.map(({ run_id: id }) => id), ['run-cli-01']);
});

test('event verifyは保存event chainをtyped検証する', () => {
  const runDir = path.join('.lattice', 'runs', 'run-cli-01');
  const result = runCli(['event', 'verify', '--run', runDir], repoRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'lattice.event_verification.v1');
  assert.equal(output.valid, true, JSON.stringify(output.failed_conditions));
  assert.ok(output.checks_total >= 10);
});

test('未知executor adapterと省略はtyped rejectされる', () => {
  const unknown = runCli(['run', 'start', '--request', requestPath, '--executor', 'ghost-adapter'], repoRoot);
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).code, 'UNKNOWN_ADAPTER');
  // --executor省略はusage違反exit 2（暗黙fallbackなし）。
  const omitted = runCli(['run', 'start', '--request', requestPath], repoRoot);
  assert.equal(omitted.status, 2);
});

test('既存run storeへのrun startはtyped rejectされる', () => {
  const dup = runCli(['run', 'start', '--request', requestPath, '--executor', 'scripted'], repoRoot);
  assert.equal(dup.status, 1);
  assert.equal(JSON.parse(dup.stderr).code, 'RUN_EXISTS');
});

test('resumeはbase bindingを検証し、未完了closeは残りTODOを記録して閉じる', async () => {
  const runRef = path.join('.lattice', 'runs', 'run-cli-01');
  const resume = runCli(['run', 'resume', '--run', runRef], repoRoot);
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).outcome, 'resumable');

  // C18: close no longer refuses an incomplete run; a separate run keeps run-cli-01 open for the abandon test.
  const { readFile } = await import('node:fs/promises');
  const request = { ...JSON.parse(await readFile(requestPath, 'utf8')), request_id: 'run-cli-close' };
  request.request_digest = selfDigest(request, 'request_digest');
  const closeRequestPath = path.join(temporaryRoot, 'run-request-close.json');
  await writeFile(closeRequestPath, `${JSON.stringify(request)}\n`);
  const started = runCli(['run', 'start', '--request', closeRequestPath, '--executor', 'scripted'], repoRoot);
  assert.equal(started.status, 0, started.stderr);
  const closeRef = path.join('.lattice', 'runs', 'run-cli-close');
  const close = runCli(['run', 'close', '--run', closeRef], repoRoot);
  assert.equal(close.status, 0, close.stderr);
  assert.deepEqual(JSON.parse(close.stdout).abandoned_todo_ids, ['T1', 'T2']);
  assert.equal(JSON.parse(runCli(['run', 'status', '--run', closeRef], repoRoot).stdout).closed, true);
});

test('stale baseはresumeを止めるが明示abandonでrunを閉じられる', async () => {
  await writeFile(path.join(repoRoot, 'README.md'), 'new head\n');
  run('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', 'add', 'README.md'], repoRoot);
  run('git', ['-c', 'user.email=r@example.invalid', '-c', 'user.name=r', 'commit', '--quiet', '-m', 'advance'], repoRoot);
  const runRef = path.join('.lattice', 'runs', 'run-cli-01');
  const resume = runCli(['run', 'resume', '--run', runRef], repoRoot);
  assert.equal(resume.status, 1);
  assert.equal(JSON.parse(resume.stderr).code, 'STALE_BASE');

  const empty = runCli(['run', 'abandon', '--run', runRef, '--reason', ''], repoRoot);
  assert.equal(empty.status, 1);
  assert.equal(JSON.parse(empty.stderr).code, 'INVALID_ABANDON_REASON');
  const invalid = runCli(['run', 'abandon', '--run', runRef, '--reason', '改行\nは禁止'], repoRoot);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).code, 'INVALID_ABANDON_REASON');
  for (const reason of ['C1\u0085は禁止', '行区切り\u2028は禁止', '方向\u202e偽装は禁止']) {
    const rejected = runCli(['run', 'abandon', '--run', runRef, '--reason', reason], repoRoot);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).code, 'INVALID_ABANDON_REASON');
  }
  const padded = runCli(['run', 'abandon', '--run', runRef, '--reason', ' 前後空白は禁止 '], repoRoot);
  assert.equal(padded.status, 1);
  assert.equal(JSON.parse(padded.stderr).code, 'INVALID_ABANDON_REASON');
  const oversized = runCli(['run', 'abandon', '--run', runRef, '--reason', 'あ'.repeat(257)], repoRoot);
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stderr).code, 'INVALID_ABANDON_REASON');

  const reason = 'ChangeSet検証waveは完了し、新しい実装waveへ移行するため';
  const abandoned = runCli(['run', 'abandon', '--run', runRef, '--reason', reason], repoRoot);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.equal(JSON.parse(abandoned.stdout).outcome, 'abandoned');
  assert.equal(JSON.parse(abandoned.stdout).reason, reason);
  const status = JSON.parse(runCli(['run', 'status', '--run', runRef], repoRoot).stdout);
  assert.equal(status.closed, true);
  assert.deepEqual(JSON.parse(runCli(['run', 'list', '--json'], repoRoot).stdout).active_runs, []);
  const close = runCli(['run', 'close', '--run', runRef], repoRoot);
  assert.equal(close.status, 1);
  assert.equal(JSON.parse(close.stderr).code, 'RUN_ABANDONED');
});

test('repo外・旧run pathはINVALID_RUN_REFとして拒否する', () => {
  for (const ref of ['research/runs/rc3/run-cli-01', '../run-cli-01', '/tmp/run-cli-01']) {
    const result = runCli(['run', 'status', '--run', ref], repoRoot);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_RUN_REF');
  }
});

test('改竄event storeのevent verifyはexit 1でtyped失敗する', async () => {
  const runDir = path.join(repoRoot, '.lattice', 'runs', 'run-cli-01');
  const eventsPath = path.join(runDir, 'events.json');
  const { readFile } = await import('node:fs/promises');
  const original = await readFile(eventsPath, 'utf8');
  const events = JSON.parse(original);
  events[1].payload = { ...events[1].payload, injected: true };
  await writeFile(eventsPath, `${JSON.stringify(events, null, 1)}\n`);
  try {
    const result = runCli(['event', 'verify', '--run', path.join('.lattice', 'runs', 'run-cli-01')], repoRoot);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'EVENT_VERIFICATION_FAILED');
  } finally {
    await writeFile(eventsPath, original);
  }
});
