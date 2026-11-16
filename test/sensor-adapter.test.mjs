import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectSensorEvidence,
  portableSensorOutcome,
} from '../src/sensor-adapter.mjs';

const READY_STATUS = JSON.stringify({
  initialized: true,
  version: '1.4.1',
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  worktreeMismatch: null,
  index: {
    builtWithVersion: '1.4.1',
    builtWithExtractionVersion: 7,
    currentExtractionVersion: 7,
    reindexRecommended: false,
    engineBehindIndexFiles: 0,
    state: 'complete',
    pendingRefs: 0,
  },
});

function fakeExecutor(responses) {
  return async ({ operation, target }) => {
    const response = responses[`${operation}:${target ?? ''}`] ?? responses[operation];
    assert.ok(response, `missing fake response for ${operation}:${target ?? ''}`);
    return response;
  };
}

test('portable outcome removes only execution telemetry and does not mutate raw evidence', () => {
  const status = {
    id: 'status',
    operation: 'status',
    outcome: 'ready',
    data: {
      initialized: true,
      version: '1.4.1',
      projectPath: '/tmp/first',
      indexPath: '/tmp/first/.lattice/sensor',
      lastIndexed: '2026-07-15T00:00:00.000Z',
      dbSizeBytes: 1_024,
      fileCount: 18,
      customFutureField: 'must remain',
    },
  };
  const query = {
    id: 'query',
    operation: 'query',
    target: 'buildDispatchRecord',
    outcome: 'ready',
    updatedAt: 'top-level unknown must remain',
    data: [{
      node: {
        id: 'function:stable',
        kind: 'function',
        name: 'buildDispatchRecord',
        filePath: 'research/fixture.mjs',
        updatedAt: 1,
        customFutureField: 'must remain',
      },
      score: 100,
    }],
  };
  const before = structuredClone({ status, query });

  const portableStatus = portableSensorOutcome(status);
  const portableQuery = portableSensorOutcome(query);

  assert.deepEqual({ status, query }, before);
  assert.deepEqual(portableStatus, {
    id: 'status',
    operation: 'status',
    outcome: 'ready',
    data: {
      initialized: true,
      version: '1.4.1',
      fileCount: 18,
      customFutureField: 'must remain',
    },
  });
  assert.equal(portableQuery.updatedAt, 'top-level unknown must remain');
  assert.equal('updatedAt' in portableQuery.data[0].node, false);
  assert.equal(portableQuery.data[0].node.customFutureField, 'must remain');

  const otherStatus = structuredClone(status);
  otherStatus.data.projectPath = '/tmp/second';
  otherStatus.data.indexPath = '/tmp/second/.lattice/sensor';
  otherStatus.data.lastIndexed = '2026-07-15T00:00:01.000Z';
  otherStatus.data.dbSizeBytes = 2_048;
  assert.deepEqual(portableSensorOutcome(otherStatus), portableStatus);

  const structuralDrift = structuredClone(status);
  structuralDrift.data.customFutureField = 'changed';
  assert.notDeepEqual(portableSensorOutcome(structuralDrift), portableStatus);
});

test('collects query operations in input order with typed ready outcomes', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [
        { id: 'status', operation: 'status' },
        { id: 'query', operation: 'query', target: 'buildDispatchRecord' },
        { id: 'affected', operation: 'affected', targets: ['fixture.mjs', 'test.mjs'] },
      ],
    },
    execute: fakeExecutor({
      status: { code: 0, stdout: READY_STATUS, stderr: '' },
      'query:buildDispatchRecord': {
        code: 0,
        stdout: '[{"node":{"name":"buildDispatchRecord","qualifiedName":"buildDispatchRecord"}}]',
        stderr: '',
      },
      'affected:fixture.mjs': { code: 0, stdout: '{"affectedTests":["test.mjs"]}', stderr: '' },
      'affected:test.mjs': { code: 0, stdout: '{"affectedTests":["test.mjs"]}', stderr: '' },
    }),
    inspectAffectedPath: async () => 'file',
  });

  assert.equal(evidence.cwd, '/repo');
  assert.deepEqual(evidence.outcomes.map(({ id }) => id), ['status', 'query', 'affected']);
  assert.deepEqual(evidence.outcomes.map(({ outcome }) => outcome), ['ready', 'ready', 'ready']);
  assert.deepEqual(evidence.outcomes[2].targets.map(({ target }) => target), ['fixture.mjs', 'test.mjs']);
});

test('keeps query and affected empty results typed rather than independent', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [
        { id: 'query', operation: 'query', target: 'missingSymbol' },
        { id: 'affected', operation: 'affected', targets: ['missing.mjs'] },
      ],
    },
    execute: fakeExecutor({
      'query:missingSymbol': { code: 0, stdout: '[]', stderr: '' },
      'affected:missing.mjs': { code: 0, stdout: '{"affectedTests":[]}', stderr: '' },
    }),
    inspectAffectedPath: async () => 'absent',
  });

  assert.equal(evidence.outcomes[0].outcome, 'symbol_absent');
  assert.equal(evidence.outcomes[1].outcome, 'empty');
  assert.equal(evidence.outcomes[1].targets[0].outcome, 'empty');
  assert.equal(evidence.outcomes[1].targets[0].path_state, 'absent');
});

test('does not promote fuzzy query and traversal matches to exact symbol presence', async () => {
  const fuzzyQuery = JSON.stringify([{
    node: {
      name: 'SEAM_BY_CONCERN',
      qualifiedName: 'SEAM_BY_CONCERN',
      signature: "{ symbol: 'selectDispatchChannel' }",
    },
  }]);
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [
        { id: 'query', operation: 'query', target: 'selectDispatchChannel' },
        { id: 'impact', operation: 'impact', target: 'selectDispatchChannel' },
      ],
    },
    execute: fakeExecutor({
      'query:selectDispatchChannel': { code: 0, stdout: fuzzyQuery, stderr: '' },
      'impact:selectDispatchChannel': {
        code: 0,
        stdout: JSON.stringify({
          symbol: 'selectDispatchChannel',
          affected: [{ name: 'SEAM_BY_CONCERN', kind: 'constant' }],
        }),
        stderr: '',
      },
    }),
  });

  assert.deepEqual(evidence.outcomes.map(({ outcome }) => outcome), [
    'symbol_absent',
    'symbol_absent',
  ]);
  assert.deepEqual(evidence.outcomes[0], {
    id: 'query',
    operation: 'query',
    target: 'selectDispatchChannel',
    outcome: 'symbol_absent',
    data: [],
  });
  assert.deepEqual(evidence.outcomes[1], {
    id: 'impact',
    operation: 'impact',
    target: 'selectDispatchChannel',
    outcome: 'symbol_absent',
  });
});

test('binds affected targets to regular files inside the observed workspace', async (context) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lattice-lattice-sensor-affected-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'test'), { recursive: true });
  await writeFile(path.join(cwd, 'test/present.test.mjs'), 'export const present = true;\n');
  await symlink('present.test.mjs', path.join(cwd, 'test/link.test.mjs'));
  await mkdir(path.join(cwd, 'test/directory'));

  const targets = [
    'test/present.test.mjs',
    'test/missing.test.mjs',
    'missing-root.mjs',
    'test/link.test.mjs',
    'test/directory',
    '../outside.test.mjs',
    path.join(cwd, 'test/present.test.mjs'),
  ];
  const responses = Object.fromEntries(targets.map((target) => [
    `affected:${target}`,
    {
      code: 0,
      stdout: JSON.stringify({
        changedFiles: [target],
        affectedTests: [target],
        totalDependentsTraversed: 0,
      }),
      stderr: '',
    },
  ]));
  const evidence = await collectSensorEvidence({
    cwd,
    querySet: { queries: [{ id: 'affected', operation: 'affected', targets }] },
    execute: fakeExecutor(responses),
  });

  assert.deepEqual(evidence.outcomes[0].targets, [
    {
      target: 'test/present.test.mjs',
      outcome: 'ready',
      data: {
        changedFiles: ['test/present.test.mjs'],
        affectedTests: ['test/present.test.mjs'],
        totalDependentsTraversed: 0,
      },
    },
    {
      target: 'test/missing.test.mjs',
      outcome: 'empty',
      path_state: 'absent',
      data: {
        changedFiles: ['test/missing.test.mjs'],
        affectedTests: [],
        totalDependentsTraversed: 0,
      },
    },
    {
      target: 'missing-root.mjs',
      outcome: 'empty',
      path_state: 'absent',
      data: {
        changedFiles: ['missing-root.mjs'],
        affectedTests: [],
        totalDependentsTraversed: 0,
      },
    },
    { target: 'test/link.test.mjs', outcome: 'unresolved' },
    { target: 'test/directory', outcome: 'unresolved' },
    { target: '../outside.test.mjs', outcome: 'unresolved' },
    { target: path.join(cwd, 'test/present.test.mjs'), outcome: 'unresolved' },
  ]);

  const filesystemFailure = await collectSensorEvidence({
    cwd,
    querySet: {
      queries: [{ id: 'affected', operation: 'affected', targets: ['test/present.test.mjs'] }],
    },
    execute: fakeExecutor(responses),
    inspectAffectedPath: async () => 'unresolved',
  });
  assert.deepEqual(filesystemFailure.outcomes[0].targets, [
    { target: 'test/present.test.mjs', outcome: 'unresolved' },
  ]);
});

test('accepts traversal JSON only after an exact query identity resolves', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [{ id: 'callers', operation: 'callers', target: 'buildDispatchRecord' }],
    },
    execute: fakeExecutor({
      'query:buildDispatchRecord': {
        code: 0,
        stdout: JSON.stringify([{
          node: {
            name: 'buildDispatchRecord',
            qualifiedName: 'buildDispatchRecord',
          },
        }]),
        stderr: '',
      },
      'callers:buildDispatchRecord': {
        code: 0,
        stdout: JSON.stringify({
          symbol: 'buildDispatchRecord',
          callers: [{ name: 'fixture.test.mjs', kind: 'file' }],
        }),
        stderr: '',
      },
    }),
  });

  assert.equal(evidence.outcomes[0].outcome, 'ready');
  assert.equal(evidence.outcomes[0].resolution[0].node.name, 'buildDispatchRecord');
});

test('strict traversalは宣言pathをCLIへ渡しportable outcomeへ保持する', async () => {
  const commands = [];
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [{
        id: 'callers', operation: 'callers', target: 'buildDispatchRecord',
        exact_path: 'src/runtime.mjs',
      }],
    },
    execute: async (command) => {
      commands.push(command);
      if (command.operation === 'query') {
        return {
          code: 0, stderr: '', stdout: JSON.stringify([{
            node: {
              name: 'buildDispatchRecord', qualifiedName: 'buildDispatchRecord',
              kind: 'function', filePath: 'src/runtime.mjs',
            },
          }]),
        };
      }
      return {
        code: 0, stderr: '', stdout: JSON.stringify({
          symbol: 'buildDispatchRecord', exactPath: 'src/runtime.mjs',
          exactResolution: 'ready', callers: [],
        }),
      };
    },
  });

  assert.deepEqual(commands[0].args, [
    'callers', 'buildDispatchRecord', '--path', '.', '--limit', '200',
    '--exact-path', 'src/runtime.mjs', '--json',
  ]);
  assert.equal(evidence.outcomes[0].data.exactResolution, 'ready');
});

test('accepts only the observed ANSI info-prefixed Symbol not found output', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: { queries: [{ id: 'impact', operation: 'impact', target: 'selectDispatchChannel' }] },
    execute: fakeExecutor({
      'impact:selectDispatchChannel': {
        code: 0,
        stdout: '\u001B[34mℹ\u001B[0m Symbol "selectDispatchChannel" not found\n',
        stderr: '',
      },
    }),
  });

  assert.equal(evidence.outcomes[0].outcome, 'symbol_absent');
});

test('rejects approximate non-JSON Symbol not found messages', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: { queries: [{ id: 'impact', operation: 'impact', target: 'selectDispatchChannel' }] },
    execute: fakeExecutor({
      'impact:selectDispatchChannel': {
        code: 0,
        stdout: '\u001B[34mnotice\u001B[0m Symbol "selectDispatchChannel" not found later\n',
        stderr: '',
      },
    }),
  });

  assert.equal(evidence.outcomes[0].outcome, 'invalid_json');
});

test('fails loud for arbitrary non-JSON and nonzero command results', async () => {
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: [
        { id: 'invalid', operation: 'impact', target: 'knownSymbol' },
        { id: 'failed', operation: 'callees', target: 'knownSymbol' },
      ],
    },
    execute: fakeExecutor({
      'impact:knownSymbol': { code: 0, stdout: 'not JSON', stderr: '' },
      'callees:knownSymbol': { code: 2, stdout: '', stderr: 'boom' },
    }),
  });

  assert.equal(evidence.outcomes[0].outcome, 'invalid_json');
  assert.equal(evidence.outcomes[1].outcome, 'command_failure');
});

test('索引対象0件の完了indexはreadyであって、未解決へ落とさない', async () => {
  // 最初のsource fileを書く前のprojectは新規repoの正常な初期状態である。
  // sensorがこの索引に出自を刻まなかった時代（builtWithVersion: null）、ここは
  // 永久にunresolvedになり、shared pull runがboundaryを検証できず退役もできない
  // 閉じた循環を作った（2026-08-10）。件数はreadyの条件ではない。
  const emptyIndex = { ...JSON.parse(READY_STATUS), fileCount: 0, nodeCount: 0, edgeCount: 0 };
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: { queries: [{ id: 'status', operation: 'status' }] },
    execute: fakeExecutor({ status: { code: 0, stdout: JSON.stringify(emptyIndex), stderr: '' } }),
  });
  assert.equal(evidence.outcomes[0].outcome, 'ready');
});

test('fails loud for stale, unresolved, and unsupported status', async () => {
  const cases = [
    ['stale', {
      ...JSON.parse(READY_STATUS),
      pendingChanges: { added: 1, modified: 0, removed: 0 },
    }],
    ['stale', { ...JSON.parse(READY_STATUS), worktreeMismatch: { expected: 'a', actual: 'b' } }],
    ['stale', {
      ...JSON.parse(READY_STATUS),
      index: { ...JSON.parse(READY_STATUS).index, reindexRecommended: true },
    }],
    ['unresolved', {
      ...JSON.parse(READY_STATUS),
      pendingChanges: { added: -1, modified: 0, removed: 0 },
    }],
    ['unresolved', {
      ...JSON.parse(READY_STATUS),
      index: { ...JSON.parse(READY_STATUS).index, state: 'indexing' },
    }],
    ['unresolved', { ...JSON.parse(READY_STATUS), worktreeMismatch: false }],
    // 索引の素性を語る欄が欠けた／壊れたstatusは、readyへ丸めず未解決として扱う。
    ['unresolved', {
      ...JSON.parse(READY_STATUS),
      index: { ...JSON.parse(READY_STATUS).index, engineBehindIndexFiles: -1 },
    }],
    ['unresolved', {
      ...JSON.parse(READY_STATUS),
      index: (({ engineBehindIndexFiles, ...rest }) => rest)(JSON.parse(READY_STATUS).index),
    }],
    ['unsupported', { ...JSON.parse(READY_STATUS), version: null }],
  ];

  for (const [expected, status] of cases) {
    const evidence = await collectSensorEvidence({
      cwd: '/repo',
      querySet: { queries: [{ id: 'status', operation: 'status' }] },
      execute: fakeExecutor({ status: { code: 0, stdout: JSON.stringify(status), stderr: '' } }),
    });

    assert.equal(evidence.outcomes[0].outcome, expected);
  }
});

test('runs queries concurrently under a cap and keeps outcomes in query order', async () => {
  const delays = [40, 5, 30, 1, 20, 10, 15, 2, 25, 3];
  let running = 0;
  let peak = 0;
  const evidence = await collectSensorEvidence({
    cwd: '/repo',
    querySet: {
      queries: delays.map((delay, index) => (
        { id: `q${index}`, operation: 'affected', target: `f${index}.mjs`, delay }
      )),
    },
    execute: async ({ target }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delays[Number(target.slice(1, -4))]));
      running -= 1;
      // f3 fails; every other file has a dependent test named after itself.
      return target === 'f3.mjs'
        ? { code: 2, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: JSON.stringify({ affectedTests: [`t-${target}`] }), stderr: '' };
    },
    inspectAffectedPath: async () => 'file',
  });

  assert.ok(peak > 1 && peak <= 6, `peak concurrency ${peak}`);
  assert.deepEqual(evidence.outcomes.map(({ id }) => id), delays.map((_, index) => `q${index}`));
  evidence.outcomes.forEach((outcome, index) => {
    assert.equal(outcome.targets[0].target, `f${index}.mjs`);
    if (index === 3) {
      assert.equal(outcome.targets[0].outcome, 'command_failure');
      assert.equal(outcome.targets[0].exitCode, 2);
    } else {
      assert.equal(outcome.targets[0].outcome, 'ready');
      assert.deepEqual(outcome.targets[0].data.affectedTests, [`t-f${index}.mjs`]);
    }
  });
});
