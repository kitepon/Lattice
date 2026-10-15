import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const SOURCE = '478947af3470982bfc8c810e99b2f8d35a5c81f9';
const BASE = '3300d770b31e06a1b701e547c10d4899429e4024';
const allowlist = JSON.parse(fs.readFileSync(new URL('./sec002-stage-paths.json', import.meta.url), 'utf8'));
export function assertSource(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== SOURCE) throw Error('source mismatch');
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw Error('tracked source dirty');
  const actual = git(['diff', '--name-only', BASE, 'HEAD']).split('\n').filter(Boolean).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...allowlist].sort())) throw Error('source path allowlist mismatch');
}
export function assertRuntime() {
  if (process.version !== 'v24.20.0' || process.arch !== 'x64' || process.platform !== 'win32') throw Error('runtime mismatch');
  if (process.env.LATTICE_SENSOR_PARSE_WORKERS !== undefined || (process.env.NODE_OPTIONS ?? '').includes('sec002-preload')) throw Error('ambient diagnostic pool/preload override');
}
function save(output, summary) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}
export function summarizeRootTimeline(output) {
  const file = path.join(output, 'root-report-timeline.jsonl');
  const result = { present: fs.existsSync(file), eventCount: 0, parseErrors: 0, unreadable: false,
    writeFailed: false, dropped: null, observerErrors: null, partial: true, missingEdges: [],
    mockBodyCount: 0, mockResponseCount: 0, sameAcceptedSocket: null, orderComplete: false, lastStage: null, reports: [], complete: false };
  try { result.writeFailed = fs.readFileSync(path.join(output, 'test.log'), 'utf8').includes('[sec002-root-timeline-write-failed]'); }
  catch { result.unreadable = true; }
  if (!result.present) return result;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { result.unreadable = true; return result; }
  const paired = ['case', 'intake_fixture', 'workspace_fixture', 'record_errors', 'first_report',
    'nothing_pending', 'resolve_store', 'resolution_report', 'cleanup_close', 'cleanup_rm'];
  const mocks = ['mock_body', 'mock_response_queued'];
  const reasons = ['network_error', 'response_error', 'response_too_large', 'timeout',
    'receipt_not_verified', 'ack_not_recorded', 'unavailable', 'unrecognized_response'];
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const exactKeys = (row, keys) => Object.keys(row).every(key => keys.includes(key));
  const events = []; let footer = null;
  const lines = text.split('\n').filter(Boolean);
  if (!text.endsWith('\n') || lines.length > 65) result.parseErrors++;
  for (const [index, line] of lines.entries()) {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.caseId !== 'root-resolution-report') throw Error('schema');
      if (row.schema === 'sec002.root_timeline_summary.v1') {
        if (footer || index !== lines.length - 1 || !exactKeys(row, ['schema', 'caseId', 'eventCount', 'dropped', 'observerErrors', 'partial']) ||
          !integer(row.eventCount) || row.eventCount > 64 || !integer(row.dropped) || !integer(row.observerErrors) || typeof row.partial !== 'boolean') throw Error('footer');
        footer = row; continue;
      }
      if (row.schema !== 'sec002.root_timeline.v1' || !integer(row.sequence) || row.sequence !== events.length + 1 ||
        !integer(row.pid) || row.pid === 0 || !Number.isFinite(row.monotonicMs) || row.monotonicMs < 0 ||
        typeof row.utc !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.utc) || !Number.isFinite(Date.parse(row.utc))) throw Error('event');
      const baseKeys = ['schema', 'caseId', 'sequence', 'pid', 'stage', 'edge', 'utc', 'monotonicMs'];
      if (mocks.includes(row.stage)) {
        if (row.edge !== 'point' || !integer(row.receivedCount) || !integer(row.socketId) || row.socketId === 0 ||
          !exactKeys(row, [...baseKeys, 'receivedCount', 'socketId'])) throw Error('mock');
      } else if (paired.includes(row.stage) && ['enter', 'leave'].includes(row.edge)) {
        const isReport = ['first_report', 'resolution_report'].includes(row.stage) && row.edge === 'leave';
        if (isReport) {
          if (!['delivered', 'unconfirmed', 'nothing_pending', 'other'].includes(row.outcome) ||
            !(row.reason === null || reasons.includes(row.reason) || row.reason === 'other') ||
            !(row.httpStatus === null || Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599) ||
            !(row.acknowledgedThrough === null || integer(row.acknowledgedThrough)) || !integer(row.receivedCount) ||
            !exactKeys(row, [...baseKeys, 'outcome', 'reason', 'httpStatus', 'acknowledgedThrough', 'receivedCount'])) throw Error('report');
        } else if (!exactKeys(row, baseKeys)) throw Error('fields');
      } else throw Error('stage');
      const prior = events.at(-1);
      if (prior && (row.pid !== prior.pid || row.monotonicMs < prior.monotonicMs)) throw Error('stream');
      events.push(row);
    } catch { result.parseErrors++; }
  }
  result.eventCount = events.length;
  if (footer) {
    result.dropped = footer.dropped; result.observerErrors = footer.observerErrors; result.partial = footer.partial;
    if (footer.eventCount !== events.length) result.parseErrors++;
  } else result.parseErrors++;
  result.missingEdges = paired.flatMap(stage => ['enter', 'leave'].filter(edge =>
    events.filter(row => row.stage === stage && row.edge === edge).length !== 1).map(edge => stage + ':' + edge));
  const bodies = events.filter(row => row.stage === 'mock_body');
  const responses = events.filter(row => row.stage === 'mock_response_queued');
  result.mockBodyCount = bodies.length; result.mockResponseCount = responses.length;
  if (bodies.length === 2) result.sameAcceptedSocket = bodies[0].socketId === bodies[1].socketId;
  const last = events.at(-1);
  if (last) result.lastStage = { stage: last.stage, edge: last.edge, utc: last.utc, sequence: last.sequence };
  result.reports = events.filter(row => ['first_report', 'resolution_report'].includes(row.stage) && row.edge === 'leave')
    .map(row => ({ stage: row.stage, outcome: row.outcome, reason: row.reason, httpStatus: row.httpStatus,
      receivedCount: row.receivedCount, acknowledgedThrough: row.acknowledgedThrough }));
  const expectedMocks = [bodies, responses].every(rows => rows.length === 2 && rows[0].receivedCount === 1 && rows[1].receivedCount === 2);
  const expectedOrder = ['case:enter', 'intake_fixture:enter', 'intake_fixture:leave', 'workspace_fixture:enter', 'workspace_fixture:leave',
    'record_errors:enter', 'record_errors:leave', 'first_report:enter', 'mock_body:point', 'mock_response_queued:point', 'first_report:leave',
    'nothing_pending:enter', 'nothing_pending:leave', 'resolve_store:enter', 'resolve_store:leave', 'resolution_report:enter',
    'mock_body:point', 'mock_response_queued:point', 'resolution_report:leave', 'cleanup_close:enter', 'cleanup_close:leave',
    'cleanup_rm:enter', 'cleanup_rm:leave', 'case:leave'];
  result.orderComplete = JSON.stringify(events.map(row => row.stage + ':' + row.edge)) === JSON.stringify(expectedOrder);
  result.complete = !result.unreadable && !result.writeFailed && result.parseErrors === 0 && result.missingEdges.length === 0 &&
    result.dropped === 0 && result.observerErrors === 0 && !result.partial && expectedMocks && result.orderComplete;
  return result;
}
export function summarize(output) {
  const raw = path.join(output, 'raw-events');
  const events = []; let parseErrors = 0; let unreadableFiles = 0;
  if (fs.existsSync(raw)) for (const name of fs.readdirSync(raw).filter(name => name.endsWith('.jsonl'))) {
    let text;
    try { text = fs.readFileSync(path.join(raw, name), 'utf8'); } catch { unreadableFiles++; continue; }
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.caseId !== 'string' || typeof event.stage !== 'string' ||
          !['enter', 'leave', 'point'].includes(event.edge) || !Number.isSafeInteger(event.sequence) ||
          !Number.isSafeInteger(event.pid) || !Number.isSafeInteger(event.threadId)) throw Error('invalid row');
        events.push(event);
      } catch { parseErrors++; }
    }
  }
  const av = events.filter(event => typeof event.caseId === 'string' && event.caseId.startsWith('cli-'));
  const source = events.filter(event => event.caseId === 'currency-read-error');
  for (const [name, rows] of [['av-events', av], ['source-events', source]]) {
    fs.writeFileSync(path.join(output, name + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  }
  const streams = {};
  for (const event of events) {
    const key = [event.caseId, event.callOrder, event.pid, event.threadId].join(':');
    const stream = streams[key] ??= { caseId: event.caseId, callOrder: event.callOrder, pid: event.pid,
      parentPid: event.parentPid, threadId: event.threadId, counts: {}, lastSequence: -1, lastStage: null };
    const stage = event.stage + ':' + event.edge;
    stream.counts[stage] = (stream.counts[stage] ?? 0) + 1;
    if (event.sequence > stream.lastSequence) {
      stream.lastSequence = event.sequence; stream.lastStage = { stage: event.stage, edge: event.edge, utc: event.utc };
    }
  }
  const expectedCases = ['cli-counts', 'cli-idempotent', 'cli-quiet', 'cli-live-daemon', 'cli-recovery', 'cli-recreate', 'currency-read-error'];
  const missingCases = expectedCases.filter(caseId => !events.some(event => event.caseId === caseId));
  const requiredSource = ['currency_before_each', 'currency_body', 'currency_after_each', 'currency_db_close', 'currency_fixture_rm'];
  const missingSourceEdges = requiredSource.flatMap(stage => ['enter', 'leave'].filter(edge =>
    !source.some(event => event.stage === stage && event.edge === edge)).map(edge => stage + ':' + edge));
  return { rootTimeline: summarizeRootTimeline(output), eventCount: events.length, parseErrors, unreadableFiles,
    writeFailureRows: events.filter(event => event.priorWriteFailures > 0).length,
    missingCases, missingSourceEdges, streams: Object.values(streams),
    avStatuses: av.filter(event => event.stage === 'cli_spawn' && event.edge === 'leave').map(event =>
      ({ caseId: event.caseId, callOrder: event.callOrder, status: event.status ?? null,
        signaled: event.signaled ?? false, spawnErrorCode: event.spawnErrorCode ?? null })),
    avRecurrence: av.some(event => event.stage === 'cli_spawn' && event.status === 3221225477),
    limitation: 'Missing leaves alone do not classify AV; no AV recurrence yields only normal-stage baseline.' };
}
async function main() {
  const [mode, rootArg, outputArg] = process.argv.slice(2);
  if (!['check-source', 'initialize', 'run', 'finalize'].includes(mode) || !rootArg) throw Error('fixed mode and root required');
  const root = path.resolve(rootArg);
  if (mode === 'check-source') { assertSource(root); console.log('sourcePinned=true trackedClean=true paths=20'); return; }
  if (!outputArg) throw Error('output directory required');
  const output = path.resolve(outputArg);
  let summary = { source: SOURCE, diagnosticOnly: true, acceptanceFull: false, progress: 'not-started' };
  try { summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')); } catch { /* absent remains explicit */ }
  if (mode === 'initialize') {
    assertSource(root); assertRuntime();
    summary.progress = 'entry-validated'; summary.sourceValidAtEntry = true; save(output, summary); return;
  }
  save(output, summary);
  if (mode === 'finalize') {
    let sourceValid = true;
    try { assertSource(root); } catch { sourceValid = false; }
    summary.sourceValidAtEnd = sourceValid; summary.observations = summarize(output);
    summary.observationComplete = sourceValid && summary.progress === 'finished' &&
      summary.observations.eventCount > 0 && summary.observations.parseErrors === 0 &&
      summary.observations.unreadableFiles === 0 && summary.observations.writeFailureRows === 0 &&
      summary.observations.rootTimeline.complete &&
      summary.observations.missingCases.length === 0 && summary.observations.missingSourceEdges.length === 0;
    save(output, summary);
    if (!summary.observationComplete || summary.status !== 0) process.exitCode = 1;
    return;
  }
  assertSource(root);
  assertRuntime();
  const raw = path.join(output, 'raw-events'); fs.mkdirSync(raw, { recursive: true });
  summary.runtime = { node: process.versions.node, arch: process.arch, platform: process.platform };
  summary.progress = 'running'; summary.lastCommandStage = 'sensor:build'; save(output, summary);
  const log = fs.createWriteStream(path.join(output, 'test.log'), { flags: 'wx' });
  await new Promise((resolve, reject) => {
    log.once('open', resolve); log.once('error', reject);
  });
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'npm --prefix sensor run build && npm run ci; exit $LASTEXITCODE'], { cwd: root, shell: false,
    env: { ...process.env, LATTICE_SENSOR_STAGE_TRACE_DIR: raw }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  function consume(chunk, channel) {
    log.write(chunk); channel.write(chunk);
    tail = (tail + chunk.toString()).slice(-4096);
    const stages = [...tail.matchAll(/^> (@[^\s]+) (check:docs|test:sensor|test|check|ci|build)(?:\s|$)/gm)];
    const last = stages.at(-1);
    const component = last?.[1].startsWith('@quolu/lattice-sensor@') ? 'sensor'
      : last?.[1].startsWith('@quolu/lattice@') ? 'root' : null;
    const stage = component && last ? component + ':' + last[2] : null;
    if (stage && stage !== summary.lastCommandStage) { summary.lastCommandStage = stage; save(output, summary); }
  }
  child.stdout.on('data', chunk => consume(chunk, process.stdout));
  child.stderr.on('data', chunk => consume(chunk, process.stderr));
  let spawnFailed = false;
  child.once('error', () => { spawnFailed = true; });
  await new Promise(resolve => child.once('close', (status, signal) => {
    summary.status = status; summary.signaled = !!signal; summary.spawnFailed = spawnFailed;
    summary.progress = 'finished'; log.end(resolve);
  }));
  try { assertSource(root); summary.sourceValidAtEnd = true; } catch { summary.sourceValidAtEnd = false; }
  save(output, summary);
  if (summary.status !== 0 || summary.signaled || summary.spawnFailed || !summary.sourceValidAtEnd) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('fixed-stage diagnostic driver failed; preserved summary/raw evidence may be incomplete'); process.exitCode = 1; });
}
