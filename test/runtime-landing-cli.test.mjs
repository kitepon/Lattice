import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalizeArtifact, digestArtifact } from '../src/artifact-contracts.mjs';
import { acquireRuntimeLifecycleLock } from '../src/runtime-lifecycle-lock.mjs';
import { selfDigest } from '../src/runtime-contracts.mjs';
import { buildNextRunEvent } from '../src/runtime-engine.mjs';
import { projectRuntimeState } from '../src/runtime-projection.mjs';
import { invokeSensorCli } from '../src/sensor-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'lattice.mjs');
const RUN_ID = 'landing-cli-fixture';
const RUN_REF = path.join('.lattice', 'runs', RUN_ID);
const CHECKPOINT_DIGEST = 'c'.repeat(64);
const DECOY_CHECKPOINT_DIGEST = 'e'.repeat(64);
const TODO_SOURCES = Object.freeze([
  { todoId: 'T1', source: 'alpha', checkpointDigest: CHECKPOINT_DIGEST },
  { todoId: 'T2', source: 'beta', checkpointDigest: '1'.repeat(64) },
  { todoId: 'T3', source: 'gamma', checkpointDigest: '2'.repeat(64) },
]);

let temporaryRoot;
let repoRoot;
let resultWorktree;
let baseSha;
let receiptHeadSha;
let eventsPath;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
}

function rebuildEventChain(events, transform) {
  const rebuilt = [];
  for (const event of events) {
    const next = transform(structuredClone(event));
    rebuilt.push(buildNextRunEvent({
      events: rebuilt,
      runId: next.run_id,
      kind: next.kind,
      planEpoch: next.plan_epoch,
      subject: next.subject,
      payload: next.payload,
      recordedAt: next.recorded_at,
    }));
  }
  return rebuilt;
}

async function snapshotRegularFiles(root, relative = '') {
  const snapshot = {};
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotRegularFiles(root, next));
    else if (entry.isFile()) snapshot[next] = (await readFile(path.join(root, next))).toString('base64');
  }
  return snapshot;
}

function witness(source) {
  return {
    owns: [{ kind: 'symbol', target: source }, { kind: 'path', target: `src/${source}.mjs` }],
    reads: [],
    writes: [`src/${source}.mjs`],
    resources: [],
    state_effects: [],
    sensor_provenance: {
      queries: [
        { query_id: `q-${source}`, expect: { kind: 'symbol', name: source, path: `src/${source}.mjs` } },
        { query_id: `q-${source}-aff`, expect: { kind: 'affected', path: `src/${source}.mjs` } },
      ],
    },
    affected_tests: [`test/${source}.test.mjs`],
    unknowns: [],
  };
}

test.before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-run-landing-'));
  repoRoot = path.join(temporaryRoot, 'repo');
  resultWorktree = path.join(temporaryRoot, 'result-worktree');
  const remoteRoot = path.join(temporaryRoot, 'remote.git');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await mkdir(path.join(repoRoot, 'test'), { recursive: true });
  await writeFile(path.join(repoRoot, '.gitignore'), '.lattice/runs/\n');
  for (const { source } of TODO_SOURCES) {
    await writeFile(path.join(repoRoot, 'src', `${source}.mjs`), `export const ${source} = 1;\n`);
    await writeFile(path.join(repoRoot, 'test', `${source}.test.mjs`),
      `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { ${source} } from '../src/${source}.mjs';\n\ntest('${source}', () => assert.equal(${source}, 1));\n`);
  }
  run('git', ['init', '--bare', '--quiet', remoteRoot], temporaryRoot);
  run('git', ['init', '--quiet', '--initial-branch=main'], repoRoot);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'add', '.'], repoRoot);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'commit', '--quiet', '-m', 'base'], repoRoot);
  baseSha = run('git', ['rev-parse', 'HEAD'], repoRoot);
  run('git', ['remote', 'add', 'origin', remoteRoot], repoRoot);
  run('git', ['push', '--quiet', '-u', 'origin', 'main'], repoRoot);
  run('git', ['remote', 'set-head', 'origin', 'main'], repoRoot);
  invokeSensorCli(run, ['init', '.'], repoRoot);

  const request = {
    schema: 'lattice.run_request.v1',
    request_id: RUN_ID,
    repo: { base_sha: baseSha, root_kind: 'git-worktree' },
    capacity: { executors: 1 },
    todos: TODO_SOURCES.map(({ todoId }) => ({ todo_id: todoId })),
    manual_witness: Object.fromEntries(TODO_SOURCES.map(({ todoId, source }) => [todoId, witness(source)])),
    sensor_query_set: {
      queries: [
        { id: 'q-status', operation: 'status' },
        ...TODO_SOURCES.flatMap(({ source }) => [
          { id: `q-${source}`, operation: 'query', target: source },
          { id: `q-${source}-aff`, operation: 'affected', target: `src/${source}.mjs` },
        ]),
      ],
    },
    executor_capability: { adapters: ['scripted'] },
    claim_mode: 'exact_minimum',
  };
  request.request_digest = selfDigest(request, 'request_digest');
  const requestPath = path.join(temporaryRoot, 'request.json');
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  const started = runCli(['run', 'start', '--request', requestPath, '--executor', 'scripted']);
  assert.equal(started.status, 0, started.stderr);

  run('git', ['worktree', 'add', '--quiet', '-b', 'receipt-result', resultWorktree, baseSha], repoRoot);
  for (const { source } of TODO_SOURCES) {
    await writeFile(path.join(resultWorktree, 'src', `${source}.mjs`), `export const ${source} = 2;\n`);
  }
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'add', ...TODO_SOURCES.map(({ source }) => `src/${source}.mjs`)], resultWorktree);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'commit', '--quiet', '-m', 'result'], resultWorktree);
  receiptHeadSha = run('git', ['rev-parse', 'HEAD'], resultWorktree);

  const runDir = path.join(repoRoot, RUN_REF);
  eventsPath = path.join(runDir, 'events.json');
  const events = JSON.parse(await readFile(eventsPath, 'utf8'));
  const append = (kind, subject, payload) => events.push(buildNextRunEvent({
    events,
    runId: RUN_ID,
    kind,
    planEpoch: 1,
    subject,
    payload,
    recordedAt: '2026-08-09T00:00:00.000Z',
  }));
  const appendAcceptedReceipt = ({ todoId, source, checkpointDigest }, { withDecoys = false } = {}) => {
    const ordinal = Number(todoId.slice(1));
    const executorHandle = `landing-executor-${ordinal}`;
    const worktreeId = `landing-worktree-${ordinal}`;
    append('executor_dispatched', { kind: 'todo', ref: todoId }, {
      executor_handle: executorHandle,
      worktree_id: worktreeId,
      packet_digest: 'a'.repeat(64),
      context_content_digest: 'b'.repeat(64),
    });
    append('checkpoint_observed', { kind: 'todo', ref: todoId }, {
      checkpoint_digest: checkpointDigest,
      observed_by: 'supervisor_terminal',
      diff: {
        schema: 'lattice.checkpoint_diff.v2',
        base_sha: baseSha,
        head_sha: receiptHeadSha,
        entries: [{ path: `src/${source}.mjs`, change: 'modified', content_digest: 'd'.repeat(64) }],
      },
    });
    if (withDecoys) {
      // exact bindの各predicateを落とした欠陥版が、必ず別headを選ぶdecoy群。
      append('checkpoint_observed', { kind: 'todo', ref: todoId }, {
        checkpoint_digest: DECOY_CHECKPOINT_DIGEST,
        observed_by: 'supervisor_terminal',
        diff: {
          schema: 'lattice.checkpoint_diff.v2',
          base_sha: baseSha,
          head_sha: baseSha,
          entries: [],
        },
      });
      append('checkpoint_observed', { kind: 'todo', ref: 'T4' }, {
        checkpoint_digest: checkpointDigest,
        observed_by: 'supervisor_terminal',
        diff: {
          schema: 'lattice.checkpoint_diff.v2',
          base_sha: baseSha,
          head_sha: baseSha,
          entries: [],
        },
      });
    }
    const receipt = {
      schema: 'lattice.executor_receipt.v1',
      receipt_id: `landing-receipt-${ordinal}`,
      executor_handle: executorHandle,
      worktree_id: worktreeId,
      base_sha: baseSha,
      plan_epoch: 1,
      packet_digest: 'a'.repeat(64),
      todo_id: todoId,
      checkpoint_digest: checkpointDigest,
      observed_diff: [{ path: `src/${source}.mjs`, change: 'modified' }],
    };
    receipt.receipt_digest = selfDigest(receipt, 'receipt_digest');
    append('receipt_recorded', { kind: 'todo', ref: todoId }, receipt);
    append('executor_terminal', { kind: 'todo', ref: todoId }, {
      executor_handle: executorHandle, terminal_state: 'reported',
    });
    append('receipt_accepted', { kind: 'todo', ref: todoId }, {
      receipt_id: receipt.receipt_id, checkpoint_digest: checkpointDigest,
    });
  };

  appendAcceptedReceipt(TODO_SOURCES[0], { withDecoys: true });
  append('checkpoint_observed', { kind: 'todo', ref: 'T1' }, {
    checkpoint_digest: CHECKPOINT_DIGEST,
    observed_by: 'supervisor_terminal',
    diff: {
      schema: 'lattice.checkpoint_diff.v2',
      base_sha: baseSha,
      head_sha: baseSha,
      entries: [],
    },
  });
  for (const todo of TODO_SOURCES.slice(1)) appendAcceptedReceipt(todo);
  await writeFile(eventsPath, `${JSON.stringify(events, null, 1)}\n`);
});

test.after(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test('moved HEADでも完了runをcloseし、未完了の放棄記録・未着地投影・再close冪等性を維持する', async () => {
  const runDir = path.dirname(eventsPath);
  await writeFile(path.join(repoRoot, 'unrelated.txt'), 'canonical main moved independently\n');
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'add', 'unrelated.txt'], repoRoot);
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'commit', '--quiet', '-m', 'unrelated'], repoRoot);
  run('git', ['push', '--quiet', 'origin', 'main'], repoRoot);
  assert.notEqual(run('git', ['rev-parse', 'HEAD'], repoRoot), baseSha);
  assert.equal(run('git', ['rev-list', '--count', '@{push}..HEAD'], repoRoot), '0');

  const acceptedEvents = await readFile(eventsPath, 'utf8');
  const incompleteEvents = JSON.parse(acceptedEvents);
  assert.equal(incompleteEvents.at(-1).kind, 'receipt_accepted');
  incompleteEvents.pop();
  await writeFile(eventsPath, `${JSON.stringify(incompleteEvents, null, 1)}\n`);
  // u03 C18: 未完了のcloseは拒否せず、残りを放棄として記録して閉じる。
  const incomplete = runCli(['run', 'close', '--run', RUN_REF]);
  await writeFile(eventsPath, acceptedEvents);
  assert.equal(incomplete.status, 0, incomplete.stderr);
  const incompleteOutput = JSON.parse(incomplete.stdout);
  assert.equal(incompleteOutput.outcome, 'closed');
  assert.equal(incompleteOutput.abandoned_todo_ids.length, 1);

  const closed = runCli(['run', 'close', '--run', RUN_REF]);
  assert.equal(closed.status, 0, closed.stderr);
  const closeOutput = JSON.parse(closed.stdout);
  assert.equal(closeOutput.already_closed, false);
  const report = closeOutput.landing;
  assert.equal(report.schema, 'lattice.run_landing_report.v1');
  assert.equal(report.landed, false);
  assert.equal(report.repository.default_branch_state, 'resolved');
  assert.equal(report.repository.default_branch_ref, 'refs/remotes/origin/main');
  assert.equal(report.repository.push_state, 'tracked');
  assert.equal(report.repository.unpushed_commits, 0);
  assert.deepEqual(report.accepted_receipts, TODO_SOURCES.map(({ todoId }, index) => ({
    todo_id: todoId,
    receipt_id: `landing-receipt-${index + 1}`,
    head_sha: receiptHeadSha,
    landing_state: 'not_landed',
    landed: false,
  })));

  const landing = runCli(['run', 'landing', '--run', RUN_REF]);
  assert.equal(landing.status, 0, landing.stderr);
  assert.deepEqual(JSON.parse(landing.stdout), report);

  const beforeReclose = await snapshotRegularFiles(runDir);
  const reclosed = runCli(['run', 'close', '--run', RUN_REF]);
  assert.equal(reclosed.status, 0, reclosed.stderr);
  const recloseOutput = JSON.parse(reclosed.stdout);
  assert.equal(recloseOutput.already_closed, true);
  assert.deepEqual(recloseOutput.landing, report);
  assert.deepEqual(await snapshotRegularFiles(runDir), beforeReclose);
});

test('exact bindの3 predicateを1つでも落とすとdecoy HEADを選ぶ', async () => {
  const state = projectRuntimeState({ events: JSON.parse(await readFile(eventsPath, 'utf8')) });
  const receipt = state.receipts.find((entry) => entry.receipt_id === 'landing-receipt-1');
  const select = ({ todo = true, digest = true, beforeAcceptance = true }) => (
    state.checkpoints.findLast((entry) => (
      (!todo || entry.todo_id === receipt.todo_id)
      && (!digest || entry.payload?.checkpoint_digest === receipt.payload?.checkpoint_digest)
      && (!beforeAcceptance || entry.sequence < receipt.accepted_sequence)
    ))?.payload?.diff?.head_sha ?? null
  );

  assert.equal(select({}), receiptHeadSha);
  assert.equal(select({ digest: false }), baseSha, 'digest条件なしは同TODO・別digest decoyを選ぶ');
  assert.equal(select({ todo: false }), baseSha, 'TODO条件なしは別TODO・同digest decoyを選ぶ');
  assert.equal(select({ beforeAcceptance: false }), baseSha,
    'sequence条件なしは受理後の同TODO・同digest decoyを選ぶ');
});

test('exact checkpoint HEADを解決できないreceiptはhead_unavailableをexit 0で返す', async () => {
  const original = await readFile(eventsPath, 'utf8');
  const events = JSON.parse(original);
  const acceptedSequence = events.find((event) => event.kind === 'receipt_accepted').sequence;
  const modified = rebuildEventChain(events, (event) => {
    if (event.kind === 'checkpoint_observed'
      && event.subject.ref === 'T1'
      && event.sequence < acceptedSequence
      && event.payload.checkpoint_digest === CHECKPOINT_DIGEST) {
      event.payload.checkpoint_digest = DECOY_CHECKPOINT_DIGEST;
    }
    return event;
  });
  await writeFile(eventsPath, `${JSON.stringify(modified, null, 1)}\n`);
  try {
    const result = runCli(['run', 'landing', '--run', RUN_REF]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.accepted_receipts.length, 3);
    assert.deepEqual(report.accepted_receipts[0], {
      todo_id: 'T1',
      receipt_id: 'landing-receipt-1',
      head_sha: null,
      landing_state: 'head_unavailable',
      landed: false,
    });
    for (const receipt of report.accepted_receipts.slice(1)) {
      assert.equal(receipt.head_sha, receiptHeadSha);
      assert.equal(receipt.landing_state, 'not_landed');
      assert.equal(receipt.landed, false);
    }
    assert.equal(report.landed, false);
  } finally {
    await writeFile(eventsPath, original);
  }
});

test('既定branchへ未pushのreceipt HEADは未着地かつ未push本数を返す', async () => {
  run('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test',
    'merge', '--quiet', '--no-edit', 'receipt-result'], repoRoot);
  const before = await readFile(eventsPath, 'utf8');
  const result = runCli(['run', 'landing', '--run', RUN_REF]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.landed, false);
  assert.equal(report.accepted_receipts[0].landing_state, 'not_landed');
  assert.equal(report.repository.unpushed_commits, 2);
  assert.equal(await readFile(eventsPath, 'utf8'), before);
});

test('既定branchへpush済みなら着地済みを返す', () => {
  run('git', ['push', '--quiet', 'origin', 'main'], repoRoot);
  const result = runCli(['run', 'landing', '--run', RUN_REF]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.landed, true);
  assert.equal(report.accepted_receipts[0].landing_state, 'landed');
  assert.equal(report.repository.unpushed_commits, 0);
});

test('remote既定branchを解決できない時は公開状態値へ出しexit 0を維持する', () => {
  run('git', ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'], repoRoot);
  try {
    const result = runCli(['run', 'landing', '--run', RUN_REF]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.landed, false);
    assert.equal(report.repository.default_branch_state, 'unresolved');
    assert.equal(report.repository.default_branch_ref, null);
    assert.equal(report.accepted_receipts[0].landing_state, 'default_branch_unresolved');
    assert.equal(report.accepted_receipts[0].landed, false);
  } finally {
    run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repoRoot);
  }
});

test('upstream無しはno_upstream状態値へ出しexit 0を維持する', () => {
  run('git', ['branch', '--unset-upstream'], repoRoot);
  run('git', ['config', 'push.default', 'upstream'], repoRoot);
  try {
    const result = runCli(['run', 'landing', '--run', RUN_REF]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.landed, true);
    assert.equal(report.repository.push_state, 'no_upstream');
    assert.equal(report.repository.push_ref, null);
    assert.equal(report.repository.unpushed_commits, null);
  } finally {
    run('git', ['config', '--unset', 'push.default'], repoRoot);
  }
});

test('CLI lifecycle lock recovers aged legacy bytes and a reused owner', async () => {
  const lockPath = path.join(path.dirname(eventsPath), '.cli-lifecycle.lock');
  for (const bytes of ['', '{"torn":']) {
    await writeFile(lockPath, bytes);
    const old = new Date(Date.now() - 11_000);
    await utimes(lockPath, old, old);
    const result = runCli(['run', 'close', '--run', RUN_REF]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).already_closed, true);
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  }

  const ownerIdentity = {
    schema: 'lattice.process_start_identity.v1',
    platform: process.platform,
    pid: process.pid,
    started_identity: 'prior-process-start',
    identity_digest: '',
  };
  ownerIdentity.identity_digest = selfDigest(ownerIdentity, 'identity_digest');
  const staleLock = {
    schema: 'lattice.runtime_lifecycle_lock.v1',
    owner_pid: process.pid,
    owner_process_start_identity: ownerIdentity,
    session_nonce_digest: digestArtifact({ run_dir: path.dirname(eventsPath), lock: '.cli-lifecycle.lock' }),
    operation: 'cli-lifecycle',
    request_id: 'prior-request',
    acquired_at: new Date().toISOString(),
    lock_digest: '',
  };
  staleLock.lock_digest = selfDigest(staleLock, 'lock_digest');
  await writeFile(lockPath, `${canonicalizeArtifact(staleLock)}\n`);
  const recovered = runCli(['run', 'close', '--run', RUN_REF]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).already_closed, true);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});

test('CLI lifecycle lock keeps fresh bytes and a live owner, then releases after either action outcome', async () => {
  const runDir = path.dirname(eventsPath);
  const lockPath = path.join(runDir, '.cli-lifecycle.lock');
  const freshBytes = Buffer.from('fresh unidentified bytes');
  await writeFile(lockPath, freshBytes);
  const fresh = runCli(['run', 'close', '--run', RUN_REF]);
  assert.equal(fresh.status, 1);
  assert.equal(JSON.parse(fresh.stderr).code, 'RUN_BUSY');
  assert.deepEqual(await readFile(lockPath), freshBytes);
  await rm(lockPath);

  const owner = await acquireRuntimeLifecycleLock({
    lockPath,
    sessionNonceDigest: digestArtifact({ run_dir: runDir, lock: '.cli-lifecycle.lock' }),
    operation: 'cli-lifecycle',
    requestId: 'live-owner',
  });
  try {
    const liveBytes = await readFile(lockPath);
    const live = runCli(['run', 'close', '--run', RUN_REF]);
    assert.equal(live.status, 1);
    assert.equal(JSON.parse(live.stderr).code, 'RUN_BUSY');
    assert.deepEqual(await readFile(lockPath), liveBytes);
  } finally {
    await owner.release();
  }

  const success = runCli(['run', 'close', '--run', RUN_REF]);
  assert.equal(success.status, 0, success.stderr);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });

  const failure = runCli(['run', 'abandon', '--run', RUN_REF, '--reason', 'already closed']);
  assert.equal(failure.status, 1);
  assert.equal(JSON.parse(failure.stderr).code, 'RUN_CLOSED');
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});
