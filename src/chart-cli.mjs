// Host connection (a101, docs/architecture/dfd-charts-read.md): K8 addressing, K5 chart creation, K1/K2 chart list
// and change tokens, K4 naming, K7 code-chart repo. A host reads charts only through these commands.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

import { parseFlagMap } from './todo-authoring-input.mjs';
import { TODO_CHARTS_ROOT_ENV } from './todo-external.mjs';
import {
  readTodoChartMeta, readTodoStoreDisplaySource, TodoStoreError, writeTodoChartMeta,
} from './todo-store.mjs';

export const PROJECT_ID_ENV = 'LATTICE_PROJECT_ID';
const SEAT_ID_ENV = 'LATTICE_SEAT_ID';
const MANIFEST = path.join('.lattice', 'todo', 'manifest.json');
// Relative file arguments keep meaning the caller's cwd after K8 moves the process into the chart.
const FILE_FLAGS = new Set(['--input', '--plan-input', '--review']);
const runGit = promisify(execFile);

/** A project id names one direct child of the charts root, never a path. */
function isChartId(id) {
  return typeof id === 'string' && id !== '' && id !== '.' && id !== '..' && !/[/\\\0]/u.test(id);
}

/** Commands that make the chart when it does not exist yet (K5). Reads never create one. */
function createsChart(argv) {
  return (argv[0] === 'plan' && argv[1] === 'create' && !['--schema', '--schema-version', '--template'].includes(argv[2]))
    || (argv[0] === 'chart' && argv[1] === 'set');
}

function refusal(code, reason, detail) {
  return new TodoStoreError(code, reason, undefined, detail);
}

async function lstatOrNull(target) {
  try { return await lstat(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * K8 + K5: with `LATTICE_CHARTS_ROOT` and `LATTICE_PROJECT_ID` both set, the command runs in `<root>/<id>`.
 * Returns `null` when not addressed, else `{dir, created, argv}` (`created` = the dir this run made, for removal on
 * failure). Throws `CHART_PATH_INVALID` (named protection: writes outside the root or through a link) or
 * `CHART_NOT_FOUND` (protection: a read would otherwise run on the caller's cwd, the wrong chart; self-exit: create it).
 */
export async function enterAddressedChart({ env, argv, cwd }) {
  const rootValue = env[TODO_CHARTS_ROOT_ENV];
  const id = env[PROJECT_ID_ENV];
  if (typeof rootValue !== 'string' || rootValue === '' || typeof id !== 'string' || id === '') return null;
  const root = path.resolve(rootValue);
  const dir = path.join(root, id);
  if (!isChartId(id)) {
    throw refusal('CHART_PATH_INVALID', 'chart_id_not_a_name', { project_id: id,
      next_action: `Set ${PROJECT_ID_ENV} to a chart directory name (no path separators).` });
  }
  let stat = await lstatOrNull(dir);
  let created = null;
  if (stat === null && createsChart(argv)) {
    await mkdir(root, { recursive: true });
    try {
      await mkdir(dir, { mode: 0o700 });
      created = dir;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    stat = await lstat(dir);
    if (created !== null) {
      try { await runGit('git', ['init', '--quiet'], { cwd: dir }); } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    }
  }
  if (stat === null) {
    throw refusal('CHART_NOT_FOUND', 'chart_missing', { project_id: id, path: dir,
      next_action: 'lattice chart set --name <text> (or plan create --input <file>) creates the chart' });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw refusal('CHART_PATH_INVALID', 'chart_path_not_a_directory', { project_id: id, path: dir,
      next_action: `Remove or rename ${dir}; a chart is a plain directory under ${TODO_CHARTS_ROOT_ENV}.` });
  }
  const absolute = argv.map((word, index) => (FILE_FLAGS.has(argv[index - 1]) && !word.startsWith('--')
    && !path.isAbsolute(word) ? path.resolve(cwd, word) : word));
  return { dir, created, argv: absolute };
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reasonOf = (error) => error?.detail?.reason ?? error?.code ?? 'chart_unreadable';

/** One chart's identity and change token; never throws (K1/K2). */
async function readChart(root, id) {
  const dir = path.join(root, id);
  const findings = [];
  let meta = null;
  let display = null;
  try { meta = await readTodoChartMeta({ repoRoot: dir }); } catch (error) {
    findings.push({ project_id: id, reason: reasonOf(error) });
  }
  try { display = await readTodoStoreDisplaySource({ repoRoot: dir }); } catch (error) {
    findings.push({ project_id: id, reason: reasonOf(error) });
  }
  return { meta, findings, source: meta === null || display === null ? null : digest([display, meta]) };
}

/** Direct children of the root that hold a Store manifest, sorted; a missing root has none. */
async function chartIds(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
  const ids = [];
  for (const entry of entries) {
    if (entry.isDirectory() && await lstatOrNull(path.join(root, entry.name, MANIFEST)) !== null) ids.push(entry.name);
  }
  return ids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function chartsRoot(env) {
  const value = env[TODO_CHARTS_ROOT_ENV];
  return typeof value === 'string' && value !== '' ? path.resolve(value) : null;
}

/** K1 `lattice.charts_list_result.v1`. */
export async function listCharts(env) {
  const root = chartsRoot(env);
  if (root === null) {
    return { schema: 'lattice.charts_list_result.v1', charts_root: null, charts: [],
      findings: [{ project_id: null, reason: 'charts_root_unset' }] };
  }
  const charts = [];
  const findings = [];
  for (const id of await chartIds(root)) {
    const chart = await readChart(root, id);
    findings.push(...chart.findings);
    charts.push({ project_id: id, name: chart.meta?.name ?? null, created_by: chart.meta?.created_by ?? null,
      created_at: chart.meta?.created_at ?? null, source: chart.source });
  }
  return { schema: 'lattice.charts_list_result.v1', charts_root: root, charts, findings };
}

/** K2 `lattice.charts_source_result.v1`; no ids = every chart; an id with no chart (or unreadable) is null. */
export async function chartSources(env, ids) {
  const root = chartsRoot(env);
  const chosen = ids.length > 0 ? ids : root === null ? [] : await chartIds(root);
  const charts = {};
  for (const id of chosen) {
    const present = root !== null && isChartId(id) && await lstatOrNull(path.join(root, id, MANIFEST)) !== null;
    charts[id] = present ? (await readChart(root, id)).source : null;
  }
  return { schema: 'lattice.charts_source_result.v1', charts };
}

/** BellTeam's rule: 1-40 characters, already trimmed, no control characters. */
function validChartName(value) {
  return typeof value === 'string' && value === value.trim() && [...value].length >= 1 && [...value].length <= 40
    && !/\p{Cc}/u.test(value);
}

async function repoRoot(cwd) {
  try {
    return path.resolve((await runGit('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim());
  } catch {
    throw refusal('REPO_UNRESOLVED', 'git_toplevel_unresolved');
  }
}

function projectIdOf(env, dir) {
  return env[PROJECT_ID_ENV] || path.basename(dir);
}

/** K4 `chart set --name <text> [--created-by <id>]`; `created` = K5 made the chart in this run. */
async function chartSet({ cwd, env, flags, created }) {
  const name = typeof flags.name === 'string' ? flags.name.trim() : null;
  if (!validChartName(name)) {
    throw refusal('CHART_NAME_INVALID', 'chart_name_invalid', { field: '--name',
      rule: '1-40 characters after trimming, no control characters',
      next_action: 'lattice chart set --name <text>' });
  }
  const explicit = typeof flags['created-by'] === 'string' ? flags['created-by'].trim() : undefined;
  if (explicit !== undefined && !validChartName(explicit)) {
    throw refusal('CHART_NAME_INVALID', 'chart_created_by_invalid', { field: '--created-by',
      rule: '1-40 characters after trimming, no control characters',
      next_action: 'lattice chart set --name <text> --created-by <id>' });
  }
  const dir = await repoRoot(cwd);
  const createdBy = explicit ?? (created ? env[SEAT_ID_ENV] || null : undefined);
  const { meta, unchanged } = await writeTodoChartMeta({ repoRoot: dir,
    patch: { name, ...(createdBy === undefined ? {} : { created_by: createdBy }) } });
  return { schema: 'lattice.chart_set_result.v1', project_id: projectIdOf(env, dir), name: meta.name,
    created_by: meta.created_by, created_at: meta.created_at, unchanged };
}

const URL_PATTERN = /^(?:https:\/\/|ssh:\/\/|file:\/\/|git@)[^\s\p{Cc}]+$/u;

/** K7 bind: record `{url, branch, accepted_tip}`; a new url or branch drops the old baseline. */
async function chartRepoBind({ cwd, env, flags }) {
  const { url, branch } = flags;
  if (typeof url !== 'string' || !URL_PATTERN.test(url)) {
    throw refusal('CHART_REPO_INVALID', 'repo_url_invalid', { field: '--url',
      rule: 'https://, ssh://, file:// or git@ URL without spaces', next_action: 'lattice chart repo bind --url <url> --branch <branch>' });
  }
  const branchOk = typeof branch === 'string' && await runGit('git', ['check-ref-format', '--branch', branch], { cwd })
    .then(() => true, () => false);
  if (!branchOk) {
    throw refusal('CHART_REPO_INVALID', 'repo_branch_invalid', { field: '--branch',
      rule: 'a valid git branch name', next_action: 'lattice chart repo bind --url <url> --branch <branch>' });
  }
  const dir = await repoRoot(cwd);
  const current = (await readTodoChartMeta({ repoRoot: dir })).repo;
  const same = current?.url === url && current?.branch === branch;
  const { meta, unchanged } = await writeTodoChartMeta({ repoRoot: dir,
    patch: { repo: { url, branch, accepted_tip: same ? current.accepted_tip ?? null : null } } });
  return { schema: 'lattice.chart_repo_result.v1', project_id: projectIdOf(env, dir), status: 'bound',
    repo: meta.repo, unchanged };
}

/** Run the bundled sensor in process; `{command, exit_code, code}` (`code` = its typed error code or null). */
async function runSensor(command, dir) {
  const { runSensorCli } = await import('./sensor-cli.mjs');
  let errorText = '';
  const sink = () => new Writable({ write(chunk, _encoding, done) { errorText += chunk; done(); } });
  const exitCode = await runSensorCli({ argv: [command, dir, '--json'], stdout: sink(), stderr: sink() });
  const code = errorText.split('\n').map((line) => { try { return JSON.parse(line).code; } catch { return null; } })
    .find((value) => typeof value === 'string') ?? null;
  return { command, exit_code: exitCode, code };
}

/**
 * K7 sync. Named protection: never reset, clean, force or repoint; tracked edits make it `dirty` and a HEAD that is
 * not the accepted baseline makes it `diverged` (nothing moves). Self-exit: a failed step is reported and the next
 * sync tries again. A depth-1 tip has no parent, so `--ff-only` cannot see the link: HEAD moves only from the baseline.
 */
async function chartRepoSync({ cwd, env }) {
  const dir = await repoRoot(cwd);
  const meta = await readTodoChartMeta({ repoRoot: dir });
  const result = (status, fields = {}) => ({ schema: 'lattice.chart_repo_result.v1', project_id: projectIdOf(env, dir),
    status, tip: null, accepted_tip: meta.repo?.accepted_tip ?? null, sensor: null, failure: null, ...fields });
  if (meta.repo === null || meta.repo === undefined) {
    return result('failed', { failure: { step: 'bind', message: 'no repository bound to this chart',
      next_action: 'lattice chart repo bind --url <url> --branch <branch>' } });
  }
  const { url, branch } = meta.repo;
  const git = async (step, args) => {
    try { return (await runGit('git', args, { cwd: dir })).stdout.trim(); } catch (error) {
      throw Object.assign(new Error(String(error?.stderr || error?.message).trim().split('\n')[0]), { step });
    }
  };
  const optional = (args) => runGit('git', args, { cwd: dir }).then(({ stdout }) => stdout.trim() || null, () => null);
  try {
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    const excluded = await readFile(exclude, 'utf8').catch(() => '');
    if (!excluded.split(/\r?\n/u).includes('.lattice/')) {
      await mkdir(path.dirname(exclude), { recursive: true });
      await appendFile(exclude, `${excluded === '' || excluded.endsWith('\n') ? '' : '\n'}.lattice/\n`);
    }
    if (await git('status', ['status', '--porcelain', '--untracked-files=no'])) return result('dirty');
    // A lazily fetching (promisor) clone fetches each missing blob on every full object walk; never fetch lazily.
    for (const key of ['remote.origin.promisor', 'remote.origin.partialclonefilter', 'extensions.partialclone']) {
      await optional(['config', '--unset-all', key]);
    }
    // Charts moved before 0.101.0 kept the baseline in refs/remotes/origin/<branch>.
    const accepted = meta.repo.accepted_tip ?? await optional(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    await git('fetch', ['fetch', '--quiet', '--depth=1', '--no-tags', url, branch]);
    const tip = await git('fetch', ['rev-parse', 'FETCH_HEAD']);
    const head = await optional(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head !== null && head !== tip && head !== accepted) return result('diverged', { tip, accepted_tip: accepted });
    if (head !== tip) await git('checkout', ['checkout', '--quiet', '-B', branch, tip]);
    if (meta.repo.accepted_tip !== tip) {
      await writeTodoChartMeta({ repoRoot: dir, patch: { repo: { url, branch, accepted_tip: tip } } });
    }
    let sensor = await runSensor('sync', dir);
    if (sensor.code === 'LATTICE_SENSOR_NOT_INITIALIZED') sensor = await runSensor('init', dir);
    if (sensor.exit_code !== 0) {
      return result('failed', { tip, accepted_tip: tip, sensor,
        failure: { step: 'sensor', message: sensor.code ?? 'sensor failed' } });
    }
    return result(head === tip ? 'current' : 'synced', { tip, accepted_tip: tip, sensor });
  } catch (error) {
    return result('failed', { failure: { step: error?.step ?? 'sync', message: String(error?.message ?? error) } });
  }
}

function usage(stderr, args) {
  stderr.write(`${JSON.stringify({ schema: 'lattice.cli_error.v2', code: 'USAGE', message: `usage: lattice ${args}`,
    detail: { next_action: 'lattice chart --help' } })}\n`);
  return 2;
}

function failure(stderr, error) {
  stderr.write(`${JSON.stringify({ schema: 'lattice.cli_error.v2', code: error?.code ?? 'INTERNAL_FAILURE',
    message: error?.message ?? String(error), detail: error?.detail ?? null })}\n`);
  return 1;
}

/** `lattice charts list|source` (root-level, never addressed) and `lattice chart set|repo bind|repo sync`. */
export async function runChartCli({ argv, cwd, env, stdout, stderr, created = false }) {
  const words = argv.filter((word) => word !== '--json');
  const [group, command, sub] = words;
  try {
    let result;
    if (group === 'charts' && command === 'list' && words.length === 2) {
      result = await listCharts(env);
    } else if (group === 'charts' && command === 'source') {
      const ids = [];
      for (let index = 2; index < words.length; index += 2) {
        if (words[index] !== '--project' || words[index + 1] === undefined) return usage(stderr, 'charts source [--project <id>]... [--json]');
        ids.push(words[index + 1]);
      }
      result = await chartSources(env, ids);
    } else if (group === 'chart' && command === 'set') {
      const { flags, rest } = parseFlagMap(words.slice(2));
      if (rest.length > 0 || Object.keys(flags).some((key) => !['name', 'created-by'].includes(key))) {
        return usage(stderr, 'chart set --name <text> [--created-by <id>] [--json]');
      }
      result = await chartSet({ cwd, env, flags, created });
    } else if (group === 'chart' && command === 'repo' && sub === 'bind') {
      const { flags, rest } = parseFlagMap(words.slice(3));
      if (rest.length > 0 || Object.keys(flags).some((key) => !['url', 'branch'].includes(key))) {
        return usage(stderr, 'chart repo bind --url <url> --branch <branch> [--json]');
      }
      result = await chartRepoBind({ cwd, env, flags });
    } else if (group === 'chart' && command === 'repo' && sub === 'sync' && words.length === 3) {
      result = await chartRepoSync({ cwd, env });
    } else {
      return usage(stderr, `${group} --help`);
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    return failure(stderr, error);
  }
}
