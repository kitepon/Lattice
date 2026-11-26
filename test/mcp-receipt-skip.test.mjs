import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { MCP_RECEIPT_SLOTS } from '../src/mcp-startup-receipt.mjs';

const MODULE = pathToFileURL(path.resolve('src/mcp-startup-receipt.mjs')).href;

// The child counts the workers it starts, makes the three observations at once (before the
// slot hint can return), waits for the receipt if a worker was started, then exits itself.
const CHILD = [
  "import { createRequire, syncBuiltinESMExports } from 'node:module';",
  "import { readFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const wt = createRequire(import.meta.url)('node:worker_threads');",
  "const Real = wt.Worker; let workers = 0;",
  "wt.Worker = class extends Real { constructor(...a) { workers++; super(...a); } };",
  "syncBuiltinESMExports();",
  "const { createMcpStartupReceipt } = await import(process.env.RECEIPT_MODULE);",
  "const receipt = createMcpStartupReceipt('0.79.4');",
  "receipt.setMode('proxy', '0.7.3-lattice.1'); receipt.initializeReceived(); receipt.initializeWritten();",
  "const sync = workers;",
  "const free = process.env.FREE_SLOT;",
  "const file = path.join(process.env.HOME, '.lattice', 'mcp-startup', 'slot-' + free, 'receipt.json');",
  "let record = null;",
  "for (let i = 0; i < 500 && !record; i++) {",
  "  await new Promise(r => setTimeout(r, 20));",
  "  if (free === '') { if (i >= 25) break; continue; }",
  "  try { const r = JSON.parse(readFileSync(file, 'utf8')); if (r.events.some(e => e.phase === 'initialize_response_written')) record = r; } catch {}",
  "}",
  "console.log(JSON.stringify({ workersBeforeHint: sync, workers, mode: record?.mode, phases: record?.events.map(e => e.phase) }));",
  "process.exit(0);",
].join('\n');

async function run(taken) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lattice-mcp-skip-'));
  const root = path.join(dir, '.lattice', 'mcp-startup');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let i = 0; i < taken; i++) await mkdir(path.join(root, 'slot-' + i), { mode: 0o700 });
  // A script file, not -e: a worker inherits the parent's execArgv and would re-run the -e source.
  const script = path.join(dir, 'child.mjs');
  await writeFile(script, CHILD);
  const child = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, RECEIPT_MODULE: MODULE,
      FREE_SLOT: taken < MCP_RECEIPT_SLOTS ? String(taken) : '' },
  });
  assert.equal(child.status, 0, child.stderr);
  return { root, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
}

test('64 slots taken: no receipt worker is started and the slots stay as they are', async () => {
  const { root, result } = await run(MCP_RECEIPT_SLOTS);
  assert.equal(result.workers, 0);
  assert.equal((await readdir(root)).length, MCP_RECEIPT_SLOTS);
});

test('a free slot: the worker starts after the hint and the receipt keeps the observations made while it was pending', async () => {
  const { result } = await run(MCP_RECEIPT_SLOTS - 1);
  assert.equal(result.workersBeforeHint, 0);
  assert.equal(result.workers, 1);
  assert.equal(result.mode, 'proxy');
  assert.deepEqual(result.phases, ['started', 'initialize_received', 'initialize_response_written']);
});
