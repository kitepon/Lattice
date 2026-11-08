import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalizeArtifact } from '../src/artifact-contracts.mjs';
import { selfDigest } from '../src/runtime-contracts.mjs';
import {
  RuntimeLifecycleLockError,
  acquireRuntimeLifecycleLock,
  recoverUnidentifiedLock,
  releaseRuntimeLifecycleLock,
  validateRuntimeLifecycleLockArtifact,
} from '../src/runtime-lifecycle-lock.mjs';

const D = (character) => character.repeat(64);
const WHEN = new Date('2026-07-21T00:00:00.000Z');

function identity(pid, startedIdentity = `fixture-${pid}`) {
  const value = {
    schema: 'lattice.process_start_identity.v1', platform: process.platform,
    pid, started_identity: startedIdentity, identity_digest: '',
  };
  value.identity_digest = selfDigest(value, 'identity_digest');
  return value;
}

async function fixture(t) {
  const runDir = await mkdtemp(path.join(tmpdir(), 'lattice-lifecycle-lock-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  return { runDir, lockPath: path.join(runDir, '.lifecycle.lock') };
}

function acquire(runDir, overrides = {}) {
  const current = identity(process.pid);
  return acquireRuntimeLifecycleLock({
    runDir,
    sessionNonceDigest: D('a'),
    operation: 'hold',
    requestId: 'request-a',
    processStartIdentity: current,
    observeProcessStartIdentity: async () => current,
    now: () => WHEN,
    ...overrides,
  });
}

test('並行2取得はwxで一方だけ成功し、他方をtyped RUN_BUSYにする', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const results = await Promise.allSettled([acquire(runDir), acquire(runDir)]);
  const fulfilled = results.filter(({ status }) => status === 'fulfilled');
  const rejected = results.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason instanceof RuntimeLifecycleLockError, true);
  assert.equal(rejected[0].reason.code, 'RUN_BUSY');
  const bytes = await readFile(lockPath, 'utf8');
  const artifact = JSON.parse(bytes);
  assert.equal(bytes, `${canonicalizeArtifact(artifact)}\n`);
  assert.equal(validateRuntimeLifecycleLockArtifact(artifact), true);
  await fulfilled[0].value.release();
});

test('dead又はPID再利用されたowner artifactを検証して回収する', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const staleIdentity = identity(process.pid, 'old-process-start');
  const stale = {
    schema: 'lattice.runtime_lifecycle_lock.v1', owner_pid: process.pid,
    owner_process_start_identity: staleIdentity, session_nonce_digest: D('b'),
    operation: 'recompile', request_id: 'old-request',
    acquired_at: WHEN.toISOString(), lock_digest: '',
  };
  stale.lock_digest = selfDigest(stale, 'lock_digest');
  await writeFile(lockPath, `${canonicalizeArtifact(stale)}\n`, { mode: 0o600, flag: 'wx' });

  const current = identity(process.pid, 'current-process-start');
  const acquired = await acquire(runDir, {
    processStartIdentity: current,
    observeProcessStartIdentity: async () => current,
    operation: 'resume', requestId: 'new-request',
  });
  assert.equal(acquired.artifact.operation, 'resume');
  assert.notEqual(acquired.artifact.lock_digest, stale.lock_digest);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).lock_digest,
    acquired.artifact.lock_digest);
  await acquired.release();
});

test('foreign owner digestによるreleaseはlockを残して拒否する', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const acquired = await acquire(runDir);
  await assert.rejects(
    releaseRuntimeLifecycleLock({ lockPath, ownerDigest: D('f') }),
    (error) => error instanceof RuntimeLifecycleLockError
      && error.code === 'RUN_LOCK_OWNER_MISMATCH',
  );
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).lock_digest,
    acquired.artifact.lock_digest);
  await acquired.release();
});

test('待機期限切れはtyped RUN_BUSYで既存ownerを保持する', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const first = await acquire(runDir);
  await assert.rejects(acquire(runDir, {
    requestId: 'request-timeout', timeoutMs: 15, retryIntervalMs: 2,
  }), (error) => error instanceof RuntimeLifecycleLockError
    && error.code === 'RUN_BUSY' && /timeout/u.test(error.detail));
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).lock_digest,
    first.artifact.lock_digest);
  await first.release();
});

test('u03 L1: 公開はtemp+linkで完全bytesだけを置き、temporaryを残さない', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const handle = await acquire(runDir);
  assert.equal(validateRuntimeLifecycleLockArtifact(JSON.parse(await readFile(lockPath, 'utf8'))), true);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.endsWith('.tmp')), []);
  await handle.release();
  assert.deepEqual(await readdir(runDir), []);
});

test('u03 L1: 死んだ取得者のtemporaryは次の取得者が片付ける', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const dead = `${lockPath}.2147483646.00000000-0000-0000-0000-000000000000.tmp`;
  await writeFile(dead, '{"partial":');
  const handle = await acquire(runDir);
  assert.deepEqual((await readdir(runDir)).filter((name) => name.endsWith('.tmp')), []);
  await handle.release();
});

test('u03 L2: 空・破損lockは猶予内はRUN_BUSY、猶予後は自動回収して取得できる', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  for (const bytes of ['', '{"schema":"lattice.runtime_lifecycle_lock.v1","owner_pid":']) {
    await writeFile(lockPath, bytes);
    await assert.rejects(acquire(runDir), (error) => error.code === 'RUN_BUSY');
    assert.equal(await readFile(lockPath, 'utf8'), bytes, '猶予内の未識別bytesは保つ');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const handle = await acquire(runDir);
    assert.equal(validateRuntimeLifecycleLockArtifact(JSON.parse(await readFile(lockPath, 'utf8'))), true);
    await handle.release();
    assert.deepEqual(await readdir(runDir), []);
  }
});

test('u03 L2: 別schemaのlockは新しい版のownerとみなし、古くても回収しない', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const bytes = '{"schema":"lattice.runtime_lifecycle_lock.v2","owner_pid":1}\n';
  await writeFile(lockPath, bytes);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await assert.rejects(acquire(runDir), (error) => error.code === 'RUN_LOCK_INVALID');
  assert.equal(await readFile(lockPath, 'utf8'), bytes);
});

test('u03 L2: 判定後に差し替わったlockはquarantineから戻し、消さない', async (t) => {
  const { lockPath } = await fixture(t);
  await writeFile(lockPath, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const judged = await lstat(lockPath);
  // 判定(lstat)と回収(rename)の間に、解放と新しい取得が割り込んだ状況。
  await rm(lockPath);
  await writeFile(lockPath, 'fresh-owner');
  assert.equal(await recoverUnidentifiedLock(lockPath, judged), true);
  assert.equal(await readFile(lockPath, 'utf8'), 'fresh-owner');
  assert.deepEqual((await readdir(path.dirname(lockPath))).sort(), ['.lifecycle.lock']);
});

test('u03 L1: hard linkの無いfilesystemでは従来の排他作成へ戻って取得できる', async (t) => {
  const { runDir, lockPath } = await fixture(t);
  const noLink = async () => { const error = new Error('no link'); error.code = 'EPERM'; throw error; };
  const handle = await acquire(runDir, { publishLink: noLink });
  assert.equal(validateRuntimeLifecycleLockArtifact(JSON.parse(await readFile(lockPath, 'utf8'))), true);
  await assert.rejects(acquire(runDir, { publishLink: noLink }), (error) => error.code === 'RUN_BUSY');
  await handle.release();
  assert.deepEqual(await readdir(runDir), []);
});
