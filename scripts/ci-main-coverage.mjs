import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Main-push coverage (gate owner Shiratsuru, 2026-11-08). A push to main skips its full test
 * gate only when the merged PR's latest CI run tested exactly the pushed tree with the full
 * (unscoped) gate and every gate OS concluded success. Anything missing, ambiguous or
 * unreadable runs the full gate; the lookup never fails the push.
 *   record: on a PR, print the tested merge sha, tree and scope as step outputs.
 *   decide: on a main push, print covered=true|false and write the reason to the job summary.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const GATE_OSES = Object.freeze(['macos-native', 'linux-workstation', 'windows-native']);
// The PR run records what it tested in a classify step name; the jobs API returns rendered names.
const TESTED = /^tested merge ([0-9a-f]{40}) tree ([0-9a-f]{40}) scope (full|scoped)$/u;

/** Pure decision over one PR run's latest jobs (`filter=latest`). */
export function decideCoverage({ pushedTree, pr, run, jobs }) {
  if (!pr || !run || !Array.isArray(jobs)) return { covered: false, reason: 'no merged PR run found' };
  const tested = jobs.flatMap((job) => job.steps ?? []).map((step) => TESTED.exec(step.name ?? '')).find(Boolean);
  if (!tested) return { covered: false, reason: `PR #${pr} run ${run.id} recorded no tested tree` };
  const [, mergeSha, tree, scope] = tested;
  if (tree !== pushedTree) return { covered: false, reason: `PR #${pr} run ${run.id} tested tree ${tree}, pushed ${pushedTree}` };
  if (scope !== 'full') return { covered: false, reason: `PR #${pr} run ${run.id} ran the scoped gate` };
  for (const os of GATE_OSES) {
    const job = jobs.find((candidate) => candidate.name === `full / full (${os})`);
    if (job?.conclusion !== 'success') {
      return { covered: false, reason: `PR #${pr} run ${run.id} ${os}: ${job?.conclusion ?? 'missing'}` };
    }
  }
  return { covered: true, reason: `covered by PR #${pr} run ${run.id} (merge ${mergeSha}, tree ${tree})` };
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function api(route) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}${route}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GET ${route}: HTTP ${response.status}`);
  return response.json();
}

async function lookup(sha) {
  const pulls = await api(`/commits/${sha}/pulls`);
  const pull = pulls.find((candidate) => candidate.merge_commit_sha === sha && candidate.merged_at);
  if (!pull) return {};
  const { workflow_runs: runs } = await api(`/actions/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=50`);
  const run = runs.filter((candidate) => candidate.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.id - a.id)[0];
  if (!run) return { pr: pull.number };
  const { jobs } = await api(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  return { pr: pull.number, run, jobs };
}

function output(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'record') {
    const { collectTests, testRoot } = await import('./run-product-tests.mjs');
    const { computeCiScope } = await import('./ci-scope.mjs');
    const scope = await computeCiScope(process.env.LATTICE_CI_BASE || null, { allTests: (await collectTests(testRoot)).sort() });
    output(`merge=${git('rev-parse', 'HEAD')}`);
    output(`tree=${git('rev-parse', 'HEAD^{tree}')}`);
    output(`scope=${scope.full ? 'full' : 'scoped'}`);
  } else if (mode === 'decide') {
    let decision;
    try {
      decision = decideCoverage({ pushedTree: git('rev-parse', 'HEAD^{tree}'), ...await lookup(git('rev-parse', 'HEAD')) });
    } catch (error) {
      decision = { covered: false, reason: `lookup failed: ${error.message}` };
    }
    console.log(`main coverage: ${decision.covered ? 'skip full gate' : 'run full gate'} (${decision.reason})`);
    output(`covered=${decision.covered}`);
    output(`reason=${decision.reason}`);
  } else {
    console.error('usage: ci-main-coverage.mjs record|decide');
    process.exitCode = 2;
  }
}
