import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

/** A missing process and an unavailable birth observation are different. */
export async function observeDashboardProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('invalid dashboard pid');
  try { process.kill(pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return null;
    throw error;
  }
  try {
    if (process.platform === 'linux') {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') return null;
      return { pid, birth: `linux:${boot.trim()}:${fields[19]}` };
    }
    const { stdout } = process.platform === 'win32'
      ? await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToFileTimeUtc()`],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      : await execute('/bin/ps', ['-o', 'lstart=', '-p', String(pid)],
        { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } });
    return { pid, birth: stdout.trim() || null };
  } catch (error) {
    // Recheck death after a racing exit. An observation failure never licenses a kill.
    try { process.kill(pid, 0); } catch (probeError) {
      if (probeError.code === 'ESRCH') return null;
      throw probeError;
    }
    return { pid, birth: null, observation: 'unavailable' };
  }
}

export function observedDashboardExit(code, signal, platform = process.platform) {
  if (platform === 'win32') {
    if (!Number.isInteger(code)) return { status: 'unknown', signal: 'not_applicable' };
    const uint32 = code >>> 0;
    return { status: 'observed', uint32, hex: `0x${uint32.toString(16).padStart(8, '0').toUpperCase()}`,
      signal: 'not_applicable', source: 'node_child_wait', origin: 'unknown' };
  }
  if (Number.isInteger(code)) return { status: 'observed', code, signal: null, source: 'node_child_wait' };
  if (typeof signal === 'string') return { status: 'observed', code: null, signal, source: 'node_child_wait' };
  return { status: 'unknown' };
}

/** Use the same authenticated handle for birth check, termination and exit read. */
export async function terminateOwnedWindowsDashboard(identity, exitCode = 1) {
  if (!identity || !Number.isSafeInteger(identity.pid) || !/^[0-9]+$/u.test(identity.birth ?? '')) {
    throw Object.assign(new Error('dashboard process birth is unavailable'),
      { code: 'DASHBOARD_CHILD_IDENTITY_UNAVAILABLE' });
  }
  const script = fileURLToPath(new URL('./dashboard-windows-process-control.ps1', import.meta.url));
  const { stdout } = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script,
    '-ChildPid', String(identity.pid), '-BirthFileTime', identity.birth, '-RequestedExitCode', String(exitCode)],
  { encoding: 'utf8', timeout: 12_000, windowsHide: true, maxBuffer: 16_384 });
  const result = JSON.parse(stdout.trim());
  if (result.schema !== 'lattice.dashboard_process_control.v1'
    || result.pid !== identity.pid || result.birth_filetime !== identity.birth
    || typeof result.termination_requested !== 'boolean' || result.requested_exit_code !== exitCode
    || !Number.isInteger(result.actual_exit_code) || result.actual_exit_code < 0
    || result.actual_exit_code > 0xFFFFFFFF
    || result.actual_exit_hex !== `0x${result.actual_exit_code.toString(16).padStart(8, '0').toUpperCase()}`
    || result.source !== 'GetExitCodeProcess') {
    throw Object.assign(new Error('dashboard process control result invalid'),
      { code: 'DASHBOARD_CHILD_CONTROL_INVALID' });
  }
  return result;
}
