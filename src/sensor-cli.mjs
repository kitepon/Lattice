import { existsSync } from 'node:fs';
import path from 'node:path';
import sensorPackage from '../sensor/package.json' with { type: 'json' };
import { compareSensorIndexes, parseSensorDiffArgs, SensorDiffError } from './sensor-diff.mjs';
import { spawnSensorCli } from './sensor-runtime.mjs';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

const USAGE = 'usage: lattice sensor <init|sync> [path] [--json]'
  + ' | lattice sensor diff <rootA> <rootB>'
  + ' [--subtree-a <rel>] [--subtree-b <rel>] [--map-a <from>=<to>] [--map-b <from>=<to>]'
  + ' [--limit <n>] [--json]';

function usage(stderr) {
  writeJson(stderr, { schema: 'lattice.cli_error.v2', code: 'USAGE', message: USAGE });
  return 2;
}

function parse(argv) {
  if (argv.at(-1) !== '--json') return null;
  const words = argv.slice(0, -1);
  if (words[0] === 'diff') {
    const request = parseSensorDiffArgs(words.slice(1));
    return request === null ? null : { command: 'diff', diff: request };
  }
  if (!['init', 'sync'].includes(words[0]) || words.length > 2) return null;
  return { command: words[0], path: words[1] ?? '.' };
}

/**
 * 2つのindexを突き合わせる。索引そのものは作らない——差分を見に来た人に、黙ってrepoの状態を
 * 書き換える権限は与えられていない。片側が未索引なら、次の一手を添えて止まる。
 */
function runDiff(request, stdout, stderr) {
  try {
    writeJson(stdout, {
      ...compareSensorIndexes(request),
      sensor_version: sensorPackage.version,
    });
    return 0;
  } catch (error) {
    // 想定外の失敗もtyped errorへ落とす。素通しさせるとstack traceだけが出て、
    // 呼んだ側は「差分が出なかった」のか「壊れた」のかを機械で区別できない。
    const typed = error instanceof SensorDiffError;
    writeJson(stderr, {
      schema: 'lattice.cli_error.v2',
      code: typed ? error.code : 'LATTICE_SENSOR_DIFF_FAILED',
      message: typed ? error.message : 'sensor diff failed',
      detail: typed ? error.detail : { cause: error?.message ?? 'unknown error' },
    });
    return 1;
  }
}

function execute(command, projectPath) {
  return new Promise((resolve, reject) => {
    let captured = 0;
    const stderrChunks = [];
    let diagnosticBytes = 0;
    const hasIndex = existsSync(path.resolve(projectPath, '.lattice/sensor', 'sensor.db'));
    const sensorArgs = command === 'init' && hasIndex
      ? ['index', projectPath, '--quiet']
      : [command, projectPath];
    const child = spawnSensorCli(sensorArgs, {
      env: {
        ...process.env,
        LATTICE_SENSOR_NO_UPDATE_CHECK: '1',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const observe = (chunk, retain = false) => {
      captured += chunk.length;
      if (retain && diagnosticBytes < MAX_DIAGNOSTIC_BYTES) {
        const retained = chunk.subarray(0, MAX_DIAGNOSTIC_BYTES - diagnosticBytes);
        stderrChunks.push(retained);
        diagnosticBytes += retained.length;
      }
      if (captured > MAX_CAPTURE_BYTES) child.kill('SIGTERM');
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', (chunk) => observe(chunk, true));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      overflow: captured > MAX_CAPTURE_BYTES,
      stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
    }));
  });
}

export async function runSensorCli({ argv, stdout, stderr }) {
  const request = parse(argv);
  if (!request) return usage(stderr);
  if (request.command === 'diff') return runDiff(request.diff, stdout, stderr);
  if (!existsSync(request.path)) {
    writeJson(stderr, { schema: 'lattice.cli_error.v2', code: 'LATTICE_SENSOR_PATH_MISSING',
      message: `no such project path: ${request.path}`,
      detail: { path: request.path, next_action: `lattice sensor ${request.command}` } });
    return 1;
  }
  try {
    const result = await execute(request.command, request.path);
    if (result.code !== 0 || result.signal || result.overflow) {
      const notInitialized = request.command === 'sync' && /not initialized/u.test(result.stderr);
      writeJson(stderr, {
        schema: 'lattice.cli_error.v2',
        code: result.overflow ? 'LATTICE_SENSOR_OUTPUT_LIMIT'
          : notInitialized ? 'LATTICE_SENSOR_NOT_INITIALIZED' : 'LATTICE_SENSOR_COMMAND_FAILED',
        message: `LatticeSensor ${request.command} failed`,
        detail: {
          exit_code: result.code,
          signal: result.signal,
          stderr: result.stderr,
          next_action: notInitialized ? `lattice sensor init ${request.path} --json` : null,
        },
      });
      return 1;
    }
    writeJson(stdout, {
      schema: 'lattice.sensor_command_result.v1',
      provider: 'lattice',
      sensor_owner: 'lattice',
      sensor_version: sensorPackage.version,
      command: request.command,
      status: 'ok',
    });
    return 0;
  } catch (error) {
    writeJson(stderr, {
      schema: 'lattice.cli_error.v2',
      code: error?.code === 'LATTICE_SENSOR_UNAVAILABLE' ? error.code : 'LATTICE_SENSOR_COMMAND_FAILED',
      message: `LatticeSensor ${request.command} failed`,
      detail: { cause: error?.message ?? 'unknown error' },
    });
    return 1;
  }
}
