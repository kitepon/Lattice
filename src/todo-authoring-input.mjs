/**
 * AIが書くauthoring入力の受理。
 *
 * storeへ書くbytesはこれまでどおりcanonical。入口がpretty-print・digest未計算・
 * repo内絶対pathを拒否するのは、機械が直せるものを儀式にしている。
 * 空の設計メモは直さない——NO_PLANは無策の明示申告であり、欠落から作らない。
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseTree } from 'jsonc-parser';

import { todoSelfDigest } from './todo-contracts.mjs';
import { TodoStoreError } from './todo-store.mjs';

const MAX_AUTHORING_INPUT_BYTES = 8_388_608;

export const AUTHORING_DIGEST_FIELDS = Object.freeze({
  'lattice.plan_backchain.v1': 'chain_digest',
  'lattice.todo_witness_set.v1': 'witness_set_digest',
  'lattice.todo_witness_set.v2': 'witness_set_digest',
  'lattice.todo_witness_set.v3': 'witness_set_digest',
  'lattice.todo_witness_set.v4': 'witness_set_digest',
  'lattice.todo_witness_set.v5': 'witness_set_digest',
  'lattice.todo_extraction.v2': 'extraction_digest',
  'lattice.todo_extraction.v3': 'extraction_digest',
  'lattice.todo_extraction.v4': 'extraction_digest',
  'lattice.plan_create_input.v1': 'input_digest',
  'lattice.plan_create_input.v2': 'input_digest',
  'lattice.plan_create_input.v3': 'input_digest',
  'lattice.plan_create_input.v4': 'input_digest',
  'lattice.todo_revision.v1': 'revision_digest',
  'lattice.todo_revision.v2': 'revision_digest',
  'lattice.phase_todo_revision.v1': 'revision_digest',
  'lattice.phase_todo_revision.v2': 'revision_digest',
  'lattice.phase_todo_revision.v3': 'revision_digest',
  'lattice.phase_todo_revision.v4': 'revision_digest',
  'lattice.todo_revision_set.v1': 'revision_set_digest',
  'lattice.todo_revision_set.v2': 'revision_set_digest',
  'lattice.todo_revision_set.v3': 'revision_set_digest',
  'lattice.phase_accept_input.v1': 'input_digest',
  'lattice.phase_reject_input.v1': 'input_digest',
});

function fail(code, reason, detail) {
  throw new TodoStoreError(code, reason, undefined, detail);
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function hasDuplicateJsonKey(node) {
  if (node?.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (keys.has(key?.value) || hasDuplicateJsonKey(value)) return true;
      keys.add(key?.value);
    }
  } else if (node?.type === 'array') {
    return (node.children ?? []).some(hasDuplicateJsonKey);
  }
  return false;
}

/** CLI引数がauthoring fileを指しているか。repo相対でも絶対でもよい。 */
export function isAuthoringPathToken(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('--');
}

export function parseAuthoringJson(text, { invalidCode = 'INVALID_JSON' } = {}) {
  if (typeof text !== 'string') fail(invalidCode, 'input_json_invalid');
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  const parseErrors = [];
  const tree = parseTree(normalized, parseErrors, { allowTrailingComma: false, disallowComments: true });
  if (parseErrors.length > 0 || tree === undefined) fail(invalidCode, 'json_parse_failed');
  if (hasDuplicateJsonKey(tree)) fail(invalidCode, 'duplicate_key');
  try {
    return JSON.parse(normalized);
  } catch {
    fail(invalidCode, 'json_parse_failed');
  }
  return null;
}

export function repairAuthoringArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const field = AUTHORING_DIGEST_FIELDS[value.schema];
  if (field === undefined) return value;
  const next = { ...value, [field]: typeof value[field] === 'string' ? value[field] : '' };
  next[field] = todoSelfDigest(next, field);
  return next;
}

/**
 * 渡された値がpathでなく本文そのものに見えるか。
 * `--input`/`--evidence`はfileを取るが、AIも人もインラインの文章を渡して詰まる。
 * 詰まった時に「fileを取る／文章なら--message」と言えるように判定する。
 */
function looksLikeProse(value) {
  if (typeof value !== 'string') return false;
  return value.length > 160
    || /[\n\r]/u.test(value)
    || /[、。「」（）]/u.test(value)
    || (/\s/u.test(value) && !/[/\\]/u.test(value));
}

export async function resolveAuthoringInputPath(repoRoot, inputRef, { inlineFlag = null } = {}) {
  if (typeof inputRef !== 'string' || inputRef.length === 0) {
    fail('INPUT_UNREADABLE', 'input_ref_invalid', { input_ref: inputRef });
  }
  const canonicalRoot = await realpath(repoRoot);
  const candidate = path.isAbsolute(inputRef)
    ? inputRef
    : path.resolve(canonicalRoot, inputRef);
  let stats;
  try { stats = await lstat(candidate); } catch {
    fail('INPUT_UNREADABLE', 'input_missing', {
      input_ref: inputRef,
      repo_root: canonicalRoot,
      next_action: looksLikeProse(inputRef)
        ? (inlineFlag
          ? `この引数はrepo内のfile pathを取る。文章をそのまま渡すなら ${inlineFlag} <text> を使う`
          : 'この引数はrepo内のfile pathを取る。渡された値は本文に見える——先にfileへ書いてからそのpathを渡す')
        : `repo内に存在するfile pathを渡す（repo_root: ${canonicalRoot}）`,
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail('INPUT_UNREADABLE', 'unsafe_input_path', { input_ref: inputRef });
  }
  const resolved = await realpath(candidate);
  if (!within(canonicalRoot, resolved) || resolved === canonicalRoot) {
    fail('INPUT_UNREADABLE', 'input_path_outside_repo', {
      input_ref: inputRef,
      repo_root: canonicalRoot,
      next_action: `repo内のfileだけ受理する。repo外(/tmp等)にあるならrepo内へ写してから渡す（repo_root: ${canonicalRoot}）`,
    });
  }
  if (stats.size > MAX_AUTHORING_INPUT_BYTES) fail('INPUT_TOO_LARGE', 'input_size_limit_exceeded');
  const relative = path.relative(canonicalRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    fail('INPUT_UNREADABLE', 'input_path_outside_repo', {
      input_ref: inputRef,
      repo_root: canonicalRoot,
      next_action: `repo内のfileだけ受理する。repo外(/tmp等)にあるならrepo内へ写してから渡す（repo_root: ${canonicalRoot}）`,
    });
  }
  return {
    absolute: resolved,
    inputRef: relative.split(path.sep).join('/'),
    maxBytes: MAX_AUTHORING_INPUT_BYTES,
  };
}

export async function readAuthoringJsonFile(repoRoot, inputRef, {
  invalidCode = 'INVALID_JSON',
  inlineFlag = null,
} = {}) {
  const located = await resolveAuthoringInputPath(repoRoot, inputRef, { inlineFlag });
  const bytes = await readFile(located.absolute);
  if (bytes.length > located.maxBytes) fail('INPUT_TOO_LARGE', 'input_size_limit_exceeded');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(invalidCode, 'invalid_utf8'); }
  const parsed = parseAuthoringJson(text, { invalidCode });
  return repairAuthoringArtifact(parsed);
}

export function parseFlagMap(argv) {
  const flags = Object.create(null);
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--') || token === '--') {
      rest.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && typeof next === 'string' && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { flags, rest };
}

export function flagMapKeys(flags, expected) {
  const actual = Object.keys(flags).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

/**
 * 位置ではなくflag名でwriteコマンドを束ねる。未知flag・位置引数は受理しない。
 * boolean flagは値がtrueのときだけ合法。requiredは非空string。
 */
export function matchFlagCommand(argv, head, { known, required = [], booleans = [] } = {}) {
  if (!Array.isArray(argv) || !Array.isArray(head) || head.some((token, index) => argv[index] !== token)) {
    return null;
  }
  const { flags, rest } = parseFlagMap(argv.slice(head.length));
  if (rest.length > 0) return null;
  if (Object.keys(flags).some((key) => !known.includes(key))) return null;
  for (const key of required) {
    if (typeof flags[key] !== 'string' || flags[key].length === 0) return null;
  }
  for (const key of booleans) {
    if (flags[key] !== undefined && flags[key] !== true) return null;
  }
  return flags;
}
