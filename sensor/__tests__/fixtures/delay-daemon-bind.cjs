// Explicit preload for one owned test socket. Never loaded by the product.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

if (process.env.LATTICE_SENSOR_DAEMON_INTERNAL === '1' && process.env.CG_TEST_BIND_SOCKET) {
  const root = process.env.CG_TEST_BIND_ROOT;
  const marker = process.env.CG_TEST_BIND_MARKER;
  const delay = Number(process.env.CG_TEST_BIND_DELAY_MS);
  if (!root || path.dirname(marker) !== root || !Number.isSafeInteger(delay) || delay < 0 || delay > 9000) {
    throw new Error('INVALID_OWNED_BIND_FIXTURE');
  }
  const original = net.Server.prototype.listen;
  let delayed = false;
  net.Server.prototype.listen = function (...args) {
    const socket = typeof args[0] === 'string' ? args[0] : args[0]?.path;
    if (delayed || socket !== process.env.CG_TEST_BIND_SOCKET) return original.apply(this, args);
    const lock = JSON.parse(fs.readFileSync(path.join(root, '.lattice/sensor/daemon.pid'), 'utf8'));
    if (lock.pid !== process.pid) throw new Error('BIND_FIXTURE_NOT_LOCK_OWNER');
    const record = (phase) => fs.appendFileSync(marker, JSON.stringify({
      phase, pid: process.pid, at: Date.now(), startedAt: lock.startedAt,
    }) + '\n', { mode: 0o600 });
    delayed = true;
    record('owned_before_bind');
    this.once('listening', () => record('listening'));
    setTimeout(() => { record('release_bind'); original.apply(this, args); }, delay);
    return this;
  };
}
