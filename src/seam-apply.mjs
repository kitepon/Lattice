/**
 * 記録済みseam提案を隔離worktreeで実際に適用し、五条件で採否を決める（ADR 0137・0138）。
 *
 * 本repositoryは一切変更しない。変換も検証も使い捨てworktreeの中だけで起き、残るのは判定と
 * その理由である。採用された変換を本ツリーへ着地させるのは別工程が持つ。
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { runIsolatedTransform } from './isolation-runner.mjs';
import { collectSensorEvidence } from './sensor-adapter.mjs';
import { invokeSensorCli } from './sensor-runtime.mjs';
import { buildSeamDerivationQuerySet, deriveBoundedSeamCandidate } from './seam-derivation.mjs';
import { joinImportSurface, mentions, planSeamRewrite } from './seam-rewrite.mjs';
import {
  buildPostTransformWitnessSet, compareExportSurface, evaluateSeamVerification, measureWaveCount,
} from './seam-verification.mjs';
import { isTodoRef, todoSelfDigest } from './todo-contracts.mjs';
import { digestArtifact } from './artifact-contracts.mjs';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const MISSING_PREFIX = 'callee_data_missing:';
const MAX_CLOSURE_ROUNDS = 32;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha16 = (value) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);

function nodeOf(entry) {
  const node = entry?.node ?? entry;
  return typeof node?.name === 'string' && typeof node?.filePath === 'string' ? node : null;
}

/**
 * 同一file内のcalleeを、閉包が閉じるまで反復して集める。
 *
 * 未照会と「calleeが無い」を同一視しないので、導出は不足を`callee_data_missing`で返す。
 * その名前を追加照会して繰り返す。1回で済ませようとすると閉包が浅くなり、移動先で参照だけが
 * 宙に浮く——構文は通るので実行するまで気づけない。
 */
async function deriveWithClosure({ cwd, deriveOnce }) {
  const calleesBySymbol = {};
  const ask = async (symbols) => {
    if (symbols.length === 0) return;
    const querySet = buildSeamDerivationQuerySet(symbols);
    const collected = await collectSensorEvidence({ cwd, querySet });
    querySet.queries.forEach((query, index) => {
      if (query.operation !== 'callees') return;
      const raw = collected.outcomes[index];
      const list = raw?.data?.callees ?? raw?.data ?? [];
      calleesBySymbol[query.target] = (Array.isArray(list) ? list : [])
        .map(nodeOf).filter(Boolean)
        .map((node) => ({ name: node.name, path: node.filePath }));
    });
  };
  await ask(deriveOnce.seeds);
  for (let round = 0; round < MAX_CLOSURE_ROUNDS; round += 1) {
    const outcome = deriveOnce.derive(calleesBySymbol);
    if (outcome.candidate !== null) return { ...outcome, rounds: round + 1, calleesBySymbol };
    const missing = outcome.reasons
      .filter((reason) => reason.startsWith(MISSING_PREFIX))
      .map((reason) => reason.slice(MISSING_PREFIX.length));
    if (missing.length === 0) return { ...outcome, rounds: round + 1, calleesBySymbol };
    await ask(missing);
  }
  return { candidate: null, reasons: ['closure_rounds_exhausted'], calleesBySymbol };
}

/** 宣言symbolの行範囲。移す範囲を決めるので、原path上のexact一致だけを採る。 */
const SYMBOL_LOOKUP_LIMIT = 500;

/** gitに載らないbuild成果物のうち、focused testが要るものを実在する時だけ張る。 */
export async function buildOutputMounts(repoRoot) {
  const { access } = await import('node:fs/promises');
  const mounts = [];
  for (const entry of ['sensor/dist']) {
    try {
      await access(path.join(repoRoot, entry));
      mounts.push({ entry, target: path.join(repoRoot, entry) });
    } catch { /* 無ければ張らない。無い環境ではそのtestも同梱sensorを要求しない。 */ }
  }
  return mounts;
}

/**
 * 変換対象symbolの行範囲を、対象file限定で読む。
 *
 * witness evidenceの共通経路（`collectSensorEvidence`）で名前を引くと、sensor CLIの既定
 * `--limit 10`で打ち切られる。同名symbolが多いprojectでは対象fileの定義が窓の外へ落ち、
 * **実在するsymbolを「範囲なし」と誤報して正当な変換を棄却する**。実測では`GIT_SHA1`が
 * 17 fileにあり、名前順で先頭10件に入らなかった`src/seam-commit.mjs`の定義が返らなかった。
 *
 * よってここは共通経路を使わず、明示limitで引く。limitに達した結果は打ち切りの疑いがある
 * ので、`missing`ではなく`truncated`として区別して返す——観測の欠落を「無い」へ丸めない。
 */
export async function readSymbolExtents({ cwd, sourcePath, symbols }) {
  const extents = {};
  const truncated = [];
  for (const symbol of [...new Set(symbols)]) {
    const result = invokeSensorCli(
      (command, args, options) => spawnSync(command, args, options),
      ['query', symbol, '--path', '.', '--limit', String(SYMBOL_LOOKUP_LIMIT), '--json'],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) continue;
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { continue; }
    const entries = Array.isArray(parsed) ? parsed : parsed?.data ?? parsed?.results ?? [];
    for (const entry of entries) {
      const node = nodeOf(entry);
      if (node === null || node.name !== symbol || node.filePath !== sourcePath) continue;
      if (!Number.isSafeInteger(node.startLine) || !Number.isSafeInteger(node.endLine)) continue;
      // 装飾込みの開始行（sensor v11）を優先する。Pythonの@decoratorやRustの#[derive]は
      // 宣言の外の行にあり、宣言行だけで切ると装飾が残余面へ取り残される。
      const start = Number.isSafeInteger(node.extentStartLine) && node.extentStartLine < node.startLine
        ? node.extentStartLine : node.startLine;
      // export状態もAST事実として持ち帰る（sc-013）。書き換え側のtext走査を置き換える。
      extents[symbol] = { startLine: start, endLine: node.endLine, isExported: node.isExported === true };
    }
    if (extents[symbol] === undefined && entries.length >= SYMBOL_LOOKUP_LIMIT) truncated.push(symbol);
  }
  return { extents, truncated: [...new Set(truncated)].sort(compareText) };
}

/**
 * 対象fileのimport面をsensorの観測から読む（sc-013）。
 *
 * `file-nodes`の`imports`（文の行範囲）と`import_bindings`（AST由来の束縛）を
 * `joinImportSurface`で文単位へ束ねる。観測が取れなければnullを返し、書き換え側が
 * `import_surface_missing`のtyped理由で止める——正規表現の再解析へfallbackしない。
 */
export function readImportSurface({ cwd, sourcePath }) {
  const result = invokeSensorCli(
    (command, args, options) => spawnSync(command, args, options),
    ['file-nodes', sourcePath, '--path', '.'],
    { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) return null;
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { return null; }
  if (!Array.isArray(parsed?.imports) || !Array.isArray(parsed?.import_bindings)) return null;
  return joinImportSurface(parsed.imports, parsed.import_bindings);
}

async function runIn(worktreePath, command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: worktreePath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error) };
  }
}

/**
 * 変換で切断された参照を数える（検証網、ADR 0145）。
 *
 * 移した先のcodeが、残余面に留まったsymbol（module変数・非公開関数）へ束縛なしで言及して
 * いれば、その参照は切断されている——moduleの読み込みは通り、実行して初めてReferenceErrorに
 * なるので、focused testが当該経路を通らなければ黙って壊れたまま採用される。これを受入の
 * 一点で数える。
 *
 * 残余面のsymbol一覧は、変換後worktreeのfresh indexから抽出精度で取る（`file-nodes`）。
 * value-ref辺の名前フィルタはノード生成に効かないので、全小文字のmodule変数もここには載る。
 * `unresolved_refs`は使わない——bare参照の切断はそこに記録されないことを実測で確認した
 * （builtin呼び出しは載るが、未束縛のidentifier読みは載らない）。
 *
 * 検査は保守的である。`mentions`はtext一致なので、文字列やcomment内の同名語も
 * 「切断の疑い」として数える——見逃す方向ではなく誤検出の方向へ倒す（fail closed）。
 * 網は受入の一点だけで、過程には触れない。不認定は拒否ではなく、理由を見て直せば
 * 何度でも再提出できる。
 */
export async function detectSeveredReferences({ worktreePath, files, residualPath }) {
  const readFileNodes = (target) => {
    const result = invokeSensorCli(
      (command, args, options) => spawnSync(command, args, options),
      ['file-nodes', target, '--path', '.'],
      { cwd: worktreePath, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { return null; }
    if (!Array.isArray(parsed?.nodes)) return null;
    return parsed;
  };

  const residual = readFileNodes(residualPath);
  if (residual === null) return { observed: false, entries: [] };
  const residualNames = residual.nodes.map(({ name }) => name);

  const entries = [];
  for (const [target, body] of Object.entries(files)) {
    if (target === residualPath) continue;
    const own = readFileNodes(target);
    if (own === null) return { observed: false, entries: [] };
    const defined = new Set(own.nodes.map(({ name }) => name));
    // import束縛はworktreeのfresh indexのAST観測から取る（sc-013）。text再解析をしない。
    // 束縛が観測できないindexでは網の判定材料が欠けるので、unobservedへ倒す（fail closed）。
    if (!Array.isArray(own.import_bindings)) return { observed: false, entries: [] };
    const imported = new Set(own.import_bindings
      .map(({ local }) => local).filter((name) => typeof name === 'string'));
    for (const name of residualNames) {
      if (defined.has(name) || imported.has(name)) continue;
      if (mentions(body, name)) entries.push({ file: target, name });
    }
  }
  return {
    observed: true,
    entries: entries.sort((left, right) => compareText(
      `${left.file}\0${left.name}`, `${right.file}\0${right.name}`,
    )),
  };
}

/**
 * 変換後worktreeを再indexし、新pathが索引に載ったかを見る。
 *
 * 載っていなければ、その後のcompileは古い構造を見ている。observationの欠落を
 * 「変わらなかった」へ丸めない。
 */
async function observeFreshSensor({ worktreePath, latticeBin, paths }) {
  const init = await runIn(worktreePath, process.execPath, [latticeBin, 'sensor', 'init', '.', '--json']);
  if (!init.ok) {
    return {
      fresh: false,
      detail: `sensor_init_failed:${String(init.stderr ?? '').replace(/\s+/gu, ' ').slice(0, 200)}`,
    };
  }
  const querySet = {
    queries: [
      { id: 'fresh-status', operation: 'status' },
      ...paths.map((target, index) => ({
        id: `fresh-affected-${String(index).padStart(3, '0')}`, operation: 'affected', target,
      })),
    ],
  };
  const collected = await collectSensorEvidence({ cwd: worktreePath, querySet });
  const affectedByPath = {};
  let fresh = true;
  querySet.queries.forEach((query, index) => {
    if (query.operation !== 'affected') return;
    const outcome = collected.outcomes[index];
    const entry = outcome?.targets?.[0];
    // `path_state`はfs観測で不存在だった時にだけ付く。正常時は欄そのものが無いので、
    // `=== 'file'`を要求すると常に落ちる。見るべきは「不存在と観測されていないこと」と
    // 「affected観測が在ること」の2つである。
    if (entry?.path_state === 'absent' || !Array.isArray(entry?.data?.affectedTests)) {
      fresh = false;
      return;
    }
    affectedByPath[query.target] = [...entry.data.affectedTests].sort(compareText);
  });
  return { fresh, affectedByPath, detail: fresh ? null : 'new_path_not_indexed' };
}

/** 競合対を`{task, task}`の集合として数える。componentでなくplan全体を見る（ADR 0138）。 */
function conflictPairsOf(artifact) {
  return new Set((artifact?.conflicts ?? [])
    .map(({ task_ids: ids }) => [...ids].sort(compareText).join('\0')));
}

/** 係争資源の中で、そのtaskが自分の担当と宣言したsymbol。 */
function ownedSymbolsWithin(witnessSet, taskIds, sourcePath) {
  const owned = {};
  for (const taskId of taskIds) {
    owned[taskId] = (witnessSet?.manual_witness?.[taskId]?.concern_anchors ?? [])
      .filter((entry) => entry.within.target === sourcePath)
      .flatMap((entry) => entry.symbols);
  }
  return owned;
}

/**
 * 記録済みseam提案を、変換の入力へ正規化する。
 *
 * 提案が出すpathはhash由来の仮名である。名前を付けるのは判断なので製品が発明しない
 * （AGENTS.md「装置の境界」）。与えられた名前は導出の入力として最初から使う——後から改名すると、
 * 生成済みのimport指定子が旧名を指したまま残る。
 */
export function seamConflictFromProposal({ proposal, witnessSet, pathNames = {} } = {}) {
  const decision = (proposal?.decisions ?? []).find(({ verdict }) => verdict === 'seam_candidate');
  if (decision === undefined) return { conflict: null, reasons: ['no_seam_candidate'] };
  const sourcePath = decision.conflicts[0].target;
  return {
    conflict: {
      sourcePath,
      taskIds: [...decision.task_ids],
      ownedSymbolsByTask: ownedSymbolsWithin(witnessSet, decision.task_ids, sourcePath),
      proposedPathByTask: Object.fromEntries(decision.seam_candidate.proposed_surfaces
        .map((surface) => [
          surface.owner_task_ids[0],
          pathNames[surface.owner_task_ids[0]] ?? surface.target,
        ])),
      affectedTests: decision.seam_candidate.affected_tests,
      baseSha: proposal.source_binding.base_sha,
      manifestDigest: proposal.source_binding.independence_result_digest,
      findingDigest: decision.seam_candidate.proposal_digest,
      candidateId: `seam-apply-${decision.component_id}`,
    },
    reasons: [],
  };
}

/**
 * 実行時競合のfindingを、同じ変換の入力へ正規化する（請求項8）。
 *
 * 静的側との違いは入力だけである。記録済み提案の代わりに、観測された競合path・関与する2 task・
 * 実行中requestの宣言を持つ。導出の芯は同じなので、口だけを分けて共有する。
 *
 * 提案と違い所有面のpathは決まっていないので、名前は呼び出し側が全部与える。与えられなければ
 * 候補を作らない——製品が名前を発明しないという線は実行時でも同じである。
 */
export function seamConflictFromFinding({
  finding, witnessSet, pathNames = {}, affectedTests = [], baseSha, manifestDigest,
  recordedFindingDigest = null,
} = {}) {
  if (finding?.kind !== 'observed_write_conflict' || typeof finding.path !== 'string') {
    return { conflict: null, reasons: ['finding_not_write_conflict'] };
  }
  const taskIds = [...(finding.todo_ids ?? [])].sort(compareText);
  if (taskIds.length < 2) return { conflict: null, reasons: ['finding_below_two_tasks'] };
  const missing = taskIds.filter((taskId) => !isTodoRef(pathNames[taskId] ?? ''));
  if (missing.length > 0) {
    return { conflict: null, reasons: missing.map((taskId) => `owned_path_name_missing:${taskId}`) };
  }
  return {
    conflict: {
      sourcePath: finding.path,
      taskIds,
      ownedSymbolsByTask: ownedSymbolsWithin(witnessSet, taskIds, finding.path),
      proposedPathByTask: Object.fromEntries(taskIds.map((taskId) => [taskId, pathNames[taskId]])),
      affectedTests: [...affectedTests].sort(compareText),
      baseSha,
      manifestDigest,
      // 実行時は提案artifactが無い。観測したfindingそのものを出所として縛る。
      //
      // **記録済みfindingのdigestがあるなら、それを使う。** 内容から再導出したdigestで縛ると、
      // 「この変換はあのfindingへの答えだ」という記録が、storeに実在しないidを指す。実際、
      // 再計画側は`findings/<digest>.json`を読むので、再導出値では必ず読めない。
      findingDigest: recordedFindingDigest ?? digestArtifact({
        kind: finding.kind, path: finding.path, todo_ids: taskIds,
      }),
      candidateId: `seam-runtime-${sha16(`${finding.path}\0${taskIds.join(',')}`)}`,
    },
    reasons: [],
  };
}

/**
 * 正規化した競合入力から変換を適用し、五条件で採否を返す。
 *
 * @returns {Promise<{outcome: object, files: object|null}>} `lattice.seam_apply_outcome.v1`
 */
export async function applySeamConflict({
  repoRoot, planKey, conflict, witnessSet, latticeBin, sharedPathFor,
  executors, compileIndependence, pathNames = {}, precedences = [],
} = {}) {
  const {
    sourcePath, taskIds, ownedSymbolsByTask, proposedPathByTask, affectedTests,
    baseSha, manifestDigest, findingDigest, candidateId,
  } = conflict;
  const decision = { task_ids: taskIds };

  const derived = await deriveWithClosure({
    cwd: repoRoot,
    deriveOnce: {
      seeds: [...new Set(Object.values(ownedSymbolsByTask).flat())],
      derive: (calleesBySymbol) => deriveBoundedSeamCandidate({
        sourcePath,
        taskRefs: taskIds.map((taskId) => ({ plan_key: planKey, task_id: taskId })),
        ownedSymbolsByTask,
        proposedPathByTask,
        sharedPath: pathNames.shared ?? sharedPathFor(sourcePath),
        calleesBySymbol,
        affectedTests,
        baseSha,
        manifestDigest,
        findingDigest,
        candidateId,
      }),
    },
  });
  if (derived.candidate === null) {
    return { outcome: outcome({ planKey, decision: 'rejected', reasons: derived.reasons }), files: null };
  }
  const candidate = derived.candidate;

  const { readFile } = await import('node:fs/promises');
  const beforeText = await readFile(path.join(repoRoot, sourcePath), 'utf8');
  const lookup = await readSymbolExtents({
    cwd: repoRoot, sourcePath,
    symbols: candidate.surfaces.flatMap(({ symbols }) => symbols),
  });
  if (lookup.truncated.length > 0) {
    // 打ち切りは「範囲が無い」ではない。誤った理由で棄却して原因を隠さない。
    return {
      outcome: outcome({ planKey, decision: 'rejected', candidate,
        reasons: lookup.truncated.map((symbol) => `symbol_lookup_truncated:${symbol}`) }),
      files: null,
    };
  }
  const rewritten = planSeamRewrite({
    sourceText: beforeText, candidate, symbolExtents: lookup.extents,
    importSurface: readImportSurface({ cwd: repoRoot, sourcePath }),
  });
  if (rewritten.files === null) {
    return { outcome: outcome({ planKey, decision: 'rejected', reasons: rewritten.reasons, candidate }), files: null };
  }

  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const scratchLattice = await mkdtemp(path.join(tmpdir(), 'lattice-seam-scratch-'));
  const beforePairs = conflictPairsOf(compileIndependence.baseArtifact);
  const targetPair = [...decision.task_ids].sort(compareText).join('\0');
  let observation = null;
  let verifierFailure = null;
  try {
    await runIsolatedTransform({
      repoRoot,
      baseRef: candidate.base_sha,
      allowedPaths: candidate.allowed_paths,
      transform: async ({ worktreePath }) => {
        for (const [target, text] of Object.entries(rewritten.files)) {
          await mkdir(path.dirname(path.join(worktreePath, target)), { recursive: true });
          await writeFile(path.join(worktreePath, target), text);
        }
      },
      // 依存が無いとfocused testはERR_MODULE_NOT_FOUNDで落ち、変換の欠陥と環境の欠陥が
      // 同じfailに見える。runnerが張るので、呼び出し側が任意の変更を隠す口にはならない。
      //

      mounts: [
        { entry: 'node_modules', target: path.join(repoRoot, 'node_modules') },
        // 索引の書き先を使い捨てへ向ける。verifierも再indexもここへ書くので、本repoの
        // 索引を触らせない。src／testへはrunnerがmountを拒否する。
        { entry: '.lattice/sensor', target: scratchLattice },
        // build成果物はgitignoreされているので、どのcommitのworktreeにも存在しない。
        // 張らないと、同梱sensorを起動するfocused testがすべてENOENTで落ち、
        // focused_tests_passedが原理的に満たせなくなる（実測でこれに当たった）。
        // 存在する時だけ張る——Latticeを依存として使うprojectはnode_modules側に持つ。
        ...await buildOutputMounts(repoRoot),
      ],
      // 書き先を隠すのでなく、書かせない。verifierが常駐面を起こすとworktreeへ索引が
      // 生まれ、変更を残さない規律に当たる。
      verifierEnv: { LATTICE_DASHBOARD_AUTOSTART: '0' },
      verifyCommands: candidate.verification_policy.focused_test_refs
        .map((ref) => ({ command: process.execPath, args: ['--test', ref] })),
      observe: async ({ worktreePath }) => {
        const owned = candidate.surfaces
          .filter(({ role }) => role === 'task_owned').map(({ path: target }) => target);
        const sensor = await observeFreshSensor({ worktreePath, latticeBin, paths: owned });
        observation = { sensor, afterText: null, afterArtifact: null, severed: null };
        observation.afterText = await readFile(path.join(worktreePath, sourcePath), 'utf8');
        if (!sensor.fresh) return;
        // 網は受入の一点だけ（ADR 0145）。fresh indexの上でしか意味を持たないので、
        // sensorが新pathを見ていない時は数えず、observation欠落として別理由で落とす。
        observation.severed = await detectSeveredReferences({
          worktreePath, files: rewritten.files, residualPath: sourcePath,
        });
        const post = buildPostTransformWitnessSet({
          witnessSet, candidate, affectedTestsByPath: sensor.affectedByPath,
        });
        if (post.witnessSet === null) {
          observation.reasons = post.reasons;
          return;
        }
        observation.afterArtifact = await compileIndependence.inWorktree({
          worktreePath, witnessSet: post.witnessSet,
        });
      },
    });
  } catch (error) {
    verifierFailure = String(error?.message ?? error);
  } finally {
    await rm(scratchLattice, { recursive: true, force: true });
  }

  const afterPairs = observation?.afterArtifact === null || observation?.afterArtifact === undefined
    ? null : conflictPairsOf(observation.afterArtifact);
  const orderedTaskIds = [...taskIds].sort(compareText);
  const verification = evaluateSeamVerification({
    exportSurface: observation?.afterText === null || observation?.afterText === undefined
      ? { preserved: false, missing: [] }
      : compareExportSurface({ before: beforeText, after: observation.afterText }),
    severed: observation?.severed ?? null,
    focusedTestsPassed: verifierFailure === null,
    sensorFresh: observation?.sensor?.fresh === true,
    conflictPairs: afterPairs === null ? { targetResolved: false }
      : { targetResolved: !afterPairs.has(targetPair), before: beforePairs.size, after: afterPairs.size },
    waves: {
      before: measureWaveCount({
        taskIds, conflictPairs: [...beforePairs].map((key) => key.split('\0')), precedences, executors,
      }).waves,
      after: afterPairs === null ? null : measureWaveCount({
        taskIds, conflictPairs: [...afterPairs].map((key) => key.split('\0')), precedences, executors,
      }).waves,
    },
  });

  return { files: rewritten.files, outcome: outcome({
    planKey,
    decision: verification.decision,
    reasons: [
      ...verification.failures,
      ...(verifierFailure === null ? [] : [`verifier:${verifierFailure}`]),
      // 判定が落ちた理由を、条件名だけで終わらせない（ADR 0130）。
      ...(observation?.sensor?.detail ? [`sensor_detail:${observation.sensor.detail}`] : []),
      ...(observation?.reasons ?? []).map((reason) => `witness:${reason}`),
    ],
    candidate,
    conditions: verification.conditions,
    closureRounds: derived.rounds ?? null,
  }) };
}

function outcome({ planKey, decision, reasons, candidate = null, conditions = null, closureRounds = null }) {
  const result = {
    schema: 'lattice.seam_apply_outcome.v1',
    plan_key: planKey,
    decision,
    candidate_id: candidate?.candidate_id ?? null,
    candidate_digest: candidate?.candidate_digest ?? null,
    surfaces: (candidate?.surfaces ?? []).map(({ role, path: target, owner_task_ids: owners }) => ({
      role, path: target, owner_task_ids: [...owners],
    })),
    conditions,
    closure_rounds: closureRounds,
    reasons: [...new Set(reasons)].sort(compareText),
    result_digest: '',
  };
  result.result_digest = todoSelfDigest(result, 'result_digest');
  return result;
}

/**
 * 記録済みseam提案を適用して採否を返す。入力の正規化だけを行い、芯は`applySeamConflict`が持つ。
 */
export async function applySeamProposal({ sourceProposal, witnessSet, pathNames = {}, ...rest } = {}) {
  const { conflict, reasons } = seamConflictFromProposal({
    proposal: sourceProposal, witnessSet, pathNames,
  });
  if (conflict === null) {
    return { outcome: outcome({ planKey: rest.planKey, decision: 'rejected', reasons }), files: null };
  }
  return applySeamConflict({ ...rest, conflict, witnessSet, pathNames });
}
