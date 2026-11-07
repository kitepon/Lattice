import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The full gate runs every step even after one fails, so a red suite never hides later suites' evidence.
export const ciSteps = Object.freeze([
  'check:docs', 'test', 'test:sensor', 'check', 'check:cli-surface',
  'check:open-questions', 'check:reachability', 'verify:todo-store',
]);

export function runAll(steps, runStep) {
  const failed = [];
  for (const step of steps) {
    if (runStep(step) !== 0) failed.push(step);
  }
  return failed;
}

function npmRun(step) {
  // npm_execpath is npm's own CLI when started through `npm run ci`; it avoids the Windows npm.cmd shell.
  const cli = process.env.npm_execpath;
  const result = cli
    ? spawnSync(process.execPath, [cli, 'run', step], { stdio: 'inherit' })
    : spawnSync('npm', ['run', step], { stdio: 'inherit', shell: true });
  return result.status ?? 1;
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failed = runAll(ciSteps, npmRun);
  for (const step of ciSteps) console.log(`${failed.includes(step) ? 'FAIL' : 'pass'} ${step}`);
  if (failed.length > 0) {
    console.error(`npm run ci: ${failed.length} of ${ciSteps.length} steps failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}
