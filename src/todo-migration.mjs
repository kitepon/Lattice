import {
  TODO_LIMITS,
  exactRecord,
  isStrictTodoTimestamp,
  isTodoDigest,
  isTodoDesignMemo,
  isTodoIdentifier,
  isTodoRef,
  todoSelfDigest,
} from './todo-contracts.mjs';
import {
  TodoStoreError,
  appendImportedPlan,
  createTodoStoreWriter,
} from './todo-store.mjs';

export const TODO_EXTRACTION_SCHEMA = 'lattice.todo_extraction.v1';
export const TODO_EXTRACTION_SCHEMA_V2 = 'lattice.todo_extraction.v2';
export const TODO_EXTRACTION_SCHEMA_V3 = 'lattice.todo_extraction.v3';
export const TODO_EXTRACTION_SCHEMA_V4 = 'lattice.todo_extraction.v4';

const V1_DISPOSITIONS = new Set([
  'register_pending',
  'register_done',
  'exclude_superseded',
  'exclude_compatibility_record',
  'unknown_requires_evidence',
]);
const V2_DISPOSITIONS = new Set([...V1_DISPOSITIONS, 'register_in_progress']);
const CHECKBOX_STATES = new Set(['checked', 'unchecked', 'absent', 'ambiguous']);
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function boundedText(value, maximumBytes = 16_384) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximumBytes;
}

function nullableText(value) {
  return value === null || boundedText(value);
}

function actor(value) {
  return exactRecord(value, ['host', 'session', 'agent'])
    && [value.host, value.session, value.agent].every(isTodoIdentifier);
}

function nodeRef(value) {
  return (exactRecord(value, ['project_id', 'plan_key', 'task_id'])
    || exactRecord(value, ['project_id', 'plan_key', 'task_id', 'expected_topology_digest']))
    && isTodoIdentifier(value.project_id) && isTodoIdentifier(value.plan_key)
    && isTodoIdentifier(value.task_id)
    && (value.expected_topology_digest === undefined || isTodoDigest(value.expected_topology_digest));
}

function refKey(value) {
  return `${value.project_id}\0${value.plan_key}\0${value.task_id}`;
}

function sortedStrictly(values, key = (value) => value) {
  return values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));
}

function sourceLocation(value) {
  return exactRecord(value, [
    'origin_plan_ref', 'origin_line', 'source_commit', 'heading_path', 'markdown_depth',
    'parent_task_id', 'checkbox_state',
  ]) && isTodoRef(value.origin_plan_ref) && Number.isSafeInteger(value.origin_line) && value.origin_line >= 1
    && COMMIT_OID.test(value.source_commit)
    && Array.isArray(value.heading_path) && value.heading_path.length <= 32
    && value.heading_path.every((part) => boundedText(part, 1_024))
    && Number.isSafeInteger(value.markdown_depth) && value.markdown_depth >= 0 && value.markdown_depth <= 64
    && (value.parent_task_id === null || isTodoIdentifier(value.parent_task_id))
    && CHECKBOX_STATES.has(value.checkbox_state);
}

function migrationContext(value) {
  return exactRecord(value, [
    'external_canonical_ref', 'carry_over_ref', 'h_required', 'condition', 'evidence_refs', 'notes',
  ]) && nullableText(value.external_canonical_ref) && nullableText(value.carry_over_ref)
    && typeof value.h_required === 'boolean' && nullableText(value.condition)
    && Array.isArray(value.evidence_refs) && value.evidence_refs.length <= 64
    && value.evidence_refs.every((entry) => boundedText(entry, 4_096))
    && Array.isArray(value.notes) && value.notes.length <= 64
    && value.notes.every((entry) => boundedText(entry, 4_096));
}

function completion(value) {
  return exactRecord(value, ['done_mode', 'completed_at'])
    && value.done_mode === 'historical_import'
    && (value.completed_at === 'unknown_requires_evidence' || isStrictTodoTimestamp(value.completed_at));
}

function historicalStart(value) {
  return exactRecord(value, ['start_mode', 'status', 'started_at'])
    && value.start_mode === 'historical_import' && value.status === 'in-progress'
    && (value.started_at === 'unknown_requires_evidence' || isStrictTodoTimestamp(value.started_at));
}

function extractionTask(value, schema) {
  const v2 = [TODO_EXTRACTION_SCHEMA_V2, TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema);
  const designMemo = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema);
  const keys = [
    'task_id', 'title', 'lane', 'narrative_ref', 'compile_binding', 'disposition',
    'completion', 'source', 'migration_context',
  ];
  if (v2) keys.push('start');
  if (designMemo) keys.push('design_memo');
  if (!exactRecord(value, keys) || !isTodoIdentifier(value.task_id) || !boundedText(value.title)
    || !isTodoIdentifier(value.lane) || (value.narrative_ref !== null && !isTodoRef(value.narrative_ref))
    || (designMemo && !isTodoDesignMemo(value.design_memo))
    || value.compile_binding !== null || !(v2 ? V2_DISPOSITIONS : V1_DISPOSITIONS).has(value.disposition)
    || !sourceLocation(value.source) || !migrationContext(value.migration_context)) return false;
  if (!v2) return value.disposition === 'register_done' ? completion(value.completion) : value.completion === null;
  if (value.disposition === 'register_done') return value.start === null && completion(value.completion);
  if (value.disposition === 'register_in_progress') {
    return historicalStart(value.start) && value.completion === null;
  }
  return value.start === null && value.completion === null;
}

function isCrossPlanEdge(edge) {
  return edge?.from?.project_id !== edge?.to?.project_id
    || edge?.from?.plan_key !== edge?.to?.plan_key;
}

function validateEdges(value, schema) {
  return Array.isArray(value) && value.length <= TODO_LIMITS.edgesPerPlan
    && value.every((edge) => {
      const basic = exactRecord(edge, ['from', 'to']);
      const refsValid = nodeRef(edge?.from) && nodeRef(edge?.to);
      const crossPlan = refsValid && isCrossPlanEdge(edge);
      const withReason = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema)
        && exactRecord(edge, ['from', 'to', 'reason'])
        && boundedText(edge.reason);
      return (basic || withReason) && refsValid
        && (!crossPlan || ![TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema) || withReason);
    })
    && sortedStrictly(value, (edge) => `${refKey(edge.from)}\0${refKey(edge.to)}`);
}

function validateJoins(value) {
  return Array.isArray(value) && value.length <= TODO_LIMITS.joinsPerPlan
    && value.every((join) => exactRecord(join, ['id', 'after', 'before'])
      && isTodoIdentifier(join.id) && Array.isArray(join.after) && join.after.length > 0
      && join.after.length <= TODO_LIMITS.tasksPerPlan && join.after.every(nodeRef)
      && sortedStrictly(join.after, refKey) && nodeRef(join.before))
    && sortedStrictly(value, (join) => join.id);
}

/**
 * taskを新規登録しない入力は、既存source planの1 taskから別planの1 taskへ張る
 * 明示dependencyだけに限定する。top-level identityはsource planを指し、両端の
 * topology digestで、古い観測のまま接続しない。
 */
export function isTodoExtractionConnectionOnly(value) {
  const edge = Array.isArray(value?.hard_dependencies) && value.hard_dependencies.length === 1
    ? value.hard_dependencies[0] : null;
  return value?.schema === TODO_EXTRACTION_SCHEMA_V4
    && Array.isArray(value.tasks) && value.tasks.length === 0
    && Array.isArray(value.joins) && value.joins.length === 0
    && edge !== null && nodeRef(edge.from) && nodeRef(edge.to) && isCrossPlanEdge(edge)
    && edge.from.project_id === value.project_id && edge.from.plan_key === value.plan_key
    && isTodoDigest(edge.from.expected_topology_digest)
    && isTodoDigest(edge.to.expected_topology_digest);
}

const reject = (reason, path = '', detail = {}) => ({ valid: false, reason, path, ...detail });

/** value自体がexactRecordの対象になれる素朴なobjectかどうか（配列・nullを除く）。 */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 期待keyとの過不足を1件ずつ言い当てる。missing/unexpectedのどちらが先に見つかっても
 * そこで止め、複数の欠落を一度に説明しない——`exactRecord`のbooleanと違い、
 * 最初に見つかった違反fieldをpathへ刻む。
 */
function explainKeys(value, requiredKeys, at) {
  if (!plainObject(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return reject('not_an_object', at);
  }
  const actualKeys = new Set(Object.keys(value));
  for (const key of requiredKeys) {
    if (!actualKeys.has(key)) return reject('missing_required_key', `${at}/${key}`);
  }
  const requiredSet = new Set(requiredKeys);
  for (const key of actualKeys) {
    if (!requiredSet.has(key)) return reject('unexpected_key', `${at}/${key}`);
  }
  return { valid: true };
}

function explainSortedStrictly(values, key, at) {
  for (let index = 1; index < values.length; index += 1) {
    if (!(key(values[index - 1]) < key(values[index]))) {
      return reject('unsorted_or_duplicate_collection', `${at}/${index}`);
    }
  }
  return { valid: true };
}

/**
 * `lattice.todo_extraction.v1/v2`を、既存の`validateTodoExtraction`の可否は変えずに
 * 診断する（ADR 0130の案内規律をmigration入口へ拡張）。
 *
 * 深いgraph整合（親task解決・edge/join local参照解決）はここでは個別に言い当てず、
 * 単一のreasonへ丸める——既知の実運用の詰まりどころ（必須key欠落・task/edge/joinの
 * ソート違反・digest不一致）を優先して解消する。それでも掴めない違反は
 * `diagnosis_incomplete`として正直に返す。
 */
export function explainTodoExtraction(value) {
  try {
    if (!plainObject(value)) return reject('not_an_object', '');
    const schema = value.schema;
    if (![TODO_EXTRACTION_SCHEMA, TODO_EXTRACTION_SCHEMA_V2, TODO_EXTRACTION_SCHEMA_V3,
      TODO_EXTRACTION_SCHEMA_V4].includes(schema)) {
      return reject('schema_mismatch', '/schema', {
        expected: TODO_EXTRACTION_SCHEMA_V4, actual: typeof schema === 'string' ? schema : null,
      });
    }
    const v2 = [TODO_EXTRACTION_SCHEMA_V2, TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema);
    const designMemo = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(schema);
    const v4 = schema === TODO_EXTRACTION_SCHEMA_V4;
    const topKeys = [
      'schema', 'project_id', 'plan_key', 'plan_version', 'actor', 'recorded_at',
      'tasks', 'hard_dependencies', 'joins', 'extraction_digest',
    ];
    const topKeyCheck = explainKeys(value, topKeys, '');
    if (!topKeyCheck.valid) return topKeyCheck;
    if (!isTodoIdentifier(value.project_id)) return reject('invalid_identifier', '/project_id');
    if (!isTodoIdentifier(value.plan_key)) return reject('invalid_identifier', '/plan_key');
    if (!isTodoIdentifier(value.plan_version)) return reject('invalid_identifier', '/plan_version');
    if (!actor(value.actor)) return reject('invalid_actor', '/actor');
    if (!isStrictTodoTimestamp(value.recorded_at)) return reject('invalid_timestamp', '/recorded_at');
    if (!Array.isArray(value.tasks) || value.tasks.length > TODO_LIMITS.tasksPerPlan
      || (value.tasks.length === 0 && !v4)) {
      return reject('bounded_collection_violation', '/tasks');
    }
    const taskKeys = v2
      ? ['task_id', 'title', 'lane', 'narrative_ref', 'compile_binding', 'disposition',
        'start', 'completion', 'source', 'migration_context']
      : ['task_id', 'title', 'lane', 'narrative_ref', 'compile_binding', 'disposition',
        'completion', 'source', 'migration_context'];
    if (designMemo) taskKeys.push('design_memo');
    for (const [index, task] of value.tasks.entries()) {
      const taskKeyCheck = explainKeys(task, taskKeys, `/tasks/${index}`);
      if (!taskKeyCheck.valid) return taskKeyCheck;
      if (designMemo && !isTodoDesignMemo(task.design_memo)) {
        return reject('design_memo_required', `/tasks/${index}/design_memo`, {
          task_id: isTodoIdentifier(task.task_id) ? task.task_id : null,
          expected: 'non-empty Markdown or NO_PLAN',
        });
      }
      if (task.disposition === 'register_done'
        && task.completion?.done_mode !== 'historical_import') {
        return reject('enum_mismatch', `/tasks/${index}/completion/done_mode`, {
          task_id: isTodoIdentifier(task.task_id) ? task.task_id : null,
          expected: 'historical_import', actual: task.completion?.done_mode ?? null,
        });
      }
      if (!Array.isArray(task.migration_context?.notes)) {
        return reject('expected_array', `/tasks/${index}/migration_context/notes`, {
          task_id: isTodoIdentifier(task.task_id) ? task.task_id : null,
          expected: 'array', actual: typeof task.migration_context?.notes,
        });
      }
      if (!extractionTask(task, schema)) {
        return reject('task_shape_invalid', `/tasks/${index}`, {
          task_id: isTodoIdentifier(task.task_id) ? task.task_id : null,
        });
      }
    }
    const sortCheck = explainSortedStrictly(value.tasks, (task) => task.task_id, '/tasks');
    if (!sortCheck.valid) return sortCheck;
    if (new Set(value.tasks.map(({ task_id: taskId }) => taskId)).size !== value.tasks.length) {
      return reject('duplicate_task_id', '/tasks');
    }
    if (!validateEdges(value.hard_dependencies, schema)) return reject('hard_dependencies_invalid', '/hard_dependencies');
    if (!validateJoins(value.joins)) return reject('joins_invalid', '/joins');
    if (!isTodoDigest(value.extraction_digest)) return reject('invalid_digest', '/extraction_digest');
    const expectedDigest = todoSelfDigest(value, 'extraction_digest');
    if (value.extraction_digest !== expectedDigest) {
      return reject('extraction_digest_mismatch', '/extraction_digest', {
        expected: expectedDigest, actual: value.extraction_digest,
      });
    }
    if (v4 && value.hard_dependencies.filter(isCrossPlanEdge).length > 1) {
      return reject('cross_plan_dependency_limit_exceeded', '/hard_dependencies', { maximum: 1 });
    }
    const connectionOnly = isTodoExtractionConnectionOnly(value);
    if (value.tasks.length === 0 && !connectionOnly) {
      return reject('connection_only_shape_invalid', '/tasks', {
        expected: 'one reasoned cross-plan dependency from the top-level source plan',
      });
    }
    if (!connectionOnly) {
      const taskIds = new Set(value.tasks.map(({ task_id: taskId }) => taskId));
      const badParent = value.tasks.find((task) => task.source.parent_task_id === task.task_id
        || (task.source.parent_task_id !== null && !taskIds.has(task.source.parent_task_id)));
      if (badParent !== undefined) {
        return reject('parent_task_id_unresolved',
          `/tasks/${value.tasks.indexOf(badParent)}/source/parent_task_id`);
      }
      const excluded = new Set(value.tasks
        .filter((task) => task.disposition.startsWith('exclude_'))
        .map(({ task_id }) => task_id));
      const excludedParent = value.tasks.find((task) => task.disposition.startsWith('register_')
        && task.source.parent_task_id !== null && excluded.has(task.source.parent_task_id));
      if (excludedParent !== undefined) {
        return reject('registered_parent_task_id_unresolved',
          `/tasks/${value.tasks.indexOf(excludedParent)}/source/parent_task_id`, {
            task_id: excludedParent.task_id,
            expected: 'task_id not excluded from the compiled plan',
            actual: excludedParent.source.parent_task_id,
          });
      }
      const localRefViolation = firstUnregisteredLocalRef(value);
      if (localRefViolation !== null) {
        return reject('local_ref_unresolved', localRefViolation.path, {
          task_id: localRefViolation.task_id,
          expected: 'registered task_id', actual: localRefViolation.task_id,
        });
      }
    }
    // ここまでの個別検査を全て通過したのに`validateTodoExtraction`がfalseを返す状況は、
    // このexplainがまだ言い当てられない違反があるということ。捏造せず未特定と申告する。
    return { valid: true };
  } catch {
    return reject('diagnosis_failed', '');
  }
}

function registeredTaskIds(value) {
  return new Set(value.tasks
    .filter(({ disposition }) => disposition.startsWith('register_'))
    .map(({ task_id }) => task_id));
}

function localRefsResolve(value) {
  return firstUnregisteredLocalRef(value) === null;
}

function firstUnregisteredLocalRef(value) {
  const registered = registeredTaskIds(value);
  const unresolved = (ref) => ref.project_id === value.project_id && ref.plan_key === value.plan_key
    && !registered.has(ref.task_id);
  for (const [index, edge] of value.hard_dependencies.entries()) {
    if (unresolved(edge.from)) return { path: `/hard_dependencies/${index}/from`, task_id: edge.from.task_id };
    if (unresolved(edge.to)) return { path: `/hard_dependencies/${index}/to`, task_id: edge.to.task_id };
  }
  for (const [index, join] of value.joins.entries()) {
    if (unresolved(join.before)) return { path: `/joins/${index}/before`, task_id: join.before.task_id };
    const afterIndex = join.after.findIndex(unresolved);
    if (afterIndex >= 0) {
      return { path: `/joins/${index}/after/${afterIndex}`, task_id: join.after[afterIndex].task_id };
    }
  }
  return null;
}

/** Exact, bounded validation for the AI-authored G4 intermediate artifact. */
export function validateTodoExtraction(value) {
  try {
    const schema = value?.schema;
    if (!exactRecord(value, [
      'schema', 'project_id', 'plan_key', 'plan_version', 'actor', 'recorded_at',
      'tasks', 'hard_dependencies', 'joins', 'extraction_digest',
    ]) || ![TODO_EXTRACTION_SCHEMA, TODO_EXTRACTION_SCHEMA_V2, TODO_EXTRACTION_SCHEMA_V3,
      TODO_EXTRACTION_SCHEMA_V4].includes(schema)
      || !isTodoIdentifier(value.project_id)
      || !isTodoIdentifier(value.plan_key) || !isTodoIdentifier(value.plan_version)
      || !actor(value.actor) || !isStrictTodoTimestamp(value.recorded_at)
      || !Array.isArray(value.tasks) || value.tasks.length > TODO_LIMITS.tasksPerPlan
      || (value.tasks.length === 0 && schema !== TODO_EXTRACTION_SCHEMA_V4)
      || !value.tasks.every((task) => extractionTask(task, schema))
      || !sortedStrictly(value.tasks, (task) => task.task_id)
      || new Set(value.tasks.map(({ task_id }) => task_id)).size !== value.tasks.length
      || !validateEdges(value.hard_dependencies, schema) || !validateJoins(value.joins)
      || !isTodoDigest(value.extraction_digest)
      || value.extraction_digest !== todoSelfDigest(value, 'extraction_digest')) return false;

    if (schema === TODO_EXTRACTION_SCHEMA_V4 && value.hard_dependencies.filter(isCrossPlanEdge).length > 1) {
      return false;
    }
    const connectionOnly = isTodoExtractionConnectionOnly(value);
    if (value.tasks.length === 0 && !connectionOnly) return false;
    if (connectionOnly) return true;
    const taskIds = new Set(value.tasks.map(({ task_id }) => task_id));
    if (value.tasks.some((task) => task.source.parent_task_id === task.task_id
      || (task.source.parent_task_id !== null && !taskIds.has(task.source.parent_task_id)))) return false;
    const excluded = new Set(value.tasks
      .filter((task) => task.disposition.startsWith('exclude_'))
      .map(({ task_id }) => task_id));
    if (value.tasks.some((task) => task.disposition.startsWith('register_')
      && task.source.parent_task_id !== null && excluded.has(task.source.parent_task_id))) return false;
    return localRefsResolve(value);
  } catch {
    return false;
  }
}

export function todoExtractionImportSource(task) {
  return {
    schema: 'lattice.todo_import_source.v1',
    origin_plan_ref: task.source.origin_plan_ref,
    origin_line: task.source.origin_line,
    source_commit: task.source.source_commit,
  };
}

/**
 * Translate an already-extracted artifact into appendImportedPlan input.
 * Source locations are passed to the importer but no Markdown is read here.
 * Unresolved records stop the whole transaction so the owner can adjudicate
 * the JSON and rerun the same command.
 */
export function compileTodoExtraction(value, repoRoot) {
  if (!validateTodoExtraction(value)) {
    const explained = explainTodoExtraction(value);
    throw new TodoStoreError('INVALID_TODO_EXTRACTION', 'schema_invalid', undefined,
      explained.valid ? undefined : {
        violation_reason: explained.reason, violation_path: explained.path,
        ...(explained.task_id === undefined ? {} : { task_id: explained.task_id }),
      });
  }
  const unresolved = value.tasks
    .filter(({ disposition }) => disposition === 'unknown_requires_evidence')
    .map(({ task_id }) => task_id);
  if (unresolved.length > 0) {
    throw new TodoStoreError('MIGRATION_UNRESOLVED', 'unknown_requires_evidence', undefined, {
      task_ids: unresolved,
    });
  }

  const registered = value.tasks.filter(({ disposition }) => disposition.startsWith('register_'));
  const connectionOnly = isTodoExtractionConnectionOnly(value);
  if (registered.length === 0 && !connectionOnly) {
    throw new TodoStoreError('MIGRATION_EMPTY', 'no_registered_tasks');
  }
  const hardDependencies = value.hard_dependencies.map(({ from, to }) => ({ from, to }));
  const crossPlanDependencies = [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(value.schema)
    ? value.hard_dependencies
      .filter(isCrossPlanEdge)
      .map(({ from, to, reason }) => ({ from, to, reason }))
    : [];
  if (connectionOnly) {
    return {
      repoRoot,
      writer: createTodoStoreWriter({ caller: 'g4-migration' }),
      connectionOnly: true,
      connectionPlan: {
        project_id: value.project_id, plan_key: value.plan_key, plan_version: value.plan_version,
      },
      crossPlanDependencies,
      genesis: {
        actor: value.actor,
        recorded_at: value.recorded_at,
        provenance: null,
      },
    };
  }
  return {
    repoRoot,
    writer: createTodoStoreWriter({ caller: 'g4-migration' }),
    initializeIfMissing: {
      projectId: value.project_id,
      repositories: [{ repo_id: 'self', path: '.' }],
    },
    plan: {
      schema: [TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(value.schema)
        ? 'lattice.todo_plan.v6' : 'lattice.todo_plan.v2',
      project_id: value.project_id,
      plan_key: value.plan_key,
      plan_version: value.plan_version,
      predecessor_plan_digest: null,
      tasks: registered.map((task) => ({
        task_id: task.task_id,
        title: task.title,
        lane: task.lane,
        ...([TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(value.schema)
          ? { design_memo: task.design_memo } : {}),
        narrative_ref: task.narrative_ref,
        narrative_anchor: null,
        compile_binding: null,
        ...([TODO_EXTRACTION_SCHEMA_V3, TODO_EXTRACTION_SCHEMA_V4].includes(value.schema)
          ? { parent_task_id: task.source.parent_task_id } : {}),
      })),
      hard_dependencies: hardDependencies,
      joins: value.joins,
    },
    crossPlanDependencies,
    narrativeAnchorSources: registered.map((task) => ({
      task_id: task.task_id,
      origin_plan_ref: task.source.origin_plan_ref,
      origin_line: task.source.origin_line,
      source_commit: task.source.source_commit,
      checkbox_state: task.source.checkbox_state,
    })),
    genesis: {
      actor: value.actor,
      recorded_at: value.recorded_at,
      provenance: null,
    },
    completedTasks: registered
      .filter(({ disposition }) => disposition === 'register_done')
      .map((task) => ({
        task_id: task.task_id,
        completed_at: task.completion.completed_at,
        evidence: todoExtractionImportSource(task),
      })),
    inProgressTasks: registered
      .filter(({ disposition }) => disposition === 'register_in_progress')
      .map((task) => ({
        task_id: task.task_id,
        started_at: task.start.started_at,
        evidence: todoExtractionImportSource(task),
      })),
  };
}

export async function appendTodoExtraction({ repoRoot, extraction }) {
  const request = compileTodoExtraction(extraction, repoRoot);
  return appendImportedPlan(request);
}
