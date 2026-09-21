import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_UNIX_EPOCH_TICKS = 621_355_968_000_000_000n;
const WINDOWS_TICKS_PER_MILLISECOND = 10_000n;

// OS観測はobserverのlocaleへ依存させない。psのlstart書式（LC_TIME）と非ASCII argvの
// エスケープ有無（LC_CTYPE）はlocaleで変わり、同じprocessでも観測者ごとにidentity digestが
// 割れる（2026-08-22 実測: 席fileと席自身の観測でWORKER_IDENTITY_MISMATCH）。
//
// 既知の限界: Linuxの`LC_ALL=C`は非ASCIIバイトを`?`へ非可逆に潰すため、非ASCII部分だけが
// 違うargvの識別力はLinuxでは落ちる（観測者間の一致は保たれる——潰れた`?`は誰が観測しても
// 同じ`?`になるので、locale不一致によるdigest分裂は防げる）。darwinの`ps`はvisエスケープで
// 非ASCIIを可逆に表現するため、この劣化は起きない。
export function osObservationEnvironment() { return { ...process.env, LC_ALL: 'C' }; }

/** processのstart identity（darwin/linuxはps lstart、win32はPowerShell StartTime Ticks）の生文字列を返す。 */
export async function observeStartIdentityRaw(pid) {
  const executable = process.platform === 'win32' ? 'pwsh.exe' : '/bin/ps';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command',
      `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`]
    : ['-o', 'lstart=', '-p', String(pid)];
  const { stdout } = await execFileAsync(executable, args, { encoding: 'utf8', env: osObservationEnvironment() });
  return stdout.trim();
}

/** OS固有のstart identityをUnix epoch millisecondsへ正規化する。raw identityの契約は変えない。 */
export function processStartIdentityEpochMs(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  if (!/^[0-9]+$/u.test(raw)) return null;
  const epochMs = (BigInt(raw) - WINDOWS_UNIX_EPOCH_TICKS) / WINDOWS_TICKS_PER_MILLISECOND;
  if (epochMs < BigInt(Number.MIN_SAFE_INTEGER) || epochMs > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(epochMs);
}

/** processのstart identityをOS差のないUnix epoch millisecondsで返す。解釈不能ならnull。 */
export async function observeStartIdentityEpochMs(pid) {
  return processStartIdentityEpochMs(await observeStartIdentityRaw(pid));
}

/** processのargv（`ps -o command=`）の生文字列を返す。 */
export async function observeArgv(pid) {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: osObservationEnvironment() });
  return stdout.trim();
}

/** processのprocess group id（`ps -o pgid=`）の生文字列を返す。 */
export async function observePgid(pid) {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', env: osObservationEnvironment() });
  return stdout.trim();
}

/** 全processの`pid=,ppid=,pgid=,state=,lstart=`スナップショットの生stdoutを返す。 */
export async function observePsSnapshot() {
  const { stdout } = await execFileAsync('/bin/ps', [
    '-axo', 'pid=,ppid=,pgid=,state=,lstart=',
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: osObservationEnvironment() });
  return stdout;
}

/**
 * 実行中processの実行imageのcanonical pathを観測する。linuxは`/proc/<pid>/exe`、
 * darwinは`ps -o comm=`の結果をrealpathで正規化する。
 */
export async function observeExecutablePath(pid) {
  if (process.platform === 'linux') {
    return realpath(`/proc/${pid}/exe`);
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', env: osObservationEnvironment() });
  return realpath(stdout.trim());
}
