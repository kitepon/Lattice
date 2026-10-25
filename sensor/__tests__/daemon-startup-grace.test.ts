import { expect, it } from 'vitest';
import { daemonStartupDeadline, DAEMON_STARTUP_GRACE_MS } from '../src/mcp/daemon-paths';

it('startupの保護期限は元の時刻から固定し観測のたびに延ばさない', () => {
  const owner = { startedAt: 100_000 };
  expect(daemonStartupDeadline(owner, 100_001)).toBe(100_000 + DAEMON_STARTUP_GRACE_MS);
  expect(daemonStartupDeadline(owner, 109_999)).toBe(110_000);
  expect(daemonStartupDeadline(owner, 110_000)).toBeNull();
});

it('欠測・legacy・非有限の起動時刻から保護期限を作らない', () => {
  expect(daemonStartupDeadline(null, 100_000)).toBeNull();
  for (const startedAt of [0, -1, NaN, Infinity]) {
    expect(daemonStartupDeadline({ startedAt }, 100_000)).toBeNull();
  }
});

it('未来の起動時刻や不明な現在時刻で待機を延ばさない', () => {
  expect(daemonStartupDeadline({ startedAt: 100_001 }, 100_000)).toBeNull();
  expect(daemonStartupDeadline({ startedAt: 100_000 }, NaN)).toBeNull();
});
