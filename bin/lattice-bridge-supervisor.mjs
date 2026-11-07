#!/usr/bin/env node
/**
 * Windows/Linux bridge supervisor (bh6 prep). Startup-folder items only run once at
 * logon — nothing like launchd's KeepAlive exists to restart a crashed
 * process. This script is that supervision, written in JS instead of a batch
 * GOTO loop because a loop's own process (and therefore its killability) is
 * awkward to track reliably on Windows; a Node process's pid is not.
 *
 * Usage: node lattice-bridge-supervisor.mjs <descriptor.json>
 * The descriptor supplies the environment `lattice-bridge.mjs` needs (it is
 * never inherited from the Startup-folder launch context) and the path to
 * write this supervisor's own pid to, so `bridge-startup-folder.mjs` can find
 * and stop the whole tree later via `taskkill /T /F`. Linux records process
 * birth alongside the PID so its detached adapter can reject PID reuse.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { observeDashboardProcess } from '../src/dashboard-process-control.mjs';

const RESTART_DELAY_MS = 3_000;

const descriptorPath = process.argv[2];
if (typeof descriptorPath !== 'string' || descriptorPath.length === 0) {
  process.stderr.write('usage: lattice-bridge-supervisor.mjs <descriptor.json>\n');
  process.exit(2);
}
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
if (descriptor?.schema !== 'lattice.bridge_supervisor_descriptor.v1'
  || typeof descriptor.bridgePath !== 'string' || typeof descriptor.pidPath !== 'string'
  || typeof descriptor.env !== 'object' || descriptor.env === null) {
  process.stderr.write('bridge supervisor descriptor is invalid\n');
  process.exit(2);
}

const identity = process.platform === 'win32' ? String(process.pid)
  : JSON.stringify(await observeDashboardProcess(process.pid) ?? { pid: process.pid, birth: null });
await writeFile(descriptor.pidPath, identity, { encoding: 'utf8', flag: 'w', mode: 0o600 });

let stopping = false;
let child = null;
const stop = () => {
  stopping = true;
  child?.kill();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const bridgePath = path.resolve(descriptor.bridgePath);
while (!stopping) {
  child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, ...descriptor.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
  if (stopping) break;
  await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
}
