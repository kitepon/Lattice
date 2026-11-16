/**
 * Code graph's side of ADR 0205 §3-§4: check a worker's function-split commit, and size the cut before the worker decides.
 *
 * The cut itself is the worker's code change; this module only observes it. It never reads the plan or the journal (the
 * overlap and parallel conditions are Plan/lifecycle's), and never writes the source repository: every observation runs
 * in a disposable worktree of the commit with ONE fresh index, reused for the tests, the file nodes and Resolve.
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { runIsolatedTransform } from './isolation-runner.mjs';
import { computeSeamCostProfile } from './seam-cost.mjs';
import { buildOutputMounts, detectSeveredReferences } from './seam-apply.mjs';
import { compareExportSurface } from './seam-verification.mjs';
import { runSensorCli } from './sensor-cli.mjs';
import { resolveAnchors } from './sensor-resolve.mjs';
import { invokeSensorCli } from './sensor-runtime.mjs';

const execFileAsync = promisify(execFile);
const LIST_CAP = 64; // the splits record caps lists at 64 (ADR 0205 §2)
const DETAIL_CAP = 2048;
const JS_TS = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/u;
const NODE_RUNNABLE = /\.(?:mjs|cjs|js)$/u;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const sink = { write() {} };
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const cap = (list) => list.slice(0, LIST_CAP);
const clip = (text) => String(text).slice(0, DETAIL_CAP);

class InputError extends Error {
  constructor(code, next_action, extra = {}) {
    super(code);
    this.error = { code, next_action, ...extra };
  }
}

const git = async (repoRoot, args, options = {}) => (await execFileAsync('git', args, {
  cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options,
})).stdout;

const safePath = (value) => typeof value === 'string' && value !== '' && !path.isAbsolute(value)
  && !value.split('/').includes('..');
const wellFormed = (entry) => safePath(entry?.path) && typeof entry?.symbol === 'string' && entry.symbol !== '';

function validate({ target, map, anchors }) {
  if (!wellFormed(target)) throw new InputError('map_entry_malformed', 'target must be {path, symbol} (repo-relative path)');
  const seen = new Set();
  for (const entry of map) {
    if (!wellFormed(entry) || typeof entry.task_id !== 'string' || entry.task_id === '' || seen.has(entry.task_id)) {
      throw new InputError('map_entry_malformed', 'map takes one {task_id, path, symbol} per member, repo-relative paths');
    }
    seen.add(entry.task_id);
  }
  for (const entry of anchors) {
    if (!wellFormed(entry) || typeof entry.task_id !== 'string') {
      throw new InputError('map_entry_malformed', 'anchors take {task_id, path, symbol}');
    }
  }
}

async function revParse(repoRoot, ref, what) {
  try {
    return (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  } catch {
    throw new InputError('commit_not_found', `${what} ${ref} is not in this repository: fetch or push the branch, then verify again`, { ref });
  }
}

/** `git diff --name-status`: [{status: A|M|D|..., path}]. No rename detection: a rename is a delete plus an add. */
async function changedFiles(repoRoot, base, commit) {
  const fields = (await git(repoRoot, ['diff', '--name-status', '-z', '--no-renames', base, commit])).split('\0');
  const changes = [];
  for (let at = 0; at + 1 < fields.length; at += 2) changes.push({ status: fields[at][0], path: fields[at + 1] });
  return changes;
}

const spanKey = (rows) => rows.map((row) => `${row.start_line}-${row.end_line}`).sort(compareText).join(',');

/** Runs `work` inside a disposable worktree of `ref` with one fresh index; `verifyCommands` may be filled by `work`. */
async function atRef({ repoRoot, ref, work, verifyCommands = [] }) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'lattice-split-index-'));
  try {
    return await runIsolatedTransform({
      repoRoot, baseRef: ref, allowedPaths: [], verifyCommands,
      transform: ({ worktreePath }) => work(worktreePath),
      mounts: [
        { entry: 'node_modules', target: path.join(repoRoot, 'node_modules') },
        { entry: '.lattice/sensor', target: scratch },
        ...await buildOutputMounts(repoRoot),
      ],
      verifierEnv: { LATTICE_DASHBOARD_AUTOSTART: '0' },
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function indexWorktree(worktreePath) {
  if (await runSensorCli({ argv: ['init', worktreePath, '--json'], stdout: sink, stderr: sink }) !== 0) {
    throw new Error('sensor_init_failed');
  }
}

function fileNodes(worktreePath, file) {
  const result = invokeSensorCli(
    (command, args, options) => spawnSync(command, args, options),
    ['file-nodes', file, '--path', '.'],
    { cwd: worktreePath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)?.nodes ?? null; } catch { return null; }
}

function affectedTests(worktreePath, files) {
  const result = invokeSensorCli(
    (command, args, options) => spawnSync(command, args, options),
    ['affected', ...files, '--path', '.', '--json'],
    { cwd: worktreePath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)?.affectedTests ?? null; } catch { return null; }
}

/** Resolve rows of each requested `{path, symbol}`: Map key `path\0symbol` -> rows; plus the misses and ambiguous names. */
async function resolveAll(root, wanted) {
  const unique = [...new Map(wanted.map(({ path: p, symbol }) => [`${p}\0${symbol}`, { path: p, symbol }])).values()];
  const answer = await resolveAnchors({ root, anchors: unique });
  const rows = new Map();
  for (const row of answer.resolved) {
    const key = `${row.path}\0${row.symbol}`;
    rows.set(key, [...(rows.get(key) ?? []), row]);
  }
  return {
    rows,
    unresolved: new Map(answer.unresolved.map((item) => [`${item.path}\0${item.symbol}`, item])),
    ambiguous: new Map(answer.ambiguous.map((item) => [`${item.path}\0${item.symbol}`, item])),
  };
}

const keyOf = ({ path: p, symbol }) => `${p}\0${symbol}`;

/** Why an entry is not usable: `{reason, nearest|candidates}` or null when it resolved to one definition. */
function missOf(resolved, entry) {
  const key = keyOf(entry);
  if (resolved.ambiguous.has(key)) return { reason: 'ambiguous', candidates: resolved.ambiguous.get(key).names };
  if (!resolved.rows.has(key)) {
    const miss = resolved.unresolved.get(key);
    return { reason: 'not_found', nearest: (miss?.nearest ?? []).slice(0, 5) };
  }
  return null;
}

/** The base side: ranges of the target and mapped entries before the cut, and the graph nodes of deleted non-JS files. */
async function observeBase({ repoRoot, base, target, map, deletedOther }) {
  const seen = { rows: new Map(), deletedWithNodes: [] };
  await atRef({
    repoRoot, ref: base,
    work: async (worktreePath) => {
      await indexWorktree(worktreePath);
      seen.rows = (await resolveAll(worktreePath, [target, ...map])).rows;
      for (const file of deletedOther) {
        if ((fileNodes(worktreePath, file) ?? []).length > 0) seen.deletedWithNodes.push(file);
      }
    },
  });
  return seen;
}

async function textAt(repoRoot, ref, file) {
  try { return await git(repoRoot, ['show', `${ref}:${file}`]); } catch { return ''; }
}

/**
 * Verify a function-split commit (ADR 0205 §4, behaviour / tests / fresh; overlap and parallel are Plan/lifecycle's).
 * → `{base, commit, target, behaviour, tests, fresh, ranges, anchors_unresolved, map}` or `{error: {code, next_action}}`.
 */
export async function verifyFunctionSplit({ repoRoot, commit, base, target, map = [], anchors = [] } = {}) {
  try {
    validate({ target, map, anchors });
    const commitSha = await revParse(repoRoot, commit, 'commit');
    const baseSha = base === undefined
      ? await git(repoRoot, ['merge-base', commitSha, 'HEAD']).then((out) => out.trim(), () => {
        throw new InputError('commit_not_found', 'commit shares no history with HEAD: pass --base', { ref: commit });
      })
      : await revParse(repoRoot, base, 'base');
    if (baseSha === commitSha) {
      throw new InputError('empty_diff', 'the commit is already on HEAD or equals base: pass --base <main sha before the merge>');
    }
    const changes = await changedFiles(repoRoot, baseSha, commitSha);
    if (changes.length === 0) throw new InputError('empty_diff', 'no file differs between base and commit: pass a different --base or commit');
    if (!changes.some((change) => change.path === target.path)) {
      throw new InputError('target_untouched', `the diff base..commit does not touch ${target.path}: the cut must change the target file`);
    }
    return await observe({ repoRoot, baseSha, commitSha, changes, target, map, anchors });
  } catch (error) {
    if (error instanceof InputError) return { error: error.error };
    const errors = error instanceof AggregateError ? error.errors : [error];
    const dirty = errors.find((item) => String(item?.message).startsWith('source repository must be clean'));
    if (dirty) {
      return { error: { code: 'source_dirty', next_action: 'commit or stash the changes in the repository, then verify again', detail: clip(dirty.message) } };
    }
    throw error;
  }
}

async function observe({ repoRoot, baseSha, commitSha, changes, target, map, anchors }) {
  const alive = changes.filter(({ status }) => status !== 'D').map(({ path: p }) => p);
  const deletedOther = changes.filter(({ status, path: p }) => status === 'D' && !JS_TS.test(p)).map(({ path: p }) => p);
  const state = { failures: [], resolved: null, unobserved: null, tests: null };

  let baseSeen = null;
  try {
    baseSeen = await observeBase({ repoRoot, base: baseSha, target, map, deletedOther });
  } catch (error) {
    if (String(error?.message).startsWith('source repository must be clean')) throw error;
    // existed_at_base is recorded, not a condition (ADR 0205 §4): a failed base index leaves it null.
  }

  const verifyCommands = [];
  const work = async (worktreePath) => {
    try {
      await indexWorktree(worktreePath);
    } catch (error) {
      state.indexFailure = clip(error.message);
      return;
    }
    // behaviour: export surface per JS/TS file, the graph for every other language.
    for (const { status, path: file } of changes) {
      if (JS_TS.test(file)) {
        const before = status === 'A' ? '' : await textAt(repoRoot, baseSha, file);
        const after = status === 'D' ? '' : await readFile(path.join(worktreePath, file), 'utf8');
        const { missing } = compareExportSurface({ before, after });
        if (missing.length > 0) state.failures.push(`export_surface_lost:${file}:${missing.join(',')}`);
      } else if (status !== 'D' && (fileNodes(worktreePath, file) ?? []).length > 0) {
        state.failures.push(`export_surface_unobserved:${file}`);
      }
    }
    for (const file of baseSeen?.deletedWithNodes ?? []) state.failures.push(`export_surface_unobserved:${file}`);
    const others = {};
    for (const file of alive) {
      if (file !== target.path && JS_TS.test(file) && !TEST_FILE.test(file)) {
        others[file] = await readFile(path.join(worktreePath, file), 'utf8');
      }
    }
    if (alive.includes(target.path)) {
      const severed = await detectSeveredReferences({ worktreePath, files: others, residualPath: target.path });
      if (!severed.observed) state.failures.push('severed_observation_missing');
      for (const { file, name } of severed.entries) state.failures.push(`severed_reference:${file}:${name}`);
    }
    state.resolved = await resolveAll(worktreePath, [target, ...map, ...anchors]);
    // tests: the file-level affected tests of the changed files, the target and the mapped paths, on this index.
    const roots = [...new Set([...alive, target.path, ...map.map(({ path: p }) => p)])]
      .filter((file) => existsSync(path.join(worktreePath, file)));
    const affected = affectedTests(worktreePath, roots);
    if (affected === null) { state.testsFailure = 'affected_unavailable'; return; }
    const runnable = affected.filter((file) => NODE_RUNNABLE.test(file)).sort(compareText);
    state.tests = { runnable, skipped: affected.filter((file) => !NODE_RUNNABLE.test(file)).sort(compareText) };
    for (const file of runnable) verifyCommands.push({ command: process.execPath, args: ['--test', file] });
  };

  let infra = null;
  try {
    await atRef({ repoRoot, ref: commitSha, work, verifyCommands });
    state.testsPassed = true;
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    const dirty = errors.find((item) => String(item?.message).startsWith('source repository must be clean'));
    if (dirty) throw dirty;
    const failed = errors.find((item) => String(item?.message).startsWith('verifier failed'));
    if (failed) state.testsFailed = failed;
    else infra = clip(errors.map((item) => item?.message).join(' | '));
  }

  return report({ baseSha, commitSha, target, map, anchors, baseSeen, state, verifyCommands, infra });
}

function report({ baseSha, commitSha, target, map, anchors, baseSeen, state, verifyCommands, infra }) {
  const cause = state.indexFailure ?? infra;
  const resolved = state.resolved;
  const ran = verifyCommands.map(({ args }) => args[1]);
  const spans = (entry) => (resolved?.rows.get(keyOf(entry)) ?? []);

  const behaviourFailures = cause ? [`worktree_failed:${cause}`] : state.failures;
  const behaviour = { passed: behaviourFailures.length === 0, detail: behaviourFailures.length === 0 ? 'ok' : clip(behaviourFailures.join('; ')) };

  let tests;
  if (cause || state.testsFailure) {
    tests = { passed: false, ran: [], not_run: [], skipped: [], detail: cause ? `worktree_failed:${cause}` : state.testsFailure };
  } else if (state.tests.runnable.length === 0) {
    tests = { passed: false, ran: [], not_run: [], skipped: cap(state.tests.skipped), detail: 'no_test_reaches_function' };
  } else if (state.testsFailed) {
    const stopped = String(state.testsFailed.message).match(/--test (\S+)/u)?.[1];
    const at = ran.indexOf(stopped);
    tests = {
      passed: false, ran: cap(ran.slice(0, at + 1)), not_run: cap(ran.slice(at + 1)), skipped: cap(state.tests.skipped),
      detail: clip(state.testsFailed.message),
    };
  } else {
    tests = { passed: true, ran: cap(ran), not_run: [], skipped: cap(state.tests.skipped), detail: 'ok' };
  }

  const unresolved = [];
  const anchorsUnresolved = [];
  const ranges = [];
  const mapOut = [];
  if (resolved) {
    for (const entry of map) {
      const miss = missOf(resolved, entry);
      if (miss) unresolved.push({ task_id: entry.task_id, path: entry.path, symbol: entry.symbol, ...miss });
      const before = baseSeen?.rows.get(keyOf(entry));
      mapOut.push({
        ...entry,
        existed_at_base: baseSeen === null ? null : before !== undefined && spanKey(before) === spanKey(spans(entry)),
      });
    }
    for (const entry of anchors) {
      const miss = missOf(resolved, entry);
      if (miss) anchorsUnresolved.push({ task_id: entry.task_id, path: entry.path, symbol: entry.symbol, ...miss });
    }
    for (const entry of [...map, ...anchors]) {
      for (const row of spans(entry)) {
        ranges.push({ task_id: entry.task_id, path: entry.path, symbol: entry.symbol, start_line: row.start_line, end_line: row.end_line });
      }
    }
  }
  const targetRows = resolved ? spans(target) : [];
  return {
    base: baseSha,
    commit: commitSha,
    target: {
      resolved: targetRows.length > 0,
      start_line: targetRows.length > 0 ? Math.min(...targetRows.map((row) => row.start_line)) : null,
      end_line: targetRows.length > 0 ? Math.max(...targetRows.map((row) => row.end_line)) : null,
    },
    behaviour,
    tests,
    fresh: resolved === null
      ? { passed: false, unresolved: [], detail: `worktree_failed:${cause ?? 'not_observed'}` }
      : { passed: unresolved.length === 0, unresolved: cap(unresolved) },
    // never capped: Plan/lifecycle's overlap check reads every row, and a lost row could turn an overlap into a pass.
    ranges,
    anchors_unresolved: anchorsUnresolved,
    map: mapOut,
  };
}

/**
 * Size of the cut for `todo start S` (ADR 0205 §3): the seam-cost profile of the target function's file, every member
 * owning F. Best effort: `{profile: null, reasons}` when the maintained index cannot answer. One owner key joins the member
 * ids because they all own the same function; the profile's cross-task figures are therefore empty by construction.
 */
export async function cutCost({ repoRoot, target, memberTaskIds } = {}) {
  if (!wellFormed(target) || !Array.isArray(memberTaskIds) || memberTaskIds.length === 0) {
    return { profile: null, reasons: ['target_or_members_malformed'] };
  }
  let sourceText;
  try { sourceText = await readFile(path.join(repoRoot, target.path), 'utf8'); } catch { return { profile: null, reasons: ['source_unreadable'] }; }
  // the profile names nodes by their bare name; a qualified `Cls.method` is looked up by its last part.
  const name = target.symbol.split('.').at(-1);
  return computeSeamCostProfile({
    repoRoot, sourcePath: target.path, sourceText,
    ownedSymbolsByTask: { [[...memberTaskIds].sort(compareText).join('+')]: [name] },
  });
}
