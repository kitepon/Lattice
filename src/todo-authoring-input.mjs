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

// u03s A57: a set but non-identifier value is treated like an unset one (no refusal).
export function resolveTodoActor(env) {
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
export const DEFAULT_EVIDENCE_SLOT = 'acceptance';
export const DEFAULT_CREATE_INPUT_SCHEMA = 'lattice.plan_create_input.v5';
const DEFAULT_LANE = 'main';
const DEFAULT_GATE_POLICY = 'heavy';
const ISO_DATE_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u;
const absent = (value) => value === undefined || value === null;

// a11: 辺の参照が同じplanを指すなら、作成者はtask_id/phase_idだけ書けばよい。レコードでない参照はvalidatorへ。
function fillRef(ref, projectId, planKey) {
  if (!isRecord(ref)) return ref;
  const filled = { ...ref };
  if (filled.project_id === undefined && projectId !== undefined) filled.project_id = projectId;
  if (filled.plan_key === undefined && planKey !== undefined) filled.plan_key = planKey;
  return filled;
}

// 配列の各レコードだけを補う。配列でない値・レコードでない要素は触らず、validatorの指摘に任せる。
function fillEach(next, key, fill) {
  if (!Array.isArray(next[key])) return;
  next[key] = next[key].map((entry) => (isRecord(entry) ? fill(entry) : entry));
}

export function completeCreateInput(value, { env, now }) {
  if (!isRecord(value)) return value;
  const next = { ...value };
  // a11: schemaを書かなければ現行のcreate入力(v5)。他のschemaを持つ値は作成入力でないのでそのまま返す。
  if (absent(next.schema)) next.schema = DEFAULT_CREATE_INPUT_SCHEMA;
  if (typeof next.schema !== 'string' || !CREATE_INPUT_SCHEMA.test(next.schema)) return value;
  const fillNode = (ref) => fillRef(ref, next.project_id, next.plan_key);
  const phaseInput = next.schema !== 'lattice.plan_create_input.v1';
  const memoInput = ['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5'].includes(next.schema);
  const decoupled = !['lattice.plan_create_input.v1', 'lattice.plan_create_input.v2'].includes(next.schema);
  if (absent(next.actor)) next.actor = resolveTodoActor(env);
  if (absent(next.recorded_at)) next.recorded_at = now.toISOString();
  else if (typeof next.recorded_at === 'string' && ISO_DATE_PREFIX.test(next.recorded_at)) {
    // 厳密形でなくても読める時刻はUTCミリ秒へ寄せる。読めない文字列はvalidatorが拒否する。
    const parsed = new Date(next.recorded_at);
    if (!Number.isNaN(parsed.getTime())) next.recorded_at = parsed.toISOString();
  }
  if (absent(next.hard_dependencies)) next.hard_dependencies = [];
  if (absent(next.joins)) next.joins = [];
  if (decoupled && absent(next.phase_accept_dependencies)) next.phase_accept_dependencies = [];
  fillEach(next, 'hard_dependencies', (edge) => ({ ...edge, from: fillNode(edge.from), to: fillNode(edge.to) }));
  fillEach(next, 'joins', (join) => ({
    ...join,
    ...(Array.isArray(join.after) ? { after: join.after.map(fillNode) } : {}),
    ...('before' in join ? { before: fillNode(join.before) } : {}),
  }));
  if (decoupled) {
    fillEach(next, 'phase_accept_dependencies',
      (edge) => ({ ...edge, from: fillNode(edge.from), to: fillNode(edge.to) }));
  }
  fillEach(next, 'tasks', (task) => {
    const filled = { ...task };
    for (const key of ['narrative_anchor', 'compile_binding', 'parent_task_id', 'narrative_ref']) {
      if (filled[key] === undefined) filled[key] = null;
    }
    if (absent(filled.lane)) filled.lane = DEFAULT_LANE;
    if (next.schema === DEFAULT_CREATE_INPUT_SCHEMA && filled.done_condition === undefined) {
      filled.done_condition = null;
    }
    if (memoInput && (absent(filled.design_memo)
      || (typeof filled.design_memo === 'string' && filled.design_memo.trim() === ''))) {
      filled.design_memo = 'NO_PLAN';
    }
    return filled;
  });
  if (phaseInput) {
    fillEach(next, 'phases', (phase) => {
      const filled = { ...phase };
      if (absent(filled.gate_policy)) filled.gate_policy = DEFAULT_GATE_POLICY;
      if (absent(filled.predecessor_phase_ids)) filled.predecessor_phase_ids = [];
      // 段が要求する証拠の種類を書かなければ、受入の証拠1つ（acceptance）を求める。
      if (absent(filled.required_evidence_slots)
        || (Array.isArray(filled.required_evidence_slots) && filled.required_evidence_slots.length === 0)) {
        filled.required_evidence_slots = [DEFAULT_EVIDENCE_SLOT];
      }
      return filled;
    });
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

/**
 * matchFlagCommand が null を返す理由を、最初に落ちた flag と規則で返す。通るなら null。
 * 規則は matchFlagCommand と同じ順で判定する（未知flag・位置引数、必須flag、boolean）。
 */
export function explainFlagCommand(argv, head, { known, required = [], booleans = [] } = {}) {
  if (!Array.isArray(argv) || !Array.isArray(head) || head.some((token, index) => argv[index] !== token)) {
    return null;
  }
  const { flags, rest } = parseFlagMap(argv.slice(head.length));
  if (rest.length > 0) return { pointer: String(rest[0]), rule: 'flag_unknown' };
  const unknown = Object.keys(flags).find((key) => !known.includes(key));
  if (unknown !== undefined) return { pointer: `--${unknown}`, rule: 'flag_unknown' };
  const missing = required.find((key) => typeof flags[key] !== 'string' || flags[key].length === 0);
  if (missing !== undefined) return { pointer: `--${missing}`, rule: 'flag_missing' };
  const valued = booleans.find((key) => flags[key] !== undefined && flags[key] !== true);
  if (valued !== undefined) return { pointer: `--${valued}`, rule: 'flag_takes_no_value' };
  return null;
}
