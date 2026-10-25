import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateNodeVersionGuard } from './node-version-guard.mjs';

/**
 * dotagents工場の native factory diagnostics 面（親plan L6要件）。
 *
 * - schema `lattice.native_factory_diagnostics.v1`: exact key・bounded・秘密なしJSON。
 * - read-only: provider・network・run store書込・index生成を一切行わない。
 * - 非0意味論: overall `failed` → exit 1。CLI usage違反は既存contractどおり exit 2。
 * - 本面が健全性の唯一の診断正本（旧`doctor --json`はADR 0052で退役済み）。
 */

const SCHEMA = 'lattice.native_factory_diagnostics.v1';
const PRODUCT = 'lattice';
const MAX_DETAIL_LENGTH = 256;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UNKNOWN_VERSION_SENTINEL = '0.0.0-unknown';
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENGINE_COMPARATOR = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;
const CHECK_IDS = Object.freeze([
  'package_version',
  'node_runtime',
  'cli_surface',
  'mcp_entry',
  'sensor_attribution',
]);

const rootDirDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function check(id, ok, detail) {
  return { id, status: ok ? 'ok' : 'failed', detail: String(detail).slice(0, MAX_DETAIL_LENGTH) };
}

async function isNonEmptyFile(absolutePath) {
  try {
    const stats = await lstat(absolutePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function checkPackageVersion(packageJson) {
  const version = packageJson?.version;
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    return check('package_version', false, 'package.json version is missing or not semver');
  }
  if (version === UNKNOWN_VERSION_SENTINEL) {
    // ADR 0049 Decision 3(c): sentinel versionはビルド破損＝沈黙させない。
    return check('package_version', false, `sentinel version ${UNKNOWN_VERSION_SENTINEL} means a broken build`);
  }
  return check('package_version', true, version);
}

function checkNodeRuntime(nodeVersion, enginesNode) {
  const runtime = NODE_VERSION_PATTERN.exec(nodeVersion ?? '');
  if (!runtime) {
    return check('node_runtime', false, 'node version is unreadable');
  }
  // Lattice declares disjunctions of numeric >= floors and optional < ceilings.
  // Parse the entire declared contract; a floor-only check silently accepts holes.
  const alternatives = typeof enginesNode === 'string' ? enginesNode.split(' || ') : [];
  const ranges = alternatives.map((range) => range.split(' ').map((part) => ENGINE_COMPARATOR.exec(part)));
  if (ranges.length === 0 || ranges.some((range) => range.length < 1 || range.length > 2
    || range.some((part) => part === null) || range[0][1] !== '>='
    || (range.length === 2 && range[1][1] !== '<'))) {
    return check('node_runtime', false, 'package.json engines.node range is unreadable');
  }
  const actual = nodeVersion.slice(1).split(/[.+-]/u).slice(0, 3).map(Number);
  const compare = (bound) => {
    const version = bound.slice(2, 5).map((part) => Number(part ?? 0));
    for (let index = 0; index < 3; index += 1) {
      if (actual[index] !== version[index]) return actual[index] < version[index] ? -1 : 1;
    }
    return 0;
  };
  const satisfied = ranges.some((range) => range.every((bound) =>
    bound[1] === '>=' ? compare(bound) >= 0 : compare(bound) < 0))
    && !evaluateNodeVersionGuard(nodeVersion.slice(1), false).blocked;
  return check(
    'node_runtime',
    satisfied,
    `${nodeVersion} ${satisfied ? 'satisfies' : 'does not satisfy'} engines.node ${enginesNode}`,
  );
}

async function checkCliSurface(rootDir) {
  try {
    const runtimeCli = await import(pathToFileURL(path.join(rootDir, 'src', 'runtime-cli.mjs')).href);
    if (typeof runtimeCli.runRuntimeCli !== 'function') {
      return check('cli_surface', false, 'src/runtime-cli.mjs does not export runRuntimeCli');
    }
    return check('cli_surface', true, 'runtime CLI surface loads and exports runRuntimeCli');
  } catch (error) {
    return check('cli_surface', false, `runtime CLI failed to load: ${error?.constructor?.name ?? 'Error'}`);
  }
}

async function checkMcpEntry(rootDir) {
  const ok = await isNonEmptyFile(path.join(rootDir, 'bin', 'lattice-mcp.mjs'));
  return check('mcp_entry', ok, ok ? 'bin/lattice-mcp.mjs is present' : 'bin/lattice-mcp.mjs is missing or empty');
}

async function checkSensorAttribution(rootDir) {
  // ADR 0047: fork吸収の受入条件＝MIT license noticeとattributionの維持。
  const license = await isNonEmptyFile(path.join(rootDir, 'sensor', 'LICENSE'));
  const notice = await isNonEmptyFile(path.join(rootDir, 'sensor', 'NOTICE'));
  const ok = license && notice;
  return check(
    'sensor_attribution',
    ok,
    ok ? 'sensor/LICENSE and sensor/NOTICE are present' : 'sensor/LICENSE or sensor/NOTICE is missing or empty',
  );
}

/**
 * Builds the bounded, read-only native factory diagnostics object.
 * @param {{ rootDir?: string, nodeVersion?: string }} options
 * @returns {Promise<object>}
 */
export async function buildFactoryDiagnostics({ rootDir = rootDirDefault, nodeVersion = process.version } = {}) {
  let packageJson = null;
  try {
    packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  } catch {
    packageJson = null;
  }

  const checks = [
    checkPackageVersion(packageJson),
    checkNodeRuntime(nodeVersion, packageJson?.engines?.node),
    await checkCliSurface(rootDir),
    await checkMcpEntry(rootDir),
    await checkSensorAttribution(rootDir),
  ];

  const diagnostics = {
    schema: SCHEMA,
    product: PRODUCT,
    version: typeof packageJson?.version === 'string' ? packageJson.version.slice(0, MAX_DETAIL_LENGTH) : UNKNOWN_VERSION_SENTINEL,
    overall: checks.every((entry) => entry.status === 'ok') ? 'ok' : 'failed',
    checks,
  };

  if (!validateFactoryDiagnostics(diagnostics)) {
    throw new TypeError('invalid factory diagnostics output');
  }

  return diagnostics;
}

/**
 * Strictly validates the public native factory diagnostics schema.
 * @param {unknown} value
 * @returns {boolean}
 */
export function validateFactoryDiagnostics(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, ['schema', 'product', 'version', 'overall', 'checks'])) {
    return false;
  }
  if (value.schema !== SCHEMA || value.product !== PRODUCT) {
    return false;
  }
  if (typeof value.version !== 'string' || value.version.length === 0 || value.version.length > MAX_DETAIL_LENGTH) {
    return false;
  }
  if (value.overall !== 'ok' && value.overall !== 'failed') {
    return false;
  }
  if (!Array.isArray(value.checks) || value.checks.length !== CHECK_IDS.length) {
    return false;
  }
  const allOk = value.checks.every((entry) => isPlainObject(entry)
    && hasExactKeys(entry, ['id', 'status', 'detail'])
    && (entry.status === 'ok' || entry.status === 'failed')
    && typeof entry.detail === 'string'
    && entry.detail.length <= MAX_DETAIL_LENGTH);
  if (!allOk) {
    return false;
  }
  const ids = value.checks.map((entry) => entry.id);
  if (ids.some((id, index) => id !== CHECK_IDS[index])) {
    return false;
  }
  const expectedOverall = value.checks.every((entry) => entry.status === 'ok') ? 'ok' : 'failed';
  return value.overall === expectedOverall;
}
