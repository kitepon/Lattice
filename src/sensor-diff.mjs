/**
 * 2つのindexの構造グラフ差分。
 *
 * 動機は upstream追従である。sensor/ には由来元のupstreamがあり、54コミット分の差分を
 * 人がgrepとdiffで消化した（由来の正本は sensor/UPSTREAM.json）。両側のindexへ別々に
 * 照会はできても、差分を機械列挙する入口が無かった。ここがその入口である。
 * 用途はupstream追従に限らない——2つのtreeの構造グラフを突き合わせる汎用の入口である。
 *
 * ## なぜ node id で突き合わせないか
 *
 * node idは `<kind>:` + sha256(`相対path:kind:name:start_line`) であり、**行番号が埋まっている**。
 * idで突き合わせると、関数が数行ずれただけで両側とも別idになり、そのnodeも、そのnodeを
 * 端点に持つ全ての辺も、偽の追加＋削除として出る。54コミット級では差分が全て偽陽性で埋まる。
 * よって突き合わせは行番号を含まない自然キー `kind|file_path|qualified_name|name` で行い、
 * 辺も端点idを自然キーへ解決してから比べる。
 *
 * ## 同一キーが複数ある時（overload・無名関数・同名の重複定義）
 *
 * 自然キーは一意でない。同キーの集団は両側をstart_line順に並べて先頭から対にする。対の中で
 * 属性が違えば changed、属性同一で行だけ違えば moved、余った分が added／removed になる。
 * 対応付けは発見的であり、「10個の無名callbackのうち3番目が消えた」を正確に指す保証は無い。
 * 件数と、その集団に何が起きたかは正しく出る。
 *
 * ## 出さないもの
 *
 * 揮発列（updated_at・indexed_at・modified_at・size・content_hash）は比較しない。
 * 端点を解決できない辺、subtree外へ出る辺は比較から外すが、**件数をexcludedへ必ず出す**。
 * 黙って落とすと「差分なし」と「見ていない」が同じ顔になる。
 *
 * ## 規模の前提
 *
 * 両側のnode・edge・fileを全件メモリへ載せてから突き合わせる。件数summaryを正確に出す以上、
 * 全件を見ないと済まないからである。`--limit`が切るのは**出力の明細だけ**で、読み込み量は
 * 切らない。実測の目安は片側17k nodes／72k edgesで数百MB未満だが、桁が2つ上がるindexでは
 * この前提ごと見直しが要る（streaming差分は別設計になる）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SENSOR_DB_RELATIVE_PATH = path.join('.lattice', 'sensor', 'sensor.db');

const DEFAULT_LIMIT = 200;
// 制御文字を区切りに使う。識別子・path・qualified nameのどれにも現れないので、
// 名前の中の記号が偶然キーを割るという壊れ方をしない。
const KEY_SEPARATOR = '\u0000';
const EDGE_SEPARATOR = '\u0001';

/** 対で比べる属性。差分は「どの属性が変わったか」を名前で返し、消費側が絞れるようにする。 */
const COMPARED_NODE_FIELDS = Object.freeze([
  'language', 'signature', 'visibility', 'return_type', 'docstring',
  'decorators', 'type_parameters',
  'is_exported', 'is_async', 'is_static', 'is_abstract',
  'span', 'extent_offset',
]);

export class SensorDiffError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SensorDiffError';
    this.code = code;
    this.detail = detail ?? {};
  }
}

/** `from=to` を1件解釈する。`=` を含まない指定は黙って無視せずusage errorにする。 */
function parseMapping(spec) {
  const index = spec.indexOf('=');
  if (index <= 0 || index === spec.length - 1) return null;
  return { from: normalizeRelative(spec.slice(0, index)), to: normalizeRelative(spec.slice(index + 1)) };
}

function normalizeRelative(value) {
  const normalized = value.replaceAll('\\', '/')
    .replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
  // `.` はrootそのものを指す慣用である。これを剥がさないとprefixが `./` になり、
  // どのpathにも一致せず「全件がsubtree外」＝差分ゼロという静かな嘘になる。
  return normalized === '.' ? '' : normalized;
}

/**
 * subtreeで絞ってprefixを剥がし、改名写像を当てる。写像は最長prefix一致で1回だけ適用する
 * （連鎖適用すると写像順で結果が変わり、再現しない）。
 */
function makePathNormalizer(subtree, mappings) {
  const prefix = subtree === '' ? '' : `${subtree}/`;
  const ordered = [...mappings].sort((a, b) => b.from.length - a.from.length);
  return (rawPath) => {
    const normalized = normalizeRelative(rawPath);
    if (prefix !== '' && !normalized.startsWith(prefix)) return null;
    let result = prefix === '' ? normalized : normalized.slice(prefix.length);
    for (const { from, to } of ordered) {
      if (result === from) { result = to; break; }
      if (result.startsWith(`${from}/`)) { result = `${to}/${result.slice(from.length + 1)}`; break; }
    }
    return result;
  };
}

function openIndex(root) {
  const resolvedRoot = path.resolve(root);
  const dbPath = path.join(resolvedRoot, SENSOR_DB_RELATIVE_PATH);
  if (!existsSync(dbPath)) {
    throw new SensorDiffError(
      'LATTICE_SENSOR_DIFF_INDEX_MISSING',
      `no sensor index at ${dbPath}`,
      { root: resolvedRoot, database: dbPath, next_action: `lattice sensor init ${root} --json` },
    );
  }
  try {
    return { root: resolvedRoot, dbPath, db: new DatabaseSync(dbPath, { readOnly: true }) };
  } catch (error) {
    throw new SensorDiffError(
      'LATTICE_SENSOR_DIFF_INDEX_UNREADABLE',
      `cannot read sensor index at ${dbPath}`,
      { root: resolvedRoot, database: dbPath, cause: error?.message ?? 'unknown error' },
    );
  }
}

/** 読み出しが要求する列。1つでも欠ければindexが古い。 */
const REQUIRED_COLUMNS = Object.freeze({
  nodes: ['id', 'kind', 'name', 'qualified_name', 'file_path', 'language', 'start_line', 'end_line',
    'signature', 'visibility', 'return_type', 'docstring', 'decorators', 'type_parameters',
    'extent_start_line', 'is_exported', 'is_async', 'is_static', 'is_abstract'],
  edges: ['source', 'target', 'kind'],
  files: ['path', 'language', 'content_hash', 'node_count', 'extraction_version', 'errors'],
});

/**
 * 読み出す前にschemaを確かめる。確かめないと、古いindexとの比較が「列が無い」というSQLiteの
 * 生の例外で落ちる——comparabilityを返す前に死ぬので、degradedにすら降りられない。
 */
function assertReadableSchema(handle, side) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(handle.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    if (present.size === 0) { missing.push(`${table}.*`); continue; }
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  if (missing.length === 0) return;
  throw new SensorDiffError(
    'LATTICE_SENSOR_DIFF_SCHEMA_UNSUPPORTED',
    `sensor index schema at ${handle.dbPath} is missing columns this diff requires`,
    {
      side,
      root: handle.root,
      database: handle.dbPath,
      missing_columns: missing,
      next_action: `lattice sensor init ${handle.root} --json`,
    },
  );
}

/**
 * 片側の読み出しを1つの読み取りtransactionで囲う。囲わないと、並行するsyncのcommitが
 * node読出しとedge読出しの間へ割り込み、実在しないdanglingや偽の差分を作る。
 * A側とB側は別DBなので、両者が同一時刻の断面である保証はここでは得られない（片側ずつの
 * 内部整合だけを保証する）。
 */
function withReadSnapshot(handle, read) {
  handle.db.exec('BEGIN DEFERRED');
  try {
    const result = read();
    handle.db.exec('COMMIT');
    return result;
  } catch (error) {
    try { handle.db.exec('ROLLBACK'); } catch { /* 元の失敗を潰さない */ }
    throw error;
  }
}

/**
 * qualified nameがfile pathを埋め込む種類のnode（file node の qualified_name は
 * `sub/lib.mjs` そのもの）は、pathへ当てた subtree 剥がしと改名写像を qualified name にも
 * 当てる。当てないと、揃えたはずの2つのtreeでfile nodeだけが追加＋削除として残る。
 */
function rewriteQualifiedName(qualifiedName, rawPath, normalizedPath) {
  if (qualifiedName === rawPath) return normalizedPath;
  for (const separator of ['/', ':', '#']) {
    if (qualifiedName.startsWith(`${rawPath}${separator}`)) {
      return `${normalizedPath}${qualifiedName.slice(rawPath.length)}`;
    }
  }
  return qualifiedName;
}

function naturalKey(kind, filePath, qualifiedName, name) {
  return `${kind}${KEY_SEPARATOR}${filePath}${KEY_SEPARATOR}${qualifiedName}${KEY_SEPARATOR}${name}`;
}

/**
 * `files.errors`は部分抽出時のerrorを持つ。抽出が途中で折れたfileはnodeが欠けたまま
 * 正常なfileの顔で並ぶので、数えて表に出さないと「差分なし」と「抽出が不完全」が同じ顔になる。
 */
function hasExtractionErrors(raw) {
  if (raw === null || raw === undefined || raw === '') return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    // 読めないerrors列そのものが異状である。無かったことにしない。
    return true;
  }
}

/**
 * 片側を読み出して、自然キーで索き直した形にする。
 *
 * キーは突き合わせにしか使わず、出力へ戻す時は`keyMeta`／`edgeMeta`に控えた構造をそのまま
 * 使う。キー文字列を割って復元しない——POSIXのfile名は `/` とNUL以外の制御文字を許すので、
 * 区切りに選んだ文字がpathに現れた瞬間に復元が壊れる。
 *
 * `idToKey`は辺の端点解決に使う。subtree外のnodeはキーを持たないので、そのnodeを端点に持つ
 * 辺は比較対象外になる（件数はcallerがexcludedへ出す）。
 */
function loadSide(handle, normalizePath, side) {
  const nodesByKey = new Map();
  const keyMeta = new Map();
  const edgeMeta = new Map();
  const idToKey = new Map();
  // subtreeで外したidも覚えておく。「indexが壊れている」と「比較の射程外」は原因が違うので、
  // 除外件数を1つにまとめない。
  const knownIds = new Set();
  let nodesOutsideSubtree = 0;

  const nodeRows = handle.db.prepare(`
    SELECT id, kind, name, qualified_name, file_path, language,
           start_line, end_line, signature, visibility, return_type, docstring,
           decorators, type_parameters, extent_start_line,
           is_exported, is_async, is_static, is_abstract
    FROM nodes
  `).all();
  for (const row of nodeRows) {
    knownIds.add(row.id);
    const filePath = normalizePath(row.file_path);
    if (filePath === null) { nodesOutsideSubtree += 1; continue; }
    const qualifiedName = rewriteQualifiedName(
      row.qualified_name, normalizeRelative(row.file_path), filePath,
    );
    const key = naturalKey(row.kind, filePath, qualifiedName, row.name);
    const entry = {
      key,
      start_line: row.start_line,
      attributes: {
        language: row.language,
        signature: row.signature,
        visibility: row.visibility,
        return_type: row.return_type,
        docstring: row.docstring,
        decorators: row.decorators,
        type_parameters: row.type_parameters,
        is_exported: row.is_exported,
        is_async: row.is_async,
        is_static: row.is_static,
        is_abstract: row.is_abstract,
        span: row.end_line - row.start_line,
        extent_offset: row.extent_start_line === null ? null : row.extent_start_line - row.start_line,
      },
    };
    const bucket = nodesByKey.get(key);
    if (bucket === undefined) {
      nodesByKey.set(key, [entry]);
      keyMeta.set(key, {
        kind: row.kind, file_path: filePath, qualified_name: qualifiedName, name: row.name,
      });
    } else bucket.push(entry);
    idToKey.set(row.id, key);
  }
  for (const bucket of nodesByKey.values()) bucket.sort((a, b) => a.start_line - b.start_line);

  const edgeCounts = new Map();
  let danglingEdges = 0;
  let edgesOutsideSubtree = 0;
  for (const row of handle.db.prepare('SELECT source, target, kind FROM edges').all()) {
    const source = idToKey.get(row.source);
    const target = idToKey.get(row.target);
    if (source === undefined || target === undefined) {
      // nodes表に居ないidはindexの不整合（dangling）、居るのにキーが無いならsubtreeで外した分。
      if (knownIds.has(row.source) && knownIds.has(row.target)) edgesOutsideSubtree += 1;
      else danglingEdges += 1;
      continue;
    }
    const key = `${source}${EDGE_SEPARATOR}${target}${EDGE_SEPARATOR}${row.kind}`;
    const seen = edgeCounts.get(key);
    if (seen === undefined) {
      edgeCounts.set(key, 1);
      edgeMeta.set(key, { kind: row.kind, source: keyMeta.get(source), target: keyMeta.get(target) });
    } else edgeCounts.set(key, seen + 1);
  }

  const files = new Map();
  const rawPathByNormalized = new Map();
  let filesOutsideSubtree = 0;
  let filesWithExtractionErrors = 0;
  for (const row of handle.db.prepare('SELECT path, language, content_hash, node_count, extraction_version, errors FROM files').all()) {
    const filePath = normalizePath(row.path);
    if (filePath === null) { filesOutsideSubtree += 1; continue; }
    const collided = rawPathByNormalized.get(filePath);
    if (collided !== undefined) {
      // 写像が2つの実在fileを同じpathへ潰した。片方が黙って消えると、消えた側の全symbolが
      // 「無かったこと」になり、差分は静かに嘘をつく。指定した人にしか直せないので止める。
      throw new SensorDiffError(
        'LATTICE_SENSOR_DIFF_PATH_COLLISION',
        `path mapping collapses two indexed files onto "${filePath}"`,
        { side, root: handle.root, normalized_path: filePath, source_paths: [collided, row.path] },
      );
    }
    rawPathByNormalized.set(filePath, row.path);
    if (hasExtractionErrors(row.errors)) filesWithExtractionErrors += 1;
    files.set(filePath, {
      language: row.language,
      content_hash: row.content_hash,
      node_count: row.node_count,
      extraction_version: row.extraction_version,
    });
  }

  return {
    nodesByKey,
    keyMeta,
    edgeCounts,
    edgeMeta,
    files,
    schema_version: handle.db.prepare('SELECT MAX(version) AS v FROM schema_versions').get()?.v ?? null,
    counts: {
      nodes: nodeRows.length - nodesOutsideSubtree,
      edges: [...edgeCounts.values()].reduce((sum, n) => sum + n, 0),
      files: files.size,
    },
    integrity: { files_with_extraction_errors: filesWithExtractionErrors },
    excluded: {
      nodes_outside_subtree: nodesOutsideSubtree,
      files_outside_subtree: filesOutsideSubtree,
      edges_outside_subtree: edgesOutsideSubtree,
      dangling_edge_endpoints: danglingEdges,
    },
  };
}

function versionHistogram(files) {
  const counts = {};
  for (const record of files.values()) {
    counts[record.extraction_version] = (counts[record.extraction_version] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((x, y) => Number(x[0]) - Number(y[0])));
}

/**
 * indexそのものの素性を突き合わせる。ここが食い違うなら、差分はcodeの変化とは限らない。
 *
 * extraction versionは集合でなく**同じfileどうしで**比べる。集合だけを見ると、
 * A={x:24,y:25}／B={x:25,y:24} のように対応が入れ替わっていても両方 {24,25} で一致し、
 * 中断したincremental syncが作る本物の食い違いを取りこぼす。
 */
function assessComparability(sideA, sideB) {
  const reasons = [];
  if (sideA.schema_version !== sideB.schema_version) {
    reasons.push(`schema version differs (a=${sideA.schema_version}, b=${sideB.schema_version})`);
  }
  let mismatched = 0;
  for (const [filePath, left] of sideA.files) {
    const right = sideB.files.get(filePath);
    if (right !== undefined && left.extraction_version !== right.extraction_version) mismatched += 1;
  }
  if (mismatched > 0) {
    reasons.push(`${mismatched} common file(s) were extracted at different extraction versions`);
  }
  const errored = sideA.integrity.files_with_extraction_errors
    + sideB.integrity.files_with_extraction_errors;
  if (errored > 0) {
    reasons.push(`${errored} indexed file(s) recorded extraction errors`
      + ` (a=${sideA.integrity.files_with_extraction_errors},`
      + ` b=${sideB.integrity.files_with_extraction_errors});`
      + ' their symbols may be missing rather than removed');
  }
  return {
    // degradedは「比べるな」ではなく「この差分はcodeの変化だけを意味しない」という宣言である。
    status: reasons.length === 0 ? 'ok' : 'degraded',
    reasons,
    extraction_version_mismatched_files: mismatched,
    a: {
      schema_version: sideA.schema_version,
      extraction_versions: versionHistogram(sideA.files),
      files_with_extraction_errors: sideA.integrity.files_with_extraction_errors,
    },
    b: {
      schema_version: sideB.schema_version,
      extraction_versions: versionHistogram(sideB.files),
      files_with_extraction_errors: sideB.integrity.files_with_extraction_errors,
    },
  };
}

function changedFields(left, right) {
  const fields = [];
  for (const field of COMPARED_NODE_FIELDS) {
    if (left.attributes[field] !== right.attributes[field]) fields.push(field);
  }
  return fields;
}

function diffNodes(sideA, sideB) {
  const added = [];
  const removed = [];
  const changed = [];
  const moved = [];
  let unchanged = 0;

  const keys = new Set([...sideA.nodesByKey.keys(), ...sideB.nodesByKey.keys()]);
  for (const key of keys) {
    // 出力の名前・pathはキー文字列を割って復元せず、読み出し時に控えた構造をそのまま使う。
    const identity = sideA.keyMeta.get(key) ?? sideB.keyMeta.get(key);
    const left = sideA.nodesByKey.get(key) ?? [];
    const right = sideB.nodesByKey.get(key) ?? [];
    const paired = Math.min(left.length, right.length);
    for (let i = 0; i < paired; i += 1) {
      const fields = changedFields(left[i], right[i]);
      if (fields.length > 0) {
        changed.push({
          ...identity,
          fields,
          a: { start_line: left[i].start_line },
          b: { start_line: right[i].start_line },
        });
      } else if (left[i].start_line !== right[i].start_line) {
        moved.push({ ...identity, a_start_line: left[i].start_line, b_start_line: right[i].start_line });
      } else {
        unchanged += 1;
      }
    }
    for (let i = paired; i < left.length; i += 1) {
      removed.push({ ...identity, start_line: left[i].start_line, language: left[i].attributes.language });
    }
    for (let i = paired; i < right.length; i += 1) {
      added.push({ ...identity, start_line: right[i].start_line, language: right[i].attributes.language });
    }
  }
  return { added, removed, changed, moved, unchanged };
}

function diffEdges(sideA, sideB) {
  const added = [];
  const removed = [];
  let common = 0;
  const keys = new Set([...sideA.edgeCounts.keys(), ...sideB.edgeCounts.keys()]);
  for (const key of keys) {
    const identity = sideA.edgeMeta.get(key) ?? sideB.edgeMeta.get(key);
    const left = sideA.edgeCounts.get(key) ?? 0;
    const right = sideB.edgeCounts.get(key) ?? 0;
    common += Math.min(left, right);
    for (let i = 0; i < left - right; i += 1) removed.push(identity);
    for (let i = 0; i < right - left; i += 1) added.push(identity);
  }
  return { added, removed, common };
}

function diffFiles(sideA, sideB) {
  const added = [];
  const removed = [];
  const changed = [];
  let identicalContent = 0;
  let common = 0;
  for (const [filePath, left] of sideA.files) {
    const right = sideB.files.get(filePath);
    if (right === undefined) { removed.push({ path: filePath, language: left.language }); continue; }
    common += 1;
    if (left.content_hash === right.content_hash) identicalContent += 1;
    if (left.language !== right.language) {
      changed.push({ path: filePath, field: 'language', a: left.language, b: right.language });
    }
  }
  for (const [filePath, right] of sideB.files) {
    if (!sideA.files.has(filePath)) added.push({ path: filePath, language: right.language });
  }
  return { added, removed, changed, common, identical_content: identicalContent };
}

function tally(items, pick) {
  const counts = {};
  for (const item of items) {
    const value = pick(item) ?? 'unknown';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function fieldTally(changed) {
  const counts = {};
  for (const entry of changed) for (const field of entry.fields) counts[field] = (counts[field] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/** 明細は切ってよいが、切ったことと切った量は必ず出す。件数summaryは常に正確。 */
function applyLimit(lists, limit, truncation) {
  if (limit === 0) return lists;
  const out = {};
  for (const [name, items] of Object.entries(lists)) {
    if (items.length <= limit) { out[name] = items; continue; }
    out[name] = items.slice(0, limit);
    truncation[name] = { returned: limit, omitted: items.length - limit, total: items.length };
  }
  return out;
}

/** added/removedは`start_line`、movedは`a_start_line`、changedは`a.start_line`に行を持つ。 */
function entryLine(entry) {
  return entry.start_line ?? entry.a_start_line ?? entry.a?.start_line ?? 0;
}

function sortNodeEntries(entries) {
  return entries.sort((a, b) => a.file_path.localeCompare(b.file_path)
    || entryLine(a) - entryLine(b)
    || a.qualified_name.localeCompare(b.qualified_name));
}

function sortEdgeEntries(entries) {
  return entries.sort((a, b) => a.source.file_path.localeCompare(b.source.file_path)
    || a.source.qualified_name.localeCompare(b.source.qualified_name)
    || a.kind.localeCompare(b.kind)
    || a.target.qualified_name.localeCompare(b.target.qualified_name));
}

/**
 * 2つのindexを突き合わせて差分を返す。片側にindexが無ければ SensorDiffError を投げる
 * （勝手に索引しない——索引はrepoの状態を書き換える操作であり、差分を見に来た人の依頼ではない）。
 */
export function compareSensorIndexes(request) {
  const limit = request.limit ?? DEFAULT_LIMIT;
  const handleA = openIndex(request.a.root);
  let handleB;
  try {
    handleB = openIndex(request.b.root);
  } catch (error) {
    handleA.db.close();
    throw error;
  }
  try {
    // 読み出す前にschemaを確かめる。読んでから落ちると、素性を返す機会そのものを失う。
    assertReadableSchema(handleA, 'a');
    assertReadableSchema(handleB, 'b');
    const sideA = withReadSnapshot(handleA, () => loadSide(
      handleA, makePathNormalizer(request.a.subtree ?? '', request.a.mappings ?? []), 'a',
    ));
    const sideB = withReadSnapshot(handleB, () => loadSide(
      handleB, makePathNormalizer(request.b.subtree ?? '', request.b.mappings ?? []), 'b',
    ));
    // A subtree that matches no indexed file is a typo, not an empty side: say so instead of "ok".
    for (const [side, loaded, subtree] of [['a', sideA, request.a.subtree], ['b', sideB, request.b.subtree]]) {
      if (subtree && loaded.counts.files === 0 && loaded.excluded.files_outside_subtree > 0) {
        throw new SensorDiffError('LATTICE_SENSOR_DIFF_SUBTREE_EMPTY',
          `--subtree-${side} ${subtree} matches no indexed file`,
          { side, subtree, next_action: `check the path; omit --subtree-${side} to compare the whole index` });
      }
    }
    const comparability = assessComparability(sideA, sideB);

    const nodes = diffNodes(sideA, sideB);
    const edges = diffEdges(sideA, sideB);
    const files = diffFiles(sideA, sideB);

    const truncation = {};
    const lists = applyLimit({
      'files.added': files.added.sort((x, y) => x.path.localeCompare(y.path)),
      'files.removed': files.removed.sort((x, y) => x.path.localeCompare(y.path)),
      'files.changed': files.changed.sort((x, y) => x.path.localeCompare(y.path)),
      'nodes.added': sortNodeEntries(nodes.added),
      'nodes.removed': sortNodeEntries(nodes.removed),
      'nodes.changed': sortNodeEntries(nodes.changed),
      'nodes.moved': sortNodeEntries(nodes.moved),
      'edges.added': sortEdgeEntries(edges.added),
      'edges.removed': sortEdgeEntries(edges.removed),
    }, limit, truncation);

    return {
      schema: 'lattice.sensor_diff_result.v1',
      provider: 'lattice',
      sensor_owner: 'lattice',
      command: 'diff',
      a: {
        root: handleA.root,
        database: handleA.dbPath,
        subtree: request.a.subtree ?? '',
        indexed: sideA.counts,
      },
      b: {
        root: handleB.root,
        database: handleB.dbPath,
        subtree: request.b.subtree ?? '',
        indexed: sideB.counts,
      },
      comparability,
      summary: {
        files: {
          added: files.added.length,
          removed: files.removed.length,
          changed: files.changed.length,
          common: files.common,
          identical_content: files.identical_content,
        },
        nodes: {
          added: nodes.added.length,
          removed: nodes.removed.length,
          changed: nodes.changed.length,
          moved: nodes.moved.length,
          unchanged: nodes.unchanged,
        },
        nodes_added_by_kind: tally(nodes.added, (n) => n.kind),
        nodes_removed_by_kind: tally(nodes.removed, (n) => n.kind),
        nodes_added_by_language: tally(nodes.added, (n) => n.language),
        nodes_removed_by_language: tally(nodes.removed, (n) => n.language),
        nodes_changed_by_field: fieldTally(nodes.changed),
        edges: { added: edges.added.length, removed: edges.removed.length, common: edges.common },
        edges_added_by_kind: tally(edges.added, (e) => e.kind),
        edges_removed_by_kind: tally(edges.removed, (e) => e.kind),
      },
      excluded: { a: sideA.excluded, b: sideB.excluded },
      integrity: { a: sideA.integrity, b: sideB.integrity },
      limit,
      truncation,
      files: { added: lists['files.added'], removed: lists['files.removed'], changed: lists['files.changed'] },
      nodes: {
        added: lists['nodes.added'],
        removed: lists['nodes.removed'],
        changed: lists['nodes.changed'],
        moved: lists['nodes.moved'],
      },
      edges: { added: lists['edges.added'], removed: lists['edges.removed'] },
    };
  } finally {
    handleA.db.close();
    handleB.db.close();
  }
}

/**
 * `sensor diff` のargvを解釈する。解釈できない指定はnullを返し、callerがusage errorにする
 * （知らないoptionを黙って捨てると、指定したつもりの絞り込みが効かないまま差分を信じてしまう）。
 */
export function parseSensorDiffArgs(words) {
  if (words.length < 2) return null;
  const request = {
    a: { root: words[0], subtree: '', mappings: [] },
    b: { root: words[1], subtree: '', mappings: [] },
    limit: DEFAULT_LIMIT,
  };
  if (request.a.root.startsWith('--') || request.b.root.startsWith('--')) return null;
  for (let i = 2; i < words.length; i += 1) {
    const flag = words[i];
    const value = words[i + 1];
    if (value === undefined || value.startsWith('--')) return null;
    if (flag === '--subtree-a') request.a.subtree = normalizeRelative(value);
    else if (flag === '--subtree-b') request.b.subtree = normalizeRelative(value);
    else if (flag === '--map-a' || flag === '--map-b') {
      const mapping = parseMapping(value);
      if (mapping === null) return null;
      (flag === '--map-a' ? request.a : request.b).mappings.push(mapping);
    } else if (flag === '--limit') {
      // 桁だけ見てNumber()へ渡すと、長い10進数がInfinityになって上限が消える。
      if (!/^\d+$/u.test(value)) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) return null;
      request.limit = parsed;
    } else return null;
    i += 1;
  }
  return request;
}
