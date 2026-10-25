/**
 * Shared Node.js compatibility policy for CLI and MCP bootstrap.
 * Includes the Node cppgc Realm lifetime repair and the existing Node25 exclusion.
 *
 * Node 25.x has a V8 turboshaft WASM JIT Zone allocator bug that
 * reliably crashes LatticeSensor with `Fatal process out of memory: Zone`
 * during tree-sitter grammar compilation. This module owns the
 * user-facing banner shown before exit. Kept side-effect-free so it's
 * safe to import from tests without triggering CLI bootstrap.
 */

/**
 * Build the bordered banner shown when LatticeSensor detects an
 * unsupported Node.js major version (Node 25.x). Pinned via unit
 * test so the recovery commands and override instructions can't be
 * silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNode25BlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[LatticeSensor] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 25.x has a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when LatticeSensor',
    'compiles tree-sitter grammars. LatticeSensor WILL crash on this Node',
    'version mid-indexing. See https://github.com/kitepon/Lattice/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  LATTICE_SENSOR_ALLOW_UNSAFE_NODE=1 lattice sensor ...',
    sep,
  ].join('\n');
}

/** Node 25.xだけが既知のV8 WASM Zone allocator bugの影響を受ける。 */
export function isNode25Affected(nodeMajor: number): boolean {
  return nodeMajor === 25;
}

/**
 * Lowest supported Node.js major version. Matches the `engines` floor in
 * package.json. Below this, LatticeSensor relies on language features / native APIs
 * that aren't present, and the combination is untested. `engines` alone only
 * *warns* on install (unless the user set `engine-strict`), so the CLI bootstrap
 * also hard-blocks here to actually enforce the floor.
 */
export const MIN_NODE_MAJOR = 20;

/**
 * Build the bordered banner shown when LatticeSensor detects a Node.js major below
 * {@link MIN_NODE_MAJOR}. Pinned via unit test so the recovery commands and the
 * override env var can't be silently stripped by future edits.
 *
 * Uses ASCII glyphs to stay readable on Windows OEM-codepage consoles
 * (see ../ui/glyphs.ts for the rationale).
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[LatticeSensor] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `LatticeSensor requires Node.js ${MIN_NODE_MAJOR} or newer. Older versions lack`,
    'language features and native APIs LatticeSensor depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - unsupported):',
    '  LATTICE_SENSOR_ALLOW_UNSAFE_NODE=1 lattice sensor ...',
    sep,
  ].join('\n');
}

/** Node's cppgc Realm lifetime repair: nodejs/node#65778 (24.x backport#83b3431c). */
export function isNodeRealmLifetimeAffected(nodeVersion: string): boolean {
  const parts = nodeVersion.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  return (major === 24 && minor >= 2 && minor < 22)
    || (major === 26 && minor < 10);
}

export function buildNodeRealmLifetimeBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[LatticeSensor] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'This Node.js release has a cppgc wrapper/Realm lifetime defect.',
    'Worker teardown can write to freed memory and corrupt the native heap.',
    'Upstream repair: https://github.com/nodejs/node/pull/65778',
    '',
    'Fix: use Node.js 24.22.0+ on the 24.x line or 26.10.0+ on the 26.x line.',
    'Supported Node.js 22 LTS is also outside this affected implementation.',
    '',
    'For a custom patched runtime only, the existing override is:',
    '  LATTICE_SENSOR_ALLOW_UNSAFE_NODE=1 lattice sensor ...',
    sep,
  ].join('\n');
}

/** Shared bootstrap policy for the sensor CLI and the packaged MCP entry. */
export function evaluateNodeVersionGuard(nodeVersion: string, overrideActive: boolean): { blocked: boolean; banner: string | null } {
  const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  let banner: string | null = null;
  if (isNode25Affected(nodeMajor)) banner = buildNode25BlockBanner(nodeVersion);
  else if (nodeMajor < MIN_NODE_MAJOR) banner = buildNodeTooOldBanner(nodeVersion);
  else if (isNodeRealmLifetimeAffected(nodeVersion)) banner = buildNodeRealmLifetimeBanner(nodeVersion);
  return { blocked: banner !== null && !overrideActive, banner };
}
