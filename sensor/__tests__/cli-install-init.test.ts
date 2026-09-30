/**
 * `lattice sensor install --init` and `lattice sensor init --yes` (#1578): the one-shot,
 * non-interactive "wire agents + build this project's index" bootstrap a fresh
 * container / CI job needs.
 *
 * Exercised end-to-end against the built binary so the CLI wiring (the shared
 * `runInit` flow, the flag plumbing, exit codes) is what's covered. Every run
 * uses `--target none`, so the installer touches no agent config on the
 * machine running the suite; the only side effect is the temp project's
 * `.lattice/sensor/`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../dist/bin/lattice-sensor.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with stdin closed — a prompt that blocks would hang / fail here. */
function runLatticeSensor(args: string[], cwd: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        LATTICE_SENSOR_NO_DAEMON: '1',
        LATTICE_SENSOR_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

describe('lattice sensor install --init / init --yes (#1578)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-sensor-install-init-'));
    fs.writeFileSync(
      path.join(tempDir, 'a.ts'),
      `export function greet(name: string) { return hello(name); }\n` +
        `export function hello(n: string) { return 'hi ' + n; }\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('install --yes --target none --init builds the current project\'s index in one command', () => {
    const r = runLatticeSensor(['install', '--yes', '--target', 'none', '--init'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // The installer ran (and had nothing to wire) …
    expect(r.stdout).toContain('No agent targets selected');
    // … and the init ran afterwards, in cwd.
    expect(r.stdout).toContain(`Initialized in ${fs.realpathSync(tempDir)}`);
    expect(fs.existsSync(path.join(tempDir, '.lattice/sensor', 'sensor.db'))).toBe(true);
  });

  it('install --init on an already-initialized project reports that and still exits 0', () => {
    expect(runLatticeSensor(['init', '--yes'], tempDir).status).toBe(0);
    const r = runLatticeSensor(['install', '--yes', '--target', 'none', '--init'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Already initialized');
  });

  it('install --init refuses an unsafe root (filesystem root) with exit code 1, like init does', () => {
    // `/` (or the drive root on Windows) is the canonical unsafe root: the
    // refusal fires before anything is created, so nothing is written there.
    const root = path.parse(process.cwd()).root;
    const r = runLatticeSensor(['install', '--yes', '--target', 'none', '--init'], root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Refusing to initialize');
    expect(fs.existsSync(path.join(root, '.lattice/sensor'))).toBe(false);
  });

  it('init --yes runs non-interactively with stdin closed and builds the index', () => {
    const r = runLatticeSensor(['init', '--yes'], tempDir);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Initialized in');
    expect(fs.existsSync(path.join(tempDir, '.lattice/sensor', 'sensor.db'))).toBe(true);
  });

  it('documents the new flags in --help', () => {
    expect(runLatticeSensor(['init', '--help'], tempDir).stdout).toMatch(/-y, --yes\b/);
    expect(runLatticeSensor(['install', '--help'], tempDir).stdout).toMatch(/-i, --init\b/);
  });
});
