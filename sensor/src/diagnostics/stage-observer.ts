/** Temporary opt-in SEC002 observer. No spawn, argv dump or Promise reactions. */
import * as fs from 'fs';
import * as path from 'path';
import { isMainThread, threadId } from 'worker_threads';

export const TRACE_CASES = ['unknown', 'cli-counts', 'cli-idempotent', 'cli-quiet', 'cli-live-daemon',
  'cli-recovery', 'cli-recreate', 'currency-read-error', 'currency-other'] as const;
export type TraceCase = typeof TRACE_CASES[number];
export const TRACE_STAGES = ['runtime', 'kernel', 'cli_spawn', 'grammar_bytes', 'pool_start', 'pool_ready',
  'pool_shutdown', 'first_parse', 'store_open', 'store_drain', 'currency_before_each', 'currency_body',
  'currency_after_each', 'currency_commit', 'currency_sync_fault', 'currency_sync_recovery',
  'currency_read_fault', 'currency_get_changed', 'currency_db_close', 'currency_fixture_rm', 'git'] as const;
export type TraceStage = typeof TRACE_STAGES[number];
export const GIT_KINDS = ['init', 'config', 'add', 'commit', 'rev_parse', 'status', 'diff', 'ls_files', 'restore', 'other'] as const;
export type GitKind = typeof GIT_KINDS[number];
interface Detail { poolSize?: number; kernel?: 'native' | 'wasm'; git?: GitKind; status?: number; op?: number }
let caseId: TraceCase = TRACE_CASES.find(value => value === process.env.LATTICE_SENSOR_TRACE_CASE) ?? 'unknown';
const initialOrder = Number(process.env.LATTICE_SENSOR_TRACE_CALL);
let callOrder = Number.isSafeInteger(initialOrder) && initialOrder >= 0 ? initialOrder : 0;
let sequence = 0;
let writeFailures = 0;
export function setStageContext(value: TraceCase, order = 0): void {
  caseId = TRACE_CASES.includes(value) ? value : 'unknown';
  callOrder = Number.isSafeInteger(order) && order >= 0 ? order : 0;
}
export function stageWriteFailures(): number { return writeFailures; }
export function gitKind(args: readonly unknown[]): GitKind {
  const value = args[0] === '-C' ? args[2] : args[0];
  const normalized = value === 'rev-parse' ? 'rev_parse' : value === 'ls-files' ? 'ls_files' : value;
  return GIT_KINDS.find(kind => kind === normalized) ?? 'other';
}
export function recordStage(stage: TraceStage, edge: 'enter' | 'leave' | 'point', detail: Detail = {}): void {
  const directory = process.env.LATTICE_SENSOR_STAGE_TRACE_DIR;
  if (!directory || caseId === 'unknown' || caseId === 'currency-other') return;
  try {
    if (!path.isAbsolute(directory) || !TRACE_STAGES.includes(stage)) { writeFailures++; return; }
    const event: Record<string, unknown> = { stage, edge, caseId, callOrder, sequence: ++sequence,
      utc: new Date().toISOString(), monotonicMs: performance.now(), pid: process.pid, parentPid: process.ppid,
      threadId, isMainThread, priorWriteFailures: writeFailures };
    if (stage === 'runtime') {
      event.node = process.versions.node; event.arch = process.arch; event.platform = process.platform;
      event.knownFlags = ['--liftoff-only', '--disable-warning=ExperimentalWarning'].filter(flag => process.execArgv.includes(flag));
      event.wasmRelaunched = !!process.env.LATTICE_SENSOR_WASM_RELAUNCHED;
      event.noRelaunch = !!process.env.LATTICE_SENSOR_NO_RELAUNCH;
      const requested = Number(process.env.LATTICE_SENSOR_PARSE_WORKERS);
      event.poolRequest = process.env.LATTICE_SENSOR_PARSE_WORKERS !== undefined
        && process.env.LATTICE_SENSOR_PARSE_WORKERS !== '' && Number.isFinite(requested) && requested >= 0
        ? Math.max(1, Math.min(Math.floor(requested), 16)) : 'default';
    }
    for (const key of ['poolSize', 'status', 'op'] as const) {
      if (Number.isSafeInteger(detail[key])) event[key] = detail[key];
    }
    if (detail.kernel === 'native' || detail.kernel === 'wasm') event.kernel = detail.kernel;
    if (detail.git && GIT_KINDS.includes(detail.git)) event.git = detail.git;
    fs.appendFileSync(path.join(directory, `${process.pid}-${threadId}.jsonl`), JSON.stringify(event) + '\n');
  } catch { writeFailures++; } // Diagnostic I/O must never replace the product result/exception.
}
/** Synchronous call boundary only: a Promise return is returned untouched, never observed with .then. */
export function observeSync<T>(stage: TraceStage, fn: () => T, detail: Detail = {}): T {
  recordStage(stage, 'enter', detail);
  try { return fn(); } finally { recordStage(stage, 'leave', detail); }
}
