import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { lstatSync, mkdirSync, openSync, writeFileSync, closeSync, renameSync, readdirSync } from 'node:fs';
import { ensureSafeDir, ensureSafeFile } from './runtime-errors.mjs';
import { observeDashboardProcess } from './dashboard-process-control.mjs';
import { isAclScratchName } from './windows-owner-only.mjs';

const VERSION = /^[a-zA-Z0-9.+-]{1,128}$/u;
const PHASES = new Set(['initialize_received', 'initialize_response_written']);
export const MCP_RECEIPT_SLOTS = 64;
export const MCP_RECEIPT_BYTES = 4096;

/** No filesystem or process-identity work on the MCP response event loop. */
export function createMcpStartupReceipt(wrapperVersion) {
  let worker;
  const posted = new Set();
  const post = message => { try { worker?.postMessage(message); } catch { /* observation only */ } };
  const phase = name => {
    if (!worker || posted.has(name)) return;
    posted.add(name); post({ phase: name, at: new Date().toISOString() });
  };
  return {
    setMode(mode, sensorVersion) {
      if (!['direct', 'proxy'].includes(mode) || !VERSION.test(wrapperVersion) || !VERSION.test(sensorVersion)) return;
      if (!worker) {
        try {
          worker = new Worker(new URL(import.meta.url), { workerData: {
            receipt: true, home: homedir(), wrapperVersion, pid: process.pid,
            runId: randomUUID(), startedAt: new Date().toISOString(),
          }, stdout: true, stderr: true });
          worker.stdout.resume(); worker.stderr.resume();
          worker.on('error', () => {});
          worker.unref();
        } catch { return; }
      }
      if (!posted.has(mode)) { posted.add(mode); post({ mode, sensorVersion }); }
    },
    initializeReceived() { phase('initialize_received'); },
    initializeWritten() { phase('initialize_response_written'); },
  };
}

if (!isMainThread && workerData?.receipt === true) {
  // Parent messages carry fixed observations only, never JSON-RPC data.
  let queue = Promise.resolve();
  let slot = null;
  let disabled = false;
  let record = null;
  const root = path.join(workerData.home, '.lattice', 'mcp-startup');
  async function prepare() {
    const parent = path.dirname(root);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()
      || process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) throw Error('unsafe');
    ensureSafeDir(root);
    if (readdirSync(root).some(name => !/^slot-(?:[0-9]|[1-5][0-9]|6[0-3])$/u.test(name)
      && !(process.platform === 'win32' && isAclScratchName(name)))) throw Error('unexpected entry');
    for (let index = 0; index < MCP_RECEIPT_SLOTS; index++) {
      const candidate = path.join(root, `slot-${index}`);
      try { mkdirSync(candidate, { mode: 0o700 }); slot = candidate; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!slot) throw Error('capacity');
    ensureSafeDir(slot);
    const identity = await observeDashboardProcess(workerData.pid);
    record = { schema: 'lattice.mcp_startup.v1', run_id: workerData.runId,
      pid: workerData.pid, birth: identity?.birth ?? null,
      wrapper_version: workerData.wrapperVersion, sensor_version: null, mode: null,
      events: [{ phase: 'started', at: workerData.startedAt }] };
  }
  async function receive(message) {
    if (disabled) return;
    if (!record) await prepare();
    if (['direct', 'proxy'].includes(message.mode) && VERSION.test(message.sensorVersion)) {
      record.mode = message.mode; record.sensor_version = message.sensorVersion;
    } else if (PHASES.has(message.phase) && typeof message.at === 'string'
      && Number.isFinite(Date.parse(message.at)) && !record.events.some(e => e.phase === message.phase)) {
      if (message.phase === 'initialize_response_written'
        && !record.events.some(e => e.phase === 'initialize_received')) return;
      record.events.push({ phase: message.phase, at: message.at });
    } else return;
    if (!record.mode) return;
    const bytes = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(bytes) > MCP_RECEIPT_BYTES) throw Error('capacity');
    ensureSafeDir(root); ensureSafeDir(slot);
    const temporary = path.join(slot, 'pending.json'), target = path.join(slot, 'receipt.json');
    try { ensureSafeFile(target, slot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    ensureSafeFile(temporary, slot);
    renameSync(temporary, target);
  }
  parentPort.on('message', message => {
    queue = queue.then(() => receive(message)).catch(() => { disabled = true; parentPort.close(); });
  });
}
