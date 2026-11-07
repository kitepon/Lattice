import {
  TODO_LIMITS, canonicalizeTodoArtifact, exactRecord, isStrictTodoTimestamp, isTodoDigest,
} from './todo-contracts.mjs';
import { readTodoNoteContextsForPlan } from './todo-note-store.mjs';

export const WORKFLOW_STATE_SCHEMA = 'lattice.workflow_state.v1';
export const WORKFLOW_STATUS_KEYS = Object.freeze([
  'flow_state', 'pr_url', 'ci_url', 'ci_result', 'detail',
  'workflow_note_digest', 'workflow_recorded_at',
]);
const OPTIONAL_INPUT_KEYS = ['pr_url', 'ci_url', 'ci_result', 'detail'];
const STAGES = ['pr', 'ci', 'review', 'clear'];
const CI_RESULTS = ['pass', 'fail', 'running'];
const issue = (path, reason, expected) => ({ path, reason, expected });

function webUrl(value) {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function explainWorkflowState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return issue('/', 'workflow_object_required', { schema: WORKFLOW_STATE_SCHEMA });
  }
  const keys = ['schema', 'stage', ...OPTIONAL_INPUT_KEYS.filter((key) => Object.hasOwn(value, key))];
  if (!exactRecord(value, keys)) return issue('/', 'workflow_fields_invalid', keys);
  if (value.schema !== WORKFLOW_STATE_SCHEMA) return issue('/schema', 'workflow_schema_invalid', WORKFLOW_STATE_SCHEMA);
  if (!STAGES.includes(value.stage)) return issue('/stage', 'workflow_stage_invalid', STAGES);
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    return issue('/detail', 'workflow_detail_must_be_string', 'string');
  }
  if (value.stage === 'clear') {
    if (['pr_url', 'ci_url', 'ci_result'].some((key) => Object.hasOwn(value, key))) {
      return issue('/', 'workflow_clear_has_no_references', ['schema', 'stage', 'detail']);
    }
  } else {
    if (!webUrl(value.pr_url)) return issue('/pr_url', 'workflow_pr_url_required', 'http(s) URL');
    const hasCi = value.stage === 'ci' || value.ci_url !== undefined || value.ci_result !== undefined;
    if (hasCi && !webUrl(value.ci_url)) {
      return issue('/ci_url', 'workflow_ci_url_required', 'http(s) URL');
    }
    if (hasCi && !CI_RESULTS.includes(value.ci_result)) {
      return issue('/ci_result', 'workflow_ci_result_invalid', CI_RESULTS);
    }
  }
  if (Buffer.byteLength(canonicalizeTodoArtifact(value), 'utf8') > TODO_LIMITS.noteBodyBytes) {
    return issue('/', 'workflow_note_too_large', { max_utf8_bytes: TODO_LIMITS.noteBodyBytes });
  }
  return null;
}

/** Store orders each scope by descending sequence; task migration is already projected. */
export function workflowStatusFields(history) {
  for (const note of history) {
    if (note.scope !== 'task' || note.superseded_by != null) continue;
    let value;
    try { value = JSON.parse(note.body); } catch { continue; }
    if (explainWorkflowState(value) !== null) continue;
    if (value.stage === 'clear') return {};
    const fields = { flow_state: value.stage, pr_url: value.pr_url };
    for (const key of ['ci_url', 'ci_result', 'detail']) {
      if (Object.hasOwn(value, key)) fields[key] = value[key];
    }
    return { ...fields, workflow_note_digest: note.event_digest, workflow_recorded_at: note.recorded_at };
  }
  return {};
}

export function validWorkflowStatusFields(value) {
  const keys = WORKFLOW_STATUS_KEYS.filter((key) => Object.hasOwn(value, key));
  if (keys.length === 0) return true;
  if (value.flow_state === 'clear' || !isTodoDigest(value.workflow_note_digest)
    || !isStrictTodoTimestamp(value.workflow_recorded_at)) return false;
  const input = { schema: WORKFLOW_STATE_SCHEMA, stage: value.flow_state };
  for (const key of OPTIONAL_INPUT_KEYS) {
    if (Object.hasOwn(value, key)) input[key] = value[key];
  }
  return explainWorkflowState(input) === null;
}

export async function readTodoWorkflowStates({ repoRoot, store }) {
  const states = [];
  for (const member of store.members) {
    const planKey = member.plan.plan_key;
    const { histories } = await readTodoNoteContextsForPlan({ repoRoot, store,
      planKey, includeHistory: true });
    for (const { task_id, history } of histories) {
      const fields = workflowStatusFields(history);
      if (Object.keys(fields).length > 0) states.push({ plan_key: planKey, task_id, ...fields });
    }
  }
  return states;
}
