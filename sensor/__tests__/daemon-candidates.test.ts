import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordSpawns, readCandidateSnapshot, removeSpawnLog, settleLosingCandidates, spawnLogFor } from './daemon-candidates';

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../../src/dashboard-process-control.mjs', () => ({ observeDashboardProcess: observe }));
const { recordCandidate } = require('./fixtures/record-detached-spawns.cjs');

let fixture: string;
function append(event: object): void {
  fs.appendFileSync(spawnLogFor(fixture), JSON.stringify({ token: 'original', pid: 123456, ...event }) + '\n');
}
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(0); }

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-identity-'));
  recordSpawns(fixture);
  vi.useFakeTimers();
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  observe.mockReset().mockResolvedValue({ pid: 123456, birth: 'A' });
});
afterEach(() => {
  removeSpawnLog(fixture);
  fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('original candidate lifecycle', () => {
  it('rejects an expired remaining budget even with no candidates', async () => {
    await expect(settleLosingCandidates(fixture, () => null, -1)).rejects.toThrow(/did not settle/);
  });

  it('keeps a live same-birth loser pending and fails within its budget', async () => {
    append({ kind: 'spawn' }); append({ kind: 'identity', birth: 'A' });
    const result = expect(settleLosingCandidates(fixture, () => null, 50)).rejects.toThrow(/did not settle/);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(observe).toHaveBeenCalledTimes(1);
    expect(process.kill).toHaveBeenCalledWith(123456, 0);
    expect((await readCandidateSnapshot(fixture)).items[0].state).toBe('pending');
  });

  it.each(['child-exit', 'absence'] as const)('remembers %s before later PID reuse across reads', async (source) => {
    append({ kind: 'spawn' }); append({ kind: 'identity', birth: 'A' });
    if (source === 'child-exit') append({ kind: 'child-exit', code: 0, signal: null });
    else vi.mocked(process.kill).mockImplementationOnce(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    expect((await readCandidateSnapshot(fixture)).items[0].state).toBe('exited');
    observe.mockResolvedValue({ pid: 123456, birth: 'B' });
    await settleLosingCandidates(fixture, () => null, 50);
    expect((await readCandidateSnapshot(fixture)).items[0].state).toBe('exited');
    expect(observe).not.toHaveBeenCalled();
  });

  it('proves original exit from a changed birth without signaling the new occupant', async () => {
    append({ kind: 'spawn' }); append({ kind: 'identity', birth: 'A' });
    observe.mockResolvedValue({ pid: 123456, birth: 'B' });
    await readCandidateSnapshot(fixture); await flush();
    await settleLosingCandidates(fixture, () => null, 50);
    expect((await readCandidateSnapshot(fixture)).items[0].reason).toBe('birth-changed');
    expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it.each(['missing-birth', 'EPERM', 'observer-error'] as const)('keeps %s unknown and can recover on confirmed absence', async (source) => {
    append({ kind: 'spawn' });
    if (source !== 'missing-birth') append({ kind: 'identity', birth: 'A' });
    if (source === 'EPERM') vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
    if (source === 'observer-error') observe.mockRejectedValue(Object.assign(new Error(), { code: 'EIO' }));
    await readCandidateSnapshot(fixture); await flush();
    expect((await readCandidateSnapshot(fixture)).items[0].state).toBe('unknown');
    const failure = expect(settleLosingCandidates(fixture, () => null, 25)).rejects.toThrow(/unknown/);
    await vi.advanceTimersByTimeAsync(25); await failure;
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    await settleLosingCandidates(fixture, () => null, 50);
  });

  it('preserves the worker holder but requires every original candidate to exit', async () => {
    append({ kind: 'spawn', pid: process.pid });
    await settleLosingCandidates(fixture, () => process.pid, 50);
    const failure = expect(settleLosingCandidates(fixture, () => null, 25)).rejects.toThrow(/unknown/);
    await vi.advanceTimersByTimeAsync(25); await failure;
    append({ kind: 'child-exit', pid: process.pid, code: 0, signal: null });
    await settleLosingCandidates(fixture, () => null, 50);
    expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it('discards late identity resolution after the original native exit', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 654321, exitCode: null as number | null, signalCode: null });
    let resolve!: (value: object) => void;
    const capture = vi.fn(() => new Promise((done) => { resolve = done; }));
    recordCandidate(child, spawnLogFor(fixture), capture);
    expect(capture).toHaveBeenCalledWith(child.pid);
    child.exitCode = 0; child.emit('exit', 0, null);
    resolve({ pid: child.pid, birth: 'reused' }); await flush();
    const log = fs.readFileSync(spawnLogFor(fixture), 'utf8');
    expect(log).toContain('child-exit'); expect(log).not.toContain('identity');
    expect((await readCandidateSnapshot(fixture)).items[0].state).toBe('exited');
  });

  it('observes different live candidates concurrently with one in-flight probe each', async () => {
    for (const token of ['first', 'second']) {
      append({ kind: 'spawn', token }); append({ kind: 'identity', token, birth: 'A' });
    }
    let resolve!: (value: object) => void;
    observe.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await readCandidateSnapshot(fixture);
    expect(observe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await readCandidateSnapshot(fixture);
    expect(observe).toHaveBeenCalledTimes(2);
    resolve({ pid: 123456, birth: 'A' }); await flush();
  });

  it('throttles completed observations and preserves malformed/missing evidence', async () => {
    append({ kind: 'spawn' }); append({ kind: 'identity', birth: 'A' });
    await readCandidateSnapshot(fixture); await flush();
    await vi.advanceTimersByTimeAsync(999); await readCandidateSnapshot(fixture);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await readCandidateSnapshot(fixture); await flush();
    expect(observe).toHaveBeenCalledTimes(2);
    fs.appendFileSync(spawnLogFor(fixture), '{');
    expect((await readCandidateSnapshot(fixture)).status).toBe('invalid');
    fs.rmSync(spawnLogFor(fixture));
    expect((await readCandidateSnapshot(fixture)).status).toBe('missing');
  });
});
