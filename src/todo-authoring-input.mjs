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

import { canonicalizeTodoArtifact, isTodoIdentifier, todoSelfDigest } from './todo-contracts.mjs';
import { readOrCreateTerminalIdSync, terminalPublicLabel } from './terminal-identity.mjs';
import { TodoStoreError } from './todo-store.mjs';

const MAX_AUTHORING_INPUT_BYTES = 8_388_608;
const ACTOR_ENV_KEYS = Object.freeze([
  'LATTICE_TODO_ACTOR_HOST',
  'LATTICE_TODO_ACTOR_SESSION',
  'LATTICE_TODO_ACTOR_AGENT',
]);

function sanitizeActorIdentifier(raw, fallback) {
  const compact = String(raw ?? '').replace(/[^0-9A-Za-z._-]/gu, '-').replace(/^-+/u, '').slice(0, 128);
  return isTodoIdentifier(compact) ? compact : fallback;
}

/**
 * 名乗りの無い操作のhost（ADR 0197）。journalは公開repositoryへcommitされるので、OSのhost名は
 * 書かない——host名はOSが決めた自由文で、持ち主の名前を含むことがある。端末ごとの識別子から
 * 一方向に導いたlabelを使い、端末の区別は保つ。識別子を読めず作れない端末は`host`になる。
 */
function defaultActorHost(env) {
  const terminalId = readOrCreateTerminalIdSync({ env });
  return terminalId === null ? 'host' : terminalPublicLabel(terminalId);
}

export function resolveTodoActor(env) {
  const provided = ACTOR_ENV_KEYS.map((key) => ({ key, value: env[key] }));
  const invalidEnvironment = provided
    .filter(({ value }) => typeof value === 'string' && value.length > 0 && !isTodoIdentifier(value))
    .map(({ key }) => key);
  if (invalidEnvironment.length > 0) {
    throw new TodoStoreError('ACTOR_UNRESOLVED', 'actor_environment_invalid', undefined, {
      required_environment: ACTOR_ENV_KEYS,
      missing_environment: [],
      invalid_environment: invalidEnvironment,
      next_action: 'set_required_actor_environment_and_retry',
    });
  }
  return {
    host: isTodoIdentifier(env.LATTICE_TODO_ACTOR_HOST)
      ? env.LATTICE_TODO_ACTOR_HOST
      : defaultActorHost(env),
    session: isTodoIdentifier(env.LATTICE_TODO_ACTOR_SESSION)
      ? env.LATTICE_TODO_ACTOR_SESSION
      : 'session',
    agent: isTodoIdentifier(env.LATTICE_TODO_ACTOR_AGENT)
      ? env.LATTICE_TODO_ACTOR_AGENT
      : sanitizeActorIdentifier(env.USER ?? env.LOGNAME, 'agent'),
  };
}

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
  'lattice.plan_create_input.v5': 'input_digest',
  'lattice.todo_revision.v1': 'revision_digest',
  'lattice.todo_revision.v2': 'revision_digest',
  'lattice.phase_todo_revision.v1': 'revision_digest',
  'lattice.phase_todo_revision.v2': 'revision_digest',
  'lattice.phase_todo_revision.v3': 'revision_digest',
  'lattice.phase_todo_revision.v4': 'revision_digest',
  'lattice.phase_todo_revision.v5': 'revision_digest',
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

// todo-contractsのcompareText/refKey/phaseRefKeyと同じ比較。validatorが要求する正準順そのもの。
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const refKey = (value) => `${value?.project_id}\0${value?.plan_key}\0${value?.task_id}`;
const phaseRefKey = (value) => `${value?.project_id}\0${value?.plan_key}\0${value?.phase_id}`;

/** 正準順へ整列し、完全一致の重複だけを落とす。同じkeyで内容が違うものは残し、validatorに拒否させる。 */
function sortUnique(list, key) {
  if (!Array.isArray(list)) return list;
  const seen = new Set();
  const kept = [];
  for (const entry of list) {
    const identity = canonicalizeTodoArtifact(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push({ entry, sortKey: key(entry), index: kept.length });
  }
  return kept.sort((left, right) => compareText(left.sortKey, right.sortKey) || left.index - right.index)
    .map(({ entry }) => entry);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const CREATE_INPUT_SCHEMA = /^lattice\.plan_create_input\.v[1-5]$/u;

/**
 * plan_create_input.v1〜v5: 並びに作成者の意味が無い集合を、入力順に依らず正準形へ寄せる(u03p A81s)。
 * 形が壊れていれば触らず、validatorの指摘に任せる。
 */
function normalizeCreateInput(value) {
  const normalizers = {
    tasks: (list) => sortUnique(list, (task) => task?.task_id),
    hard_dependencies: (list) => sortUnique(list, (edge) => `${refKey(edge?.from)}\0${refKey(edge?.to)}`),
    phase_accept_dependencies: (list) => sortUnique(list,
      (edge) => `${phaseRefKey(edge?.from)}\0${refKey(edge?.to)}`),
    joins: (list) => (Array.isArray(list)
      ? sortUnique(list.map((join) => (isRecord(join)
        ? { ...join, after: sortUnique(join.after, refKey) } : join)), (join) => join?.id) : list),
    phases: (list) => (Array.isArray(list)
      ? sortUnique(list.map((phase) => (isRecord(phase) ? {
        ...phase,
        predecessor_phase_ids: sortUnique(phase.predecessor_phase_ids, (id) => id),
        required_evidence_slots: sortUnique(phase.required_evidence_slots, (id) => id),
      } : phase)), (phase) => phase?.phase_id) : list),
  };
  try {
    const next = { ...value };
    for (const [field, normalize] of Object.entries(normalizers)) {
      if (field in next) next[field] = normalize(next[field]);
    }
    return next;
  } catch {
    return value;
  }
}

export function repairAuthoringArtifact(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const field = AUTHORING_DIGEST_FIELDS[value.schema];
  if (field === undefined) return value;
  const base = CREATE_INPUT_SCHEMA.test(value.schema) ? normalizeCreateInput(value) : value;
  const next = { ...base, [field]: typeof base[field] === 'string' ? base[field] : '' };
  next[field] = todoSelfDigest(next, field);
  return next;
}

/**
 * 機械が出せる事実を作成入力へ補う(u03p A81/A80)。AIは意図(tasks・依存)だけを書く:
 * actorは席の解決値、recorded_atは現在時刻、v4/v5の空の設計メモはNO_PLAN、配列は正準順、
 * input_digestは再計算。作成入力でない値と、レコードでない値はそのまま返す。
 */
export function completeCreateInput(value, { env, now }) {
  if (!isRecord(value) || !CREATE_INPUT_SCHEMA.test(value.schema)) return value;
  const next = { ...value };
  if (next.actor === undefined || next.actor === null) next.actor = resolveTodoActor(env);
  if (next.recorded_at === undefined || next.recorded_at === null) next.recorded_at = now.toISOString();
  if (['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5'].includes(next.schema)
    && Array.isArray(next.tasks)) {
    next.tasks = next.tasks.map((task) => (isRecord(task)
      && (task.design_memo === undefined || task.design_memo === null
        || (typeof task.design_memo === 'string' && task.design_memo.trim() === ''))
      ? { ...task, design_memo: 'NO_PLAN' } : task));
  }
  return repairAuthoringArtifact(next);
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
