import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sensorPackage from '../sensor/package.json' with { type: 'json' };
import { compareSensorIndexes, parseSensorDiffArgs, SensorDiffError } from './sensor-diff.mjs';
import { parseAnchor, resolveAnchors, SensorResolveError } from './sensor-resolve.mjs';
import { spawnSensorCli } from './sensor-runtime.mjs';
import { touchedFunctions } from './sensor-touched.mjs';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

const USAGE = 'usage: lattice sensor <init|sync> [path] [--json]'
  + ' | lattice sensor diff <rootA> <rootB>'
  + ' [--subtree-a <rel>] [--subtree-b <rel>] [--map-a <from>=<to>] [--map-b <from>=<to>]'
  + ' [--limit <n>] [--json]'
  + ' | lattice sensor resolve <path#symbol>... [--path <root>] [--related] [--json]'
  + ' | lattice sensor touched <from> [<to>] [--path <root>] [--json]';

function usage(stderr) {
  writeJson(stderr, { schema: 'lattice.cli_error.v2', code: 'USAGE', message: USAGE });
  return 2;
}

function parse(argv) {
  if (argv.at(-1) !== '--json') return null;
  const words = argv.slice(0, -1);
  if (words[0] === 'resolve') {
    const anchors = [];
    let root = '.';
    let related = false;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === '--related') related = true;
      else if (words[i] === '--path') { root = words[++i]; if (root === undefined) return null; }
      else if (words[i].startsWith('-')) return null;
      else anchors.push(words[i]);
    }
    return anchors.length === 0 ? null : { command: 'resolve', resolve: { anchors, root, related } };
  }
  if (words[0] === 'touched') {
    const refs = [];
    let root = '.';
    for (let i = 1; i < words.length; i++) {
      if (words[i] === '--path') { root = words[++i]; if (root === undefined) return null; }
      else if (words[i].startsWith('-')) return null;
      else refs.push(words[i]);
    }
    return refs.length < 1 || refs.length > 2 ? null : { command: 'touched', touched: { from: refs[0], to: refs[1] ?? 'HEAD', root } };
  }
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

/**
 * a3 (ADR 0204 Resolve): `path#symbol` → line spans. An anchor that does not resolve is an answer (`unresolved`, with the
 * nearest names), exit 0; malformed text is listed, never guessed. No index → the same typed error as `sensor sync`.
 */
async function runResolve({ anchors, root, related }, stdout, stderr) {
  try {
    const parsed = anchors.map((text) => ({ text, anchor: parseAnchor(text) }));
    const result = await resolveAnchors({ root: path.resolve(root), anchors: parsed.flatMap((p) => p.anchor ?? []), related });
    writeJson(stdout, {
      schema: 'lattice.sensor_resolve_result.v1',
      sensor_version: sensorPackage.version,
      ...result,
      malformed: parsed.filter((p) => p.anchor === null).map((p) => p.text),
    });
    return 0;
  } catch (error) {
    const typed = error instanceof SensorResolveError;
    writeJson(stderr, {
      schema: 'lattice.cli_error.v2',
      code: error?.code === 'RESOLVE_INDEX_MISSING' ? 'LATTICE_SENSOR_NOT_INITIALIZED'
        : error?.code === 'LATTICE_SENSOR_UNAVAILABLE' ? error.code : 'LATTICE_SENSOR_COMMAND_FAILED',
      message: 'LatticeSensor resolve failed',
      detail: typed ? { ...error.detail, next_action: error.code === 'RESOLVE_INDEX_MISSING' ? `lattice sensor init ${root} --json` : null }
        : { cause: error?.message ?? 'unknown error' },
    });
    return 1;
  }
}

/** a6 (ADR 0204 Touched): commit range -> changed symbols. A bad ref or git failure is typed; unattributed hunks are an answer. */
async function runTouched({ from, to, root }, stdout, stderr) {
  try {
    writeJson(stdout, {
      schema: 'lattice.sensor_touched_result.v1',
      sensor_version: sensorPackage.version,
      ...await touchedFunctions({ repoRoot: path.resolve(root), from, to }),
    });
    return 0;
  } catch (error) {
    const notInitialized = error?.code === 'RESOLVE_INDEX_MISSING';
    writeJson(stderr, {
      schema: 'lattice.cli_error.v2',
      code: notInitialized ? 'LATTICE_SENSOR_NOT_INITIALIZED'
        : error?.code === 'LATTICE_SENSOR_UNAVAILABLE' ? error.code
          : error?.code === 'TOUCHED_GIT_FAILED' ? 'LATTICE_SENSOR_TOUCHED_GIT_FAILED' : 'LATTICE_SENSOR_COMMAND_FAILED',
      message: 'LatticeSensor touched failed',
      detail: { ...(error?.detail ?? { cause: error?.message ?? 'unknown error' }),
        next_action: notInitialized ? `lattice sensor init ${root} --json` : null },
    });
    return 1;
  }
}

/**
 * g2: the index (`.lattice/sensor/`, ~143 MB) must not be committed by `git add -A` in a product clone; not a git work tree = nothing to do.
 * Only the index: `.lattice/todo` may be tracked or added in the same repo (ignoring all of `.lattice/` broke `git add .lattice/todo`).
 */
async function excludeSensorIndex(projectPath) {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: projectPath });
    const exclude = path.resolve(projectPath, stdout.trim());
    const text = await readFile(exclude, 'utf8').catch(() => '');
    if (text.split(/\r?\n/u).includes('.lattice/sensor/')) return;
    await mkdir(path.dirname(exclude), { recursive: true });
    await appendFile(exclude, `${text === '' || text.endsWith('\n') ? '' : '\n'}.lattice/sensor/\n`);
  } catch (error) {
    // Not a git work tree (git exits 128) or no git on PATH: there is nothing `git add -A` could commit from here.
    if (error?.code === 128 || error?.code === 'ENOENT') return;
    process.emitWarning(`.lattice/sensor/ not added to .git/info/exclude: ${error?.message ?? error}`, { code: 'LATTICE_SENSOR_EXCLUDE_FAILED' });
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
  if (request.command === 'resolve') return runResolve(request.resolve, stdout, stderr);
  if (request.command === 'touched') return runTouched(request.touched, stdout, stderr);
  if (!existsSync(request.path)) {
    writeJson(stderr, { schema: 'lattice.cli_error.v2', code: 'LATTICE_SENSOR_PATH_MISSING',
      message: `no such project path: ${request.path}`,
      detail: { path: request.path, next_action: `lattice sensor ${request.command}` } });
    return 1;
  }
  try {
    await excludeSensorIndex(request.path);
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
