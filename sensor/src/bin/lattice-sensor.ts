#!/usr/bin/env node
/**
 * LatticeSensor CLI
 *
 * Command-line interface for LatticeSensor code intelligence.
 *
 * Usage:
 *   lattice sensor                    Refuse: no standalone installer
 *   lattice sensor install            Refuse: host wiring is owned by dotagents
 *   lattice sensor uninstall          Refuse: retirement is owned by dotagents
 *   lattice sensor init [path]        Initialize LatticeSensor in a project
 *   lattice sensor uninit [path]      Remove LatticeSensor from a project
 *   lattice sensor index [path]       Index all files in the project
 *   lattice sensor sync [path]        Sync changes since last index
 *   lattice sensor status [path]      Show index status
 *   lattice sensor query <search>     Search for symbols
 *   lattice sensor files [options]    Show project file structure
 *   lattice sensor context <task>     Build context for a task
 *   lattice sensor callers <symbol>   Find what calls a function/method
 *   lattice sensor callees <symbol>   Find what a function/method calls
 *   lattice sensor impact <symbol>    Analyze what code is affected by changing a symbol
 *   lattice sensor affected [files]   Find test files affected by changes
 *   lattice sensor upgrade [version]  Update LatticeSensor to the latest release
 */

// FIRST import, before anything else loads: capture process.ppid while our
// launcher is (almost certainly) still alive. A launcher killed mid-startup
// otherwise blinds the PPID watchdog forever (#1185) — see early-ppid.ts.
import '../mcp/early-ppid';

// The browser viewer is not part of a release yet (see viewer-gate). Refuse
// `ui` / `web` — also as `help ui` or `ui --help` — before any startup work,
// unless LATTICE_SENSOR_UI=1 opts in.
import { requestedViewerCommand, viewerEnabled } from './viewer-gate';
{
  const viewerCommand = requestedViewerCommand(process.argv.slice(2));
  if (viewerCommand && !viewerEnabled()) {
    process.stderr.write(`error: 'lattice sensor ${viewerCommand}' is not in this release yet. The browser viewer is coming in an upcoming release.\n`);
    process.exit(1);
  }
}

// Persist V8 compile artifacts across runs (Node ≥22.8). Every invocation —
// and every worker thread, which re-requires the whole extraction module
// graph — skips recompiling unchanged sources. Worth hundreds of ms of
// worker-boot latency per bulk index; harmless no-op when unavailable.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch { /* cache is best-effort */ }

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getLatticeSensorDir, isInitialized, hasSchemalessDb, hasForeignDbFile, unsafeIndexRootReason, findNearestLatticeSensorRoot, planFrontload, isTaskNotification, hasStructuralKeyword, extractCodeTokens, capPromptHookInjection, latticeSensorRelativeDir, DEFAULT_LATTICE_SENSOR_DIR } from '../directory';
import { extractProseCandidates } from '../search/identifier-segments';
import { isRunnableTestFile } from '../search/query-utils';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';
import { ansiColorsEnabled } from '../ui/color';

import { buildNode25BlockBanner, buildNodeTooOldBanner, isNode25Affected, MIN_NODE_MAJOR } from './node-version-check';
import { installFatalHandlers } from './fatal-handler';
import { relaunchWithWasmRuntimeFlagsIfNeeded } from '../extraction/wasm-runtime-flags';
import { installCommandSupervision } from './command-supervision';
import { selectExactTraversalCandidate } from './exact-traversal';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { getTelemetry, TELEMETRY_DOCS, recordIndexEvent } from '../telemetry';
// Value import, but dependency-free by design so `--help` text can name the
// default port without dragging node:http into every other subcommand; the
// server itself is loaded lazily inside the `ui` action. See ui-server/constants.
import { BROWSER_ENV, DEFAULT_UI_PORT } from '../ui-server/constants';
import type { UiServerHandle } from '../ui-server';
import { lookupSymbolNodes, describeSymbolNode, groupDefinitions } from '../graph/symbol-lookup';
import type { Node, Edge } from '../types';

// Decided once, before `--color`/`--no-color` are stripped from argv below
// (#1281). Piped/redirected stdout, NO_COLOR, or --no-color -> plain output.
const COLORS_ENABLED = ansiColorsEnabled();

// Lazy-load heavy modules (LatticeSensor, runInstaller) to keep CLI startup fast.
async function loadLatticeSensor(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const [red, reset] = COLORS_ENABLED ? ['\x1b[31m', '\x1b[0m'] : ['', ''];
    console.error(`${red}${getGlyphs().err}${reset} Failed to load LatticeSensor modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Reinstall the owning package with: npm install -g @quolu/lattice@latest\n');
    process.exit(1);
  }
}

// Dynamic import helper — tsc compiles import() to require() in CJS mode,
// which fails for ESM-only packages. This bypasses the transformation.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// Block LatticeSensor on Node.js 25.x — V8's turboshaft WASM JIT has a Zone
// allocator bug that reliably crashes when compiling tree-sitter
// grammars (see #54, #81, #140). The previous behaviour was a soft
// console.warn that scrolls off-screen before the OOM crash 30 seconds
// later, leading to a steady stream of "what is this OOM" reports.
// Hard-exit before any WASM work; allow override via env var for users
// who patched V8 themselves or want to test a future fix.
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (isNode25Affected(nodeMajor)) {
  process.stderr.write(buildNode25BlockBanner(nodeVersion) + '\n');
  if (!process.env.LATTICE_SENSOR_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}
// Enforce the supported Node floor. `engines` in package.json only *warns* on
// install (unless engine-strict), so hard-block here to actually keep users off
// unsupported versions. Mirrors the Node 25 block above. See package.json `engines`.
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  if (!process.env.LATTICE_SENSOR_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // Override active — banner shown for visibility, continuing.
}

// Re-exec with V8's `--liftoff-only` if it isn't already set, so tree-sitter's
// large WASM grammars never hit the turboshaft Zone OOM (`Fatal process out of
// memory: Zone`) on Node >= 22. No-op under the bundled launcher, which already
// passes the flag. Must run before any grammar (in the parse worker, which
// inherits this process's flags) is compiled. See ../extraction/wasm-runtime-flags.
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// Last-resort fatal handlers: log a bounded line and exit non-zero. A fault
// that reaches here escaped every boundary, so the process is in an undefined
// state — keeping it alive is what let the detached MCP daemon orphan and pin a
// CPU core with no recovery (#799, #850). Installed before the command branch
// so it also covers a synchronous throw during startup. See ./fatal-handler.
installFatalHandlers();

// The absorbed sensor has no standalone installer. Lattice owns host wiring.
if (process.argv.length === 2) {
  console.error('Lattice sensor requires an explicit command. Use `lattice sensor init|sync [path] --json`.');
  process.exit(2);
} else {
  // Normal CLI flow
  main();
}

function main() {

const program = new Command();

// Version from package.json
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// Make the version trivial to reach. commander's `.version()` (below) wires up
// `--version` and `-V`; intercept the spellings it can't — lowercase `-v` and
// single-dash `-version` — before any parsing. (commander's version short flag
// is the capital `-V`, and its parser rejects a multi-character single-dash
// flag.) The bare `lattice sensor version` subcommand is registered further down so
// the affordance also shows up in `lattice sensor --help`.
const firstArg = process.argv[2];
if (firstArg === '-v' || firstArg === '-version') {
  console.log(packageJson.version);
  return;
}

// =============================================================================
// ANSI Color Helpers (avoid chalk ESM issues)
// =============================================================================

// `--color` / `--no-color` are global and position-independent — they were
// already read by ansiColorsEnabled() at module load, so strip them before
// commander parses (a subcommand would otherwise reject the unknown flag).
process.argv = process.argv.filter((a) => a !== '--color' && a !== '--no-color');

const colors = COLORS_ENABLED
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      gray: '\x1b[90m',
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      red: '',
      green: '',
      yellow: '',
      blue: '',
      cyan: '',
      white: '',
      gray: '',
    };

const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('lattice-sensor')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version)
  // Parsed manually before commander runs (any argv position works); declared
  // here so they show up in --help. NO_COLOR / FORCE_COLOR env vars are also
  // honored, and piped output defaults to no color (#1281).
  .option('--color', 'force ANSI colors even when stdout is not a TTY')
  .option('--no-color', 'disable ANSI colors (NO_COLOR env is also honored)');

// Anonymous usage telemetry (see TELEMETRY.md): record the invoked subcommand
// NAME only — never arguments or paths. Counts buffer locally; network sends
// piggyback on commands that run long anyway (quick commands only append to
// the local buffer at exit, costing nothing).
// install/uninstall are absent on purpose: the installer flushes at its own
// end, AFTER its consent prompt — a flush here would fire the first-run
// notice before the user ever sees the toggle.
const TELEMETRY_FLUSH_COMMANDS = new Set(['init', 'uninit', 'index', 'sync', 'upgrade']);
program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    // The detached daemon re-invokes `serve --mcp` internally — not a user action.
    if (process.env.LATTICE_SENSOR_DAEMON_INTERNAL) return;
    const name = actionCommand.name();
    if (name === 'telemetry') return; // managing telemetry is not usage
    getTelemetry().recordUsage('cli_command', name, true);
    if (TELEMETRY_FLUSH_COMMANDS.has(name)) getTelemetry().maybeFlush();
  } catch {
    /* telemetry must never break the CLI */
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve project path from argument or current directory
 * Walks up parent directories to find nearest initialized LatticeSensor project
 * (must have .lattice/sensor/sensor.db, not just .lattice/sensor/lessons.db)
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // If exact path is initialized (has sensor.db), use it
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // Walk up to find nearest parent with LatticeSensor initialized
  // Note: findNearestLatticeSensorRoot finds any .lattice/sensor folder, but we need one with sensor.db
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // Not found - return original path (will fail later with helpful error)
  return absolutePath;
}

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

// Shimmer progress renderer (runs in a worker thread for smooth animation)
// Imported at top of file from '../ui/shimmer-progress'

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // Log every 5% to keep output manageable
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

/**
 * Print success message
 */
function success(message: string): void {
  console.log(chalk.green(getGlyphs().ok) + ' ' + message);
}

/**
 * Print error message
 */
function error(message: string): void {
  console.error(chalk.red(getGlyphs().err) + ' ' + message);
}

/**
 * Print info message
 */
function info(message: string): void {
  console.log(chalk.blue(getGlyphs().info) + ' ' + message);
}

/**
 * Print warning message
 */
function warn(message: string): void {
  console.log(chalk.yellow(getGlyphs().warn) + ' ' + message);
}

/** "not found" (+ optional did-you-mean) when no exact symbol matches. */
function formatSymbolNotFound(symbol: string, fuzzyNames: string[]): string {
  const suggestions = [...new Set(fuzzyNames.filter((n) => n !== symbol))].slice(0, 3);
  if (suggestions.length === 0) return `Symbol "${symbol}" not found`;
  return `Symbol "${symbol}" not found — did you mean: ${suggestions.join(', ')}?`;
}

/** Compact node shape retained by the CLI's existing JSON lists. */
function cliNode(node: Node) {
  return { name: node.name, kind: node.kind, filePath: node.filePath, startLine: node.startLine };
}

/** Attribute a group's edges to every overload of this definition. */
function cliDefinition(group: Node[]) {
  const head = group[0]!;
  return {
    definition: { ...cliNode(head), id: head.id, qualifiedName: head.qualifiedName, language: head.language },
    roots: group.map((node) => node.id),
  };
}

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
  filesSkippedUnsupported?: number;
  topUnsupportedExtensions?: { ext: string; count: number }[];
};

/**
 * Print indexing results using clack log methods
 */
function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;
  const parseWarnings = result.errors.filter((e) => e.code === 'parse_error' && e.severity === 'warning');

  // Surface non-file-level failures (e.g. lock-acquisition failure
  // when another indexer is running) before the file-count branches.
  // Without this the CLI falls through to "No files found to index",
  // which is actively misleading — the index DID run, it just couldn't
  // get the lock.
  //
  // If success is false but no severity:'error' entry exists in
  // `result.errors` (degenerate case — shouldn't happen in practice
  // but worth guarding because the result shape is plumbed through
  // multiple call sites), fall back to a generic message rather than
  // continuing to the misleading "No files found" branch or throwing.
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
    // Warning-only parse failures keep indexing successful, but must be visible.
    for (const warning of parseWarnings) {
      clack.log.warn(warning.message);
    }
    // A PARTIAL index (files silently dropped mid-pipeline) must not pass
    // as a clean run — it's the difference between "indexed the repo" and
    // "indexed most of the repo, quietly". Only the completeness
    // reconciliation warning; per-file extractor warnings stay in the
    // error-code summary below.
    for (const w of result.errors.filter((e) => e.code === 'index_partial')) {
      clack.log.warn(w.message);
    }
    // Files salvaged from comment-stripped source after repeated parser
    // failures are indexed but possibly incomplete — say so here, or the run
    // reads as fully clean and the index quietly disagrees with a later
    // re-parse of the same bytes (#1565).
    const salvaged = result.errors.filter((e) => e.code === 'salvaged_stripped');
    if (salvaged.length > 0) {
      const sample = salvaged.slice(0, 3).map((e) => e.filePath).filter(Boolean).join(', ');
      const more = salvaged.length > 3 ? ', ...' : '';
      clack.log.warn(`${formatNumber(salvaged.length)} file(s) indexed from comment-stripped source after repeated parse failures ${getGlyphs().dash} symbols may be incomplete (${sample}${more})`);
    }
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else if (result.filesSkippedUnsupported) {
    // A project LatticeSensor has no grammar for used to be indistinguishable from
    // an empty one: same message, same `complete` state, same exit 0. Say which
    // files were there and that the graph is empty on purpose, so nobody — and
    // no agent trusting the graph — reads silence as "this code doesn't exist"
    // (#1502).
    const top = (result.topUnsupportedExtensions ?? [])
      .map(e => `${e.ext} (${formatNumber(e.count)})`)
      .join(', ');
    clack.log.warn(
      `No supported source files found ${getGlyphs().dash} ${formatNumber(result.filesSkippedUnsupported)} file(s) present, none in a language LatticeSensor indexes`
      + (top ? `: ${top}` : '')
    );
    clack.log.info('LatticeSensor is inactive for this workspace — searches will return nothing. Use your own file tools here.');
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .lattice/sensor/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    // No hard errors. Salvaged-file warnings still belong in the log — it
    // carries the per-file detail behind the one-line summary above.
    if (result.errors.some((e) => e.code === 'salvaged_stripped')) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .lattice/sensor/errors.log for details');
    } else {
      const logPath = path.join(getLatticeSensorDir(projectPath), 'errors.log');
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    }
  }
}

/**
 * When an `init`/`index` produced an EMPTY graph and the reason is that the
 * project's own `.gitignore` excludes nested git repositories — the "super-repo
 * gitignores its child repos" layout (#1156), where `init` at the parent
 * correctly indexes ~nothing while `init` inside each child works — name those
 * repos and offer to index them. An interactive terminal gets a yes/no prompt
 * that writes `includeIgnored` to lattice-sensor.json and re-indexes; a
 * non-interactive run just prints the one-line opt-in snippet. The caller gates
 * this on `nodesCreated === 0`, so a project that DID index real content is
 * never nagged about the gitignored reference clones it deliberately keeps out
 * (#970, #1065). Best-effort throughout: detection never breaks the command.
 */
async function offerIndexIgnoredRepos(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  reindex: () => Promise<IndexResult>,
  opts: { interactive: boolean },
): Promise<IndexResult | undefined> {
  let repos: string[];
  try {
    const { findUnindexedIgnoredRepos } = await import('../extraction');
    repos = findUnindexedIgnoredRepos(projectPath);
  } catch {
    return; // detection is advisory — never let it break the command
  }
  if (repos.length === 0) return;

  const { PROJECT_CONFIG_FILENAME } = await import('../project-config');
  const isOne = repos.length === 1;
  const SHOWN = 6;
  const names = repos.slice(0, SHOWN).map((r) => r.replace(/\/$/, ''));
  const extra = repos.length > SHOWN ? ` (+${formatNumber(repos.length - SHOWN)} more)` : '';
  const snippet = `{ "includeIgnored": [${repos.map((p) => JSON.stringify(p)).join(', ')}] }`;

  clack.log.warn(
    `Your .gitignore excludes ${isOne ? 'a nested git repository' : `${formatNumber(repos.length)} nested git repositories`} here, ` +
    `so ${isOne ? 'it was' : 'they were'} not indexed: ${names.join(', ')}${extra}.`,
  );

  const manualHint = () => {
    clack.log.info(
      `If ${isOne ? "it's" : "they're"} your code, add ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME} and re-index:`,
    );
    clack.log.info(`  ${snippet}`);
  };

  if (!opts.interactive || !process.stdin.isTTY) {
    manualHint();
    return;
  }

  const yes = await clack.confirm({
    message: `Index ${isOne ? 'it' : `these ${formatNumber(repos.length)}`} now? Adds ${isOne ? 'it' : 'them'} to ${PROJECT_CONFIG_FILENAME}.`,
    initialValue: true,
  });
  if (clack.isCancel(yes) || !yes) {
    manualHint();
    return;
  }

  let added: number;
  try {
    const { addIncludeIgnoredPatterns } = await import('../project-config');
    added = addIncludeIgnoredPatterns(projectPath, repos);
  } catch (err) {
    clack.log.error(`Could not update ${PROJECT_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
    manualHint();
    return;
  }
  clack.log.success(`Added ${formatNumber(added)} ${added === 1 ? 'entry' : 'entries'} to ${PROJECT_CONFIG_FILENAME} ${getGlyphs().dash} re-indexing…`);

  const result = await reindex();
  printIndexResult(clack, result, projectPath);
  return result;
}

/**
 * Write detailed error log to .lattice/sensor/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = getLatticeSensorDir(projectPath);
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // Group errors by file path
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `LatticeSensor Error Log - ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

/**
 * Telemetry for a completed full index (see TELEMETRY.md). The bounded flush
 * keeps init/index responsive (these commands just ran for seconds anyway)
 * while delivering the event promptly.
 */
async function recordIndexTelemetry(
  cg: { getStats(): { filesByLanguage: Record<string, number> }; getBackend(): string },
  result: IndexResult,
): Promise<void> {
  recordIndexEvent(cg, result);
  await getTelemetry().flushNow();
}

// =============================================================================
// Commands
// =============================================================================

/**
 * The `init` flow — shared by `lattice sensor init` and `lattice sensor install --init`
 * (#1578): refuse an unsafe root, create `.lattice/sensor/`, build the initial
 * index under supervision, then the post-index offers. `yes` makes every
 * offer non-interactive (defaults only), so a container / CI bootstrap never
 * blocks on a prompt. An unsafe root sets `process.exitCode = 1` and returns
 * (no `--force` is implied by any caller); an index failure exits 1.
 */
async function runInit(
  projectPath: string,
  options: { index?: boolean; force?: boolean; verbose?: boolean; yes?: boolean },
): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro('Initializing LatticeSensor');

  try {
    // Refuse to index your home directory / a filesystem root — it pulls in
    // caches, other projects, and your whole tree (a multi-GB index + watcher
    // churn, and on pre-1.0 macOS a machine-crashing fd blowup, #845).
    const unsafe = unsafeIndexRootReason(projectPath);
    if (unsafe && !options.force) {
      clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
      clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
      clack.outro('');
      process.exitCode = 1;
      return;
    }

    if (isInitialized(projectPath)) {
      clack.log.warn(`Already initialized in ${projectPath}`);
      clack.log.info('Use "lattice sensor init" to re-index or "lattice sensor sync" to update');
      clack.outro('');
      return;
    }

    if (hasForeignDbFile(projectPath)) {
      const dbFile = path.join(getLatticeSensorDir(projectPath), 'sensor.db');
      clack.log.error(`${dbFile} is not a SQLite database, so it cannot be rebuilt in place.`);
      clack.log.info('Move or delete that file, then run "lattice sensor init" again.');
      clack.outro('');
      process.exitCode = 1;
      return;
    }
    if (hasSchemalessDb(projectPath)) {
      clack.log.warn(`Found a sensor.db without the lattice sensor schema in ${getLatticeSensorDir(projectPath)} (left by an interrupted init?) — rebuilding it.`);
    }
    const { default: LatticeSensor, getDatabasePath } = await loadLatticeSensor();
    const cg = await LatticeSensor.init(projectPath, { index: false });
    clack.log.success(`Initialized in ${projectPath}`);
    // A fresh index on a Windows drive under WSL gets its own directory (#995).
    // It isn't the documented name, so say where it went and why.
    const dataDir = path.basename(getLatticeSensorDir(projectPath));
    if (dataDir !== latticeSensorRelativeDir()) {
      clack.log.info(
        `The index is in ${dataDir}/: this project is on a Windows drive, so WSL keeps its own index ` +
        `rather than share ${DEFAULT_LATTICE_SENSOR_DIR}/ with LatticeSensor on Windows. Set LATTICE_SENSOR_DIR to choose the name yourself.`
      );
    }

    // Indexing runs by default now. The legacy -i/--index flag is still
    // accepted (so existing muscle memory and scripts don't break) but is a
    // no-op — initializing always builds the initial index.
    // Supervise the index: self-terminate if orphaned or wedged (#999).
    // The DB + WAL paths let the liveness watchdog tell a slow store on
    // degraded storage from a true wedge (#1231).
    // A closure so we can re-run the exact same supervised, progress-rendered
    // index if the user opts gitignored child repos in below (#1156).
    const dbPath = getDatabasePath(projectPath);
    const runIndex = async (): Promise<IndexResult> => {
      const supervision = installCommandSupervision('init', { progressPaths: [dbPath, `${dbPath}-wal`] });
      try {
        if (options.verbose) {
          return await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
        }
        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();
        const r = await cg.indexAll({ onProgress: progress.onProgress });
        await progress.stop();
        return r;
      } finally {
        supervision.stop();
      }
    };
    const result = await runIndex();
    printIndexResult(clack, result, projectPath);
    await recordIndexTelemetry(cg, result);

    // An empty graph at a git super-repo usually means `.gitignore` excludes
    // the child repos that hold the code — surface them and offer to opt in
    // rather than leaving the user with a silent 0-node "Done". (#1156)
    // Under --yes the offer prints its one-line opt-in snippet instead of
    // prompting (same as a non-TTY run).
    if (result.nodesCreated === 0) {
      await offerIndexIgnoredRepos(clack, projectPath, runIndex, { interactive: !options.yes });
    }

    clack.outro('Done');
    cg.destroy();
  } catch (err) {
    clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * lattice sensor init [path]
 */
program
  .command('init [path]')
  .description('Initialize LatticeSensor in a project directory and build the initial index')
  .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
  .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .option('-y, --yes', 'Non-interactive: skip every prompt and take the defaults (for scripts / CI / container bootstraps)')
  .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean; yes?: boolean }) => {
    await runInit(path.resolve(pathArg || process.cwd()), options);
  });

/**
 * lattice sensor uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove LatticeSensor from a project (deletes .lattice/sensor/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        warn(`LatticeSensor is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // Confirm with user
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all LatticeSensor data. Continue? (y/N) `),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = LatticeSensor.openSync(projectPath);
      cg.uninitialize();

      // Clean up any git sync hooks we installed (no-op if none / not a repo).
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* non-fatal */ }

      success(`Removed LatticeSensor from ${projectPath}`);

      // Churn signal — and flush now, since after an uninit there may be no
      // "next run" to deliver it.
      try {
        getTelemetry().recordLifecycle('uninstall', {});
        await getTelemetry().flushNow();
      } catch { /* non-fatal */ }
    } catch (err) {
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor index [path]
 */
program
  .command('index [path]')
  .description('Rebuild the full index from scratch (same result as a fresh init)')
  .option('-f, --force', 'Index even if the path looks like your home directory or a filesystem root')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    // An EXPLICIT path names the project to rebuild — it is never a hint to go
    // looking for one. resolveProjectPath walks up to the nearest initialized
    // ancestor, which is right for `lattice sensor query` run from a subdirectory,
    // but for a full re-index it silently rebuilt the parent's graph under a
    // normal "Done" when <path> had no index of its own (#1524). Only a bare
    // `lattice sensor index` (cwd) may resolve upward.
    const projectPath = pathArg ? path.resolve(pathArg) : resolveProjectPath();

    try {
      // Don't (re)index your home directory / a filesystem root (#845). --force
      // doubles as the override.
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        error(`Refusing to index ${projectPath} — it looks like ${unsafe}. Pass --force to override.`);
        process.exit(1);
      }

      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        const ancestor = pathArg ? resolveProjectPath(pathArg) : projectPath;
        if (ancestor !== projectPath) {
          info(`The nearest initialized project is ${ancestor} — pass that path to rebuild it, or run "lattice sensor init" in ${projectPath} to index it on its own.`);
        } else {
          info('Run "lattice sensor init" first');
        }
        process.exit(1);
      }

      const { tryAcquireWriterLock, releaseWriterLock, writerLockHeldMessage } = await import('../mcp/writer-lock');
      const rebuild = tryAcquireWriterLock(projectPath, 'rebuild', 'rebuild.pid');
      if (rebuild.kind === 'taken') throw new Error('Another index rebuild is already in progress.');
      try {
        // A live MCP daemon keeps SQLite handles open. Verify it by its socket
        // before stopping it so a stale pidfile can never signal another process.
        const { stopDaemonAt } = await import('../mcp/daemon-registry');
        const daemonStop = await stopDaemonAt(fs.realpathSync(projectPath), { preserveUnverified: true });
        if (daemonStop.outcome === 'unverified' || daemonStop.outcome === 'still-running') {
          throw new Error('Could not verify that the active LatticeSensor daemon has stopped. Run `lattice sensor daemon stop` to stop it, then retry `lattice sensor index`.');
        }

        // Keep the writer slot through recreation AND indexing. A reconnecting
        // proxy/daemon must not open the replacement database halfway through.
        const writer = tryAcquireWriterLock(projectPath, 'rebuild');
        if (writer.kind === 'taken') throw new Error(writerLockHeldMessage(writer.existing, writer.pidPath));
        try {
          const { default: LatticeSensor, getDatabasePath } = await loadLatticeSensor();
          // `index` is a FULL re-index — identical to a fresh `init`. RECREATE the
          // database from scratch (discard .lattice/sensor/sensor.db + its WAL) rather
          // than opening the old graph and DELETE-ing every row. The clear-then-index
          // approach reported "0 nodes" without the clear (#874); the recreate keeps
          // that fixed AND avoids the failure mode where, on a large or pre-fix
          // poisoned index, the per-row FTS delete churn wedged the main thread long
          // enough to trip the liveness watchdog before scanning even began (#1067).
          // recreate() hands back a fresh, empty instance — no clear() needed. For
          // fast incremental updates use `sync`.
          const cg = await LatticeSensor.recreate(projectPath);

          // Supervise the indexer: self-terminate if orphaned (parent shim killed)
          // or if the main thread wedges — neither was guarded on this path (#999).
          // The DB + WAL paths let the liveness watchdog tell a slow store on
          // degraded storage from a true wedge (#1231).
          const dbPath = getDatabasePath(projectPath);
          const supervision = installCommandSupervision('index', { progressPaths: [dbPath, `${dbPath}-wal`] });
          try {
            if (options.quiet) {
              // Quiet mode: no UI, just run against the freshly-recreated graph.
              const result = await cg.indexAll();
              if (!result.success) process.exit(1);
              return;
            }

            const clack = await importESM('@clack/prompts');
            clack.intro('Indexing project');

            // A closure so a re-index (after opting gitignored child repos in, #1156)
            // renders identically. Supervision already wraps the whole command.
            const renderIndex = async (): Promise<IndexResult> => {
              if (options.verbose) {
                return await cg.indexAll({ onProgress: createVerboseProgress(), verbose: true });
              }
              process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
              const progress = createShimmerProgress();
              const r = await cg.indexAll({ onProgress: progress.onProgress });
              await progress.stop();
              return r;
            };

            const result = await renderIndex();

            printIndexResult(clack, result, projectPath);
            await recordIndexTelemetry(cg, result);

            // Empty graph at a git super-repo → likely `.gitignore`d child repos;
            // name them and offer to opt in instead of a silent 0-node result (#1156).
            let finalResult = result;
            if (result.nodesCreated === 0) {
              finalResult = (await offerIndexIgnoredRepos(clack, projectPath, renderIndex, { interactive: true })) ?? result;
            }

            if (!finalResult.success) {
              process.exit(1);
            }

            clack.outro('Done');
          } finally {
            supervision.stop();
            cg.destroy();
          }
        } finally {
          releaseWriterLock(projectPath);
        }
      } finally {
        releaseWriterLock(projectPath, 'rebuild.pid');
      }
    } catch (err) {
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`LatticeSensor not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);

      try {
        if (options.quiet) {
          await cg.sync();
          return;
        }

        const clack = await importESM('@clack/prompts');
        clack.intro('Syncing LatticeSensor');

        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();

        const result = await cg.sync({
          onProgress: progress.onProgress,
        }).finally(() => progress.stop());

        const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

        if (totalChanges === 0 && !result.pendingRefsProcessed) {
          clack.log.info('Already up to date');
        } else if (totalChanges > 0) {
          clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
          const details: string[] = [];
          if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
          if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
          if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
          clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
        }

        if (result.pendingRefsProcessed) {
          const unresolved = result.pendingRefsUnresolved
            ? ` (${formatNumber(result.pendingRefsUnresolved)} unresolved)` : '';
          clack.log.info(`Resolved ${formatNumber(result.pendingRefsResolved ?? 0)} pending references${unresolved}`);
        }

        clack.outro('Done');
      } finally {
        cg.destroy();
      }
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * lattice sensor status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);
    // The directory the user actually ran from, before walking up to the index
    // root. Used to detect when the resolved index lives in a different git
    // working tree (e.g. a nested worktree borrowing the main checkout's index).
    const startPath = path.resolve(pathArg || process.cwd());
    const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

    try {
      if (!isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify({
            initialized: false,
            version: packageJson.version,
            projectPath,
            indexPath: getLatticeSensorDir(projectPath),
            lastIndexed: null,
          }));
          return;
        }
        console.log(chalk.bold('\nLatticeSensor Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "lattice sensor init" to initialize');
        return;
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();
      const journalMode = cg.getJournalMode();

      const buildInfo = cg.getIndexBuildInfo();
      const reindexRecommended = cg.isIndexStale();
      // Non-zero means THIS process is older than the index it is attached to.
      const engineBehindIndexFiles = cg.getEngineBehindIndexFileCount();
      const indexState = cg.getIndexState();
      // Zero on a healthy index; non-zero at rest means a resolution pass was
      // interrupted, so some files' call edges are missing (#1187).
      const pendingRefs = cg.getPendingReferenceCount();

      // JSON output mode
      if (options.json) {
        const lastIndexedMs = cg.getLastIndexedAt();
        console.log(JSON.stringify({
          initialized: true,
          version: packageJson.version,
          projectPath,
          indexPath: getLatticeSensorDir(projectPath),
          lastIndexed: lastIndexedMs != null ? new Date(lastIndexedMs).toISOString() : null,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          walSizeBytes: stats.walSizeBytes,
          backend,
          journalMode,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
          worktreeMismatch: worktreeMismatch
            ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
            : null,
          index: {
            builtWithVersion: buildInfo.version,
            builtWithExtractionVersion: buildInfo.extractionVersion,
            currentExtractionVersion: EXTRACTION_VERSION,
            reindexRecommended,
            // Files written by a NEWER extractor than this process. Non-zero
            // means this process is behind the index; it leaves those rows
            // alone rather than downgrading them, so the gap persists until
            // the older process is restarted on the current build.
            engineBehindIndexFiles,
            // 'complete' | 'partial' (files silently dropped) | 'indexing'
            // (a run was killed mid-index — the index is truncated) |
            // 'failed' | null (predates the marker).
            state: indexState,
            // References awaiting resolution. Non-zero at rest means an
            // interrupted resolution pass left edges missing; the next
            // sync sweeps them (#1187).
            pendingRefs,
          },
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nLatticeSensor Status\n'));

      // Project info
      console.log(chalk.cyan('Project:'), projectPath);
      if (worktreeMismatch) {
        warn(worktreeMismatchWarning(worktreeMismatch));
      }
      if (indexState === 'indexing') {
        warn('The last index run never finished (killed mid-index?) — the index is truncated. Re-run "lattice sensor index".');
      } else if (indexState === 'partial') {
        warn('The last index run silently dropped files — the index is partial. Re-run "lattice sensor index".');
      } else if (indexState === 'failed') {
        warn('The last index run failed — results may be incomplete. Re-run "lattice sensor index".');
      }
      if (pendingRefs > 0) {
        warn(`${formatNumber(pendingRefs)} references from an interrupted run are awaiting resolution — some callers/impact edges are missing. Run "lattice sensor sync" to resolve them.`);
      }
      console.log();

      // Index stats
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // Surface the WAL sidecar (#1431): a WAL that dwarfs the DB at rest is
      // the killed-session leak — invisible before this line, it only showed
      // up as a mysteriously full disk. open() above already kicked off the
      // automatic heal for the oversized case.
      if (stats.walSizeBytes > 0) {
        const { WAL_HEAL_THRESHOLD_BYTES } = await import('../db/index');
        const oversized = stats.walSizeBytes > Math.max(WAL_HEAL_THRESHOLD_BYTES, stats.dbSizeBytes);
        const walLabel = `${(stats.walSizeBytes / 1024 / 1024).toFixed(2)} MB`;
        console.log(`  WAL Size:  ${oversized ? chalk.yellow(walLabel) : walLabel}`);
        if (oversized) {
          warn('The write-ahead log is larger than the database — killed sessions left it behind. It is reclaimed automatically on open; if it persists across runs, another live LatticeSensor process is holding it.');
        }
      }
      // Surface the active SQLite backend (node:sqlite — Node's built-in real
      // SQLite, full WAL + FTS5, no native build).
      const backendLabel = chalk.green(`node:sqlite ${getGlyphs().dash} built-in (full WAL)`);
      console.log(`  Backend:   ${backendLabel}`);
      // Effective journal mode: 'wal' means concurrent reads never block on a
      // writer; anything else means they can ("database is locked"). node:sqlite
      // supports WAL everywhere, so a non-wal mode means the filesystem can't
      // (network mounts, WSL2 /mnt). See issue #238.
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
      console.log();

      // Node breakdown
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Language breakdown
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // Pending changes
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "lattice sensor sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      // Re-index hint: the index was built by an older engine than the one now
      // running, so a rebuild would add data a migration can't backfill.
      if (reindexRecommended) {
        const builtWith = buildInfo.version ? `v${buildInfo.version.replace(/^v/, '')}` : 'an earlier version';
        warn(`Index was built by ${builtWith}; re-index to pick up this engine's improvements.`);
        info('Run "lattice sensor index" (full rebuild) or "lattice sensor sync"');
        console.log();
      }

      // The opposite direction, and the one that used to be invisible: this
      // process is older than the index. Those rows are left untouched on
      // purpose, so nothing converges until the stale process is restarted.
      if (engineBehindIndexFiles > 0) {
        warn(`${engineBehindIndexFiles} file(s) were indexed by a NEWER extractor than this process`
          + ` (running extraction v${EXTRACTION_VERSION}).`);
        info('This process is behind the index and will not rewrite those rows.'
          + ' Restart any long-running sensor process on the current build.');
        console.log();
      }

      cg.destroy();
    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);

      const limit = parseInt(options.limit || '10', 10);
      const rawResults = cg.searchNodes(search, {
        // Fetch one extra row so the CLI can report a cut without changing the
        // long-standing bare-array contract of `query --json` (#1639).
        limit: limit + 1,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      // Mirror the MCP search down-rank so the CLI also surfaces the
      // hand-written implementation before protobuf/gRPC scaffolding
      // when both share a name. See extraction/generated-detection.ts.
      const isGen = cg.generatedFilePredicate(rawResults.map((r) => r.node.filePath));
      const rankedResults = [...rawResults].sort((a, b) => {
        const aGen = isGen(a.node.filePath) ? 1 : 0;
        const bGen = isGen(b.node.filePath) ? 1 : 0;
        return aGen - bGen;
      });
      const truncated = rankedResults.length > limit;
      const results = rankedResults.slice(0, limit);
      const truncationMessage = `Results truncated at ${limit}; pass --limit to widen.`;

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        if (truncated) console.error(truncationMessage);
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          // Results arrive already ranked by relevance, so the order conveys
          // it. We don't print the raw score: it's an unbounded BM25/FTS value
          // (relative-ranking only), and the old `(score * 100)%` rendered it
          // as nonsensical percentages like "12042%" (#1045). The MCP search
          // tool likewise shows no score. Raw `score` stays in --json output.
          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name)
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
          if (truncated) console.log(chalk.dim(truncationMessage));
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor explore <query...>
 *
 * The CLI face of the MCP lattice_sensor_explore tool — same handler, same
 * output (source of the relevant symbols grouped by file + the call path
 * among them). Exists so agents WITHOUT the MCP tools — Task-tool
 * subagents (which don't inherit MCP tools, #704) and non-MCP harnesses —
 * can reach the graph through a plain shell command.
 */
program
  .command('explore <query...>')
  .description('Explore an area: relevant symbols\' source + call paths in one shot (same output as the lattice_sensor_explore MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('--max-files <number>', 'Maximum number of files to include source from')
  .action(async (queryParts: string[], options: { path?: string; maxFiles?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor isn't available here — no .lattice/sensor/ index exists in ${projectPath}. If you are an AI agent, decide whether the expected reduction in repeated code-reading work justifies the one-time indexing cost. When workspace writes are allowed, you may run 'lattice sensor init ${projectPath} --json' yourself; otherwise continue with your usual tools and tell the user that exact command.`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      const args: Record<string, unknown> = { query: queryParts.join(' ') };
      if (options.maxFiles) args.maxFiles = parseInt(options.maxFiles, 10);
      const result = await handler.execute('lattice_sensor_explore', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Explore failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor context <task...>
 *
 * The CLI face of the public `buildContext` API (ContextBuilder): FTS entry
 * points + graph expansion + code blocks, formatted as markdown or JSON.
 * Advertised in the usage header since the first release but never actually
 * registered (#1611); external integrations (e.g. Memorix) invoke it as
 * `lattice sensor context --path <root> --format json --max-nodes 8 --no-code <task>`.
 */
program
  .command('context <task...>')
  .description('Build context for a task: relevant symbols, relationships, and code blocks')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --format <format>', 'Output format: markdown or json', 'markdown')
  .option('-n, --max-nodes <number>', 'Maximum number of symbols to include')
  .option('--no-code', 'Omit code blocks (structure only)')
  .action(async (taskParts: string[], options: { path?: string; format?: string; maxNodes?: string; code?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    const format = options.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json') {
      error(`Unknown format "${options.format}" — use "markdown" or "json".`);
      process.exit(1);
    }
    let maxNodes: number | undefined;
    if (options.maxNodes !== undefined) {
      maxNodes = parseInt(options.maxNodes, 10);
      if (Number.isNaN(maxNodes) || maxNodes < 1) {
        error(`--max-nodes expects a positive integer, got "${options.maxNodes}".`);
        process.exit(1);
      }
    }

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);

      const result = await cg.buildContext(taskParts.join(' '), {
        format,
        includeCode: options.code !== false,
        ...(maxNodes !== undefined ? { maxNodes } : {}),
      });

      // Both supported formats return a formatted string; print it verbatim so
      // `--format json` stays machine-parseable on stdout (error()/warnings go
      // to stderr only).
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      cg.destroy();
    } catch (err) {
      error(`Context build failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor prompt-hook  (hidden)
 *
 * A Claude Code `UserPromptSubmit` hook entry point. Reads `{prompt, cwd}` JSON
 * on stdin; for a structural/flow/impact prompt it runs `lattice_sensor_explore` on
 * the indexed project and prints the result to stdout, which Claude injects into
 * the agent's context — so the agent's reflex grep/read has nothing left to find
 * and reliably uses LatticeSensor (the adoption problem). Installed by the installer
 * into Claude's settings.json (opt-in, default-yes).
 *
 * LOAD-BEARING: this must NEVER break the user's prompt. Every failure path —
 * kill-switch, non-structural prompt, no index, engine error — exits 0 with no
 * output. The only effect is additive context when it can confidently provide it.
 */
program
  .command('prompt-hook', { hidden: true })
  .description('Claude UserPromptSubmit hook: inject LatticeSensor context for structural prompts (reads {prompt,cwd} JSON on stdin)')
  .action(async () => {
    try {
      // Kill-switch: lets a user disable the nudge without uninstalling /
      // editing settings.json (CI, low-power machines, personal preference).
      if (process.env.LATTICE_SENSOR_NO_PROMPT_HOOK === '1' || process.env.LATTICE_SENSOR_PROMPT_HOOK === '0') return;
      if (process.stdin.isTTY) return; // invoked by hand, no piped payload

      const raw = await new Promise<string>((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
      });

      let input: { prompt?: string; cwd?: string } = {};
      try { input = JSON.parse(raw); } catch { return; }
      const prompt = String(input.prompt || '');
      // System-injected task notifications are not user prompts: exit before
      // any project lookup or explore work (#1832).
      if (isTaskNotification(prompt)) return;

      // Gate telemetry: how often each tier fires vs. no-ops — counter names
      // only, NEVER prompt content (see TELEMETRY.md). This is the data that
      // turns "is the gate any good" from vibes into a measured recall rate.
      const gate = (outcome: string): void => {
        try { getTelemetry().recordUsage('cli_command', `prompt-hook-gate-${outcome}`, true); } catch { /* never break the hook */ }
      };

      // Gate, tiered by confidence (#994, #1126):
      //   HIGH   — a structural keyword (any covered language), or a code-shaped
      //            token verified in the index → full explore injection.
      //   MEDIUM — no keyword/token, but prose words match indexed symbol-name
      //            SEGMENTS ("state machine" → OrderStateMachine, in any
      //            language): inject a short list of the matching symbols and
      //            let the AGENT write the explore query — the graph-derived
      //            tier, no vocabulary involved.
      //   silent — nothing verified. Every other prompt ("fix this typo")
      //            stays a zero-cost no-op.
      // Keywords fire on their own; a token or prose word is only a CANDIDATE
      // verified against the graph below, so a tech brand ("JavaScript") that
      // merely looks like code doesn't inject spurious context.
      const keyworded = hasStructuralKeyword(prompt);
      const codeTokens = keyworded ? [] : extractCodeTokens(prompt);
      const proseWords = keyworded ? [] : extractProseCandidates(prompt);
      if (!keyworded && codeTokens.length === 0 && proseWords.length === 0) { gate('noop-shape'); return; }

      // Decide what to inject, shaped by WHERE the index(es) are: the nearest
      // indexed ancestor of cwd, or — when cwd is an un-indexed workspace root
      // whose indexed project(s) live in sub-dirs (the monorepo case, #964) —
      // the sub-project the prompt points at, plus a `projectPath` nudge for any
      // others. Without the down-scan the hook injected nothing at a monorepo
      // root (it only walked up), so the validated adoption lever never fired
      // exactly where the agent most needs it.
      const plan = planFrontload(String(input.cwd || process.cwd()), prompt);
      if (!plan.exploreRoot && plan.nudgeProjects.length === 0) { gate('noop-no-index'); return; } // nothing reachable — the agent's normal tools apply

      // A "pass projectPath" line for indexed sub-projects we did NOT front-load.
      // Follow-up lattice_sensor_explore calls against a sub-project (cwd isn't its
      // index root) need an explicit projectPath, so spell it out.
      const nudge = (projects: string[], lead: string): string =>
        `${lead}\n${projects.map((p) => `  - projectPath: "${p}"`).join('\n')}\n`;

      if (plan.exploreRoot) {
        const { default: LatticeSensor } = await loadLatticeSensor();
        const cg = await LatticeSensor.open(plan.exploreRoot);
        try {
          const others = plan.nudgeProjects.length
            ? `\n${nudge(plan.nudgeProjects, 'Other indexed projects in this workspace — pass projectPath to query them:')}`
            : '';

          // Tier decision against THIS index (issue #994 follow-up: candidates
          // must be real here — a brand name or prose about another domain
          // must not inject). Keyword-bearing prompts skip verification — the
          // keyword is signal enough.
          const tokenVerified = !keyworded && codeTokens.some((t) => cg.getNodesByName(t).length > 0);
          if (keyworded || tokenVerified) {
            const { ToolHandler } = await import('../mcp/tools');
            const handler = new ToolHandler(cg);
            const result = await handler.execute('lattice_sensor_explore', { query: prompt });
            const text = result.content[0]?.text ?? '';
            if (!result.isError && text.trim()) {
              // Cap the injection so a large-repo explore can't flood the prompt.
              // Claude Code shows hook stdout inline only up to 10,000 characters;
              // above that it persists the output to a file and the model sees a
              // 2 KB preview (#1694). PROMPT_HOOK_INJECTION_MAX (9,000) leaves
              // room for the wrapper and the projectPath nudge lines below.
              const body = capPromptHookInjection(text);
              // For a front-loaded SUB-project, a follow-up explore needs its path.
              const more = plan.viaSubScan
                ? `call lattice_sensor_explore with projectPath: "${plan.exploreRoot}" for more`
                : 'call lattice_sensor_explore for more';
              process.stdout.write(
                `<lattice_sensor_context note="Structural context from LatticeSensor for this prompt — treat returned source as already read; ${more}.">\n${body}${others}\n</lattice_sensor_context>\n`,
              );
              gate(keyworded ? 'high-keyword' : 'high-token');
            } else {
              // A high-* outcome must mean context was actually delivered —
              // the funnel's noop-vs-high split is how gate recall is
              // measured (#1143). An explore error or empty result is a
              // delivery failure, not a gate success.
              gate(keyworded ? 'noop-explore-keyword' : 'noop-explore-token');
            }
            return;
          }

          // MEDIUM: prose words → symbol-name segments, co-occurrence/rarity
          // scored, each hit re-verified to exist (see getSegmentMatches). The
          // payload names the symbols but does NOT run explore — the agent owns
          // the query where the hook's confidence is only "these are related".
          //
          // A database indexed before the vocab table existed starts with it
          // EMPTY, and only sync() backfills it — which this hook never runs
          // (#1142). Heal it here: on a populated vocab this is one SELECT;
          // the actual backfill is a one-time batched pass whose cost the MCP
          // server's own catch-up sync usually pays first (it runs at every
          // session start). A distinct noop outcome keeps a dormant vocab
          // from polluting the noop-unverified recall signal.
          const vocabReady = await cg.healSegmentVocabIfEmpty().catch(() => false);
          if (!vocabReady) { gate('noop-vocab-empty'); return; }
          const related = cg.getSegmentMatches(proseWords);
          if (related.length === 0) { gate('noop-unverified'); return; }
          const lines = related
            .map((m) => `  - ${m.name} (${m.kind} — ${m.filePath}:${m.startLine})`)
            .join('\n');
          const exampleQuery = related.slice(0, 3).map((m) => m.name).join(' ');
          const projectHint = plan.viaSubScan ? ` with projectPath: "${plan.exploreRoot}"` : '';
          process.stdout.write(
            `<lattice_sensor_context note="LatticeSensor found indexed symbols matching this prompt — query the graph before searching files.">\n` +
            `This project's LatticeSensor index contains symbols matching this request:\n${lines}\n` +
            `Call lattice_sensor_explore ONCE${projectHint} with the relevant names in one query (e.g. "${exampleQuery}") ` +
            `to get their source, call paths, and blast radius — cheaper and more complete than Read/Grep.\n${others}` +
            `</lattice_sensor_context>\n`,
          );
          gate('medium-segment');
        } finally {
          cg.destroy();
        }
      } else {
        // Several indexed sub-projects, none a clear match — don't guess; tell
        // the agent they exist and how to query one.
        process.stdout.write(
          `<lattice_sensor_context note="LatticeSensor is available for this workspace's indexed sub-projects — query one by passing projectPath to lattice_sensor_explore.">\n` +
          nudge(plan.nudgeProjects, "This workspace's LatticeSensor indexes live in sub-projects. To use LatticeSensor, call lattice_sensor_explore with the projectPath of the relevant one:") +
          `</lattice_sensor_context>\n`,
        );
        gate('nudge-projects');
      }
    } catch {
      // Degradable by contract: never surface an error to the prompt pipeline.
    }
  });

/**
 * lattice sensor node [name]
 *
 * The CLI face of the MCP lattice_sensor_node tool: one symbol's source +
 * caller/callee trail, or a whole file with line numbers + dependents
 * (Read-parity). Same subagent/non-MCP rationale as `explore`.
 *
 * `name` is OPTIONAL because `--file` (file-read mode) carries no symbol —
 * a required `<name>` made `lattice sensor node -f <file>` unreachable (#1044).
 */
program
  .command('node [name]')
  .description('One symbol\'s source + caller/callee trail, or read a file with line numbers + dependents (same output as the lattice_sensor_node MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --file <file>', 'Treat as file mode (or disambiguate a symbol to this file)')
  .option('--offset <number>', 'File mode: 1-based start line')
  .option('--limit <number>', 'File mode: maximum lines')
  .option('--symbols-only', 'File mode: just the symbol map + dependents')
  .action(async (name: string | undefined, options: { path?: string; file?: string; offset?: string; limit?: string; symbolsOnly?: boolean }) => {
    // Need a symbol (positional) OR a file (--file / a path-like positional).
    // With [name] optional, a bare `lattice sensor node` reaches here with neither
    // and must be told what to pass, rather than crashing downstream.
    if (!name && !options.file) {
      error("Pass a symbol name (e.g. 'lattice sensor node parseToken') or a file (e.g. 'lattice sensor node -f src/auth.ts', or 'lattice sensor node src/auth.ts').");
      process.exit(1);
    }

    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor isn't available here — no .lattice/sensor/ index exists in ${projectPath}. If you are an AI agent, decide whether the expected reduction in repeated code-reading work justifies the one-time indexing cost. When workspace writes are allowed, you may run 'lattice sensor init ${projectPath} --json' yourself; otherwise continue with your usual tools and tell the user that exact command.`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      // A name with a path separator is a file read; otherwise a symbol
      // (use --file for basename-only file reads or to pin an overload).
      // Both separators: Windows users type src\auth\session.ts. Symbols
      // never contain either ('/' isn't an identifier char anywhere we
      // index; C++ scope is '::', JS members '.').
      const args: Record<string, unknown> = {};
      if (options.file) {
        args.file = options.file;
        if (name && name !== options.file) {
          args.symbol = name;
          // Symbol mode pinned to a file is still symbol mode — the CLI
          // always wants the body, exactly like the bare-symbol branch
          // below. Omitting this printed location + trail with no source
          // (#1284).
          args.includeCode = true;
        }
      } else if (name && (name.includes('/') || name.includes('\\'))) {
        args.file = name.replace(/\\/g, '/');
      } else if (name) {
        args.symbol = name;
        args.includeCode = true;
      }
      if (options.offset) args.offset = parseInt(options.offset, 10);
      if (options.limit) args.limit = parseInt(options.limit, 10);
      if (options.symbolsOnly) args.symbolsOnly = true;

      const result = await handler.execute('lattice_sensor_node', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Node lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor file-nodes <file> — one file's indexed symbols, machine-readable.
 *
 * Lattice's seam verification needs "which top-level symbols does this file own"
 * at extraction fidelity (module constants/variables included, regardless of the
 * value-ref name filter). Reading the DB directly from Lattice would couple it to
 * the schema, so the contract stays at this CLI boundary like every other read.
 *
 * `imports` lists the file's import statements (line extents), and
 * `import_bindings` the locally bound names with their binding form —
 * resolved bindings come from the import edges' metadata, unresolvable ones
 * (builtins etc.) from unresolved_refs. Rewrite tooling joins them by line,
 * so it never re-parses import text with its own grammar.
 */
program
  .command('file-nodes <file>')
  .description('List indexed symbols of one file (JSON only)')
  .option('-p, --path <path>', 'Project path')
  .action(async (file: string, options: { path?: string }) => {
    const projectPath = resolveProjectPath(options.path);
    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }
      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      const all = cg.getNodesInFile(file);
      const nodes = all
        .filter(n => n.kind !== 'file' && n.kind !== 'import')
        .map(n => ({
          name: n.name, kind: n.kind, startLine: n.startLine, endLine: n.endLine,
          extentStartLine: n.extentStartLine ?? n.startLine,
          isExported: n.isExported === true,
        }));
      const imports = all
        .filter(n => n.kind === 'import')
        .map(n => ({ name: n.name, startLine: n.startLine, endLine: n.endLine }));
      const importBindings: Array<{
        local: string; form: string; imported: string | null; line: number | null;
      }> = [];
      const fileNode = all.find(n => n.kind === 'file');
      for (const edge of fileNode ? cg.getOutgoingEdges(fileNode.id) : []) {
        if (edge.kind !== 'imports') continue;
        const meta = edge.metadata as Record<string, unknown> | undefined;
        if (typeof meta?.binding !== 'string' || typeof meta?.refName !== 'string') continue;
        importBindings.push({
          local: meta.refName, form: meta.binding,
          imported: typeof meta.importedName === 'string' ? meta.importedName : null,
          line: typeof edge.line === 'number' ? edge.line : null,
        });
      }
      for (const ref of cg.getImportBindingRefsForFile(file)) {
        if (ref.referenceKind !== 'imports' || typeof ref.bindingForm !== 'string') continue;
        importBindings.push({
          local: ref.referenceName, form: ref.bindingForm,
          imported: ref.importedName ?? null, line: ref.line,
        });
      }
      console.log(JSON.stringify({ filePath: file, nodes, imports, import_bindings: importBindings }));
      cg.destroy();
    } catch (err) {
      error(`file-nodes failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      let files = cg.getFiles();

      if (files.length === 0) {
        info('No files indexed. Run "lattice sensor index" first.');
        cg.destroy();
        return;
      }

      // Filter by path prefix
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
      }

      // Filter by glob pattern
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        info('No files found matching the criteria.');
        cg.destroy();
        return;
      }

      // JSON output
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(output, null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

      // Format output
      switch (format) {
        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Normalize a user-supplied file path to the project-relative, forward-slash
 * form LatticeSensor stores in the index. Accepts an absolute path, a `./`-prefixed
 * path, or Windows back-slashes; an empty string when the input is blank. Used
 * by `lattice sensor affected` so `./src/x.ts`, `/abs/repo/src/x.ts`, and
 * `src/x.ts` all match the same indexed file. (#825)
 */
function normalizeIndexPath(filePath: string, projectPath: string): string {
  let f = filePath.trim();
  if (!f) return '';
  if (path.isAbsolute(f)) f = path.relative(projectPath, f);
  // Collapse `.`/`..` segments, then force forward slashes and drop a leading
  // `./` (path.normalize already strips it on POSIX; explicit for Windows).
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped);
}

/**
 * Print files as a tree
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

/**
 * lattice sensor daemon — interactive manager for the background daemons. Arrow keys
 * to pick one (the current project's daemon floats to the top, auto-selected),
 * enter to stop it. Falls back to a plain list when output isn't a TTY.
 */
program
  .command('daemon')
  .aliases(['daemons'])
  .description('Manage running LatticeSensor background daemons — pick one and press enter to stop it')
  .action(async () => {
    const { listVerifiedDaemons, stopDaemonAt, stopAllDaemons } = await import('../mcp/daemon-registry');
    const { runDaemonPicker } = await import('../mcp/daemon-manager');

    const daemons = await listVerifiedDaemons();
    if (daemons.length === 0) {
      info('No LatticeSensor daemons running.');
      return;
    }

    // No TTY (piped / CI / non-interactive) — can't do arrow-key selection, so
    // just print what's running instead of crashing on a prompt with no input.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      for (const d of daemons) {
        console.log(`pid ${d.pid}  v${d.version}  up ${formatDuration(Date.now() - d.startedAt)}  ${d.root}`);
      }
      return;
    }

    // The current project's daemon floats to the top and is pre-selected.
    let cwdRoot: string | null = null;
    const found = findNearestLatticeSensorRoot(process.cwd());
    if (found) { try { cwdRoot = fs.realpathSync(found); } catch { cwdRoot = found; } }

    const clack = await importESM('@clack/prompts');
    clack.intro('LatticeSensor daemons');
    await runDaemonPicker({
      list: listVerifiedDaemons,
      stop: stopDaemonAt,
      stopAll: stopAllDaemons,
      cwdRoot,
      now: () => Date.now(),
      select: (opts) => clack.select(opts),
      isCancel: (v) => clack.isCancel(v),
      note: (m) => clack.log.success(m),
      done: (m) => clack.outro(m),
    });
  });

/**
 * Print the "no index here" guidance.
 *
 * The viewer READS an index; it never builds one — indexing stays the user's
 * decision, exactly as it is for the MCP tools. So a missing index is normal
 * input, not a failure to apologize for: say what is missing, say the one
 * command that fixes it, and never print a stack trace.
 */
function printNoIndexGuidance(projectPath: string): void {
  error(`No LatticeSensor index found for ${projectPath}`);
  console.error('');
  // getGlyphs() (not a literal em dash): a legacy Windows console decodes raw
  // UTF-8 with its OEM codepage and renders one as mojibake (#168).
  console.error(`  The viewer reads an index that already exists ${getGlyphs().dash} it never creates one.`);
  console.error('  To index this project:');
  console.error('');
  console.error(`    ${chalk.cyan('lattice sensor init')}`);
  console.error('');
  console.error('  Already indexed somewhere else? Point the viewer at it:');
  console.error('');
  console.error(`    ${chalk.cyan('lattice sensor ui /path/to/indexed/project')}`);
  console.error('');
}

/**
 * lattice sensor ui [path]  (alias: web)
 *
 * The browser reader: serves the built viewer (`dist/viewer/`) over loopback
 * and opens it. It opens the index for reading and never writes to it, never
 * indexes, and never changes a line of the project's code. The single thing it
 * writes is a trail the reader saved, as JSON under `.lattice/sensor/ui/trails/`;
 * `--read-only` turns even that off.
 *
 * Deliberately absent from TELEMETRY_FLUSH_COMMANDS above: the command's own
 * banner tells the user nothing leaves their machine, so it must not be the
 * thing that triggers a telemetry send. The usage count still buffers locally
 * like every other quick command.
 */
program
  .command('ui [path]', { hidden: !viewerEnabled() })
  .alias('web')
  .description('Open the LatticeSensor viewer in your browser — read your indexed project as a graph')
  .option('--port <number>', `Port to listen on (default: ${DEFAULT_UI_PORT}, or the next free one)`)
  .option('--no-open', 'Print the URL instead of opening a browser')
  .option('--read-only', 'Refuse every write — saved trails can be opened but not saved or deleted')
  .addHelpText(
    'after',
    `
Examples:
  $ lattice sensor ui                    Read the project you're standing in
  $ lattice sensor ui ~/code/my-app      Read a specific indexed project
  $ lattice sensor ui --port 8080        Use one specific port (fails if it's taken)
  $ lattice sensor ui --no-open          Just print the URL (headless boxes, SSH)
  $ lattice sensor web                 Same command under its alias

Pick a symbol and you see who calls it on the left, its source in the middle,
and what it calls on the right at the height of the line that calls it. Search
with / (or Cmd-K), click a file path for the file's outline and its imports.

Ask "how does execute reach getFile" (or "execute -> getFile") in the search
box for the flow between two symbols: one card per hop, opened at the line that
makes the next call, with dynamic-dispatch hops drawn dashed and named. The Map
tab draws the whole project by module, with dependencies pointing down.

Never opened this codebase before? The Entry points tab lists the routes with
the symbols that serve them, the files that run something when they load, the
tests, and what the most code depends on — and starts a flow from any of them.

The page keeps up with the project while it is open: save a file and it says so
within about a third of a second, and whatever is on screen re-reads the graph
when something re-indexes it. It watches for that; it never polls.

Save a walk you want to keep: name the trail and it is written to
.lattice/sensor/ui/trails/ (already gitignored) as plain JSON, listed on the empty
screen, and reopened at the symbol you left. Hops are remembered by name rather
than by position, so a saved trail survives re-indexing and says which hop moved
when one does. Pass --read-only to refuse every write.

The viewer listens on 127.0.0.1 only, so nothing on your network can reach it.
It opens an index that already exists, never indexes, and never changes a line
of your code — the one thing it writes is a trail you asked it to save.
Requests from any other host are refused, and nothing is sent anywhere: no code,
no paths, no analytics.

Without --port it takes ${DEFAULT_UI_PORT}, or the next free port if that one is busy.

Set ${BROWSER_ENV}=<command> to choose which browser opens, or
${BROWSER_ENV}=none to never open one.
`
  )
  .action(async (pathArg: string | undefined, options: { port?: string; open?: boolean; readOnly?: boolean }) => {
    // An explicit --port stays explicit: a scripted `--port 8080` that quietly
    // lands on 8081 is worse than one that says the port is busy. The default
    // port is the only one we're free to walk away from.
    let requestedPort: number | undefined;
    if (options.port !== undefined) {
      requestedPort = Number(options.port);
      if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        error(`--port must be a whole number between 0 and 65535 (got "${options.port}").`);
        process.exit(1);
      }
    }

    const projectPath = resolveProjectPath(pathArg);

    // Sensitive-directory refusal before anything opens: the same guard the MCP
    // entry points use, so `lattice sensor ui /etc` is turned away here rather than
    // becoming a browsable view of the system.
    const { validateProjectPath } = await import('../utils');
    const rootError = validateProjectPath(projectPath);
    if (rootError) {
      error(rootError);
      process.exit(1);
    }

    if (!isInitialized(projectPath)) {
      printNoIndexGuidance(projectPath);
      process.exit(1);
    }

    const { startUiServer, openBrowser, createGraphApi, ViewerMissingError } = await import(
      '../ui-server'
    );

    // The JSON API the viewer reads its screens from. It opens the index lazily
    // on the first request, so a slow first paint is the only cost of mounting
    // it here rather than after the browser connects.
    const readOnly = options.readOnly === true;
    const api = createGraphApi({
      projectRoot: projectPath,
      readOnly,
      readOnlyReason: readOnly
        ? 'This viewer was started with --read-only, so trails cannot be saved.'
        : undefined,
    });

    let handle: UiServerHandle;
    try {
      handle = await startUiServer({
        projectRoot: projectPath,
        port: requestedPort,
        portFallback: requestedPort === undefined,
        api: api.handler,
      });
    } catch (err) {
      api.close();
      // Both failure modes here (viewer assets missing, no port available) carry
      // their own remediation — print it plainly, never a stack trace.
      error(err instanceof ViewerMissingError || err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    console.log('');
    console.log(chalk.bold('LatticeSensor viewer'));
    console.log('');
    console.log(`  ${chalk.dim('Reading')}  ${projectPath}`);
    console.log(`  ${chalk.dim('URL')}      ${chalk.cyan(handle.url)}`);
    console.log(
      `  ${chalk.dim('Access')}   this machine only ${getGlyphs().dash} ` +
        (readOnly
          ? 'read-only, nothing leaves your computer'
          : 'nothing leaves your computer; saved trails are the only thing written')
    );
    console.log('');

    const opened = options.open === false ? false : openBrowser(handle.url);
    console.log(
      opened
        ? chalk.dim('  Opening your browser... press Ctrl+C to stop.')
        : chalk.dim('  Open that URL in a browser. Press Ctrl+C to stop.')
    );
    console.log('');

    // The http server keeps the event loop alive on its own; these just make
    // Ctrl-C hang up live sockets instead of waiting on browser keep-alives.
    const shutdown = (): void => {
      // Release the SQLite handle before the socket: the process should never
      // exit with a live connection to the user's index.
      api.close();
      void handle.close().then(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

/**
 * lattice sensor serve
 */
program
  // Hidden from `--help`: this is the stdio entry point an AI agent launches
  // for itself (the installer wires `args: ['serve','--mcp']` into every
  // agent's MCP config), not a command a human runs. It still works when
  // invoked — hiding only removes it from the listing. See the interactive-TTY
  // guard below, which explains this to anyone who runs it by hand.
  .command('serve', { hidden: true })
  .description('Start LatticeSensor as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .action(async (options: { path?: string; mcp?: boolean; watch?: boolean }) => {
    const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

    // Commander sets watch=false when --no-watch is passed. Route it through
    // the same env-var chokepoint the watcher and MCP server already honor.
    if (options.watch === false) {
      process.env.LATTICE_SENSOR_NO_WATCH = '1';
    }

    try {
      if (options.mcp) {
        // `serve --mcp` is the stdio MCP server an AI agent launches for itself,
        // not a command to run by hand. A human in a terminal would otherwise
        // see it hang waiting for JSON-RPC on stdin, which reads as broken. If
        // stdin is an interactive TTY, explain instead of hanging. The agent's
        // pipe and the detached daemon both have a non-TTY stdin, so this only
        // ever fires for a person who typed it.
        if (process.stdin.isTTY && !process.env.LATTICE_SENSOR_DAEMON_INTERNAL) {
          console.error(chalk.bold('\nLatticeSensor MCP server\n'));
          console.error("This is the MCP server your AI agent (Claude Code, Cursor, Codex, opencode, …)");
          console.error("starts automatically — you don't run it yourself.");
          console.error(`\nIt's already wired up by ${chalk.cyan('lattice sensor install')}. To check on things:`);
          console.error(`  ${chalk.cyan('lattice sensor status')}   ${chalk.dim('— is this project indexed and healthy?')}`);
          console.error(`  ${chalk.cyan('lattice sensor daemon')}   ${chalk.dim('— list or stop background MCP servers')}`);
          console.error(chalk.dim('\n(Running it directly only does something when an MCP client drives it over stdin.)'));
          return;
        }
        // Start MCP server - it handles initialization lazily based on rootUri from client
        const { MCPServer } = await import('../mcp/index');
        const server = new MCPServer(projectPath);
        await server.start();
        // Server will run until terminated
      } else {
        // Default: show info about MCP mode.
        // Use stderr so stdout stays clean for any piped/stdio usage.
        console.error(chalk.bold('\nLatticeSensor MCP Server\n'));
        console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
        console.error('\nTo use with Claude Code, add to your MCP configuration:');
        console.error(chalk.dim(`
{
  "mcpServers": {
    "lattice-sensor": {
      "command": "lattice-sensor",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.error('Available tools:');
        console.error(chalk.cyan('  lattice_sensor_explore') + '   - Primary: source of the relevant symbols for any question');
        console.error(chalk.cyan('  lattice_sensor_search') + '    - Search for code symbols');
        console.error(chalk.cyan('  lattice_sensor_callers') + '   - Find callers of a symbol');
        console.error(chalk.cyan('  lattice_sensor_callees') + '   - Find what a symbol calls');
        console.error(chalk.cyan('  lattice_sensor_impact') + '    - Analyze impact of changes');
        console.error(chalk.cyan('  lattice_sensor_node') + '      - Get symbol details');
        console.error(chalk.cyan('  lattice_sensor_files') + '     - Get project file structure');
        console.error(chalk.cyan('  lattice_sensor_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getLatticeSensorDir(projectPath), 'sensor.lock');
      let removed = false;
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
        removed = true;
      }
      const { clearStaleDaemonArtifacts } = await import('../mcp/daemon-registry');
      removed = await clearStaleDaemonArtifacts(projectPath) || removed;
      if (removed) success('Removed stale lock artifacts. You can now run indexing again.');
      else info(`No stale lock files found ${getGlyphs().dash} nothing to do`);
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * CLI parity with MCP callers/callees: resolve once, then collect and limit
 * within each definition. The legacy JSON list remains an explicitly labeled
 * union, with its original total/limit/truncated contract (#1674).
 *
 * Lattice contract on top (src/sensor-adapter.mjs, todo-structure-source-adapter,
 * seam-cost): `--exact-path` traverses exactly the definition of `symbol` in one
 * repo-relative file and reports `exactResolution`; every listed node carries
 * `edgeKind`/`valueRef`/`valueWrite` from the edges that connect it.
 */
for (const direction of ['callers', 'callees'] as const) {
  const title = direction === 'callers' ? 'Callers' : 'Callees';
  program
    .command(`${direction} <symbol>`)
    .description(direction === 'callers'
      ? 'Find all functions/methods that call a specific symbol'
      : 'Find all functions/methods called by a specific symbol')
    .option('-p, --path <path>', 'Project path')
    .option('-f, --file <path>', 'Narrow definitions by file path or suffix (no match: show all with a note)')
    .option('-l, --limit <number>', 'Maximum results per definition (also caps the JSON union)', '20')
    .option('--exact-path <repo-relative-path>', 'Traverse one exact symbol in this repo-relative file')
    .option('-j, --json', 'Output as JSON')
    .action(async (symbol: string, options: {
      path?: string; file?: string; limit?: string; exactPath?: string; json?: boolean;
    }) => {
      const projectPath = resolveProjectPath(options.path);

      try {
        if (!isInitialized(projectPath)) {
          error(`LatticeSensor not initialized in ${projectPath}`);
          process.exit(1);
        }

        const { default: LatticeSensor } = await loadLatticeSensor();
        const cg = await LatticeSensor.open(projectPath);
        try {
          const limit = parseInt(options.limit || '20', 10);
          const { nodes: targets } = lookupSymbolNodes(cg, symbol);
          if (targets.length === 0) {
            info(formatSymbolNotFound(symbol, cg.searchNodes(symbol, { limit: 5 }).map((m) => m.node.name)));
            return;
          }

          const strict = options.exactPath === undefined
            ? null : selectExactTraversalCandidate(targets.map((node) => ({ node })), symbol, options.exactPath);
          if (strict !== null && strict.outcome !== 'ready') {
            if (options.json) {
              console.log(JSON.stringify({
                symbol, exactPath: options.exactPath, exactResolution: strict.outcome,
                [direction]: [], total: 0, limit, truncated: false,
              }, null, 2));
            } else {
              info(`No single definition of "${symbol}" in ${options.exactPath} (${strict.outcome})`);
            }
            return;
          }
          const exact = strict === null
            ? {} : { exactPath: options.exactPath, exactResolution: strict.outcome };
          const { groups, filteredOut } = groupDefinitions(
            strict === null ? targets : [strict.candidate!.node], options.file);
          const ambiguous = groups.length > 1;
          const note = filteredOut
            ? `no definition of "${symbol}" matches file "${options.file}" — showing all definitions instead.`
            : undefined;
          const collected = groups.map((group) => {
            const nodes = new Map<string, Node>();
            const edges = new Map<string, Edge>();
            for (const target of group) {
              const connections = direction === 'callers' ? cg.getCallers(target.id) : cg.getCallees(target.id);
              for (const { node, edge } of connections) {
                nodes.set(node.id, node);
                edges.set(`${edge.source}->${edge.target}:${edge.kind}`, edge);
              }
            }
            return { group, nodes: [...nodes.values()], edges: [...edges.values()] };
          });

          const relationships = (node: Node, edges: Edge[]) => [...new Set(edges
            .filter((edge) => (direction === 'callers' ? edge.source : edge.target) === node.id)
            .map((edge) => edge.kind))];
          // Lattice: the edge facts behind each listed node. A value write on ANY
          // connecting edge counts — dropping one would hide a writer from seam cost.
          const edgeFacts = (node: Node, edges: Edge[]) => {
            const own = edges.filter((edge) => (direction === 'callers' ? edge.source : edge.target) === node.id);
            return {
              edgeKind: own[0]?.kind ?? 'calls',
              valueRef: own.some((edge) => edge.metadata?.valueRef === true),
              valueWrite: own.some((edge) => edge.metadata?.valueWrite === true),
            };
          };
          if (options.json) {
            const definitions = collected.map(({ group, nodes, edges }) => {
              const limited = nodes.slice(0, limit);
              const shown = new Set(limited.map((node) => node.id));
              return {
                ...cliDefinition(group),
                [direction]: limited.map((node) => ({ id: node.id, ...cliNode(node),
                  relationships: relationships(node, edges), ...edgeFacts(node, edges) })),
                edges: edges.filter((edge) => shown.has(direction === 'callers' ? edge.source : edge.target)),
                total: nodes.length,
                limit,
                truncated: nodes.length > limit,
              };
            });
            const union = new Map<string, Node>();
            for (const { nodes } of collected) {
              for (const node of nodes) union.set(node.id, node);
            }
            const total = union.size;
            console.log(JSON.stringify({
              symbol,
              ...exact,
              targets: groups.flat().map((node) => cliDefinition([node]).definition),
              ambiguous,
              aggregation: ambiguous ? 'union' : 'definition',
              file: options.file,
              filteredOut,
              note,
              definitions,
              [direction]: [...union.values()].slice(0, limit).map((node) => {
                const all = collected.flatMap((entry) => entry.edges);
                return { ...cliNode(node), relationships: relationships(node, all), ...edgeFacts(node, all) };
              }),
              total,
              limit,
              truncated: total > limit,
            }, null, 2));
          } else {
            if (note) warn(note);
            if (ambiguous) {
              console.log(chalk.bold(`\n${title} of "${symbol}" — ${groups.length} distinct definitions (narrow with --file):`));
            }
            for (const { group, nodes, edges } of collected) {
              const limited = nodes.slice(0, limit);
              const total = nodes.length;
              const truncated = total > limit;
              const count = truncated ? `${limited.length} of ${total}` : String(total);
              if (ambiguous) {
                console.log(chalk.bold(`\n${describeSymbolNode(group[0]!)} (${count}):\n`));
              } else {
                console.log(chalk.bold(`\n${title} of "${symbol}" (${count}):\n`));
                console.log(chalk.dim(describeSymbolNode(group[0]!)));
              }
              if (total === 0) {
                if (ambiguous) console.log(chalk.dim(`  (no ${direction})`));
                else info(`No ${direction} found for "${symbol}"`);
              }
              for (const node of limited) {
                const loc = node.startLine ? `:${node.startLine}` : '';
                const kinds = relationships(node, edges).filter((kind) => kind !== 'calls');
                const relation = kinds.length ? ` [${kinds.join(', ')}]` : '';
                console.log(chalk.cyan(node.kind.padEnd(12)) + chalk.white(node.name) + chalk.dim(relation));
                console.log(chalk.dim(`  ${node.filePath}${loc}`));
                console.log();
              }
              if (truncated) console.log(chalk.dim(`Showing ${limited.length} of ${total}; pass --limit to widen.`));
            }
          }
        } finally {
          cg.destroy();
        }
      } catch (err) {
        error(`${direction} failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}

/**
 * lattice sensor impact <symbol> — one blast radius per distinct definition.
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --file <path>', 'Narrow definitions by file path or suffix (no match: show all with a note)')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; file?: string; depth?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      try {
        const depth = Math.min(Math.max(parseInt(options.depth || '2', 10), 1), 10);
        const { nodes: targets } = lookupSymbolNodes(cg, symbol);
        if (targets.length === 0) {
          info(formatSymbolNotFound(symbol, cg.searchNodes(symbol, { limit: 5 }).map((m) => m.node.name)));
          return;
        }

        const { groups, filteredOut } = groupDefinitions(targets, options.file);
        const ambiguous = groups.length > 1;
        const note = filteredOut
          ? `no definition of "${symbol}" matches file "${options.file}" — showing all definitions instead.`
          : undefined;
        const collected = groups.map((group) => {
          const nodes = new Map<string, Node>();
          const edges = new Map<string, Edge>();
          for (const target of group) {
            const impact = cg.getImpactRadius(target.id, depth);
            for (const [id, node] of impact.nodes) nodes.set(id, node);
            for (const edge of impact.edges) edges.set(`${edge.source}->${edge.target}:${edge.kind}`, edge);
          }
          return { group, nodes, edges };
        });

        if (options.json) {
          const unionNodes = new Map<string, Node>();
          const unionEdges = new Map<string, Edge>();
          const definitions = collected.map(({ group, nodes, edges }) => {
            for (const [id, node] of nodes) unionNodes.set(id, node);
            for (const [key, edge] of edges) unionEdges.set(key, edge);
            return {
              ...cliDefinition(group),
              nodeCount: nodes.size,
              edgeCount: edges.size,
              affected: [...nodes.values()].map((node) => ({ id: node.id, ...cliNode(node) })),
              edges: [...edges.values()],
            };
          });
          console.log(JSON.stringify({
            symbol,
            depth,
            targets: groups.flat().map((node) => cliDefinition([node]).definition),
            ambiguous,
            aggregation: ambiguous ? 'union' : 'definition',
            file: options.file,
            filteredOut,
            note,
            definitions,
            nodeCount: unionNodes.size,
            edgeCount: unionEdges.size,
            affected: [...unionNodes.values()].map(cliNode),
          }, null, 2));
        } else {
          if (note) warn(note);
          if (ambiguous) {
            console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${groups.length} distinct definitions (each with its own blast radius; narrow with --file):`));
          }
          for (const { group, nodes } of collected) {
            if (ambiguous) {
              console.log(chalk.bold(`\n${describeSymbolNode(group[0]!)} — ${nodes.size} affected symbols:\n`));
            } else {
              console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${nodes.size} affected symbols:\n`));
              console.log(chalk.dim(describeSymbolNode(group[0]!)));
            }
            const byFile = new Map<string, Node[]>();
            for (const node of nodes.values()) {
              const list = byFile.get(node.filePath) || [];
              list.push(node);
              byFile.set(node.filePath, list);
            }
            for (const [file, affected] of byFile) {
              console.log(chalk.cyan(file));
              for (const node of affected) {
                const loc = node.startLine ? `:${node.startLine}` : '';
                console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
              }
              console.log();
            }
          }
        }
      } finally {
        cg.destroy();
      }
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * lattice sensor affected [files...]
 *
 * Find test files affected by the given source files.
 * Traces dependency edges transitively to find test files that depend on changed code.
 *
 * Usage:
 *   git diff --name-only | lattice sensor affected --stdin
 *   lattice sensor affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`LatticeSensor not initialized in ${projectPath}`);
        process.exit(1);
      }

      // Collect changed files from args or stdin
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      // Normalize inputs to the project-relative, forward-slash form the index
      // stores. Without this, `affected ./src/x.ts`, an absolute path (what a
      // wrapping script often passes), or a Windows back-slash path silently
      // matches nothing and reports 0 affected tests. (#825)
      changedFiles = changedFiles
        .map((f) => normalizeIndexPath(f, projectPath))
        .filter(Boolean);

      if (changedFiles.length === 0) {
        if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
        process.exit(0);
      }

      const { default: LatticeSensor } = await loadLatticeSensor();
      const cg = await LatticeSensor.open(projectPath);
      const maxDepth = parseInt(options.depth || '5', 10);

      // Custom filter pattern
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // Convert glob to regex: ** → .+, * → [^/]*, . → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      // One notion of "a test" for the whole tool (#1507): the CLI used to keep
      // its own six regexes here, which knew `.test.` and `/tests/` but not Go's
      // `_test.go`, Python's `test_x.py` or the JVM's `FooTest.kt` — so
      // `affected` reported "no tests" for whole ecosystems while `search` and
      // the MCP tools counted those very files as tests.
      function matchesTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return isRunnableTestFile(filePath);
      }

      // BFS to find all transitive dependents of changed files, filtered to test files
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // If the changed file is itself a test file, include it
        if (matchesTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS through dependents
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (matchesTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // Output
      if (options.json) {
        console.log(JSON.stringify({
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }, null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * Standalone install/uninstall retired by ADR 0059.
 * Host wiring and retirement are owned by dotagents; this internal sensor
 * cannot register or remove MCP servers or packages.
 */
program
  .command("install")
  .description("Retired: use the dotagents Lattice host wiring")
  .action(() => {
    error("Retired: Lattice sensor does not install independent MCP wiring.");
    process.exit(1);
  });

program
  .command("uninstall")
  .description("Retired: use the dotagents Lattice sensor retirement transaction")
  .action(() => {
    error("Retired: use the dotagents host cutover transaction.");
    process.exit(1);
  });

/**
 * lattice sensor telemetry [on|off|status]
 */
program
  .command('telemetry [action]')
  .description('Show or change anonymous usage telemetry (status, on, off)')
  .action((action?: string) => {
    const t = getTelemetry();

    if (action === 'on' || action === 'off') {
      t.setEnabled(action === 'on', 'cli');
      if (action === 'on') {
        success('Telemetry enabled — anonymous usage stats only (no code, paths, or names).');
      } else {
        success('Telemetry disabled. Buffered, unsent data was deleted.');
      }
      const effective = t.getStatus();
      if (effective.decidedBy === 'DO_NOT_TRACK' || effective.decidedBy === 'LATTICE_SENSOR_TELEMETRY') {
        warn(
          `The ${effective.decidedBy} environment variable overrides this choice — ` +
          `effective state right now: ${effective.enabled ? 'enabled' : 'disabled'}.`
        );
      }
      return;
    }

    if (action !== undefined && action !== 'status') {
      error(`Unknown action: ${action} (expected status, on, or off)`);
      process.exit(1);
    }

    const s = t.getStatus();
    const decidedBy: Record<typeof s.decidedBy, string> = {
      DO_NOT_TRACK: 'DO_NOT_TRACK environment variable',
      LATTICE_SENSOR_TELEMETRY: 'LATTICE_SENSOR_TELEMETRY environment variable',
      config: 'your saved choice',
      default: 'default',
    };
    console.log(`\nTelemetry: ${s.enabled ? chalk.green('enabled') : chalk.yellow('disabled')} ${chalk.dim(`(${decidedBy[s.decidedBy]})`)}`);
    console.log(`Machine ID: ${s.machineId ?? chalk.dim('(random UUID, created on first use)')}`);
    console.log(`Config:     ${s.configPath}`);
    console.log(chalk.dim(`\nExactly what is collected (and never collected): ${TELEMETRY_DOCS}\n`));
  });

/**
 * lattice sensor upgrade [version]
 *
 * ADR 0049 Decision 4: upstream's self-update path (bundle install.sh/.ps1
 * download, npm reinstall, GitHub release resolution) is disabled for
 * Lattice — running it would silently overwrite this fork's ADR 0047/0048
 * improvements with an upstream LatticeSensor build and reach
 * raw.githubusercontent.com / api.github.com / GitHub release assets, which
 * the MCP surface contract forbids. The command stays registered (so it
 * doesn't look unrecognized) but refuses to run and points at Lattice's own
 * release channel instead of dispatching to ../upgrade.
 */
program
  .command('upgrade [version]')
  .description('Disabled on Lattice — see the Lattice release channel instead of upstream LatticeSensor')
  .option('--check', 'Check whether an update is available without installing')
  .option('-f, --force', 'Reinstall even if already on the target version')
  .action(async () => {
    error(
      'Disabled: `lattice sensor upgrade` self-updates from the upstream LatticeSensor project ' +
      '(GitHub releases / npm), which would overwrite Lattice sensor\'s own fork changes. ' +
      'Update Lattice through its own release channel instead.'
    );
    process.exit(1);
  });

/**
 * lattice sensor version
 *
 * The bare-noun form of `--version`. commander already provides `--version`
 * and `-V`, and the `-v` / `-version` spellings are intercepted before parse
 * (see top of main). This subcommand makes `lattice sensor version` work and lists
 * the version affordance in `lattice sensor --help`.
 */
program
  .command('version')
  .description('Print the installed LatticeSensor version (also: -v, --version)')
  .action(() => {
    console.log(packageJson.version);
  });

// Parse and run
program.parse();

} // end main()
