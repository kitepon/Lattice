// Host connection (a101): K8 addressing, K5 creation, K1/K2 list and tokens, K4 naming, K7 code-chart repo.
// docs/architecture/dfd-charts-read.md

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../bin/lattice.mjs');
const exists = (target) => access(target).then(() => true, () => false);

async function workspace(context) {
  const base = await mkdtemp(path.join(tmpdir(), 'lattice-charts-'));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'charts');
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: base, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LATTICE_DASHBOARD_AUTOSTART: '0', LATTICE_RUNTIME_ERROR_REPORTING: '0',
      LATTICE_TODO_ACTOR_HOST: 'fixture', LATTICE_TODO_ACTOR_SESSION: 'fixture', LATTICE_TODO_ACTOR_AGENT: 'bot-a',
      LATTICE_SEAT_ID: 'bot-a', LATTICE_CHARTS_ROOT: root, LATTICE_PROJECT_ID: '', ...extra } });
  const ok = (args, extra) => {
    const result = run(args, extra);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  const refused = (args, extra) => {
    const result = run(args, extra);
    assert.notEqual(result.status, 0, `${args.join(' ')} should refuse\n${result.stdout}`);
    return JSON.parse(result.stderr.trim().split('\n').at(-1));
  };
  // Relative to the caller's cwd (base): K8 keeps --input meaning that file after moving into the chart.
  await writeFile(path.join(base, 'plan.json'), JSON.stringify({
    schema: 'lattice.plan_create_input.v5', plan_key: 'a', phases: [{ phase_id: 'p', title: 'phase' }],
    tasks: [{ task_id: 'T', title: 'T', phase_id: 'p', lane: 'bot-a', design_memo: 'NO_PLAN' }], hard_dependencies: [],
  }));
  return { base, root, run, ok, refused };
}

test('K8/K5/K4/K1/K2: plan create and chart set address and create charts; list and tokens follow them', async (context) => {
  const { root, ok, refused, run } = await workspace(context);
  const alpha = { LATTICE_PROJECT_ID: 'alpha' };

  // A read never creates; a failed creating command removes only the dir it made.
  assert.equal(refused(['todo', 'display', 'read', '--json'], alpha).code, 'CHART_NOT_FOUND');
  assert.notEqual(run(['plan', 'create', '--input', 'missing.json'], alpha).status, 0);
  assert.equal(await exists(path.join(root, 'alpha')), false);

  ok(['plan', 'create', '--input', 'plan.json'], alpha);
  assert.equal(await exists(path.join(root, 'alpha', '.git')), true);
  assert.deepEqual(ok(['charts', 'list', '--json']).charts.map(({ project_id: id, created_by: by }) => [id, by]),
    [['alpha', 'bot-a']]);

  const before = ok(['charts', 'source', '--project', 'alpha', '--project', 'gone', '--json']).charts;
  assert.equal(typeof before.alpha, 'string');
  assert.equal(before.gone, null);
  const named = ok(['chart', 'set', '--name', ' Alpha chart ', '--created-by', 'someone-else', '--json'], alpha);
  assert.deepEqual([named.schema, named.project_id, named.name, named.created_by, named.unchanged],
    ['lattice.chart_set_result.v1', 'alpha', 'Alpha chart', 'bot-a', false]);
  assert.equal(ok(['chart', 'set', '--name', 'Alpha chart', '--json'], alpha).unchanged, true);
  assert.notEqual(ok(['charts', 'source', '--json']).charts.alpha, before.alpha);
  assert.equal(refused(['chart', 'set', '--name', 'x'.repeat(41), '--json'], alpha).code, 'CHART_NAME_INVALID');

  // Identity may precede the first plan: chart set creates the chart; it is listed once it holds a Store.
  const beta = ok(['chart', 'set', '--name', 'Beta', '--json'], { LATTICE_PROJECT_ID: 'beta' });
  assert.equal(beta.created_by, 'bot-a');
  assert.deepEqual(ok(['charts', 'list', '--json']).charts.map(({ project_id: id, name }) => [id, name]),
    [['alpha', 'Alpha chart']]);

  // a102 migration of a nameless chart with no recorded creator: --created-by alone keeps the name null.
  const gamma = { LATTICE_PROJECT_ID: 'gamma' };
  ok(['plan', 'create', '--input', 'plan.json'], { ...gamma, LATTICE_SEAT_ID: '' });
  const moved = ok(['chart', 'set', '--created-by', 'bot-old', '--json'], gamma);
  assert.deepEqual([moved.name, moved.created_by, moved.unchanged], [null, 'bot-old', false]);
  const again = ok(['chart', 'set', '--created-by', 'bot-new', '--json'], gamma);
  assert.deepEqual([again.name, again.created_by, again.unchanged], [null, 'bot-old', true]);
  const neither = refused(['chart', 'set', '--json'], gamma);
  assert.deepEqual([neither.code, neither.detail?.field], ['CHART_NAME_INVALID', '--name'], JSON.stringify(neither));

  await writeFile(path.join(root, 'file'), 'not a chart');
  assert.equal(refused(['todo', 'status', '--json'], { LATTICE_PROJECT_ID: 'file' }).code, 'CHART_PATH_INVALID');
  assert.equal(refused(['todo', 'status', '--json'], { LATTICE_PROJECT_ID: '..' }).code, 'CHART_PATH_INVALID');
  assert.deepEqual(ok(['charts', 'list', '--json'], { LATTICE_CHARTS_ROOT: '' }).findings,
    [{ project_id: null, reason: 'charts_root_unset' }]);
});

test('K7: chart repo bind/sync moves only from the accepted tip and never over local edits', async (context) => {
  const { base, root, ok, refused } = await workspace(context);
  const code = { LATTICE_PROJECT_ID: 'code' };
  const upstream = path.join(base, 'upstream');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (message) => {
    writeFileSync(path.join(upstream, 'a.txt'), message);
    git(upstream, 'add', 'a.txt');
    git(upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', message);
    return git(upstream, 'rev-parse', 'HEAD');
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', upstream]);
  const first = commit('one');
  const url = pathToFileURL(upstream).href;

  ok(['plan', 'create', '--input', 'plan.json'], code);
  assert.equal(refused(['chart', 'repo', 'bind', '--url', 'not a url', '--branch', 'main', '--json'], code).code,
    'CHART_REPO_INVALID');
  assert.equal(ok(['chart', 'repo', 'bind', '--url', url, '--branch', 'main', '--json'], code).repo.accepted_tip, null);

  const synced = ok(['chart', 'repo', 'sync', '--json'], code);
  assert.deepEqual([synced.status, synced.tip, synced.accepted_tip], ['synced', first, first], JSON.stringify(synced));
  assert.equal(ok(['chart', 'repo', 'sync', '--json'], code).status, 'current');

  const chart = path.join(root, 'code');
  writeFileSync(path.join(chart, 'a.txt'), 'local edit');
  assert.equal(ok(['chart', 'repo', 'sync', '--json'], code).status, 'dirty');
  git(chart, 'checkout', '--', 'a.txt');
  git(chart, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'local');
  commit('two');
  const diverged = ok(['chart', 'repo', 'sync', '--json'], code);
  assert.deepEqual([diverged.status, diverged.accepted_tip], ['diverged', first]);
  assert.notEqual(git(chart, 'rev-parse', 'HEAD'), diverged.tip);
});

function writeFileSync(target, text) {
  execFileSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(text)})`]);
}
