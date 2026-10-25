#!/usr/bin/env node
import path from 'node:path';
import { superviseDashboard } from '../src/dashboard-supervisor.mjs';

try {
  const root = process.env.LATTICE_DASHBOARD_RUNTIME_DIR;
  if (process.argv.length !== 3 || process.argv[2] !== root || !path.isAbsolute(root)) {
    throw Object.assign(new Error('invalid supervisor runtime'), { code: 'DASHBOARD_SUPERVISOR_ARGUMENT_INVALID' });
  }
  await superviseDashboard({ args: [path.resolve(import.meta.dirname, 'lattice-dashboard.mjs'), '--supervised-runtime', root],
    env: process.env, root: process.env.LATTICE_DASHBOARD_RUNTIME_DIR,
    runId: process.env.LATTICE_DASHBOARD_LIFECYCLE_RUN });
} catch (error) {
  const code = /^[A-Z_]+$/u.test(error.code ?? '') ? error.code : 'DASHBOARD_SUPERVISOR_FAILED';
  if (process.connected) process.send({ type: 'supervisor_error', code }, () => process.disconnect());
  process.stderr.write(`${JSON.stringify({ code })}\n`);
  process.exitCode = 1;
}
