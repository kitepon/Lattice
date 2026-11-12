import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  cp, mkdir, mkdtemp, open, readFile, rename, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { selfDigest } from './runtime-contracts.mjs';
import {
  RuntimeLifecycleLockError,
  acquireRuntimeLifecycleLock,
} from './runtime-lifecycle-lock.mjs';

const execFileAsync = promisify(execFile);
const STORE_REF = '.lattice/todo';
const STORE_PATHS = [STORE_REF,
  ':(exclude,glob).lattice/todo/**/.write.lock*',
  ':(exclude,glob).lattice/todo/**/.write.lock*/**',
  ':(exclude,glob).lattice/todo/.cross-plan-recovery/**',
  ':(exclude,glob).lattice/todo/notices/**',
];
const LOCK_NAME = 'lattice-todo-store-commit.lock';

export class TodoStoreGitTransactionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TodoStoreGitTransactionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new TodoStoreGitTransactionError(code, message, detail);
}

async function git(repoRoot, args, { env = process.env, allowExitCodes = [0] } = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: repoRoot,
      env,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : null;
    if (exitCode !== null && allowExitCodes.includes(exitCode)) {
      return {
        stdout: Buffer.isBuffer(error.stdout) ? error.stdout : Buffer.from(error.stdout ?? ''),
        stderr: Buffer.isBuffer(error.stderr) ? error.stderr : Buffer.from(error.stderr ?? ''),
        exitCode,
      };
    }
    throw error;
  }
}

function text(buffer) { return buffer.toString('utf8').trim(); }
function fields(buffer) {
  return buffer.toString('utf8').split('\0').filter((value) => value.length > 0);
}

function failureSummary(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    type: error?.constructor?.name ?? 'Error',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1_024) : null,
  };
}

function repositoryGitEnvironment(env) {
  const result = { ...env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) {
    delete result[key];
  }
  return result;
}

async function commonGitDir(repoRoot, env) {
  const result = await git(repoRoot,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'], { env });
  const resolved = text(result.stdout);
  if (!path.isAbsolute(resolved)) fail('STORE_COMMIT_GIT_INVALID', 'git_common_dir_not_absolute');
  return resolved;
}

export async function resolveTodoStoreCommitLockPath({ repoRoot, env = process.env }) {
  return path.join(await commonGitDir(repoRoot, env), LOCK_NAME);
}

async function head(repoRoot, env) {
  const result = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], {
    env, allowExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) {
    fail('STORE_COMMIT_HEAD_UNBORN', 'todo_store_commit_requires_head');
  }
  return text(result.stdout);
}

async function headTarget(repoRoot, env) {
  const symbolic = await git(repoRoot, ['symbolic-ref', '-q', 'HEAD'], {
    env, allowExitCodes: [0, 1],
  });
  return symbolic.exitCode === 0 ? text(symbolic.stdout) : 'HEAD';
}

async function storeStatus(repoRoot, env) {
  const result = await git(repoRoot,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...STORE_PATHS], { env });
  return fields(result.stdout);
}

async function actualIndexPath(repoRoot, env) {
  const result = await git(repoRoot,
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { env });
  const resolved = text(result.stdout);
  if (!path.isAbsolute(resolved)) fail('STORE_COMMIT_GIT_INVALID', 'git_index_path_not_absolute');
  return resolved;
}

async function syncPath(target) {
  const handle = await open(target, fsConstants.O_RDWR);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function prepareSharedIndex({ repoRoot, commitSha, env }) {
  const indexPath = await actualIndexPath(repoRoot, env);
  const lockPath = `${indexPath}.lock`;
  let lockHandle;
  try {
    // 元indexを開いてからlockを作ると、その隙に別processがindexを置換し得る。
    // wxでlock所有を先に確定し、その後に安定した元index bytesを複製する。
    lockHandle = await open(lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('STORE_COMMIT_INDEX_BUSY', 'git_index_lock_already_exists', { lock_path: lockPath });
    }
    throw error;
  }
  try {
    await lockHandle.writeFile(await readFile(indexPath));
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = null;
    const isolatedEnv = { ...env, GIT_INDEX_FILE: lockPath };
    await git(repoRoot, ['reset', '--quiet', commitSha, '--', ...STORE_PATHS], { env: isolatedEnv });
    const indexCompared = await git(repoRoot,
      ['diff', '--quiet', '--cached', commitSha, '--', ...STORE_PATHS], {
        env: isolatedEnv, allowExitCodes: [0, 1],
      });
    const worktreeCompared = await git(repoRoot,
      ['diff', '--quiet', commitSha, '--', ...STORE_PATHS], {
        env: isolatedEnv, allowExitCodes: [0, 1],
      });
    if (indexCompared.exitCode !== 0 || worktreeCompared.exitCode !== 0) {
      fail('STORE_COMMIT_INDEX_DIRTY', 'prepared_todo_store_index_not_clean', {
        index_matches_commit: indexCompared.exitCode === 0,
        worktree_matches_commit: worktreeCompared.exitCode === 0,
      });
    }
    await syncPath(lockPath);
    return {
      indexPath,
      lockPath,
      async commit() {
        await rename(lockPath, indexPath);
      },
      async rollback() {
        await rm(lockPath, { force: true });
      },
    };
  } catch (error) {
    if (lockHandle !== null) await lockHandle.close().catch(() => {});
    await rm(lockPath, { force: true });
    throw error;
  }
}

async function restoreStore({ repoRoot, backupStore, env }) {
  const storeRoot = path.join(repoRoot, STORE_REF);
  await rm(storeRoot, { recursive: true, force: true });
  await mkdir(path.dirname(storeRoot), { recursive: true });
  await cp(backupStore, storeRoot, { recursive: true, force: false, errorOnExist: true });
  const dirty = await storeStatus(repoRoot, env);
  if (dirty.length > 0) {
    fail('STORE_COMMIT_ROLLBACK_FAILED', 'todo_store_rollback_not_clean', { paths: dirty });
  }
}

function commitIdentity(argv) {
  const firstFlag = argv.findIndex((value) => typeof value === 'string' && value.startsWith('--'));
  const operation = argv.slice(0, firstFlag < 0 ? argv.length : firstFlag).join('-');
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : null;
  };
  const plan = valueAfter('--plan');
  const task = valueAfter('--task');
  const phase = valueAfter('--phase');
  const labels = [operation, plan === null ? null : `plan=${plan}`,
    task === null ? null : `task=${task}`, phase === null ? null : `phase=${phase}`]
    .filter(Boolean);
  return {
    operation: operation || 'write',
    message: `Lattice ToDo状態更新: ${labels.join(' ')}`,
  };
}

async function buildDetachedCommit({ repoRoot, commonDir, headBefore, message, env }) {
  const adminDir = await mkdtemp(path.join(commonDir, 'lattice-todo-commit-'));
  const indexPath = path.join(adminDir, 'index');
  const messagePath = path.join(adminDir, 'message');
  try {
    await mkdir(path.join(adminDir, 'logs'), { recursive: true });
    await writeFile(path.join(adminDir, 'commondir'), '..\n', { flag: 'wx' });
    await writeFile(path.join(adminDir, 'HEAD'), `${headBefore}\n`, { flag: 'wx' });
    await writeFile(messagePath, `${message}\n`, { flag: 'wx' });
    const isolatedEnv = {
      ...env,
      GIT_DIR: adminDir,
      GIT_WORK_TREE: repoRoot,
      GIT_INDEX_FILE: indexPath,
    };
    await git(repoRoot, ['read-tree', headBefore], { env: isolatedEnv });
    await git(repoRoot, ['add', '-A', '--', ...STORE_PATHS], { env: isolatedEnv });
    const changed = fields((await git(repoRoot,
      ['diff', '--cached', '--name-only', '-z', '--', ...STORE_PATHS], { env: isolatedEnv })).stdout);
    if (changed.length === 0) fail('STORE_COMMIT_NO_CHANGES', 'todo_store_mutation_changed_no_paths');
    if (changed.some((ref) => ref !== STORE_REF && !ref.startsWith(`${STORE_REF}/`))) {
      fail('STORE_COMMIT_SCOPE_VIOLATION', 'todo_store_commit_contains_outside_path', {
        paths: changed,
      });
    }
    await git(repoRoot, ['commit', '--quiet', '--no-status', '--file', messagePath], {
      env: isolatedEnv,
    });
    const commitSha = text((await git(repoRoot, ['rev-parse', 'HEAD'], { env: isolatedEnv })).stdout);
    return { commitSha, changed };
  } finally {
    await rm(adminDir, { recursive: true, force: true });
  }
}

async function updateHead({ repoRoot, target, commitSha, headBefore, env }) {
  try {
    await git(repoRoot, ['update-ref', target, commitSha, headBefore], { env });
  } catch (error) {
    const current = await head(repoRoot, env).catch(() => null);
    if (current !== headBefore) {
      fail('STORE_COMMIT_HEAD_CONFLICT', 'head_changed_before_store_commit', {
        expected_head: headBefore,
        actual_head: current,
      });
    }
    throw error;
  }
}

function receipt({ operationResult, commitSha, headBefore, changed, message }) {
  const result = {
    schema: 'lattice.todo_store_atomic_commit_result.v1',
    operation_result: operationResult,
    commit: {
      schema: 'lattice.todo_store_commit_receipt.v1',
      commit_sha: commitSha,
      parent_sha: headBefore,
      paths: changed,
      message,
    },
    result_digest: '',
  };
  result.result_digest = selfDigest(result, 'result_digest');
  return result;
}

/**
 * Todo store mutationをcommon Git-dir lockの内側で実行し、store pathだけをcommitする。
 * sourceのworking treeと、store以外の共有index entryには触れない。
 */
export async function commitTodoStoreMutation({
  repoRoot,
  argv,
  action,
  env = process.env,
  lockTimeoutMs = 0,
} = {}) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)
    || !Array.isArray(argv) || typeof action !== 'function'
    || env === null || typeof env !== 'object' || Array.isArray(env)
    || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new TypeError('commitTodoStoreMutation optionsが不正');
  }
  const gitEnv = repositoryGitEnvironment(env);
  const commonDir = await commonGitDir(repoRoot, gitEnv);
  const { operation, message } = commitIdentity(argv);
  const nonce = randomUUID();
  const lockPath = path.join(commonDir, LOCK_NAME);
  let lock;
  try {
    lock = await acquireRuntimeLifecycleLock({
      lockPath,
      sessionNonceDigest: createHash('sha256').update(nonce).digest('hex'),
      operation: `todo-${operation}`.slice(0, 128),
      requestId: `todo-${process.pid}-${nonce.replaceAll('-', '').slice(0, 16)}`,
      timeoutMs: lockTimeoutMs,
    });
  } catch (error) {
    if (error instanceof RuntimeLifecycleLockError) {
      fail(error.code, 'todo_store_commit_lock_failed', {
        lock_path: lockPath,
        reason: error.detail,
      });
    }
    throw error;
  }
  let transactionDir = null;
  let backupStore = null;
  let refUpdated = false;
  let commitSha = null;
  let backupReady = false;
  let preparedIndex = null;
  let primaryFailure = null;
  try {
    try {
      transactionDir = await mkdtemp(path.join(commonDir, 'lattice-todo-rollback-'));
      backupStore = path.join(transactionDir, 'todo');
      const dirty = await storeStatus(repoRoot, gitEnv);
      if (dirty.length > 0) {
        fail('STORE_COMMIT_DIRTY', 'todo_store_dirty_at_atomic_entry', { paths: dirty });
      }
      const storeRoot = path.join(repoRoot, STORE_REF);
      await cp(storeRoot, backupStore, { recursive: true, force: false, errorOnExist: true });
      backupReady = true;
      const headBefore = await head(repoRoot, gitEnv);
      const target = await headTarget(repoRoot, gitEnv);
      const operationResult = await action(repoRoot);
      const built = await buildDetachedCommit({
        repoRoot, commonDir, headBefore, message, env: gitEnv,
      });
      commitSha = built.commitSha;
      preparedIndex = await prepareSharedIndex({ repoRoot, commitSha, env: gitEnv });
      await updateHead({ repoRoot, target, commitSha, headBefore, env: gitEnv });
      refUpdated = true;
      try {
        // 共有index lockを保持したまま、store entryだけ整合済みのindexへatomic renameする。
        await preparedIndex.commit();
        preparedIndex = null;
      } catch (error) {
        try {
          await updateHead({
            repoRoot, target, commitSha: headBefore, headBefore: commitSha, env: gitEnv,
          });
          refUpdated = false;
        } catch (recoveryError) {
          fail('STORE_COMMIT_RECOVERY_REQUIRED', 'todo_store_index_finalize_and_ref_rollback_failed', {
            commit_sha: commitSha,
            index_lock_path: preparedIndex?.lockPath ?? null,
            cause: recoveryError?.code ?? recoveryError?.constructor?.name ?? 'Error',
          });
        }
        if (error instanceof TodoStoreGitTransactionError) throw error;
        fail('STORE_COMMIT_FINALIZE_FAILED', 'todo_store_index_finalize_failed', {
          commit_sha: commitSha,
        });
      }
      return receipt({
        operationResult, commitSha, headBefore, changed: built.changed, message,
      });
    } catch (error) {
      if (!refUpdated) {
        try {
          if (backupReady) await restoreStore({ repoRoot, backupStore, env: gitEnv });
        } catch (rollbackError) {
          if (rollbackError instanceof TodoStoreGitTransactionError) throw rollbackError;
          fail('STORE_COMMIT_ROLLBACK_FAILED', 'todo_store_rollback_failed', {
            cause: rollbackError?.constructor?.name ?? 'Error',
          });
        }
      }
      if (error instanceof TypeError || error instanceof TodoStoreGitTransactionError
        || (typeof error?.code === 'string' && error.detail !== null
          && typeof error.detail === 'object')) throw error;
      fail('STORE_COMMIT_FAILED', 'todo_store_git_commit_failed', {
        cause: error?.constructor?.name ?? 'Error',
        commit_sha: commitSha,
      });
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    const indexLockPath = preparedIndex?.lockPath ?? null;
    if (preparedIndex !== null) {
      try { await preparedIndex.rollback(); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (transactionDir !== null) {
      try { await rm(transactionDir, { recursive: true, force: true }); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await lock.release(); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length > 0) {
      throw new TodoStoreGitTransactionError(
        refUpdated ? 'STORE_COMMIT_POST_COMMIT_CLEANUP_FAILED' : 'STORE_COMMIT_CLEANUP_FAILED',
        refUpdated ? 'todo_store_commit_succeeded_but_cleanup_failed' : 'todo_store_cleanup_failed',
        {
          commit_sha: refUpdated ? commitSha : null,
          index_lock_path: indexLockPath,
          primary: primaryFailure === null ? null : failureSummary(primaryFailure),
          failures: cleanupFailures.map((error) => (
            typeof error?.code === 'string' ? error.code : error?.constructor?.name ?? 'Error'
          )),
        },
      );
    }
  }
}
