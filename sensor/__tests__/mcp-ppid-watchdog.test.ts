/**
 * PPID watchdog regression test (#277).
 *
 * On Linux, when an MCP host (Claude Code, opencode, …) is SIGKILL'd by the
 * OOM killer / a force-quit / a container teardown, the kernel does NOT
 * propagate the death to its `latticeSensor serve --mcp` child. The child gets
 * reparented to init/systemd, its stdin stays half-open in some
 * configurations, and the existing `stdin.on('end' | 'close')` handlers
 * never fire — the server lingers indefinitely, holding inotify watches,
 * file descriptors, and the SQLite WAL.
 *
 * `src/mcp/index.ts` polls `process.ppid` and shuts down the moment it
 * diverges from the value observed at startup. This test stands up a
 * process tree (vitest → wrapper → {stdin-holder, CLI → MCP runtime}) and
 * SIGKILL's the wrapper. The stdin-holder is a long-lived sibling whose
 * `stdout` pipe is dup'd into latticeSensor's `stdin`. After the wrapper dies
 * the pipe stays open (stdin-holder still owns the write-end), so the
 * existing stdin close handlers do **not** fire — the only thing that can
 * terminate latticeSensor then is the PPID watchdog.
 *
 * Windows is excluded — `process.kill(pid, 'SIGKILL')` does not actually
 * deliver SIGKILL there, and the per-OS reparenting semantics the watchdog
 * relies on are POSIX-specific.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/lattice-sensor.js');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (!isAlive(pid)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe.skipIf(process.platform === 'win32')('MCP PPID watchdog (#277)', () => {
  let wrapper: ChildProcessWithoutNullStreams | null = null;
  let childPid: number | null = null;
  let stdinHolderPid: number | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (wrapper && !wrapper.killed) {
      try { wrapper.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // A flagless CLI relaunches itself. Record both launcher and runtime PIDs
    // from the fixture preload so a failed startup cannot leave the runtime.
    let runtimePids: number[] = [];
    if (tmpDir) {
      try {
        runtimePids = fs.readFileSync(path.join(tmpDir, 'runtime-pids'), 'utf8').trim().split('\n').map(Number)
          .filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
      } catch { /* no runtime started */ }
    }
    for (const pid of runtimePids) {
      try {
        const argv = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (argv.includes(path.join(tmpDir!, 'boot.cjs'))) process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    // Belt and suspenders — don't leak processes if an assertion failed.
    for (const pid of [childPid, stdinHolderPid]) {
      if (pid !== null && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    await Promise.all([childPid, stdinHolderPid, ...runtimePids].filter((pid): pid is number => pid !== null)
      .map(async pid => { expect(await waitForExit(pid, 5000), `fixture process ${pid} survived cleanup`).toBe(true); }));
    wrapper = null;
    childPid = null;
    stdinHolderPid = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it.each([0, 1500])("shuts down when its parent is SIGKILL'd and stdin stays open (boot delay %ims)", async (bootDelayMs) => {
    // The wrapper:
    //   1. Spawns a "stdin-holder" — a tiny long-lived node process whose
    //      `stdout` pipe is dup'd into latticeSensor's `stdin`. As long as the
    //      stdin-holder is alive (it is — it's an orphan after the wrapper
    //      dies), latticeSensor's stdin never sees EOF.
    //   2. Spawns latticeSensor with that pipe as fd 0 and its stderr redirected
    //      to a tmp file that survives the wrapper, then reports both PIDs.
    //   3. Idles until SIGKILL'd from the test.
    //
    // LATTICE_SENSOR_PPID_POLL_MS=200 keeps the watchdog responsive in test; the
    // production default is 5000ms.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ppid-watchdog-'));
    const stderrLog = path.join(tmpDir, 'latticeSensor.stderr.log');
    const bootPreload = path.join(tmpDir, 'boot.cjs');
    fs.writeFileSync(bootPreload, `
      require('fs').appendFileSync(${JSON.stringify(path.join(tmpDir, 'runtime-pids'))}, process.pid + '\\n');
      if (!process.env.CG_PPID_BOOT_DELAYED) {
        process.env.CG_PPID_BOOT_DELAYED = '1';
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${bootDelayMs});
      }
    `);
    // Wait for a real initialize response. An elapsed delay does not prove
    // that the direct-mode watchdog was installed, especially on a loaded host.
    const wrapperSrc = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const stderrFd = fs.openSync(${JSON.stringify(stderrLog)}, 'a');
      const stdinHolder = spawn(process.execPath, ['-e',
        "process.on('message', line => process.stdout.write(line)); setInterval(() => {}, 60000)"], {
        stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
        detached: true,
      });
      stdinHolder.unref();
      const child = spawn(process.execPath, ['--require', ${JSON.stringify(bootPreload)}, ${JSON.stringify(BIN)}, 'serve', '--mcp'], {
        stdio: [stdinHolder.stdout, 'pipe', stderrFd],
        // Pin to direct (in-process) mode: this test targets the in-process
        // server's PPID watchdog (#277). The detached-daemon/proxy watchdog is
        // covered separately in mcp-daemon.test.ts ("daemon survives the first
        // client dying"). Without this the spawned process becomes a proxy and
        // also spawns a detached daemon that would outlive the test.
        env: { ...process.env, LATTICE_SENSOR_PPID_POLL_MS: '200', LATTICE_SENSOR_NO_DAEMON: '1' },
        detached: true,
      });
      child.unref();
      const pids = { pid: child.pid, stdinHolderPid: stdinHolder.pid };
      process.stdout.write(JSON.stringify({ ...pids, ready: false }) + '\\n');
      let responses = '';
      child.stdout.on('data', chunk => {
        responses += chunk.toString('utf8');
        let newline;
        while ((newline = responses.indexOf('\\n')) !== -1) {
          const line = responses.slice(0, newline);
          responses = responses.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1 && response.result) {
              process.stdout.write(JSON.stringify({ ...pids, ready: true }) + '\\n');
            }
          } catch { /* only initialize responses count as readiness */ }
        }
      });
      stdinHolder.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'ppid-watchdog-test', version: '1' } } }) + '\\n');
      setInterval(() => {}, 60000);
    `;
    wrapper = spawn(process.execPath, ['-e', wrapperSrc], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // All descendants inherit an isolated project. An editor's live writer
      // lock in the repository must not terminate the child before the watchdog.
      cwd: tmpDir,
    }) as ChildProcessWithoutNullStreams;

    const pids = await new Promise<{ pid: number; stdinHolderPid: number }>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error('wrapper did not receive MCP initialize response within 10s')),
        10000,
      );
      wrapper!.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let newline;
        while ((newline = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, newline);
          buf = buf.slice(newline + 1);
          const report = JSON.parse(line);
          childPid = report.pid;
          stdinHolderPid = report.stdinHolderPid;
          if (report.ready) {
            clearTimeout(timer);
            resolve({ pid: report.pid, stdinHolderPid: report.stdinHolderPid });
          }
        }
      });
      wrapper!.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('wrapper exited before reporting PIDs'));
      });
    });
    childPid = pids.pid;
    stdinHolderPid = pids.stdinHolderPid;

    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(stdinHolderPid)).toBe(true);

    // SIGKILL the wrapper — no cleanup runs, just like a real OOM kill.
    // latticeSensor and the stdin-holder both get reparented to init/systemd.
    // Crucially, the pipe between them stays open, so latticeSensor's stdin
    // doesn't close: only the watchdog can take it down.
    wrapper.kill('SIGKILL');

    // Watchdog runs every 200ms in this test → 5s gives ~25 polls of headroom.
    const exited = await waitForExit(childPid, 5000);
    const stderrContent = fs.existsSync(stderrLog) ? fs.readFileSync(stderrLog, 'utf-8') : '<no stderr captured>';
    expect(
      exited,
      `latticeSensor child (pid=${childPid}) did not exit within 5s after wrapper was SIGKILL'd.\nstderr:\n${stderrContent}`,
    ).toBe(true);
    // The watchdog announces itself before tearing down — assert that the
    // shutdown came from the parent-death path, not from any other signal.
    expect(stderrContent).toMatch(/Parent process exited.*shutting down/);
    expect(isAlive(stdinHolderPid)).toBe(true); // shutdown happened with stdin still held open
    const runtimePids = fs.readFileSync(path.join(tmpDir, 'runtime-pids'), 'utf8').trim().split('\n').map(Number);
    for (const pid of runtimePids) {
      expect(isAlive(pid), `runtime ${pid} survived its launcher's exit`).toBe(false);
    }

    // The stdin-holder is now an orphan — kill it explicitly so it doesn't
    // outlive the test. It's still tracked in `stdinHolderPid` for the
    // afterEach safety net, but we tidy up proactively here too.
    if (isAlive(stdinHolderPid)) {
      try { process.kill(stdinHolderPid, 'SIGKILL'); } catch { /* race */ }
    }
  }, 20000);
});
