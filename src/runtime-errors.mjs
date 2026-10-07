import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, platform as hostPlatform, arch as hostArch } from 'node:os';
import { dirname, join } from 'node:path';

import { READ_ONLY_COMMAND_KINDS } from './cli-command-kind.mjs';
import { cliFailureClass, failureCauseChain } from './cli-failure-class.mjs';
import {
  daclIsOwnerOnly, daclIsProtected, isAclScratchName, readWindowsDacl, restrictWindowsDirToOwner, windowsSelfSid,
} from './windows-owner-only.mjs';

/**
 * opt-in runtime error store（親plan L6要件。Caveat `caveat.runtime_errors.v1` と同型の工場契約）。
 *
 * - 収集の有効化: 工場共有config `${XDG_CONFIG_HOME:-~/.config}/dotagents/factory-reporter.json` の
 *   `collection.enabled`、またはLattice自身の送信設定（`runtime-error-reporting.json`、ADR 0193）のどちらかが
 *   有効な時だけ収集する。本storeは外部送信を行わない——送信は`runtime-error-reporting.mjs`が持つ。
 * - 既定OFF: どちらの設定も無い・malformed・disabledでは state も network も触らない。
 * - privacy by design: 保存するのは固定catalogの `error_code` / `message_template` のみ。
 *   生message・path・引数を保存しない。
 * - retention: fingerprint集約（同一原因はcount/last_seen更新）＋ack済みresolvedの30日compact。
 * - owner-only: storeは本人だけが触れる形でしか使わない。POSIXはmode（0700・0600）と所有者、Windowsは
 *   DACL（本人・SYSTEM・Administratorsだけ、ADR 0194）で確かめ、確かめられなければ `store_unsafe` で
 *   fail closedする。
 */

const RUNTIME_ERRORS_SCHEMA = 'lattice.runtime_errors.v1';
const DIAGNOSTICS_SCHEMA = 'lattice.runtime_error_diagnostics.v1';
export const REPORTING_CONFIG_SCHEMA = 'lattice.runtime_error_reporting_config.v1';
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
  // 通信の失敗が型つき契約の外へ漏れた記録（ADR 0196）。直すのは回線ではなく、その面の通信失敗の受け方。
  // 重大度は下の`severityOf`が、落ちた面で失うものがあるかで決める。
  'LATTICE.CLI_TRANSPORT_UNHANDLED': { component: 'cli', severity: 'high', template: 'Lattice CLI let a communication failure escape the typed error contract' },
  'LATTICE.MCP_SERVER_FAILED': { component: 'mcp', severity: 'high', template: 'Lattice MCP server failed' },
});

// safe_context（工場wireの任意欄）。固定語彙だけを載せ、message本文・path・引数の値・stackは載せない。
// 3つのキーは必ずそろえる——fingerprintがこの3つを含むので、欠けると記録を一意に決められない。
const SAFE_CONTEXT_KEYS = Object.freeze(['command_kind', 'error_kind', 'cause_code']);
const ERROR_KINDS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'SystemError']);
const COMMAND_KIND = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)?$/;
const COMMAND_KIND_MAX = 48;
// Nodeが付けるerror code（ENOENT・ERR_MODULE_NOT_FOUND等）だけを通す。Lattice自身のcodeや任意文字列は`none`。
const CAUSE_CODE = /^(?:E[A-Z0-9]{2,15}|ERR_[A-Z0-9_]{1,60})$/;
// 工場の`factory-reporter.json`が名乗る端末の種類。dotagentsの契約（lib/factory/contract.mjs）と同じ語を
// 受ける——ここに無い語の端末は設定全体が無効とみなされ、故障を1件も記録しない。
const HOST_PROFILES = Object.freeze(['server', 'mac', 'linux', 'wsl', 'windows-native']);

const plain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
// 収集に対応するOS。storeを本人だけが触れる形で置けると確かめられるものだけを載せる。
const SUPPORTED_OS = Object.freeze(['darwin', 'linux', 'win32']);
const validOs = (value) => typeof value === 'string' && SUPPORTED_OS.includes(value);
const validArch = (value) => typeof value === 'string' && ['x64', 'arm64', 'arm'].includes(value);

export function defaultFactoryReporterConfigPath(env = process.env) {
  const home = env.HOME || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'dotagents', 'factory-reporter.json');
}

/** Windowsで利用者ごとのdataを置く場所（`%LOCALAPPDATA%`）。 */
export function windowsLocalAppData(env = process.env) {
  return env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local');
}

/**
 * storeの置き場。Windowsは`%LOCALAPPDATA%\Lattice\runtime-errors\`という専用のフォルダへ置く
 * ——`%LOCALAPPDATA%\Lattice`には他の機能のfileがあり、フォルダごと本人だけに絞れない。
 */
export function runtimeErrorsStatePath(env = process.env, platform = hostPlatform()) {
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'lattice', 'runtime-errors.json');
  if (platform === 'win32') return join(windowsLocalAppData(env), 'Lattice', 'runtime-errors', 'runtime-errors.json');
  return join(env.HOME || homedir(), '.local', 'state', 'lattice', 'runtime-errors.json');
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

// このOSで収集に対応するか。対応しないOSでは、設定が有効でも記録は作らず、`disabled`でなく`unsupported`と
// 答える——設定は有効なのに製品が黙って無効と答えると、受け側は故障と区別できない。
const collectionSupported = (options = {}) => SUPPORTED_OS.includes(options.platform ?? hostPlatform());
const inactiveCollection = (options = {}) => (collectionSupported(options) ? 'disabled' : 'unsupported');

export function runtimeErrorCollectionSupported(options = {}) {
  return collectionSupported(options);
}

export function runtimeErrorReportingConfigPath(env = process.env, platform = hostPlatform()) {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'lattice', 'runtime-error-reporting.json');
  if (platform === 'win32') return join(windowsLocalAppData(env), 'Lattice', 'runtime-error-reporting.json');
  return join(env.HOME || homedir(), '.config', 'lattice', 'runtime-error-reporting.json');
}

/**
 * Lattice自身の送信設定（ADR 0193）。端末で`runtime-errors reporting enable`を打った時だけ有効になる。
 * `LATTICE_RUNTIME_ERROR_REPORTING=0`は既定の置き場を読まない——試験と自動化が、その端末の本物の設定を
 * 拾って送信しないための口。`options.reportingConfigPath`を明示した呼び出しはそのfileを読む。
 */
export function runtimeErrorReportingEnabled(options = {}) {
  if (!collectionSupported(options)) return false;
  const env = options.env ?? process.env;
  if (options.reportingConfigPath === undefined && env.LATTICE_RUNTIME_ERROR_REPORTING === '0') return false;
  try {
    const path = options.reportingConfigPath ?? runtimeErrorReportingConfigPath(env);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return plain(config) && exact(config, ['schema', 'enabled'])
      && config.schema === REPORTING_CONFIG_SCHEMA && config.enabled === true;
  } catch {
    return false;
  }
}

function collectionEnabled(options = {}) {
  return factoryCollectionEnabled(options) || runtimeErrorReportingEnabled(options);
}

function factoryCollectionEnabled(options = {}) {
  if (!collectionSupported(options)) return false;
  const env = options.env ?? process.env;
  try {
    const path = options.configPath ?? defaultFactoryReporterConfigPath(env);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return plain(config) && exact(config, ['schema_version', 'host', 'collection', 'reporting'])
      && config.schema_version === '1.0' && plain(config.host) && exact(config.host, ['id', 'profile'])
      && typeof config.host.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(config.host.id)
      && HOST_PROFILES.includes(config.host.profile)
      && plain(config.collection) && exact(config.collection, ['enabled']) && config.collection.enabled === true
      && canonicalReporting(config.reporting);
  } catch {
    return false;
  }
}

export function runtimeCollectionEnabled(env = process.env, configPath) {
  return collectionEnabled({ env, configPath });
}

const validCommandKind = (value) => typeof value === 'string' && value.length <= COMMAND_KIND_MAX && COMMAND_KIND.test(value);
const validErrorKind = (value) => value === 'other' || ERROR_KINDS.has(value);
const validCauseCode = (value) => value === 'none' || (typeof value === 'string' && CAUSE_CODE.test(value));
const validSafeContext = (value) => plain(value) && exact(value, SAFE_CONTEXT_KEYS)
  && validCommandKind(value.command_kind) && validErrorKind(value.error_kind) && validCauseCode(value.cause_code);

/**
 * 落ちた面と例外から、記録へ載せる固定語彙の分類を作る。語彙に無い値は`other`／`none`へ落とす
 * ——呼び出し側が何を渡しても、利用者の入力やpathが記録へ入らない。
 */
export function runtimeErrorSafeContext({ commandKind, error } = {}) {
  const errorKind = error?.constructor?.name;
  // `fetch failed`のように、codeを`cause`の側に持つ例外がある。連なりの中で最初に語彙へ合うcodeを載せる。
  const causeCode = failureCauseChain(error).map((entry) => entry.code)
    .find((code) => typeof code === 'string' && CAUSE_CODE.test(code));
  return {
    command_kind: validCommandKind(commandKind) ? commandKind : 'other',
    error_kind: ERROR_KINDS.has(errorKind) ? errorKind : 'other',
    cause_code: causeCode ?? 'none',
  };
}

/**
 * 記録の重大度。error_codeだけでは決めない記録がある（ADR 0196）: 通信の失敗が漏れた記録は、落ちた面が
 * 何も書き換えないと確かめてある時だけ`warn`——その1回が止まっただけで、失うものが無く、打ち直せば戻る。
 * 書き換える面と、確かめていない面は`high`のまま（結果が分からず、不整合や重複を否定できない）。
 * 分類と面から決まる値なので、同じfingerprintの記録は必ず同じ重大度になる。
 */
function severityOf(code, safeContext = null) {
  if (code === 'LATTICE.CLI_TRANSPORT_UNHANDLED' && safeContext !== null
    && READ_ONLY_COMMAND_KINDS.has(safeContext.command_kind)) return 'warn';
  return definitions[code].severity;
}

/**
 * 旧記録（safe_context無し）はerror_codeだけで決まる式のまま。新しい記録は3つの分類も含める
 * ——原因が違えば別の記録になる。式はdotagentsのadapterが再計算して照合する契約で、
 * 連結順・NUL区切り・末尾区切り無しを変えない。
 */
function fingerprintOf(code, safeContext = null) {
  const definition = definitions[code];
  const parts = [PRODUCT, definition.component, code, definition.template];
  if (safeContext !== null) parts.push(...SAFE_CONTEXT_KEYS.map((key) => safeContext[key]));
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function assertPosix(info, mode) {
  if ((info.mode & 0o777) !== mode || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('store_unsafe');
}

const windows = () => hostPlatform() === 'win32';

/**
 * Windowsのフォルダが本人・SYSTEM・Administratorsだけのもので、親からの継承を切ってあるか確かめる。
 * 作ったばかりのフォルダは親の権限を継いでいるので、絞る。ただし、他のaccountが触れる形なのに中身がある
 * フォルダは、その中身を信用できないので、絞らずに止める。
 */
function ensureWindowsDirOwnerOnly(dir) {
  const sid = windowsSelfSid();
  const settled = (sddl) => daclIsOwnerOnly(sddl, sid) && daclIsProtected(sddl);
  const current = readWindowsDacl(dir, dir);
  if (settled(current)) return;
  if (!daclIsOwnerOnly(current, sid) && readdirSync(dir).some((name) => !isAclScratchName(name))) throw Error('store_unsafe');
  restrictWindowsDirToOwner(dir, sid);
  if (!settled(readWindowsDacl(dir, dir))) throw Error('store_unsafe');
}

export function ensureSafeDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(dir);
  // Windowsのjunctionも`isSymbolicLink`で落ちる。
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw Error('store_unsafe');
  if (windows()) ensureWindowsDirOwnerOnly(dir);
  else assertPosix(stats, 0o700);
}

/**
 * `scratchDir`はWindowsだけが使う: DACLの読み取りが出力fileを置くフォルダ。既定はそのfileのフォルダ。
 * storeの外のfile（合鍵）を確かめる時は、絞ってあるstoreのフォルダを渡す。
 */
export function ensureSafeFile(path, scratchDir = dirname(path)) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw Error('store_unsafe');
  if (!windows()) {
    assertPosix(statSync(path), 0o600);
    return;
  }
  const sid = windowsSelfSid();
  // 出力fileを置くフォルダを他のaccountが書けるなら、読んだDACLを信用できない。先にそれを確かめる。
  if (!daclIsOwnerOnly(readWindowsDacl(scratchDir, scratchDir), sid)
    || !daclIsOwnerOnly(readWindowsDacl(path, scratchDir), sid)) throw Error('store_unsafe');
}

/**
 * 一時fileを本番の名前へ置き換える。Windowsは、読み手が開いている宛先へのrenameを一時的に断るので、
 * 少し待って繰り返す（`fs-publish.mjs`と同じ事情）。
 */
export function replaceStoreFile(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (!windows() || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 7) throw error;
      sleepSync(Math.min(64, 2 ** attempt));
    }
  }
}

const RECORD_KEYS = Object.freeze(['product', 'product_version', 'component', 'error_code', 'message_template', 'severity', 'fingerprint', 'count', 'first_seen', 'last_seen', 'state_schema_version', 'os', 'arch', 'status', 'resolved_at', 'reason_code', 'sequence']);

const empty = () => ({ schema: RUNTIME_ERRORS_SCHEMA, next_sequence: 1, acknowledged_through: 0, records: [] });

function validate(store) {
  if (!plain(store) || !exact(store, ['schema', 'next_sequence', 'acknowledged_through', 'records'])) throw Error('state_invalid');
  if (store.schema !== RUNTIME_ERRORS_SCHEMA || !Number.isSafeInteger(store.next_sequence) || store.next_sequence < 1
    || !Number.isSafeInteger(store.acknowledged_through) || store.acknowledged_through < 0 || store.acknowledged_through >= store.next_sequence
    || !Array.isArray(store.records) || store.records.length > MAX_RECORDS) throw Error('state_invalid');
  const seen = new Set();
  let previous = 0;
  for (const record of store.records) {
    if (!plain(record) || (!exact(record, RECORD_KEYS) && !exact(record, [...RECORD_KEYS, 'safe_context']))) throw Error('state_invalid');
    const safeContext = Object.hasOwn(record, 'safe_context') ? record.safe_context : null;
    if (safeContext !== null && !validSafeContext(safeContext)) throw Error('state_invalid');
    const definition = definitions[record.error_code];
    if (!definition || record.product !== PRODUCT || !validVersion(record.product_version)
      || record.component !== definition.component || record.message_template !== definition.template
      || record.severity !== severityOf(record.error_code, safeContext) || record.fingerprint !== fingerprintOf(record.error_code, safeContext)
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
    // Windowsの一時fileはフォルダの権限を引き継ぐ。置き換えた後の`ensureSafeFile`が確かめる。
    if (!windows()) assertPosix(statSync(temporary), 0o600);
    replaceStoreFile(temporary, path);
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
      // Windowsは、消している最中のlockと同じ名前の作成を`EEXIST`でなく`EPERM`で断る。
      if (!plain(error) || !(error.code === 'EEXIST' || (windows() && ['EPERM', 'EACCES'].includes(error.code)))) throw error;
      let age = 0;
      try {
        age = Date.now() - lstatSync(lockPath).mtimeMs;
      } catch {
        if (Date.now() >= deadline) throw Error('store_locked');
        continue;
      }
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
    runtime_errors: rows.filter((record) => record.status === 'open').map(({ product_version, error_code, component, status, severity, fingerprint, message_template, count, first_seen, last_seen, state_schema_version, safe_context }) => ({ product_version, error_code, component, status, severity, fingerprint, message_template, occurrence_count: count, first_seen, last_seen, state_schema_version, ...(safe_context === undefined ? {} : { safe_context }) })),
    resolutions: rows.filter((record) => record.status === 'resolved').map(({ fingerprint, resolved_at, reason_code }) => ({ fingerprint, resolved_at, reason_code })),
    diagnostics: {
      collection: enabled ? 'enabled' : inactiveCollection(options),
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
    return { schema: DIAGNOSTICS_SCHEMA, collection: inactiveCollection(options), status: 'not_applicable', total_count: 0, open_count: 0, pending_count: 0, high_watermark: 0, acknowledged_through: 0 };
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
  if (!collectionEnabled(options)) return { status: inactiveCollection(options) };
  const definition = definitions[code];
  if (!definition) throw Error('unknown_runtime_code');
  const { path } = optionsFor(options);
  return lock(path, () => {
    const store = readStore(path);
    // 新しい発生は必ず分類つきの記録へ入る。分類を渡さない呼び出しは`other`／`none`で埋める。
    const safeContext = options.safeContext === undefined ? runtimeErrorSafeContext() : options.safeContext;
    if (!validSafeContext(safeContext)) throw Error('invalid_safe_context');
    const key = fingerprintOf(code, safeContext);
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
        message_template: definition.template, severity: severityOf(code, safeContext), fingerprint: key,
        count: 1, first_seen: time, last_seen: time, state_schema_version: STATE_VERSION,
        os, arch, status: 'open', resolved_at: null, reason_code: null, sequence,
        safe_context: { ...safeContext },
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

/**
 * CLIのtyped契約の外へ漏れた例外を記録する（process境界のbinが呼ぶ）。取消は故障ではないので記録しない。
 * 通信の失敗が漏れたものは内部故障と別の記録にし、重大度を面で決める（ADR 0196）。
 */
export function observeEscapedCliFailure({ error, commandKind, ...options }) {
  const failureClass = cliFailureClass(error);
  if (failureClass === 'cancelled') return;
  observeRuntimeError(failureClass === 'transport' ? 'LATTICE.CLI_TRANSPORT_UNHANDLED' : 'LATTICE.CLI_INTERNAL_FAILED',
    { ...options, safeContext: runtimeErrorSafeContext({ commandKind, error }) });
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
