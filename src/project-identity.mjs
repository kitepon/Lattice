import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseTree } from 'jsonc-parser';

export const PROJECT_IDENTITY_REF = '.lattice/project.json';
const MAX_BYTES = 65_536;
const URL_MAX_BYTES = 2_048;
const IDENTITY_KEYS = 'display_name,project_id,schema';
const IDENTITY_KEYS_WITH_PANE = 'display_name,external_pane,project_id,schema';
const CONTROL = /[\u0000-\u001f\u007f]/u;

function fail(reason) {
  const error = new Error(reason);
  error.code = 'PROJECT_IDENTITY_INVALID';
  error.detail = { reason };
  throw error;
}

function displayName(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !CONTROL.test(value) && Buffer.byteLength(value, 'utf8') <= 256;
}

function duplicateKey(node) {
  if (node?.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (keys.has(key?.value) || duplicateKey(value)) return true;
      keys.add(key?.value);
    }
  } else if (node?.type === 'array') return (node.children ?? []).some(duplicateKey);
  return false;
}

/** 外部ペインのURLは、閲覧者のブラウザが実際に取りに行く先である。絶対URLだけを通す。 */
function paneUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL.test(value)
    || Buffer.byteLength(value, 'utf8') > URL_MAX_BYTES) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url;
}

/**
 * projectごとに1枚だけ差せる外部ペインの設定。Latticeは中身が何のサービスかを知らない
 * ——題名・埋め込み先URL・生存probe URLの3つだけを受け取る汎用の口である。
 */
function externalPane(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'probe_url,title,url') {
    fail('external_pane_schema_invalid');
  }
  if (!displayName(value.title)) fail('external_pane_title_invalid');
  const url = paneUrl(value.url);
  const probe = paneUrl(value.probe_url);
  if (url === null) fail('external_pane_url_invalid');
  if (probe === null) fail('external_pane_probe_url_invalid');
  return Object.freeze({
    title: value.title,
    url: url.href,
    probeUrl: probe.href,
    frameOrigin: url.origin,
    probeOrigin: probe.origin,
  });
}

async function readIdentityDocument({ repoRoot, projectId }) {
  const canonicalRoot = await realpath(repoRoot);
  const ref = path.join(canonicalRoot, PROJECT_IDENTITY_REF);
  let stats;
  try { stats = await lstat(ref); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_BYTES) fail('identity_file_unsafe');
  const resolved = await realpath(ref);
  if (resolved !== ref) fail('identity_file_alias');
  const bytes = await readFile(ref);
  if (bytes.length > MAX_BYTES) fail('identity_file_too_large');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('identity_utf8_invalid'); }
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0 || tree === undefined || duplicateKey(tree)) fail('identity_json_invalid');
  let document;
  try { document = JSON.parse(text); } catch { fail('identity_json_invalid'); }
  const keys = document === null || typeof document !== 'object' || Array.isArray(document)
    ? '' : Object.keys(document).sort().join(',');
  if ((keys !== IDENTITY_KEYS && keys !== IDENTITY_KEYS_WITH_PANE)
    || document.schema !== 'lattice.project_identity.v1'
    || document.project_id !== projectId || !displayName(document.display_name)) {
    fail('identity_schema_invalid');
  }
  return document;
}

export async function resolveProjectIdentity({ repoRoot, projectId, env = process.env }) {
  if (!path.isAbsolute(repoRoot) || typeof projectId !== 'string' || projectId.length === 0
    || env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('project identity options invalid');
  }
  const override = env.LATTICE_PROJECT_DISPLAY_NAME;
  if (override !== undefined) {
    if (!displayName(override)) fail('environment_display_name_invalid');
    return Object.freeze({ projectId, displayName: override, source: 'environment' });
  }
  const document = await readIdentityDocument({ repoRoot, projectId });
  if (document === null) {
    return Object.freeze({ projectId, displayName: projectId, source: 'project_id' });
  }
  // external_paneは表示名の出典ではない。ここでは形の妥当性だけ確かめて落とす
  // ——壊れた設定を黙って無視すると、差したはずのペインが出ない理由が追えなくなる。
  if (document.external_pane !== undefined) externalPane(document.external_pane);
  return Object.freeze({ projectId, displayName: document.display_name, source: 'project_file' });
}

/**
 * 差してあるなら外部ペイン設定を、無ければnullを返す。配信のたびに読むので、
 * 設定を書いた／消した側はdaemonの再起動を要さない（reloadで反映される）。
 */
export async function readProjectExternalPane({ repoRoot, projectId }) {
  if (!path.isAbsolute(repoRoot) || typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('project identity options invalid');
  }
  const document = await readIdentityDocument({ repoRoot, projectId });
  if (document === null || document.external_pane === undefined) return null;
  return externalPane(document.external_pane);
}

/**
 * The project id a repository registered in its identity file, or null. A route hint for a
 * serving process that cannot read the Store; the file's own validity is judged elsewhere.
 */
export async function readRegisteredProjectId({ repoRoot }) {
  try {
    const ref = path.join(await realpath(repoRoot), PROJECT_IDENTITY_REF);
    const stats = await lstat(ref);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_BYTES) return null;
    const id = JSON.parse(await readFile(ref, 'utf8')).project_id;
    return typeof id === 'string' ? id : null;
  } catch { return null; }
}
