import { parseForESLint, getStaticTOMLValue } from 'toml-eslint-parser';
import { parseTree, getNodeValue, modify, applyEdits } from 'jsonc-parser';
import { lstat, readFile, mkdir, open, rename, unlink, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
export const setupError = (code, message) => Object.assign(new Error(message), { code });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseSetupConfig(text, format) {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  try {
    if (format === 'toml') {
      const { ast } = parseForESLint(text, { tomlVersion: '1.0.0' });
      return { ast, value: getStaticTOMLValue(ast) };
    }
    if (!text.trim()) return { value: {} };
    const errors = [];
    const ast = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || !ast || ast.type !== 'object') throw new Error('JSON構文が不正');
    function uniqueKeys(node) {
      if (node.type === 'object') {
        const keys = node.children.map((property) => property.children[0].value);
        if (new Set(keys).size !== keys.length) throw new Error('JSONキーが重複');
      }
      for (const child of node.children ?? []) uniqueKeys(child);
    }
    uniqueKeys(ast);
    return { ast, value: getNodeValue(ast) };
  } catch {
    throw setupError('CONFIG_INVALID', 'AI設定の構文を解釈できないため変更しません');
  }
}

const keyParts = (key) => key.keys.map((part) => part.name ?? part.value);
const equalPath = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);
const prefixPath = (a, b) => a.every((part, i) => part === b[i]);

function setToml(text, keys, value) {
  const { ast } = parseSetupConfig(text, 'toml');
  let found;
  let container = { prefix: [], node: ast.body[0] };
  function visit(node, prefix) {
    if (node.type === 'TOMLTable') prefix = node.resolvedKey;
    if (['TOMLTable', 'TOMLInlineTable'].includes(node.type)
      && prefixPath(prefix, keys) && prefix.length > container.prefix.length) container = { prefix, node };
    if (node.type === 'TOMLKeyValue') {
      const full = [...prefix, ...keyParts(node.key)];
      if (equalPath(full, keys)) found = node.value;
      if (node.value.type === 'TOMLInlineTable') visit(node.value, full);
    } else for (const child of node.body ?? []) visit(child, prefix);
  }
  visit(ast.body[0], []);
  const serialized = JSON.stringify(value);
  if (found) return text.slice(0, found.range[0]) + serialized + text.slice(found.range[1]);
  const assignment = `${keys.slice(container.prefix.length).map((part) => JSON.stringify(part)).join('.')} = ${serialized}`;
  if (container.node.type === 'TOMLInlineTable') {
    const at = container.node.range[1] - 1;
    return text.slice(0, at) + (container.node.body.length ? ', ' : '') + assignment + text.slice(at);
  }
  if (container.node.type === 'TOMLTable') {
    const newline = text.indexOf('\n', container.node.key.range[1]);
    const at = newline < 0 ? text.length : newline + 1;
    return text.slice(0, at) + (newline < 0 ? '\n' : '') + assignment + '\n' + text.slice(at);
  }
  return assignment + '\n' + text;
}

export function mcpEntry(text, format) {
  const { value } = parseSetupConfig(text, format);
  const servers = value[format === 'toml' ? 'mcp_servers' : 'mcpServers'];
  if (servers !== undefined && !object(servers)) throw setupError('CONFIG_INVALID', 'MCP登録一覧がobjectではありません');
  const entry = servers?.lattice;
  if (entry !== undefined && !object(entry)) throw setupError('CONFIG_INVALID', 'Lattice登録がobjectではありません');
  return entry;
}

export function updateMcpConfig(text, format, desired) {
  if (text.startsWith('\uFEFF')) return '\uFEFF' + updateMcpConfig(text.slice(1), format, desired);
  const current = mcpEntry(text, format);
  if (current?.url || (current?.type && current.type !== 'stdio')) {
    throw setupError('MCP_REGISTRATION_CONFLICT', 'lattice名の登録がstdioではないため保持しました');
  }
  let updated = text;
  for (const [key, value] of Object.entries(desired)) {
    if (JSON.stringify(current?.[key]) === JSON.stringify(value)) continue;
    const keys = [format === 'toml' ? 'mcp_servers' : 'mcpServers', 'lattice', key];
    updated = format === 'toml' ? setToml(updated, keys, value)
      : applyEdits(updated, modify(updated, keys, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
      }));
  }
  mcpEntry(updated, format);
  return updated;
}

export async function readSetupFile(target) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (error.code === 'ENOENT') return { text: '', mode: 0o600, exists: false };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw setupError('CONFIG_PATH_UNSUPPORTED', '設定は通常fileだけを扱います');
  return { text: await readFile(target, 'utf8'), mode: info.mode & 0o777, exists: true };
}

export async function writeSetupFile(target, before, text) {
  if (text === before.text) return 'unchanged';
  await mkdir(path.dirname(target), { recursive: true });
  const current = await readSetupFile(target);
  if (current.text !== before.text || current.exists !== before.exists) throw setupError('CONFIG_CHANGED', '設定が同時に変更されました');
  const temporary = `${target}.lattice-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', before.mode);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    const latest = await readSetupFile(target);
    if (latest.text !== before.text || latest.exists !== before.exists) throw setupError('CONFIG_CHANGED', '設定が同時に変更されました');
    if (before.exists) await copyFile(target, `${temporary}.backup`);
    await rename(temporary, target);
    if ((await readSetupFile(target)).text !== text) throw setupError('CONFIG_READBACK_FAILED', '設定の読戻しが一致しません');
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return before.exists ? 'updated' : 'created';
}
