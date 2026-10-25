import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';

/** argvがfixtureのtemp pathを指すprocessだけを列挙する。 */
export function daemonPidsUnder(temporary) {
  if (process.platform === 'win32') {
    const listed = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0 || typeof listed.stdout !== 'string') return [];
    try {
      const parsed = JSON.parse(listed.stdout.replace(/^\uFEFF/u, '').trim());
      const records = Array.isArray(parsed) ? parsed : [parsed];
      const needle = temporary.toLowerCase();
      return records
        .filter((record) => typeof record?.CommandLine === 'string'
          && record.CommandLine.toLowerCase().includes(needle))
        .map((record) => Number(record.ProcessId))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    } catch {
      return [];
    }
  }
  const listed = spawnSync('ps', ['-eo', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return [];
  return listed.stdout.split('\n')
    .filter((line) => line.includes(temporary))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
}

// kill(pid, 0)は回収前のzombieにも通るので、生存判定にはpsの状態を使う。
function processAlive(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }
  const listed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = (listed.stdout ?? '').trim();
  return state.length > 0 && !state.startsWith('Z');
}

/** fixture配下のdaemonをSIGTERMからSIGKILLへ上げ、残存pidを返す。 */
export async function reapDaemonsUnder(temporary, tracked = []) {
  if (process.platform === 'win32') {
    for (const pid of tracked) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }
  const discovered = process.platform === 'win32' ? daemonPidsUnder(temporary) : null;
  const survivors = () => [...new Set([
    ...(discovered ?? daemonPidsUnder(temporary)),
    ...tracked.filter(processAlive),
  ])].filter(processAlive);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (survivors().length === 0) return [];
    for (const pid of survivors()) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGCONT');
          process.kill(-pid, signal);
        }
      } catch {
        // 既に停止済み。
      }
    }
    for (const pid of process.platform === 'win32' ? [] : daemonPidsUnder(temporary)) {
      try {
        process.kill(pid, signal);
      } catch {
        // 既に停止済み。
      }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && survivors().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return survivors();
}

const liveFixtures = new Set();

/** Wait for fixture-owned processes before removing files their exit receipts need. */
export async function removeManagedDaemonFixture(temporary, tracked = []) {
  const survivors = await reapDaemonsUnder(temporary, tracked);
  assert.deepEqual(survivors, [], `fixtureのdaemonが停まらずに残った: ${survivors.join(', ')}`);
  await rm(temporary, { recursive: true, force: true });
}

// timeout等でafter hook自体が走らなかった時の同期的な最後の受け皿。
process.on('exit', () => {
  for (const temporary of liveFixtures) {
    for (const pid of daemonPidsUnder(temporary)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 既に停止済み。
      }
    }
  }
});

/** test終了時のdaemon停止・fixture削除・残存ゼロassertを一括登録する。 */
export function registerManagedDaemonFixture(t, temporary, { tracked = [] } = {}) {
  liveFixtures.add(temporary);
  t.after(async () => {
    const survivors = await reapDaemonsUnder(temporary, tracked);
    liveFixtures.delete(temporary);
    await rm(temporary, { recursive: true, force: true });
    assert.deepEqual(survivors, [], `fixtureのdaemonが停まらずに残った: ${survivors.join(', ')}`);
  });
}
