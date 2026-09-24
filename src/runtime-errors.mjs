import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, platform as hostPlatform, arch as hostArch } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * opt-in runtime error store（親plan L6要件。Caveat `caveat.runtime_errors.v1` と同型の工場契約）。
 *
 * - collection/reporting分離: 収集可否は工場共有config
 *   `${XDG_CONFIG_HOME:-~/.config}/dotagents/factory-reporter.json` の `collection.enabled` だけが決める。
 *   reporting設定はconfig validationの一部だが、本storeは外部送信を一切行わない（送信はdotagents adapter所有）。
 * - 既定OFF: config欠落・malformed・disabledでは state も network も触らない。
 * - privacy by design: 保存するのは固定catalogの `error_code` / `message_template` のみ。
 *   生message・path・引数を保存しない。
 * - retention: fingerprint集約（同一原因はcount/last_seen更新）＋ack済みresolvedの30日compact。
 * - POSIX専用: Lattice runtimeはWindows nativeでunsupported（親plan L6）。owner-onlyを証明できない
 *   環境では `store_unsafe` でfail closedする。
 */

const RUNTIME_ERRORS_SCHEMA = 'lattice.runtime_errors.v1';
const DIAGNOSTICS_SCHEMA = 'lattice.runtime_error_diagnostics.v1';
const PRODUCT = 'lattice';
const STATE_VERSION = '1.0';
const MAX_RECORDS = 256;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5_000;

const definitions = Object.freeze({
  'LATTICE.SENSOR_EVIDENCE_FAILED': { component: 'sensor_adapter', severity: 'high', template: 'LatticeSensor evidence collection failed' },
  'LATTICE.RUN_STORE_IO_FAILED': { component: 'run_store', severity: 'high', template: 'Lattice run store IO failed' },
  'LATTICE.EVENT_CHAIN_INTEGRITY_FAILED': { component: 'event_store', severity: 'high', template: 'Lattice run event chain integrity check failed' },
  'LATTICE.CLI_INTERNAL_FAILED': { component: 'cli', severity: 'high', template: 'Lattice CLI crashed outside the typed error contract' },
  'LATTICE.MCP_SERVER_FAILED': { component: 'mcp', severity: 'high', template: 'Lattice MCP server failed' },
});

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
const validOs = (value) => typeof value === 'string' && ['darwin', 'linux'].includes(value);
const validArch = (value) => typeof value === 'string' && ['x64', 'arm64', 'arm'].includes(value);

export function defaultFactoryReporterConfigPath(env = process.env) {
  const home = env.HOME || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'dotagents', 'factory-reporter.json');
}

export function runtimeErrorsStatePath(env = process.env) {
  const home = env.HOME || homedir();
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'lattice', 'runtime-errors.json');
}

function canonicalReporting(value) {
  if (!plain(value) || !Object.keys(value).every((key) => ['enabled', 'endpoint', 'credential_file'].includes(key)) || typeof value.enabled !== 'boolean') return false;
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return false;
    try { if (!['http:', 'https:'].includes(new URL(value.endpoint).protocol)) return false; } catch { return false; }
  }
  if (value.credential_file !== undefined && (typeof value.credential_file !== 'string' || value.credential_file.length < 1 || value.credential_file.length > 4096)) return false;
  return !value.enabled || (value.endpoint !== undefined && value.credential_file !== undefined);
}

function collectionEnabled(options = {}) {
  const env = options.env ?? process.env;
  try {
    const path = options.configPath ?? defaultFactoryReporterConfigPath(env);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return plain(config) && exact(config, ['schema_version', 'host', 'collection', 'reporting'])
      && config.schema_version === '1.0' && plain(config.host) && exact(config.host, ['id', 'profile'])
      && typeof config.host.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(config.host.id)
      && ['server', 'mac', 'wsl', 'windows-native'].includes(config.host.profile)
      && plain(config.collection) && exact(config.collection, ['enabled']) && config.collection.enabled === true
      && canonicalReporting(config.reporting);
  } catch {
    return false;
  }
}

export function runtimeCollectionEnabled(env = process.env, configPath) {
  return collectionEnabled({ env, configPath });
}

function fingerprintOf(code) {
  const definition = definitions[code];
  return createHash('sha256').update(`${PRODUCT}\0${definition.component}\0${code}\0${definition.template}`).digest('hex');
}

function assertPosix(info, mode) {
  if ((info.mode & 0o777) !== mode || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('store_unsafe');
}

function ensureSafeDir(dir) {
  if (hostPlatform() === 'win32') throw Error('store_unsafe');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw Error('store_unsafe');
  assertPosix(stats, 0o700);
}

function ensureSafeFile(path) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw Error('store_unsafe');
  assertPosix(statSync(path), 0o600);
}

const empty = () => ({ schema: RUNTIME_ERRORS_SCHEMA, next_sequence: 1, acknowledged_through: 0, records: [] });

function validate(store) {
  if (!plain(store) || !exact(store, ['schema', 'next_sequence', 'acknowledged_through', 'records'])) throw Error('state_invalid');
  if (store.schema !== RUNTIME_ERRORS_SCHEMA || !Number.isSafeInteger(store.next_sequence) || store.next_sequence < 1
    || !Number.isSafeInteger(store.acknowledged_through) || store.acknowledged_through < 0 || store.acknowledged_through >= store.next_sequence
    || !Array.isArray(store.records) || store.records.length > MAX_RECORDS) throw Error('state_invalid');
  const seen = new Set();
  let previous = 0;
  for (const record of store.records) {
    if (!plain(record) || !exact(record, ['product', 'product_version', 'component', 'error_code', 'message_template', 'severity', 'fingerprint', 'count', 'first_seen', 'last_seen', 'state_schema_version', 'os', 'arch', 'status', 'resolved_at', 'reason_code', 'sequence'])) throw Error('state_invalid');
    const definition = definitions[record.error_code];
    if (!definition || record.product !== PRODUCT || !validVersion(record.product_version)
      || record.component !== definition.component || record.message_template !== definition.template
      || record.severity !== definition.severity || record.fingerprint !== fingerprintOf(record.error_code)
      || seen.has(record.fingerprint) || !Number.isSafeInteger(record.count) || record.count < 1
      || !validTime(record.first_seen) || !validTime(record.last_seen)
      || Date.parse(record.first_seen) > Date.parse(record.last_seen)
      || record.state_schema_version !== STATE_VERSION || !validOs(record.os) || !validArch(record.arch)
      || !Number.isSafeInteger(record.sequence) || record.sequence <= previous || record.sequence >= store.next_sequence
      || !['open', 'resolved'].includes(record.status)
      || (record.status === 'open' && (record.resolved_at !== null || record.reason_code !== null))
      || (record.status === 'resolved' && (!validTime(record.resolved_at) || Date.parse(record.resolved_at) < Date.parse(record.last_seen) || record.reason_code !== 'operator_resolved'))) throw Error('state_invalid');
    seen.add(record.fingerprint);
    previous = record.sequence;
  }
}

function readStore(path) {
  if (!existsSync(path)) return empty();
  ensureSafeFile(path);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  validate(value);
  return value;
}

function writeStore(path, store) {
  validate(store);
  ensureSafeDir(dirname(path));
  const temporary = join(dirname(path), `.runtime-errors-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600, flag: 'wx' });
    assertPosix(statSync(temporary), 0o600);
    renameSync(temporary, path);
    ensureSafeFile(path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lock(path, fn) {
  ensureSafeDir(dirname(path));
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (!plain(error) || error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - lstatSync(lockPath).mtimeMs; } catch { continue; }
      // crash残置lockの恒久ロックを避ける唯一の明示救済。閾値未満は正当な並行writerとして待つ。
      if (age > LOCK_STALE_MS) { try { unlinkSync(lockPath); } catch {} continue; }
      if (Date.now() >= deadline) throw Error('store_locked');
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function now(options) {
  const value = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(value.valueOf())) throw Error('invalid_time');
  return value.toISOString();
}

function optionsFor(options) {
  const env = options.env ?? process.env;
  return { env, path: options.storePath ?? runtimeErrorsStatePath(env) };
}

function requireCursor(value) { if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid_cursor'); }
function requireLimit(value) { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECORDS) throw Error('invalid_limit'); }

function snapshot(options = {}) {
  const afterCursor = options.afterCursor ?? 0;
  const limit = options.limit ?? MAX_RECORDS;
  requireCursor(afterCursor);
  requireLimit(limit);
  const enabled = collectionEnabled(options);
  const { path } = optionsFor(options);
  const store = enabled ? readStore(path) : empty();
  if (afterCursor > store.next_sequence - 1) throw Error('invalid_cursor');
  const all = store.records.filter((record) => record.sequence > afterCursor);
  const rows = all.slice(0, limit);
  return {
    schema: RUNTIME_ERRORS_SCHEMA,
    product: PRODUCT,
    version: options.version ?? 'unknown',
    state_schema_version: STATE_VERSION,
    cursor: { high_watermark: store.next_sequence - 1, acknowledged_through: store.acknowledged_through, next: rows.at(-1)?.sequence ?? afterCursor },
    runtime_errors: rows.filter((record) => record.status === 'open').map(({ product_version, error_code, component, status, severity, fingerprint, message_template, count, first_seen, last_seen, state_schema_version }) => ({ product_version, error_code, component, status, severity, fingerprint, message_template, occurrence_count: count, first_seen, last_seen, state_schema_version })),
    resolutions: rows.filter((record) => record.status === 'resolved').map(({ fingerprint, resolved_at, reason_code }) => ({ fingerprint, resolved_at, reason_code })),
    diagnostics: {
      collection: enabled ? 'enabled' : 'disabled',
      status: enabled ? 'ready' : 'not_applicable',
      total_count: store.records.length,
      pending_count: store.records.filter((record) => record.sequence > store.acknowledged_through).length,
      truncated: all.length > rows.length,
    },
  };
}

export function runtimeErrorsSnapshot(afterCursor = 0, limit = MAX_RECORDS, options = {}) {
  return snapshot({ ...options, afterCursor, limit });
}

export function runtimeErrorsDiagnostics(options = {}) {
  if (!collectionEnabled(options)) {
    return { schema: DIAGNOSTICS_SCHEMA, collection: 'disabled', status: 'not_applicable', total_count: 0, open_count: 0, pending_count: 0, high_watermark: 0, acknowledged_through: 0 };
  }
  try {
    const { path } = optionsFor(options);
    const store = readStore(path);
    return {
      schema: DIAGNOSTICS_SCHEMA,
      collection: 'enabled',
      status: 'ready',
      total_count: store.records.length,
      open_count: store.records.filter((record) => record.status === 'open').length,
      pending_count: store.records.filter((record) => record.sequence > store.acknowledged_through).length,
      high_watermark: store.next_sequence - 1,
      acknowledged_through: store.acknowledged_through,
    };
  } catch {
    return { schema: DIAGNOSTICS_SCHEMA, collection: 'enabled', status: 'unavailable', total_count: 0, open_count: 0, pending_count: 0, high_watermark: 0, acknowledged_through: 0 };
  }
}

export function recordRuntimeError(code, options = {}) {
  if (!collectionEnabled(options)) return { status: 'disabled' };
  const definition = definitions[code];
  if (!definition) throw Error('unknown_runtime_code');
  const { path } = optionsFor(options);
  return lock(path, () => {
    const store = readStore(path);
    const key = fingerprintOf(code);
    const sequence = store.next_sequence++;
    const time = now(options);
    const version = options.version ?? '0.0.0';
    const os = options.os ?? hostPlatform();
    const arch = options.arch ?? hostArch();
    if (!validVersion(version) || !validOs(os) || !validArch(arch)) throw Error('invalid_runtime_metadata');
    const existing = store.records.find((record) => record.fingerprint === key);
    if (existing) {
      existing.product_version = version;
      existing.os = os;
      existing.arch = arch;
      existing.count += 1;
      existing.last_seen = time;
      existing.sequence = sequence;
      existing.status = 'open';
      existing.resolved_at = null;
      existing.reason_code = null;
    } else {
      if (store.records.length >= MAX_RECORDS) throw Error('store_overflow');
      store.records.push({
        product: PRODUCT, product_version: version, component: definition.component, error_code: code,
        message_template: definition.template, severity: definition.severity, fingerprint: key,
        count: 1, first_seen: time, last_seen: time, state_schema_version: STATE_VERSION,
        os, arch, status: 'open', resolved_at: null, reason_code: null, sequence,
      });
    }
    store.records.sort((a, b) => a.sequence - b.sequence);
    writeStore(path, store);
    return { status: 'recorded', fingerprint: key, sequence };
  });
}

export function observeRuntimeError(code, options = {}) {
  try {
    recordRuntimeError(code, options);
  } catch {
    try { process.stderr.write('[lattice:runtime-errors] store_unavailable\n'); } catch { /* best-effort */ }
  }
}

export function acknowledgeRuntimeErrors(cursor, options = {}) {
  requireCursor(cursor);
  if (!collectionEnabled(options)) return snapshot({ ...options, afterCursor: cursor });
  const { path } = optionsFor(options);
  lock(path, () => {
    const store = readStore(path);
    if (cursor >= store.next_sequence) throw Error('invalid_cursor');
    store.acknowledged_through = Math.max(store.acknowledged_through, cursor);
    writeStore(path, store);
  });
  return snapshot(options);
}

export function setRuntimeErrorStatus(fingerprintValue, status, options = {}) {
  if (!/^[0-9a-f]{64}$/.test(fingerprintValue)) throw Error('invalid_fingerprint');
  if (!['open', 'resolved'].includes(status)) throw Error('invalid_status');
  if (!collectionEnabled(options)) return snapshot(options);
  const { path } = optionsFor(options);
  lock(path, () => {
    const store = readStore(path);
    const record = store.records.find((entry) => entry.fingerprint === fingerprintValue);
    if (!record) throw Error('fingerprint_not_found');
    if (record.status === status) return;
    record.status = status;
    record.resolved_at = status === 'resolved' ? now(options) : null;
    record.reason_code = status === 'resolved' ? 'operator_resolved' : null;
    record.sequence = store.next_sequence++;
    store.records.sort((a, b) => a.sequence - b.sequence);
    writeStore(path, store);
  });
  return snapshot(options);
}

export function compactRuntimeErrors(options = {}) {
  if (!collectionEnabled(options)) return snapshot(options);
  const { path } = optionsFor(options);
  lock(path, () => {
    const store = readStore(path);
    const cutoff = Date.parse(now(options)) - RETENTION_MS;
    store.records = store.records.filter((record) => !(record.status === 'resolved'
      && record.sequence <= store.acknowledged_through
      && record.resolved_at !== null
      && Date.parse(record.resolved_at) <= cutoff));
    writeStore(path, store);
  });
  return snapshot(options);
}

export const runtimeErrorsInternal = { validate, definitions, fingerprintOf };
