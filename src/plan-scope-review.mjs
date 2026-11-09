import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitSync } from './git-process.mjs';
import {
  exactRecord,
  isTodoDigest,
  isTodoIdentifier,
  isTodoRef,
  todoSelfDigest,
} from './todo-contracts.mjs';
import { TodoStoreError } from './todo-store.mjs';

const REVIEW_SCHEMA = 'lattice.plan_scope_review.v1';
const RESULT_SCHEMA = 'lattice.plan_scope_review_result.v1';
// a31: 席が書く既定（v5、template）も審査できる。schemaを省いた入力はv5として読む（plan createと同じ）。
const PLAN_CREATE_SCHEMAS = new Set(['lattice.plan_create_input.v4', 'lattice.plan_create_input.v5']);
const DEFAULT_PLAN_CREATE_SCHEMA = 'lattice.plan_create_input.v5';
const TODO_EXTRACTION_SCHEMAS = new Set([
  'lattice.todo_extraction.v3',
  'lattice.todo_extraction.v4',
]);
const MAX_INPUT_BYTES = 8_388_608;
const JUDGMENTS = new Set(['required', 'out_of_scope']);

function boundedText(value) {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value) <= 16_384;
}

function sortedStrictly(values, key = (value) => value) {
  return values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));
}

function within(root, candidate) {
  return candidate.startsWith(`${root}${path.sep}`);
}

function resolveRepoRoot(cwd) {
  try {
    return path.resolve(gitSync(['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\r?\n$/u, ''));
  } catch {
    return null;
  }
}

async function readJsonWithinRepo(repoRoot, inputRef) {
  if (!isTodoRef(inputRef)) {
    throw new TodoStoreError('INPUT_UNREADABLE', 'input_path_outside_repo', undefined,
      { input_ref: inputRef });
  }
  const canonicalRoot = await realpath(repoRoot);
  const absolute = path.resolve(canonicalRoot, inputRef);
  if (!within(canonicalRoot, absolute)) {
    throw new TodoStoreError('INPUT_UNREADABLE', 'input_path_outside_repo', undefined,
      { input_ref: inputRef });
  }
  let stats;
  try { stats = await lstat(absolute); } catch {
    // a27: 無いfileは原因(input_missing)と解いた場所(repo_root)を言う。どのflagかはCLIの文脈が名指す。
    throw new TodoStoreError('INPUT_UNREADABLE', 'input_missing', undefined,
      { input_ref: inputRef, repo_root: canonicalRoot });
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_INPUT_BYTES
    || await realpath(absolute) !== absolute) {
    throw new TodoStoreError('INPUT_UNREADABLE', 'input_path_unsafe', undefined,
      { input_ref: inputRef });
  }
  let value;
  try { value = JSON.parse(await readFile(absolute, 'utf8')); } catch {
    throw new TodoStoreError('INPUT_INVALID', 'input_json_invalid', undefined,
      { input_ref: inputRef });
  }
  return value;
}

function authoredPlan(value) {
  const createInput = value !== null && typeof value === 'object' && !Array.isArray(value)
    && (PLAN_CREATE_SCHEMAS.has(value.schema) || value.schema === undefined);
  const digestField = createInput ? 'input_digest'
    : TODO_EXTRACTION_SCHEMAS.has(value?.schema) ? 'extraction_digest' : null;
  if (digestField === null) {
    throw new TodoStoreError('PLAN_SCOPE_REVIEW_INVALID', 'authoring_schema_unsupported', undefined, {
      pointer: '/schema', expected: [...PLAN_CREATE_SCHEMAS, ...TODO_EXTRACTION_SCHEMAS],
      actual: typeof value?.schema === 'string' ? value.schema : null,
    });
  }
  // a31: digestは機械が計算する。書かれていなければ本文から求め、書かれていて違えば期待値を返す。
  const digest = todoSelfDigest(value, digestField);
  if (value[digestField] !== undefined && value[digestField] !== '' && value[digestField] !== digest) {
    throw new TodoStoreError('PLAN_SCOPE_REVIEW_INVALID', 'authoring_digest_mismatch', undefined, {
      pointer: `/${digestField}`, expected: digest, actual: value[digestField],
      next_action: `Omit ${digestField} (the machine computes it) or set it to "${digest}".`,
    });
  }
  const selected = TODO_EXTRACTION_SCHEMAS.has(value.schema)
    ? value.tasks?.filter((task) => typeof task?.disposition === 'string'
      && task.disposition.startsWith('register_'))
    : value.tasks;
  if (!Array.isArray(selected) || selected.length === 0
    || selected.some((task) => !isTodoIdentifier(task?.task_id))) {
    throw new TodoStoreError('PLAN_SCOPE_REVIEW_INVALID', 'authoring_tasks_invalid', undefined, {
      pointer: '/tasks',
    });
  }
  const taskIds = selected.map(({ task_id: taskId }) => taskId).sort();
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TodoStoreError('PLAN_SCOPE_REVIEW_INVALID', 'authoring_task_ids_duplicate', undefined, {
      pointer: '/tasks',
    });
  }
  return { schema: value.schema ?? DEFAULT_PLAN_CREATE_SCHEMA, digest, taskIds };
}

function invalid(reason, pointer, detail = {}) {
  throw new TodoStoreError('PLAN_SCOPE_REVIEW_INVALID', reason, undefined, { pointer, ...detail });
}

const REVIEW_KEYS = ['schema', 'authoring_digest', 'work_specs', 'task_assessments', 'verdict', 'review_digest'];

/** a31: 席は判断だけを書く。authoring_digestとreview_digestは省けば機械が埋める（書けば照合する）。 */
function completeReview(review, authored) {
  if (review === null || typeof review !== 'object' || Array.isArray(review)) return review;
  const filled = { ...review };
  if (filled.authoring_digest === undefined || filled.authoring_digest === '') filled.authoring_digest = authored.digest;
  if (filled.review_digest === undefined || filled.review_digest === '') {
    filled.review_digest = todoSelfDigest(filled, 'review_digest');
  }
  return filled;
}

function validateReview(review, authored) {
  if (!exactRecord(review, REVIEW_KEYS) || review.schema !== REVIEW_SCHEMA) {
    invalid('review_schema_invalid', exactRecord(review, REVIEW_KEYS) ? '/schema' : '/', {
      expected: { schema: REVIEW_SCHEMA, keys: [...REVIEW_KEYS].sort() },
      actual: review !== null && typeof review === 'object' ? { keys: Object.keys(review).sort() } : null,
    });
  }
  if (!isTodoDigest(review.authoring_digest) || review.authoring_digest !== authored.digest) {
    invalid('review_authoring_digest_mismatch', '/authoring_digest', {
      expected: authored.digest, actual: review.authoring_digest ?? null,
    });
  }
  if (!isTodoDigest(review.review_digest)
    || review.review_digest !== todoSelfDigest(review, 'review_digest')) {
    invalid('review_digest_mismatch', '/review_digest', {
      expected: todoSelfDigest(review, 'review_digest'), actual: review.review_digest ?? null,
    });
  }
  if (!Array.isArray(review.work_specs) || review.work_specs.length === 0
    || !review.work_specs.every((spec) => exactRecord(spec, [
      'work_spec_id', 'requirement', 'acceptance',
    ]) && isTodoIdentifier(spec.work_spec_id) && boundedText(spec.requirement)
      && boundedText(spec.acceptance))
    || !sortedStrictly(review.work_specs, ({ work_spec_id: id }) => id)) {
    invalid('work_specs_invalid', '/work_specs');
  }
  const workSpecIds = new Set(review.work_specs.map(({ work_spec_id: id }) => id));
  if (!Array.isArray(review.task_assessments)
    || !review.task_assessments.every((assessment) => exactRecord(assessment, [
      'task_id', 'work_spec_ids', 'judgment', 'reason',
    ]) && isTodoIdentifier(assessment.task_id) && Array.isArray(assessment.work_spec_ids)
      && assessment.work_spec_ids.every(isTodoIdentifier)
      && sortedStrictly(assessment.work_spec_ids) && JUDGMENTS.has(assessment.judgment)
      && boundedText(assessment.reason)
      && (assessment.judgment === 'required'
        ? assessment.work_spec_ids.length > 0 : assessment.work_spec_ids.length === 0)
      && assessment.work_spec_ids.every((id) => workSpecIds.has(id)))
    || !sortedStrictly(review.task_assessments, ({ task_id: id }) => id)) {
    invalid('task_assessments_invalid', '/task_assessments');
  }
  const assessedTaskIds = review.task_assessments.map(({ task_id: id }) => id);
  if (assessedTaskIds.length !== authored.taskIds.length
    || assessedTaskIds.some((id, index) => id !== authored.taskIds[index])) {
    invalid('task_assessments_incomplete', '/task_assessments', {
      expected_task_ids: authored.taskIds, actual_task_ids: assessedTaskIds,
    });
  }
  const outOfScopeTaskIds = review.task_assessments
    .filter(({ judgment }) => judgment === 'out_of_scope')
    .map(({ task_id: id }) => id);
  const covered = new Set(review.task_assessments.flatMap(({ work_spec_ids: ids }) => ids));
  const uncoveredWorkSpecIds = [...workSpecIds].filter((id) => !covered.has(id));
  const expectedVerdict = outOfScopeTaskIds.length === 0 && uncoveredWorkSpecIds.length === 0
    ? 'scope_preserved' : 'scope_mismatch';
  if (review.verdict !== expectedVerdict) {
    invalid('review_verdict_inconsistent', '/verdict', {
      expected: expectedVerdict, actual: review.verdict ?? null,
    });
  }
  return { outOfScopeTaskIds, uncoveredWorkSpecIds };
}

export function evaluatePlanScopeReview(planInput, authoredReview) {
  const authored = authoredPlan(planInput);
  const review = completeReview(authoredReview, authored);
  const findings = validateReview(review, authored);
  const result = {
    schema: RESULT_SCHEMA,
    authoring_schema: authored.schema,
    authoring_digest: authored.digest,
    work_spec_count: review.work_specs.length,
    reviewed_task_count: review.task_assessments.length,
    verdict: review.verdict,
    accepted: review.verdict === 'scope_preserved',
    out_of_scope_task_ids: findings.outOfScopeTaskIds,
    uncovered_work_spec_ids: findings.uncoveredWorkSpecIds,
    review_digest: review.review_digest,
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

export async function runPlanScopeReview({ cwd, planInputRef, reviewRef, stdout }) {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === null) throw new TodoStoreError('REPO_UNRESOLVED', 'git_toplevel_unresolved');
  const [planInput, review] = await Promise.all([
    readJsonWithinRepo(repoRoot, planInputRef), readJsonWithinRepo(repoRoot, reviewRef),
  ]);
  const result = evaluatePlanScopeReview(planInput, review);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result.accepted ? 0 : 1;
}

export async function runPlanScopeReviewSchema({ stdout }) {
  const schemaUrl = new URL('../docs/schemas/lattice.plan_scope_review.v1.schema.json', import.meta.url);
  const handle = await open(schemaUrl, fsConstants.O_RDONLY);
  try {
    const schema = JSON.parse(await handle.readFile('utf8'));
    if (schema?.title !== REVIEW_SCHEMA) throw new TypeError('bundled plan scope review schema invalid');
    stdout.write(`${JSON.stringify(schema)}\n`);
    return 0;
  } finally {
    await handle.close();
  }
}
