// Code graph role, public interface "Touched" (ADR 0204 §4, a6): commit range -> the symbols the hunks changed.
// Plan/lifecycle records the answer on the task; it never reads the diff or the index itself.
import { gitSpawnSync } from './git-process.mjs';
import { runSensorJson, SensorResolveError } from './sensor-resolve.mjs';
import { withObservedTree } from './todo-independence-authoritative-observation.mjs';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

function gitText(repoRoot, args) {
  const result = gitSpawnSync(['-c', 'core.quotepath=off', ...args], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new SensorResolveError('TOUCHED_GIT_FAILED', `git ${args[0]} failed`, { stderr: result.stderr?.trim() ?? result.error?.message });
  }
  return result.stdout;
}

/** `"a b.js"` (git quotes names with special characters) or `a/b.js` -> `b.js`; `/dev/null` -> null. */
function pathOf(text, prefix) {
  const name = text.endsWith('\t') ? text.slice(0, -1) : text;
  if (name === '/dev/null') return null;
  const unquoted = name.startsWith('"') ? JSON.parse(name) : name;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

/** `git diff -U0 --find-renames` text -> `[{path, old_path, status, hunks: [{old_start, old_count, new_start, new_count}]}]`. */
export function parseUnifiedZeroDiff(text) {
  const files = [];
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const names = / a\/(.+) b\/(.+)$/u.exec(line);
      file = { path: names?.[2] ?? '', old_path: null, status: 'modified', hunks: [] };
      files.push(file);
    } else if (file === null) {
      continue;
    } else if (line.startsWith('@@')) {
      const match = HUNK.exec(line);
      if (match !== null) {
        file.hunks.push({
          old_start: Number(match[1]), old_count: match[2] === undefined ? 1 : Number(match[2]),
          new_start: Number(match[3]), new_count: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    } else if (file.hunks.length > 0) {
      continue; // hunk content: a removed `-- sql comment` reads like a `---` header, so headers are only read before the first hunk
    } else if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.old_path = line.slice(12); }
    else if (line.startsWith('rename to ')) file.path = line.slice(10);
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.status = 'binary';
    else if (line.startsWith('+++ ')) { const now = pathOf(line.slice(4), 'b/'); if (now !== null) file.path = now; }
  }
  return files;
}

/**
 * Which symbols did `from..to` change? `to` need not be HEAD: a clean HEAD uses the maintained index (Observe), anything else a
 * disposable worktree of `to` with a fresh index. Never reads the working tree's uncommitted state.
 * -> `{from_sha, to_sha, touched: [{path, symbol, kind, start_line, end_line}], unattributed: [{path, reason, old_range, new_range}]}`
 * `unattributed` (imports, top-level code, deleted functions, renames, binary or unindexed files) counts as file-level, never as
 * "touched nothing".
 */
export async function touchedFunctions({ repoRoot, from, to = 'HEAD' }) {
  const resolve = (ref) => gitText(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const fromSha = resolve(from);
  const toSha = resolve(to);
  const files = parseUnifiedZeroDiff(gitText(repoRoot, [
    'diff', '--no-color', '--no-ext-diff', '--unified=0', '--find-renames', fromSha, toSha,
  ]));
  if (files.length === 0) return { from_sha: fromSha, to_sha: toSha, touched: [], unattributed: [] };
  const answer = await withObservedTree({ repoRoot, sha: toSha },
    (root) => runSensorJson({ command: 'touched', root, request: { files } }));
  return { from_sha: fromSha, to_sha: toSha, touched: answer.touched, unattributed: answer.unattributed };
}
