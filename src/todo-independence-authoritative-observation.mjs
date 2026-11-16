import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { gitSpawnSync } from './git-process.mjs';
import { runSensorCli } from './sensor-cli.mjs';
import { collectWitnessSensorEvidence } from './todo-independence.mjs';

export class TodoIndependenceObservationError extends Error {
  constructor(code, reason, detail = {}) {
    super(reason);
    this.name = 'TodoIndependenceObservationError';
    this.code = code;
    this.detail = { reason, ...detail };
  }
}

function fail(code, reason, detail = {}) {
  throw new TodoIndependenceObservationError(code, reason, detail);
}

function git({ cwd, args, operation }) {
  const result = gitSpawnSync(args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    fail('INDEPENDENCE_OBSERVATION_GIT_FAILED', 'observation_git_command_failed', {
      operation, status: result.status ?? null, signal: result.signal ?? null,
      cause: result.error?.message ?? null,
    });
  }
  return result.stdout.trim();
}

function memoryStream() {
  let value = '';
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    read: () => value,
  };
}

async function runSensor(command, observationRoot) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await runSensorCli({
    argv: [command, observationRoot, '--json'],
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  if (status !== 0) {
    fail('INDEPENDENCE_OBSERVATION_SENSOR_INIT_FAILED', 'observation_sensor_init_failed', {
      sensor_command: command, sensor_error: stderr.read(),
    });
  }
}

/**
 * a2 (ADR 0204 Observe): 作業木がHEADと同じ内容か。`.lattice/`はsensor索引とstoreが書く場所で、
 * 索引の対象外なので数えない（storeがtrackedな製品repoでは書込みのたびにdirtyになるため）。
 */
function isCleanAtHead(repoRoot, headSha) {
  return git({ cwd: repoRoot, args: ['rev-parse', '--verify', 'HEAD^{commit}'], operation: 'resolve_head' }) === headSha
    && git({
      cwd: repoRoot, operation: 'status_clean_check',
      args: ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).lattice'],
    }) === '';
}

/**
 * Observe (ADR 0204): `work(root)` を、`sha` の内容を持つ索引つきの木の上で実行する。
 * HEADと同じ内容の作業木なら、維持されている索引を増分syncして使う（無ければ最初の1回だけinit）。同期の前後で
 * cleanとHEADを確かめ、崩れていたら隔離worktreeへ落とす。`sha` がHEADでない、または作業木がdirtyなら、
 * `sha` の使い捨てworktreeで新しく索引する。保護するもの: 未commitの状態を観測しないこと。落とす先が出口で、拒否はしない。
 */
export async function withObservedTree({ repoRoot, sha }, work) {
  if (isCleanAtHead(repoRoot, sha)) {
    await runSensor(existsSync(path.join(repoRoot, '.lattice/sensor/sensor.db')) ? 'sync' : 'init', repoRoot);
    if (isCleanAtHead(repoRoot, sha)) return work(repoRoot);
  }
  const headSha = sha;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lattice-independence-observation-'));
  const observationRoot = path.join(temporaryRoot, 'worktree');
  let registered = false;
  let operationError = null;
  let result;
  try {
    git({
      cwd: repoRoot,
      args: ['worktree', 'add', '--detach', '--quiet', observationRoot, headSha],
      operation: 'worktree_add',
    });
    registered = true;
    const observedHead = git({
      cwd: observationRoot, args: ['rev-parse', '--verify', 'HEAD^{commit}'],
      operation: 'verify_observation_head',
    });
    if (observedHead !== headSha) {
      fail('INDEPENDENCE_OBSERVATION_HEAD_MISMATCH', 'observation_head_mismatch', {
        expected_head_sha: headSha, actual_head_sha: observedHead,
      });
    }
    await runSensor('init', observationRoot);
    result = await work(observationRoot);
  } catch (error) {
    operationError = error;
  }

  let cleanupError = null;
  try {
    if (registered) {
      git({
        cwd: repoRoot,
        args: ['worktree', 'remove', '--force', observationRoot],
        operation: 'worktree_remove',
      });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== null) {
    fail('INDEPENDENCE_OBSERVATION_CLEANUP_FAILED', 'observation_cleanup_failed', {
      operation_error: operationError?.message ?? null,
      cleanup_error: cleanupError?.message ?? String(cleanupError),
    });
  }
  if (operationError !== null) throw operationError;
  return result;
}

/** 共有repoのdirtyな状態を観測せず、current HEADの索引（維持されたもの、無ければclean worktree）でsensorを実行する。 */
export async function collectTodoIndependenceAuthoritativeObservation({ repoRoot, witnessSet } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0
    || witnessSet === null || typeof witnessSet !== 'object') {
    fail('INDEPENDENCE_OBSERVATION_INPUT_INVALID', 'observation_input_invalid');
  }

  const headSha = git({
    cwd: repoRoot, args: ['rev-parse', '--verify', 'HEAD^{commit}'], operation: 'resolve_head',
  });
  const sensorEvidence = await withObservedTree({ repoRoot, sha: headSha },
    (root) => collectWitnessSensorEvidence({ cwd: root, witnessSet }));
  return { head_sha: headSha, sensor_evidence: sensorEvidence };
}
