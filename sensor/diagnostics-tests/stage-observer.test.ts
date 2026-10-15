import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { Mutex } from '../src/utils';
import * as os from 'os';
import * as path from 'path';
import { childFailureDetail, gitKind, observeSync, recordStage, setStageContext, stageWriteFailures } from '../src/diagnostics/stage-observer';
let directory: string;
let priorDirectory: string | undefined;
let priorArgv: string[];
let priorPool: string | undefined;
beforeEach(() => {
  priorDirectory = process.env.LATTICE_SENSOR_STAGE_TRACE_DIR;
  priorArgv = [...process.execArgv];
  priorPool = process.env.LATTICE_SENSOR_PARSE_WORKERS;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-stage-observer-'));
  process.env.LATTICE_SENSOR_STAGE_TRACE_DIR = directory;
  setStageContext('currency-read-error');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (priorDirectory === undefined) delete process.env.LATTICE_SENSOR_STAGE_TRACE_DIR;
  else process.env.LATTICE_SENSOR_STAGE_TRACE_DIR = priorDirectory;
  process.execArgv.splice(0, process.execArgv.length, ...priorArgv);
  if (priorPool === undefined) delete process.env.LATTICE_SENSOR_PARSE_WORKERS;
  else process.env.LATTICE_SENSOR_PARSE_WORKERS = priorPool;
  fs.rmSync(directory, { recursive: true, force: true });
});
const rows = () => fs.readdirSync(directory).flatMap(name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
it('preserves return identity, this-independent invocation count, and thrown object identity', () => {
  const value = { result: 7 }; const error = new Error('private-sentinel');
  const operation = vi.fn(() => value);
  expect(observeSync('currency_get_changed', operation)).toBe(value);
  expect(operation).toHaveBeenCalledOnce();
  const fail = vi.fn(() => { throw error; });
  let caught: unknown;
  try { observeSync('currency_get_changed', fail); } catch (exception) { caught = exception; }
  expect(caught).toBe(error); expect(fail).toHaveBeenCalledOnce();
  expect(rows().map(row => row.edge)).toEqual(['enter', 'leave', 'enter', 'leave']);
  expect(JSON.stringify(rows())).not.toContain('private-sentinel');
});
it('returns the exact Promise without adding .then reactions or extra child launches', () => {
  const cp = require('child_process') as typeof import('child_process');
  const launches = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
  const spies = launches.map(name => vi.spyOn(cp, name));
  const pending = new Promise<void>(() => {});
  const then = vi.spyOn(pending, 'then');
  expect(observeSync('currency_sync_fault', () => pending)).toBe(pending);
  expect(then).not.toHaveBeenCalled();
  recordStage('runtime', 'point');
  expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
});
it('retains original return/exception when diagnostic output cannot be written', () => {
  const file = path.join(directory, 'not-a-directory'); fs.writeFileSync(file, 'x');
  process.env.LATTICE_SENSOR_STAGE_TRACE_DIR = file;
  const before = stageWriteFailures(); const error = { private: 'do-not-log' };
  expect(observeSync('currency_commit', () => 42)).toBe(42);
  let caught: unknown;
  try { observeSync('currency_commit', () => { throw error; }); } catch (exception) { caught = exception; }
  expect(caught).toBe(error);
  expect(stageWriteFailures() - before).toBe(4);
});
it('does not dump arbitrary argv, detail, error messages or env values', () => {
  process.execArgv.push('--arbitrary=private-sentinel');
  process.env.LATTICE_SENSOR_PARSE_WORKERS = 'private-sentinel';
  try {
    recordStage('runtime', 'point', { unexpected: 'private-sentinel' } as never);
    const [row] = rows();
    expect(row.poolRequest).toBe('default');
    expect(row.knownFlags.every((flag: string) => ['--liftoff-only', '--disable-warning=ExperimentalWarning'].includes(flag))).toBe(true);
    expect(JSON.stringify(row)).not.toContain('private-sentinel');
  } finally { delete process.env.LATTICE_SENSOR_PARSE_WORKERS; }
});
it('uses only fixed git kinds and records nothing when disabled', () => {
  expect(gitKind(['-C', 'secret-path', 'rev-parse', 'secret-arg'])).toBe('rev_parse');
  expect(gitKind(['secret-command'])).toBe('other');
  delete process.env.LATTICE_SENSOR_STAGE_TRACE_DIR;
  expect(observeSync('currency_commit', () => 42)).toBe(42);
  expect(fs.readdirSync(directory)).toEqual([]);
});

it('sanitizes child failure fields without replacing null or getter-thrown exceptions', () => {
  expect(childFailureDetail(null)).toEqual({ status: undefined, signaled: false, spawnErrorCode: undefined });
  expect(childFailureDetail({ status: 3221225477, signal: null })).toMatchObject({ status: 3221225477, signaled: false });
  expect(childFailureDetail({ signal: 'PRIVATE', code: 'PRIVATE' })).toMatchObject({ signaled: true, spawnErrorCode: 'other' });
  const error = Object.defineProperty({}, 'status', { get() { throw new Error('private'); } });
  expect(childFailureDetail(error)).toEqual({ spawnErrorCode: 'other' });
});
it('records only real mutex contention and preserves release ordering', async () => {
  const mutex = new Mutex(); const release = await mutex.acquire();
  expect(rows()).toEqual([]);
  const waiting = mutex.acquire();
  expect(rows().map(row => [row.stage, row.edge])).toEqual([['mutex_wait', 'enter']]);
  release(); const nextRelease = await waiting; nextRelease();
  expect(rows().map(row => [row.stage, row.edge])).toEqual([['mutex_wait', 'enter'], ['mutex_wait', 'leave']]);
});
