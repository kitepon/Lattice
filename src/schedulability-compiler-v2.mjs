const GRAPH_SCHEMA = 'lattice.normalized_boundary_graph.v2';
const PLAN_SCHEMA = 'lattice.plan_graph.v2';
const MAX_TODOS = 8;
const MAX_INPUT_TODOS = 256;
const DEFAULT_MAX_SEARCH_STATES = 2_000_000;
const IDENTIFIER = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/;

function fail(reason) {
  throw new TypeError(`schedulability compiler v2契約違反: ${reason}`);
}

function plainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function identifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function boundedText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= 4_096;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label}がarrayではない`);
  }
}

function normalizeOptions(options) {
  const keys = Object.keys(options).sort();
  if (!exactRecord(options, keys) || !keys.every((key) => ['maxSearchStates', 'omitWavesOverLimit'].includes(key))
    || (options.omitWavesOverLimit !== undefined && typeof options.omitWavesOverLimit !== 'boolean')) {
    fail('options shapeが不正');
  }
  const maxSearchStates = options.maxSearchStates ?? DEFAULT_MAX_SEARCH_STATES;
  if (!Number.isSafeInteger(maxSearchStates) || maxSearchStates < 0) {
    fail('maxSearchStatesがnon-negative safe integerではない');
  }
  return { maxSearchStates, omitWavesOverLimit: options.omitWavesOverLimit === true };
}

function assertAcyclic(todos, precedences) {
  const indegree = new Map(todos.map((todoId) => [todoId, 0]));
  const outgoing = new Map(todos.map((todoId) => [todoId, new Set()]));
  for (const { from_todo_id: from, to_todo_id: to } of precedences) {
    if (!outgoing.get(from).has(to)) {
      outgoing.get(from).add(to);
      indegree.set(to, indegree.get(to) + 1);
    }
  }

  const ready = todos.filter((todoId) => indegree.get(todoId) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const todoId = ready.shift();
    visited += 1;
    for (const next of outgoing.get(todoId)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (visited !== todos.length) fail('precedencesにcycleがある');
}

function normalizeGraph(value) {
  if (!exactRecord(value, [
    'schema_version',
    'todos',
    'conflicts',
    'precedences',
    'unknowns',
    'capacity',
  ]) || value.schema_version !== GRAPH_SCHEMA) {
    fail('normalized graph shapeまたはschema_versionが不正');
  }

  assertArray(value.todos, 'todos');
  if (value.todos.length < 1 || value.todos.length > MAX_INPUT_TODOS
    || !value.todos.every(identifier)
    || new Set(value.todos).size !== value.todos.length) {
    fail('todosがbounded unique identifier arrayではない');
  }
  const todos = [...value.todos].sort(compareText);
  const todoSet = new Set(todos);

  if (!Number.isSafeInteger(value.capacity)
    || value.capacity < 1
    || value.capacity > MAX_INPUT_TODOS) {
    fail('capacityがbounded positive integerではない');
  }

  assertArray(value.conflicts, 'conflicts');
  const conflictKeys = new Set();
  const conflicts = value.conflicts.map((entry) => {
    if (!exactRecord(entry, ['todo_ids', 'resource_id'])) {
      fail('conflict shapeが不正');
    }
    assertArray(entry.todo_ids, 'conflict.todo_ids');
    if (entry.todo_ids.length !== 2
      || !entry.todo_ids.every((todoId) => todoSet.has(todoId))
      || entry.todo_ids[0] === entry.todo_ids[1]
      || !identifier(entry.resource_id)) {
      fail('conflict relationが不正');
    }
    const todoIds = [...entry.todo_ids].sort(compareText);
    const key = `${todoIds[0]}\u0000${todoIds[1]}\u0000${entry.resource_id}`;
    if (conflictKeys.has(key)) fail('duplicate conflictがある');
    conflictKeys.add(key);
    return { todo_ids: todoIds, resource_id: entry.resource_id };
  }).sort((left, right) => (
    compareText(left.todo_ids[0], right.todo_ids[0])
    || compareText(left.todo_ids[1], right.todo_ids[1])
    || compareText(left.resource_id, right.resource_id)
  ));

  assertArray(value.precedences, 'precedences');
  const precedenceKeys = new Set();
  const precedences = value.precedences.map((entry) => {
    if (!exactRecord(entry, ['from_todo_id', 'to_todo_id', 'reason'])
      || !todoSet.has(entry.from_todo_id)
      || !todoSet.has(entry.to_todo_id)
      || entry.from_todo_id === entry.to_todo_id
      || !boundedText(entry.reason)) {
      fail('precedence relationが不正');
    }
    const key = `${entry.from_todo_id}\u0000${entry.to_todo_id}\u0000${entry.reason}`;
    if (precedenceKeys.has(key)) fail('duplicate precedenceがある');
    precedenceKeys.add(key);
    return {
      from_todo_id: entry.from_todo_id,
      to_todo_id: entry.to_todo_id,
      reason: entry.reason,
    };
  }).sort((left, right) => (
    compareText(left.from_todo_id, right.from_todo_id)
    || compareText(left.to_todo_id, right.to_todo_id)
    || compareText(left.reason, right.reason)
  ));
  assertAcyclic(todos, precedences);

  assertArray(value.unknowns, 'unknowns');
  const unknownKeys = new Set();
  const unknowns = value.unknowns.map((entry) => {
    if (!exactRecord(entry, ['todo_id', 'kind', 'reason'])
      || !todoSet.has(entry.todo_id)
      || !identifier(entry.kind)
      || !boundedText(entry.reason)) {
      fail('unknown relationが不正');
    }
    const key = `${entry.todo_id}\u0000${entry.kind}\u0000${entry.reason}`;
    if (unknownKeys.has(key)) fail('duplicate unknownがある');
    unknownKeys.add(key);
    return { todo_id: entry.todo_id, kind: entry.kind, reason: entry.reason };
  }).sort((left, right) => (
    compareText(left.todo_id, right.todo_id)
    || compareText(left.kind, right.kind)
    || compareText(left.reason, right.reason)
  ));

  return { todos, conflicts, precedences, unknowns, capacity: value.capacity };
}

function feasibleAssignment(graph, waveByIndex, indexByTodo) {
  const counts = new Array(graph.todos.length).fill(0);
  for (const waveIndex of waveByIndex) {
    counts[waveIndex] += 1;
    if (counts[waveIndex] > graph.capacity) return false;
  }
  for (const conflict of graph.conflicts) {
    if (waveByIndex[indexByTodo.get(conflict.todo_ids[0])]
      === waveByIndex[indexByTodo.get(conflict.todo_ids[1])]) {
      return false;
    }
  }
  for (const precedence of graph.precedences) {
    if (waveByIndex[indexByTodo.get(precedence.from_todo_id)]
      >= waveByIndex[indexByTodo.get(precedence.to_todo_id)]) {
      return false;
    }
  }
  return true;
}

function searchMinimum(graph, maxSearchStates) {
  const assignment = new Array(graph.todos.length).fill(0);
  const indexByTodo = new Map(graph.todos.map((todoId, index) => [todoId, index]));
  let examined = 0;

  for (let waveCount = 1; waveCount <= graph.todos.length; waveCount += 1) {
    const used = new Array(waveCount).fill(0);
    let solution = null;
    let exhausted = false;

    function visit(todoIndex, usedCount) {
      if (solution !== null || exhausted) return;
      if (todoIndex === graph.todos.length) {
        if (usedCount !== waveCount) return;
        if (examined >= maxSearchStates) {
          exhausted = true;
          return;
        }
        examined += 1;
        if (feasibleAssignment(graph, assignment, indexByTodo)) {
          solution = [...assignment];
        }
        return;
      }

      const remainingAfter = graph.todos.length - todoIndex - 1;
      for (let waveIndex = 0; waveIndex < waveCount; waveIndex += 1) {
        const isNew = used[waveIndex] === 0;
        const nextUsedCount = usedCount + (isNew ? 1 : 0);
        if (waveCount - nextUsedCount > remainingAfter) continue;
        assignment[todoIndex] = waveIndex;
        used[waveIndex] += 1;
        visit(todoIndex + 1, nextUsedCount);
        used[waveIndex] -= 1;
        if (solution !== null || exhausted) return;
      }
    }

    visit(0, 0);
    if (exhausted) return { outcome: 'exhausted' };
    if (solution !== null) return { outcome: 'found', assignment: solution, waveCount };
  }
  fail('acyclic bounded graphにfeasible scheduleがない');
}

function pairwiseVerdicts(graph) {
  return [
    ...graph.conflicts.map((conflict) => ({
      type: 'conflict',
      todo_ids: [...conflict.todo_ids],
      resource_id: conflict.resource_id,
    })),
    ...graph.precedences.map((precedence) => ({
      type: 'precedence',
      from_todo_id: precedence.from_todo_id,
      to_todo_id: precedence.to_todo_id,
      reason: precedence.reason,
    })),
  ];
}

/**
 * Candidate非依存のbounded graphをcanonical minimum-wave planへcompileする。
 * @param {unknown} normalizedGraph
 * @param {unknown} options
 * @returns {object}
 */
export function compileSchedulabilityGraphV2(normalizedGraph, options = {}) {
  const graph = normalizeGraph(normalizedGraph);
  const { maxSearchStates, omitWavesOverLimit } = normalizeOptions(options);

  const overLimit = graph.todos.length > MAX_TODOS;
  if (overLimit && !omitWavesOverLimit) {
    return { outcome: 'unsupported', code: 'NODE_LIMIT_EXCEEDED' };
  }
  if (graph.unknowns.length > 0) {
    return { outcome: 'unknown', code: 'BOUNDARY_UNKNOWN', unknowns: graph.unknowns };
  }
  // g5: the exact minimum-wave search stops at MAX_TODOS. A caller that only needs the verdicts (independence) opts in to
  // `plan: null` above it: the pairwise verdicts do not depend on the search, and no minimum is claimed.
  if (overLimit) return { outcome: 'compiled', pairwise_verdicts: pairwiseVerdicts(graph), plan: null };
  if (maxSearchStates === 0) {
    return { outcome: 'unsupported', code: 'SEARCH_BUDGET_EXHAUSTED' };
  }

  const searched = searchMinimum(graph, maxSearchStates);
  if (searched.outcome === 'exhausted') {
    return { outcome: 'unsupported', code: 'SEARCH_BUDGET_EXHAUSTED' };
  }

  const waves = Array.from({ length: searched.waveCount }, () => ({ todo_ids: [] }));
  searched.assignment.forEach((waveIndex, todoIndex) => {
    waves[waveIndex].todo_ids.push(graph.todos[todoIndex]);
  });
  return {
    outcome: 'compiled',
    pairwise_verdicts: pairwiseVerdicts(graph),
    plan: {
      schema_version: PLAN_SCHEMA,
      waves,
      minimum_feasible_waves: searched.waveCount,
    },
  };
}
