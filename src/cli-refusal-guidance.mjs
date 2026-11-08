// Every plan/todo CLI refusal says where (pointer), which rule (rule) and how to repair
// (next_action) in one detail. Pure: reads only the error and the CLI context, no I/O.
// Refusal sites keep their own keys; this fills the three keys the seat contract requires.

const PLACEHOLDER = /^[a-z_]+$/u;
const EXAMPLE_TIMESTAMP = '2026-11-08T12:00:00.000Z';

const q = (value) => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));
const names = (values) => `[${values.join(', ')}]`;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
const planOf = (detail, ctx) => ctx.plan ?? detail.plan_key ?? '<plan>';
const taskOf = (detail, ctx) => ctx.task ?? detail.task_id ?? detail.requested_task_id ?? '<task>';
const migratedTask = (detail) => detail.from_task_id ?? '<task>';
const run = (ctx, ...tail) => ['lattice', ctx.family ?? 'todo', ctx.command, ...tail].filter(Boolean).join(' ');
const schemaCommand = (ctx) => run(ctx, '--schema', '--json');
const showTask = (detail, ctx) => `lattice todo show --plan ${planOf(detail, ctx)} --task ${taskOf(detail, ctx)} --json`;
const startTask = (detail, ctx) => `lattice todo start --plan ${planOf(detail, ctx)} --task ${taskOf(detail, ctx)}`;

/** The flag that carried the unreadable input: the one whose value is the refused path. */
function inputFlag(detail, ctx) {
  const flags = record(ctx.flags) ? ctx.flags : {};
  const byValue = Object.keys(flags).find((name) => flags[name] === detail.input_ref);
  return `--${byValue ?? ['input', 'evidence', 'test-result', 'message'].find((key) => key in flags) ?? 'input'}`;
}

function movedAfter(detail, ctx, pointer) {
  const where = record(detail.expected) ? detail.expected.greater_than : undefined;
  return `Move ${q(detail.actual)} after ${q(where)}; ${pointer} must be ascending and unique.`;
}

function keyDifference(detail, ctx, pointer) {
  const expected = strings(detail.expected?.keys);
  if (!Array.isArray(detail.actual?.keys)) {
    return `At ${pointer} provide an object with exactly the keys ${names(expected)}.`;
  }
  const actual = strings(detail.actual.keys);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  const parts = [];
  if (missing.length > 0) parts.push(`add keys ${names(missing)}`);
  if (extra.length > 0) parts.push(`remove keys ${names(extra)}`);
  return `At ${pointer} ${parts.join(' and ') || `use exactly the keys ${names(expected)}`}.`;
}

function acceptedValues(detail) {
  if (Array.isArray(detail.accepted)) return detail.accepted;
  if (record(detail.expected) && Array.isArray(detail.expected.one_of)) return detail.expected.one_of;
  return [detail.expected];
}

const phaseAcceptFirst = (detail, ctx) => `Accept the phase this task depends on first (\`lattice todo phase accept --plan ${planOf(detail, ctx)} --phase <phase_id> --input <file>\`), then rerun.`;
const inputFile = (what) => ({ pointer: inputFlag, repair: (detail, ctx, pointer) => `${what} Fix the file passed to ${pointer} and rerun \`${run(ctx)}\`.` });
const revisionDigest = (what) => ({
  pointer: '--input',
  repair: (detail, ctx) => `The ${what} does not match its schema or its digest is stale: see \`${schemaCommand(ctx)}\` and recompute the digest.`,
});

// rule -> { pointer?: string | (detail, ctx) => string, repair: (detail, ctx, pointer) => string }
const REGISTRY = {
  unsorted: { repair: movedAfter },
  unsorted_or_duplicate_collection: {
    repair: (detail, ctx, pointer) => `${movedAfter(detail, ctx, pointer)} Remove the entry if ${q(detail.actual)} appears twice.`,
  },
  unexpected_or_missing_keys: { repair: keyDifference },
  identifier_invalid: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to a todo identifier (1-128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit); ${q(detail.actual)} is not one.`,
  },
  const_mismatch: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to ${acceptedValues(detail).map(q).join(' or ')}; it is ${q(detail.actual)}.`,
  },
  timestamp_invalid: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to a UTC ISO 8601 timestamp with milliseconds, for example ${EXAMPLE_TIMESTAMP}; it is ${q(detail.actual)}.`,
  },
  input_digest_mismatch: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to ${q(detail.expected)}, the canonical digest of the other fields; recompute it after every edit.`,
  },
  empty: {
    repair: (detail, ctx, pointer) => `Add at least ${detail.expected?.min_items ?? 1} item(s) at ${pointer}.${typeof detail.expected?.note === 'string' ? ` ${detail.expected.note}.` : ''}`,
  },
  type: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to a value of type ${detail.expected?.type ?? 'the expected type'}${detail.expected?.nullable ? ' or null' : ''}; it is ${q(detail.actual?.type ?? detail.actual)}.`,
  },
  blank: { repair: (detail, ctx, pointer) => `Write non-blank text at ${pointer}; it is empty or only whitespace.` },
  too_large: {
    repair: (detail, ctx, pointer) => `Shorten the text at ${pointer} to at most ${detail.expected?.max_utf8_bytes} UTF-8 bytes; it is ${detail.actual?.byte_length} bytes.`,
  },
  forbidden_control: {
    repair: (detail, ctx, pointer) => `Remove the control characters from the text at ${pointer}.`,
  },
  unknown_reference: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to one of ${names(strings(detail.expected?.one_of))}; it is ${q(detail.actual)}.`,
  },
  not_authorable_at_create: {
    repair: (detail, ctx, pointer) => `Set ${pointer} to null; it is assigned after creation, never authored.`,
  },

  invalid_done_transition: {
    repair: (detail, ctx) => ({
      predecessor_unfinished: `Record done on its unfinished predecessors first; see \`${showTask(detail, ctx)}\`.`,
      acceptance_edge: phaseAcceptFirst(detail, ctx),
      task_state: `It must be in-progress: run \`${startTask(detail, ctx)}\` first.`,
    })[detail.cause] ?? `Check the task state with \`${showTask(detail, ctx)}\`, then rerun.`,
  },
  invalid_start_transition: {
    repair: (detail, ctx) => ({
      predecessor_unfinished: `Record done on its unfinished predecessors first (see \`${showTask(detail, ctx)}\`), or start with --override-reason <text>.`,
      acceptance_edge: phaseAcceptFirst(detail, ctx),
      task_state: `Only a pending task can start; check its status with \`${showTask(detail, ctx)}\`.`,
      phase_state: 'Its phase is not active; check the phase status with `lattice todo status --json`.',
    })[detail.cause] ?? `Check the task state with \`${showTask(detail, ctx)}\`, then rerun.`,
  },
  reopen_has_started_successor: {
    repair: (detail, ctx) => `A successor of ${taskOf(detail, ctx)} has already started: split the work with \`lattice todo split --plan ${planOf(detail, ctx)} --input <file>\`, or pass --override-reason <text> to reopen anyway.`,
  },
  requested_plan_mismatch: {
    pointer: '--plan',
    repair: (detail, ctx) => `The revision's plan_key differs from --plan${ctx.plan ? ` (${q(ctx.plan)})` : ''}: pass --plan with the plan_key written inside the revision input.`,
  },
  plan_not_active: {
    pointer: '--plan',
    repair: (detail, ctx, pointer) => `${q(detail.plan_key ?? ctx.plan ?? '')} is not an active plan: run \`lattice todo status --json\` to list the active plan keys, then set ${pointer} to one of them.`,
  },
  task_not_found: {
    pointer: '--task',
    repair: (detail, ctx) => `No task ${q(detail.requested_task_id ?? ctx.task ?? '')} in plan ${planOf(detail, ctx)}: run \`lattice plan show ${planOf(detail, ctx)} --json\` to list its task ids.`,
  },
  task_id_case_ambiguous: {
    pointer: '--task',
    repair: (detail) => `${q(detail.requested_task_id)} matches several task ids ${names(strings(detail.matching_task_ids))}; pass the exact one to --task.`,
  },
  plan_key_already_exists: {
    pointer: '/plan_key',
    repair: (detail, ctx) => `Plan key ${q(detail.plan_key ?? ctx.plan ?? '')} already exists: choose a new plan_key, or change the existing plan with \`lattice plan revise --input <file> --json\`.`,
  },
  dispatch_shape_dependency_cycle: {
    pointer: '/hard_dependencies',
    repair: () => 'Remove one hard dependency (or join) that closes the cycle, then rerun.',
  },
  dispatch_shape_self_edge: {
    pointer: '/hard_dependencies',
    repair: () => 'Remove the hard dependency whose from and to are the same task, then rerun.',
  },
  dangling_dependency: {
    pointer: '/hard_dependencies',
    repair: () => 'Point every dependency at a task that exists; remove or correct the edge whose task is missing.',
  },
  self_edge: {
    pointer: '/hard_dependencies',
    repair: () => 'Remove the dependency whose from and to are the same task.',
  },
  merged_cycle: {
    pointer: '/hard_dependencies',
    repair: () => 'Remove one dependency (including cross-plan ones) that closes the cycle, then rerun.',
  },
  join_self_edge: {
    pointer: '/joins',
    repair: () => 'Remove the join whose `after` lists its own id, then rerun.',
  },
  unknown_requires_evidence: {
    pointer: '/tasks',
    repair: (detail) => `Give task(s) ${names(strings(detail.task_ids))} a register_* or skip disposition in the extraction (unknown_requires_evidence cannot migrate), then rerun \`lattice todo migrate\`.`,
  },
  no_registered_tasks: {
    pointer: '/tasks',
    repair: () => 'Give at least one task a register_* disposition in the extraction, then rerun `lattice todo migrate`.',
  },
  store_locked: {
    repair: () => 'Another writer holds the store lock: wait for it to exit and rerun the same command.',
  },
  stale_predecessor: {
    repair: (detail, ctx) => `The plan changed after your input was built: re-read it with \`lattice plan show ${planOf(detail, ctx)} --json\`, rebuild the revision from the current plan, and rerun.`,
  },
  manifest_digest_changed: {
    repair: (detail, ctx) => `The store changed since it was read: rerun \`${run(ctx)}\` unchanged.`,
  },
  revision_schema_or_digest_invalid: revisionDigest('revision'),
  phase_revision_schema_or_digest_invalid: revisionDigest('phase revision'),
  revision_set_schema_invalid: {
    pointer: '--input',
    repair: (detail, ctx) => `The revision set does not match its schema: see \`${schemaCommand(ctx)}\`.`,
  },
  schema_invalid: {
    repair: (detail, ctx, pointer) => `The input${pointer === null ? '' : ` at ${pointer}`} does not match its schema: see \`${schemaCommand(ctx)}\`.`,
  },
  todo_extraction_schema_unsupported: {
    pointer: '--input',
    repair: () => 'Rebuild the extraction as lattice.todo_extraction.v4; see `lattice todo migrate --schema --json`.',
  },

  input_missing: {
    pointer: inputFlag,
    repair: (detail, ctx, pointer) => `${q(detail.input_ref)} does not exist: pass an existing repo file to ${pointer}.`,
  },
  input_ref_invalid: {
    pointer: inputFlag,
    repair: (detail, ctx, pointer) => `Pass a non-empty repo file path to ${pointer}.`,
  },
  unsafe_input_path: {
    pointer: inputFlag,
    repair: (detail, ctx, pointer) => `${q(detail.input_ref)} is not a regular file (symlink or directory): pass a regular repo file to ${pointer}.`,
  },
  input_path_outside_repo: {
    pointer: inputFlag,
    repair: (detail, ctx, pointer) => `Copy ${q(detail.input_ref)} into the repo and pass the repo path to ${pointer}.`,
  },
  input_size_limit_exceeded: inputFile('The input is over 8 MiB.'),
  invalid_utf8: inputFile('The input is not valid UTF-8.'),
  json_parse_failed: inputFile('The input is not valid JSON (no comments or trailing commas).'),
  duplicate_key: inputFile('The input repeats a JSON object key.'),
  note_input_invalid_utf8: inputFile('The input is not valid UTF-8.'),
  note_input_too_large: inputFile('The input is too large.'),
  evidence_input_invalid_utf8: {
    pointer: '--evidence',
    repair: () => 'Save the evidence file as UTF-8 and pass it to --evidence again.',
  },
  authored_evidence_descriptor_invalid: {
    pointer: '--evidence',
    repair: () => 'Pass a non-empty text file to --evidence (or use --message <text>) whose content can be stored as evidence.',
  },
  test_result_must_be_non_empty_markdown: {
    pointer: '--test-result',
    repair: () => 'Pass a non-empty Markdown file to --test-result.',
  },

  flag_missing: { repair: (detail, ctx, pointer) => `Add ${pointer} <value> to \`${run(ctx)}\`.` },
  flag_unknown: {
    repair: (detail, ctx, pointer) => `Remove ${pointer}: \`${run(ctx)}\` does not accept it; see \`${run(ctx, '--help')}\`.`,
  },
  evidence_or_message_exactly_one: {
    repair: (detail, ctx) => `Pass exactly one of --evidence <file> or --message <text> to \`${run(ctx)}\`.`,
  },
  path_token_invalid: {
    repair: (detail, ctx, pointer) => `Give ${pointer} a repo file path (non-empty, not starting with '--').`,
  },

  actor_environment_invalid: {
    repair: (detail) => `Set each of ${names(strings(detail.invalid_environment))} to a todo identifier (letters, digits, '.', '_' or '-', at most 128 characters), or unset it.`,
  },

  plan_revise_schema_invalid: {
    pointer: '--input',
    repair: (detail, ctx) => `Use schema ${q(detail.expected)}; see \`${schemaCommand(ctx)}\`.`,
  },
  plan_revise_requires_source_revision: {
    repair: (detail) => `This plan carries source revisions: use ${detail.next_action ?? '`lattice todo revise-phase --plan <plan> --input <file>`'}.`,
  },
  predecessor_plan_schema_unsupported: {
    repair: (detail, ctx) => `Plan ${planOf(detail, ctx)} uses a schema that plan revise cannot extend; revise it with \`lattice todo revise-phase\`.`,
  },
  plan_revise_identity_mismatch: {
    repair: () => 'Set /desired/project_id and /desired/plan_key to the active plan\'s values (see `lattice todo status --json`).',
  },
  plan_revise_continuity_incomplete: {
    repair: (detail) => `Give /continuity exactly one entry for each of the plan's tasks ${names(strings(detail.expected?.task_ids))}.`,
  },
  plan_revise_continuity_invalid: {
    repair: (detail, ctx, pointer) => `Fix the continuity entry at ${pointer}: it must name an existing task and a policy.`,
  },
  plan_revise_removed_task_mismatch: {
    repair: (detail) => `Task ${q(detail.task_id)} is missing from /desired/tasks: either keep it there, or give it policy 'retire' in /continuity.`,
  },
  plan_revise_requires_backchain: {
    repair: () => 'This plan has a backchain binding: revise it with `lattice plan backchain --input <file> --json`.',
  },
  plan_revise_artifact_invalid: {
    repair: (detail, ctx) => `The derived revision is invalid; check /desired against \`${schemaCommand(ctx)}\`.`,
  },

  carry_semantics_changed: {
    repair: (detail) => `Task ${migratedTask(detail)} changed its phase, dependencies or other carried meaning: restore it to match the predecessor, or migrate it with policy 'reset'.`,
  },
  carry_outgoing_edge_removed: {
    repair: (detail) => `Task ${migratedTask(detail)} lost an outgoing dependency edge: add the edge back to the desired plan, or migrate the task with policy 'reset'.`,
  },
  phase_carry_semantics_changed: {
    repair: (detail) => `Phase ${q(detail.from_phase_id)} changed its definition or members: restore it to match the predecessor, or migrate it with policy 'reset'.`,
  },
  predecessor_task_migration_incomplete: {
    repair: () => 'List every predecessor task exactly once as from_task_id in task_migration, then rerun.',
  },
  predecessor_phase_migration_incomplete: {
    repair: () => 'List every predecessor phase exactly once as from_phase_id in phase_migration, then rerun.',
  },
  design_memo_schema_downgrade: {
    repair: (detail) => `The desired plan schema ${q(detail.desired_schema)} is older than ${q(detail.predecessor_schema)}: build the desired plan with ${q(detail.predecessor_schema)} or newer.`,
  },
  done_condition_schema_downgrade: {
    repair: (detail) => `The desired plan schema ${q(detail.desired_schema)} drops done_condition from ${q(detail.predecessor_schema)}: build the desired plan with ${q(detail.predecessor_schema)}.`,
  },
  acquire_phase_requires_unassigned_predecessor: {
    repair: (detail) => `Task ${migratedTask(detail)} already has a phase, so it cannot acquire one: migrate it with policy 'carry' or 'reset' instead.`,
  },
  acquire_phase_requires_assigned_successor: {
    repair: (detail) => `Give the successor of task ${migratedTask(detail)} a phase_id when its policy is acquire_phase.`,
  },
};

// PLAN_BACKCHAIN_INVALID reasons: one repair per family.
const BACKCHAIN_FAMILIES = [
  [/^(authoring|binding|existing_feature_reference)_/u, 'Make the referenced file exist as a regular repo file holding valid JSON of the expected schema.'],
  [/^(feature|task|required_feature|orphan|goal)/u, 'Make features, tasks and goal consistent: every required feature has a provider, every task provides what it declares, nothing repeats or cycles.'],
  [/^(continuity|dependency)/u, 'Make /continuity cover every predecessor task exactly once and keep the dependencies tasks still need.'],
];

function backchainRepair(detail, ctx, pointer) {
  const family = BACKCHAIN_FAMILIES.find(([pattern]) => pattern.test(detail.reason ?? ''));
  return `At ${pointer ?? '/'}: ${family?.[1] ?? 'Correct the value so it matches the backchain schema and recompute chain_digest.'} See \`${schemaCommand(ctx)}\`.`;
}

function registeredPointer(entry, detail, ctx) {
  if (entry?.pointer === undefined) return undefined;
  return typeof entry.pointer === 'function' ? entry.pointer(detail, ctx) : entry.pointer;
}

/**
 * Returns a NEW detail with `pointer`, `rule` and `next_action` always set; every other key is kept.
 * A concrete existing next_action wins; a placeholder token (^[a-z_]+$) is replaced by the registered repair.
 * context = { family: 'todo' | 'plan', command, plan, task, flags } (all optional).
 */
export function withRefusalGuidance({ code, message, detail }, context = {}) {
  const base = record(detail) ? detail : {};
  const rule = base.rule ?? base.violation_kind ?? base.violation_reason ?? base.reason ?? message;
  const entry = Object.hasOwn(REGISTRY, rule) ? REGISTRY[rule] : undefined;
  const pointer = [base.pointer, base.violation_path, registeredPointer(entry, base, context), context.flagPointer]
    .find((value) => typeof value === 'string') ?? null;
  const resolved = pointer === '' ? '/' : pointer;

  const existing = typeof base.next_action === 'string' && base.next_action.length > 0 ? base.next_action : null;
  let nextAction = existing !== null && !PLACEHOLDER.test(existing) ? existing : null;
  if (nextAction === null) {
    const repair = entry?.repair(base, context, resolved)
      ?? (code === 'PLAN_BACKCHAIN_INVALID' ? backchainRepair(base, context, resolved) : null);
    nextAction = repair ?? existing ?? run(context, '--help');
  }
  return { ...base, pointer: resolved, rule, next_action: nextAction };
}
