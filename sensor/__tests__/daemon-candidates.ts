/** Shared lifecycle observation for the original detached children of a fixture. */
import * as fs from 'fs';
import * as path from 'path';
import { observeDashboardProcess } from '../../src/dashboard-process-control.mjs';

const SPAWN_RECORDER = path.resolve(__dirname, 'fixtures/record-detached-spawns.cjs');

type Candidate = {
  token: string; pid: number; birth: string | null;
  state: 'pending' | 'unknown' | 'exited'; reason: string;
};
type Snapshot = { status: 'observed' | 'missing' | 'unreadable' | 'invalid'; items: Candidate[]; errorCode?: string };
type Probe = { next: number; inFlight: boolean; state: 'pending' | 'unknown'; reason: string };
const sessions = new Map<string, { active: boolean; probes: Map<string, Probe> }>();

/** Records live beside the fixture so its directory can be removed last. */
export function spawnLogFor(fixture: string): string {
  return path.join(path.dirname(fixture), `${path.basename(fixture)}.daemon-spawns`);
}

export function recordSpawns(fixture: string): { args: string[]; env: NodeJS.ProcessEnv } {
  fs.closeSync(fs.openSync(spawnLogFor(fixture), 'a'));
  return { args: ['--require', SPAWN_RECORDER], env: { CG_TEST_SPAWN_LOG: spawnLogFor(fixture) } };
}

function recordedCandidates(fixture: string): Snapshot {
  let raw: string;
  try { raw = fs.readFileSync(spawnLogFor(fixture), 'utf8'); } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { status: errorCode === 'ENOENT' ? 'missing' : 'unreadable', items: [], errorCode };
  }
  const records = new Map<string, Candidate>();
  let invalid = false;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event.token !== 'string' || !event.token
        || !Number.isSafeInteger(event.pid) || event.pid <= 0) throw new Error('identity');
      const candidate = records.get(event.token) ?? {
        token: event.token, pid: event.pid, birth: null, state: 'unknown', reason: 'birth-unavailable',
      };
      if (candidate.pid !== event.pid) throw new Error('pid changed');
      switch (event.kind) {
        case 'spawn': break;
        case 'identity':
          if (typeof event.birth !== 'string' || !event.birth
            || (candidate.birth !== null && candidate.birth !== event.birth)) throw new Error('birth changed');
          candidate.birth = event.birth;
          if (candidate.state !== 'exited') {
            candidate.state = 'pending';
            candidate.reason = 'not-observed';
          }
          break;
        case 'child-exit':
          if (!(Number.isInteger(event.code) && event.signal === null)
            && !(event.code === null && typeof event.signal === 'string' && event.signal)) throw new Error('exit');
          candidate.state = 'exited';
          candidate.reason = 'native-child-exit';
          break;
        case 'observed-exit':
          if (!['absent', 'birth-changed'].includes(event.reason)) throw new Error('exit reason');
          candidate.state = 'exited';
          candidate.reason = event.reason;
          break;
        case 'capture-unavailable':
          if (typeof event.reason !== 'string') throw new Error('capture reason');
          if (candidate.state !== 'exited' && candidate.birth === null) candidate.reason = event.reason;
          break;
        default: throw new Error('event kind');
      }
      records.set(event.token, candidate);
    } catch { invalid = true; }
  }
  return { status: invalid ? 'invalid' : 'observed', items: [...records.values()],
    ...(invalid ? { errorCode: 'INVALID_CANDIDATE_RECORD' } : {}) };
}

function proveExit(fixture: string, candidate: Candidate, reason: 'absent' | 'birth-changed'): void {
  fs.appendFileSync(spawnLogFor(fixture), `${JSON.stringify({ kind: 'observed-exit',
    token: candidate.token, pid: candidate.pid, reason })}\n`);
  candidate.state = 'exited';
  candidate.reason = reason;
}

/** Cheap checks each poll; expensive birth reads run concurrently at most once/second. */
export async function readCandidateSnapshot(fixture: string): Promise<Snapshot> {
  const snapshot = recordedCandidates(fixture);
  if (snapshot.status !== 'observed') return snapshot;
  let session = sessions.get(fixture);
  if (!session) {
    session = { active: true, probes: new Map() };
    sessions.set(fixture, session);
  }
  for (const candidate of snapshot.items) {
    if (candidate.state === 'exited') continue;
    try { process.kill(candidate.pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try { proveExit(fixture, candidate, 'absent'); } catch (writeError) {
          candidate.state = 'unknown';
          candidate.reason = (writeError as NodeJS.ErrnoException).code ?? 'exit-record-unavailable';
        }
      } else {
        candidate.state = 'unknown';
        candidate.reason = (error as NodeJS.ErrnoException).code ?? 'liveness-unavailable';
      }
      continue;
    }
    if (candidate.birth === null) continue;
    let probe = session.probes.get(candidate.token);
    if (!probe) {
      probe = { next: 0, inFlight: false, state: 'pending', reason: 'birth-observation-pending' };
      session.probes.set(candidate.token, probe);
    }
    candidate.state = probe.state;
    candidate.reason = probe.reason;
    if (probe.inFlight || Date.now() < probe.next) continue;
    probe.inFlight = true;
    probe.next = Date.now() + 1000;
    const activeSession = session;
    const activeProbe = probe;
    // Return the snapshot immediately; the waiter owns the one fixed deadline.
    void observeDashboardProcess(candidate.pid).then((identity) => {
      if (!activeSession.active) return;
      if (identity === null || (identity.birth && identity.birth !== candidate.birth)) {
        proveExit(fixture, candidate, identity === null ? 'absent' : 'birth-changed');
      } else {
        activeProbe.state = identity.birth ? 'pending' : 'unknown';
        activeProbe.reason = identity.birth ? 'same-birth' : 'birth-unavailable';
      }
    }).catch((error) => {
      activeProbe.state = 'unknown';
      activeProbe.reason = error.code ?? 'birth-observation-unavailable';
    }).finally(() => { activeProbe.inFlight = false; });
  }
  return snapshot;
}

/** Wait after launchers exit; never signal a candidate or reset its original birth. */
export async function settleLosingCandidates(
  fixture: string,
  holder: () => number | null | undefined,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = holder();
    const snapshot = await readCandidateSnapshot(fixture);
    const pending = snapshot.items.filter((candidate) => candidate.pid !== current && candidate.state !== 'exited');
    if (Date.now() <= deadline && snapshot.status === 'observed' && pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Daemon candidates did not settle with ${current ?? 'no process'} holding the lock: ${JSON.stringify({
        status: snapshot.status, errorCode: snapshot.errorCode, total: snapshot.items.length,
        pending: pending.length, items: pending.slice(-16),
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}

/** Prevent an already-started observer from recreating a successfully removed log. */
export function removeSpawnLog(fixture: string): void {
  const session = sessions.get(fixture);
  if (session) session.active = false;
  sessions.delete(fixture);
  fs.rmSync(spawnLogFor(fixture), { force: true });
}
