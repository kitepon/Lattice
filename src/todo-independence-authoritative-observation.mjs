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
 * HEADと同じ内容の作業木では、維持されている索引を増分syncして使う（無ければ最初の1回だけinit）。
 * 同期の前後でcleanとHEADを確かめ、崩れていたらnull＝隔離worktreeの経路へ落とす。
 * 保護するもの: 未commitの状態を判定が観測しないこと。落とす先が出口で、拒否はしない。
 */
async function observeMaintainedIndex({ repoRoot, headSha, witnessSet }) {
  if (!isCleanAtHead(repoRoot, headSha)) return null;
  await runSensor(existsSync(path.join(repoRoot, '.lattice/sensor/sensor.db')) ? 'sync' : 'init', repoRoot);
  if (!isCleanAtHead(repoRoot, headSha)) return null;
  return { head_sha: headSha, sensor_evidence: await collectWitnessSensorEvidence({ cwd: repoRoot, witnessSet }) };
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
  const maintained = await observeMaintainedIndex({ repoRoot, headSha, witnessSet });
  if (maintained !== null) return maintained;
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
    result = await collectWitnessSensorEvidence({ cwd: observationRoot, witnessSet });
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
  return { head_sha: headSha, sensor_evidence: result };
}
