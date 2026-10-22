#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { relativeMarkdownLinkTargets } from './markdown-link-targets.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOCS = path.join(ROOT, 'docs');
const ARCHIVE = path.join(DOCS, 'archive');
const INDEX = path.join(DOCS, 'README.md');
const STUB_MARKER = '履歴参照stub';
const failures = [];
const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));

if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  failures.push('package.jsonとpackage-lock.jsonのrelease versionが一致しない');
}
const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${packageJson.version} —`)) {
  failures.push(`CHANGELOG.md: 現行release ${packageJson.version} の見出しがない`);
}

const productMarkdown = await listProductDocumentation(ROOT);

let checkedLinks = 0;
for (const file of productMarkdown) checkedLinks += await checkLocalLinks(file);

const indexText = await readFile(INDEX, 'utf8');
for (const heading of ['現行契約', '現在の計画・構想', '履歴', '証拠', '所有境界']) {
  if (!indexText.includes(`## ${heading}`)) failures.push(`docs/README.md: 正本索引に「${heading}」区分がない`);
}

const topLevelDocs = (await readdir(DOCS, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => path.join(DOCS, entry.name))
  .sort();
const stubs = new Map();
for (const file of topLevelDocs) {
  const text = await readFile(file, 'utf8');
  if (isHistoryStub(text)) stubs.set(repoPath(file), text);
}

const indexTargets = new Set(localLinkTargets(INDEX, indexText).map((target) => path.resolve(target)));
for (const file of topLevelDocs) {
  if (file === INDEX || stubs.has(repoPath(file))) continue;
  if (!indexTargets.has(path.resolve(file))) {
    failures.push(`docs/README.md: 現行文書 ${repoPath(file)} が正本索引にない`);
  }
}

for (const [stubPath, text] of stubs) {
  const basename = path.basename(stubPath);
  const archiveRepoPath = `docs/archive/${basename}`;
  const archivePath = path.join(ARCHIVE, basename);
  try {
    await access(archivePath);
  } catch {
    failures.push(`${stubPath}: 対応する履歴本文 ${archiveRepoPath} がない`);
    continue;
  }
  const targets = new Set(localLinkTargets(path.join(ROOT, stubPath), text).map((target) => path.resolve(target)));
  if (!targets.has(path.resolve(archivePath))) {
    failures.push(`${stubPath}: ${archiveRepoPath} へのリンクがない`);
  }
}

for (const fixedPath of fixedHistoricalDocumentReferences()) {
  if (!fixedPath.startsWith('docs/') || fixedPath.startsWith('docs/archive/')) continue;
  const basename = fixedPath.slice('docs/'.length);
  if (basename.includes('/')) continue;
  try {
    await access(path.join(ARCHIVE, basename));
  } catch {
    continue;
  }
  const stubText = stubs.get(fixedPath);
  if (stubText === undefined) {
    failures.push(`${fixedPath}: 固定済み参照が残るため履歴参照stubが必要`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(
  `documentation verification: ok (${productMarkdown.length} product Markdown files including root evidence/docs archive/evidence; `
  + 'immutable raw/artifact snapshots excluded, '
  + `${checkedLinks} local links, ${stubs.size} fixed stubs)\n`,
);

async function listProductDocumentation(directory) {
  const directoryPath = repoPath(directory);
  if (
    /(?:^|\/)rag\/[^/]+\/raw(?:\/|$)/u.test(directoryPath)
    || /^research\/campaigns\/[^/]+\/artifacts(?:\/|$)/u.test(directoryPath)
  ) return [];
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.lattice', '.claude', '.codex', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      // 他のcheckoutは同じGit rootに置かれていても製品文書ではない。
      // linked worktreeの.gitはdirectoryでなくfileなので、入口で判定する。
      try { await access(path.join(file, '.git')); continue; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      out.push(...await listProductDocumentation(file));
    }
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(file);
  }
  return out;
}

async function checkLocalLinks(file) {
  const text = await readFile(file, 'utf8');
  const targets = localLinkTargets(file, text);
  for (const target of targets) {
    try {
      await access(target);
    } catch {
      failures.push(`${repoPath(file)}: リンク先 ${repoPath(target)} がない`);
    }
  }
  return targets.length;
}

function localLinkTargets(file, text) {
  return relativeMarkdownLinkTargets(text).map((target) => path.resolve(path.dirname(file), target));
}

function fixedHistoricalDocumentReferences() {
  let stdout;
  try {
    stdout = execFileSync('git', [
      'grep', '-I', '-h', '-o', '-E', 'docs/[A-Za-z0-9_./-]+\\.md', '--',
      ':(exclude)docs/archive/**',
    ], { cwd: ROOT, encoding: 'utf8' });
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return [...new Set(stdout.split('\n').filter(Boolean))].sort();
}

function isHistoryStub(text) {
  return text.split('\n', 1)[0].includes(STUB_MARKER);
}

function repoPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}
