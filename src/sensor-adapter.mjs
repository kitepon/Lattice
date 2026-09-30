import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { spawnSensorCli } from './sensor-runtime.mjs';

const OPERATIONS = new Set(['status', 'query', 'callers', 'callees', 'impact', 'affected']);
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE, '');
}

function portableCopy(value, insideNode = false) {
  if (Array.isArray(value)) {
    return value.map((entry) => portableCopy(entry));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(insideNode && key === 'updatedAt'))
    .map(([key, entry]) => [
      key,
      portableCopy(entry, key === 'node' && isPlainObject(entry)),
    ]));
}

/**
 * LatticeSensor raw outcomeから環境依存telemetryだけを除くdigest projectionを返す。
 * @param {unknown} outcome
 * @returns {unknown}
 */
export function portableSensorOutcome(outcome) {
  const portable = portableCopy(outcome);
  if (!isPlainObject(portable)
    || portable.operation !== 'status'
    || !isPlainObject(portable.data)) {
    return portable;
  }
  const {
    projectPath,
    indexPath,
    lastIndexed,
    dbSizeBytes,
    ...portableStatus
  } = portable.data;
  return { ...portable, data: portableStatus };
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function outcomeFromStatus(status) {
  if (status.initialized === false) {
    return 'absent';
  }

  const version = status.version;
  if (typeof version !== 'string' || version.length === 0) {
    return 'unsupported';
  }

  if (status.initialized !== true
    || !isPlainObject(status.pendingChanges)
    || !hasExactKeys(status.pendingChanges, ['added', 'modified', 'removed'])
    || !Object.values(status.pendingChanges).every(isNonNegativeInteger)
    || !isPlainObject(status.index)
    || !hasExactKeys(status.index, [
      'builtWithVersion',
      'builtWithExtractionVersion',
      'currentExtractionVersion',
      'reindexRecommended',
      // 非ゼロは「この索引を書いたengineより、今のengineが古い」。reindexRecommendedの逆向きで、
      // こちら側は放っておくと索引が収束しない理由が誰にも見えない。
      'engineBehindIndexFiles',
      'state',
      'pendingRefs',
    ])
    || typeof status.index.builtWithVersion !== 'string'
    || status.index.builtWithVersion.length === 0
    || !isNonNegativeInteger(status.index.builtWithExtractionVersion)
    || !isNonNegativeInteger(status.index.currentExtractionVersion)
    || typeof status.index.state !== 'string'
    || typeof status.index.reindexRecommended !== 'boolean'
    || !isNonNegativeInteger(status.index.engineBehindIndexFiles)
    || !isNonNegativeInteger(status.index.pendingRefs)
    || (status.worktreeMismatch !== null && !isPlainObject(status.worktreeMismatch))) {
    return 'unresolved';
  }

  if (status.index.state === 'unsupported') {
    return 'unsupported';
  }

  const pendingTotal = status.pendingChanges.added
    + status.pendingChanges.modified
    + status.pendingChanges.removed;
  if (pendingTotal > 0 || status.worktreeMismatch !== null || status.index.reindexRecommended) {
    return 'stale';
  }

  if (status.index.pendingRefs !== 0 || status.index.state !== 'complete') {
    return 'unresolved';
  }

  return 'ready';
}

function parseJson(stdout) {
  try {
    return { value: JSON.parse(stdout) };
  } catch {
    return { value: undefined };
  }
}

function isExactSymbolAbsent(stdout, target) {
  // The sensor may append did-you-mean candidates (upstream #1473). They are
  // suggestions, never a substitution: the exact symbol is still absent.
  const text = stripAnsi(stdout).trim();
  const absent = `ℹ Symbol "${target}" not found`;
  return text === absent || (text.startsWith(`${absent} — did you mean: `) && !text.includes('\n'));
}

function exactSymbolCandidates(value, target) {
  if (!Array.isArray(value)) {
    return { outcome: 'invalid_json', candidates: [] };
  }
  const candidates = value.filter((entry) => {
    const node = entry?.node;
    return isPlainObject(node)
      && (node.name === target || node.qualifiedName === target);
  });
  return {
    outcome: candidates.length > 0 ? 'ready' : 'symbol_absent',
    candidates,
  };
}

function summarizeAffected(targets) {
  if (targets.every(({ outcome }) => outcome === 'ready')) {
    return 'ready';
  }
  if (targets.every(({ outcome }) => outcome === 'empty')) {
    return 'empty';
  }
  return 'unresolved';
}

function pathIsInside(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function pathIsInsideOrEqual(root, candidate) {
  return path.relative(root, candidate) === '' || pathIsInside(root, candidate);
}

async function inspectAffectedPathState({ cwd, target }) {
  if (path.isAbsolute(target)) return 'unresolved';
  const root = path.resolve(cwd);
  const candidate = path.resolve(root, target);
  if (!pathIsInside(root, candidate)) return 'unresolved';

  let rootRealpath;
  try {
    rootRealpath = await realpath(root);
  } catch {
    return 'unresolved';
  }

  try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return 'unresolved';
    const candidateRealpath = await realpath(candidate);
    return pathIsInside(rootRealpath, candidateRealpath) ? 'file' : 'unresolved';
  } catch (error) {
    if (error?.code !== 'ENOENT') return 'unresolved';
    try {
      const parentRealpath = await realpath(path.dirname(candidate));
      return pathIsInsideOrEqual(rootRealpath, parentRealpath) ? 'absent' : 'unresolved';
    } catch {
      return 'unresolved';
    }
  }
}

async function affectedPathState(inspectAffectedPath, cwd, target) {
  try {
    const state = await inspectAffectedPath({ cwd, target });
    return new Set(['file', 'absent', 'unresolved']).has(state) ? state : 'unresolved';
  } catch {
    return 'unresolved';
  }
}

function emptyAffectedData(target) {
  return {
    changedFiles: [target],
    affectedTests: [],
    totalDependentsTraversed: 0,
  };
}

function defaultExecutor({ args, cwd }) {
  return new Promise((resolve) => {
    const child = spawnSensorCli(args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function executeCommand(execute, command) {
  try {
    const result = await execute(command);
    if (!result || typeof result !== 'object') {
      return { code: null, stdout: '', stderr: '', error: 'invalid executor result' };
    }
    return {
      code: result.code,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      error: result.error,
    };
  } catch (error) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveExactSymbol({ cwd, target, execute }) {
  const result = await executeCommand(execute, {
    operation: 'query',
    target,
    cwd,
    args: ['query', target, '--path', '.', '--json'],
  });
  if (result.code !== 0) {
    return { outcome: 'command_failure', exitCode: result.code };
  }
  const parsed = parseJson(result.stdout);
  if (parsed.value === undefined) {
    return {
      outcome: isExactSymbolAbsent(result.stdout, target) ? 'symbol_absent' : 'invalid_json',
    };
  }
  return exactSymbolCandidates(parsed.value, target);
}

async function collectOne({ cwd, query, execute, inspectAffectedPath }) {
  const { id, operation, target, exact_path: exactPath } = query;
  if (!OPERATIONS.has(operation)) {
    return { id, operation, outcome: 'unsupported' };
  }

  if (operation === 'affected') {
    const targets = Array.isArray(query.targets) ? query.targets : [target];
    if (targets.length === 0 || targets.some((value) => typeof value !== 'string' || value.length === 0)) {
      return { id, operation, outcome: 'unresolved' };
    }

    const results = [];
    for (const targetPath of targets) {
      const pathState = await affectedPathState(inspectAffectedPath, cwd, targetPath);
      if (pathState === 'absent') {
        results.push({
          target: targetPath,
          outcome: 'empty',
          path_state: 'absent',
          data: emptyAffectedData(targetPath),
        });
        continue;
      }
      if (pathState !== 'file') {
        results.push({ target: targetPath, outcome: 'unresolved' });
        continue;
      }
      const command = {
        operation,
        target: targetPath,
        cwd,
        args: ['affected', targetPath, '--path', '.', '--json'],
      };
      const result = await executeCommand(execute, command);
      if (result.code !== 0) {
        results.push({ target: targetPath, outcome: 'command_failure', exitCode: result.code });
        continue;
      }
      const parsed = parseJson(result.stdout);
      if (parsed.value === undefined || !parsed.value || !Array.isArray(parsed.value.affectedTests)) {
        results.push({ target: targetPath, outcome: 'invalid_json' });
        continue;
      }
      results.push({
        target: targetPath,
        outcome: parsed.value.affectedTests.length === 0 ? 'empty' : 'ready',
        data: parsed.value,
      });
    }
    return { id, operation, outcome: summarizeAffected(results), targets: results };
  }

  if (operation !== 'status' && (typeof target !== 'string' || target.length === 0)) {
    return { id, operation, outcome: 'unresolved' };
  }
  if (Object.hasOwn(query, 'exact_path')
    && (!['callers', 'callees'].includes(operation)
      || typeof exactPath !== 'string' || exactPath.length === 0 || path.isAbsolute(exactPath))) {
    return { id, operation, target, outcome: 'unresolved' };
  }

  const command = {
    operation,
    target,
    cwd,
    // callers/calleesはCLI既定の20件で黙って切られる。fanoutの大きい関数では
    // module値への参照（valueRef）が窓の外へ落ち、閉包が「完結した」と誤認する
    // ——観測の打ち切りを「無い」へ丸めない。明示limitで引く。
    args: operation === 'status'
      ? ['status', '.', '--json']
      : ['callers', 'callees'].includes(operation)
        ? [operation, target, '--path', '.', '--limit', '200',
          ...(exactPath === undefined ? [] : ['--exact-path', exactPath]), '--json']
        : [operation, target, '--path', '.', '--json'],
  };
  const result = await executeCommand(execute, command);
  if (result.code !== 0) {
    return { id, operation, outcome: 'command_failure', exitCode: result.code };
  }

  const parsed = parseJson(result.stdout);
  if (parsed.value === undefined) {
    if (operation !== 'status' && isExactSymbolAbsent(result.stdout, target)) {
      return { id, operation, target, outcome: 'symbol_absent' };
    }
    return { id, operation, target, outcome: 'invalid_json' };
  }

  if (operation === 'status') {
    if (!parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object') {
      return { id, operation, outcome: 'invalid_json' };
    }
    return { id, operation, outcome: outcomeFromStatus(parsed.value), data: parsed.value };
  }

  if (operation === 'query') {
    const resolution = exactSymbolCandidates(parsed.value, target);
    return {
      id,
      operation,
      target,
      outcome: resolution.outcome,
      data: resolution.candidates,
    };
  }

  const resolution = await resolveExactSymbol({ cwd, target, execute });
  if (resolution.outcome !== 'ready') {
    return {
      id,
      operation,
      target,
      outcome: resolution.outcome,
      ...(resolution.exitCode === undefined ? {} : { exitCode: resolution.exitCode }),
    };
  }

  return {
    id,
    operation,
    target,
    outcome: 'ready',
    data: parsed.value,
    resolution: resolution.candidates,
  };
}

/**
 * Collects LatticeSensor CLI evidence without turning command failures or empty results into independence.
 * @param {{ cwd: string, querySet: { queries?: object[] }, execute?: Function }} options
 * @returns {Promise<{ cwd: string, outcomes: object[] }>}
 */
export async function collectSensorEvidence({
  cwd,
  querySet,
  execute = defaultExecutor,
  inspectAffectedPath = inspectAffectedPathState,
} = {}) {
  const queries = Array.isArray(querySet?.queries) ? querySet.queries : [];
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { cwd, outcomes: [{ outcome: 'unresolved', reason: 'invalid_cwd' }] };
  }
  if (!Array.isArray(querySet?.queries)) {
    return { cwd, outcomes: [{ outcome: 'unresolved', reason: 'invalid_query_set' }] };
  }
  if (typeof inspectAffectedPath !== 'function') {
    return { cwd, outcomes: [{ outcome: 'unresolved', reason: 'invalid_path_inspector' }] };
  }

  const outcomes = [];
  for (const query of queries) {
    if (!query || typeof query !== 'object') {
      outcomes.push({ outcome: 'unresolved', reason: 'invalid_query' });
      continue;
    }
    outcomes.push(await collectOne({ cwd, query, execute, inspectAffectedPath }));
  }
  return { cwd, outcomes };
}
