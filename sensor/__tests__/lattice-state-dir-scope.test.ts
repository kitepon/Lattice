/**
 * Lattice owns `.lattice/` (ToDo store, run worktrees, adapter registry). The
 * FS walks and the watcher never descend into it, and git's listing must agree:
 * an untracked script a run writes there is not project source. Counting it made
 * `status` report the index stale mid-run, and a managed run's re-compile then
 * refused every finding as STALE_FINDING (found by the 2026-09-30 upstream sync).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LatticeSensor } from '../src';

let dir: string;
let cg: LatticeSensor | undefined;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=a@example.invalid', '-c', 'user.name=a', ...args], { cwd: dir, stdio: 'ignore' });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-state-scope-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.lattice/runs/\n');
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
});

afterEach(() => {
  cg?.close();
  cg = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('.lattice/ is outside the index scope', () => {
  it('an untracked script under .lattice/ is neither pending nor indexed', async () => {
    cg = await LatticeSensor.init(dir, { index: true });
    const script = path.join(dir, '.lattice', 'runtime', 'adapter-registry', 'controller.mjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'export const controller = 1;\n');

    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    await cg.sync();
    expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/alpha.ts']);
  });

  it('a tracked file under .lattice/ is not indexed either', async () => {
    const store = path.join(dir, '.lattice', 'todo', 'hook.mjs');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, 'export const hook = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'store');

    cg = await LatticeSensor.init(dir, { index: true });
    expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/alpha.ts']);
  });
});
