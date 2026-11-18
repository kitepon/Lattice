/**
 * Cargo Workspace Resolver Helper
 *
 * Parses a project's root Cargo.toml and member crate manifests to
 * build a crate-name -> member-directory map. Used by the Rust
 * resolver to resolve `use crate_name::...` references that point
 * into workspace member crates.
 */

import { ResolutionContext } from '../types';

const GLOB_CHARS = /[*?[\]{}!]/;
const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'dist', 'build']);
const MAX_GLOB_WALK_DEPTH = 5;

function getSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `[${sectionName}]`) {
        inSection = true;
      }
      continue;
    }

    if (/^\[[^\]]+\]$/.test(trimmed)) {
      break;
    }

    sectionLines.push(line);
  }

  if (!inSection) return null;
  return sectionLines.join('\n');
}

function extractQuotedValues(valueList: string): string[] {
  const values: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let current = '';

  for (const ch of valueList) {
    if (!quote) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current = '';
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === quote) {
      values.push(current.trim());
      quote = null;
      current = '';
      continue;
    }

    current += ch;
  }

  return values.filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getArrayValue(section: string, key: string): string | null {
  const keyRegex = new RegExp(`\\b${escapeRegExp(key)}\\b\\s*=`, 'm');
  const keyMatch = keyRegex.exec(section);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  while (i < section.length && /\s/.test(section.charAt(i))) i++;
  if (section.charAt(i) !== '[') return null;
  i++;

  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 1;
  const start = i;

  while (i < section.length) {
    const ch = section.charAt(i);

    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }

    if (ch === '[') {
      depth++;
      i++;
      continue;
    }

    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return section.slice(start, i);
      }
      i++;
      continue;
    }

    i++;
  }

  return null;
}

function parseWorkspaceMembers(cargoToml: string): string[] {
  const workspaceSection = getSection(cargoToml, 'workspace');
  if (!workspaceSection) return [];
  const membersValue = getArrayValue(workspaceSection, 'members');
  if (!membersValue) return [];
  return extractQuotedValues(membersValue);
}

function parsePackageName(cargoToml: string): string | null {
  const packageSection = getSection(cargoToml, 'package');
  if (!packageSection) return null;
  const packageNameMatch = packageSection.match(/name\s*=\s*["']([^"'\n]+)["']/);
  return packageNameMatch?.[1]?.trim() ?? null;
}

function addCrateAlias(map: Map<string, string>, crateName: string, memberPath: string): void {
  const normalized = crateName.replace(/-/g, '_');
  map.set(crateName, memberPath);
  if (normalized !== crateName) {
    map.set(normalized, memberPath);
  }
}

function cleanPath(memberPath: string): string {
  return memberPath.replace(/\\/g, '/').replace(/\/$/, '');
}

type GlobToken =
  | { kind: 'char'; ch: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'set'; negate: boolean; ranges: Array<[string, string]> };

/** One path component of a Cargo (glob crate) pattern: `?`, `*`, `[...]`, `[!...]`; everything else is literal. */
function compileGlobComponent(part: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < part.length; i++) {
    const ch = part.charAt(i);
    if (ch === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
    } else if (ch === '[') {
      const negate = part.charAt(i + 1) === '!';
      const start = i + (negate ? 2 : 1);
      const end = part.indexOf(']', start + 1);
      if (end === -1) {
        tokens.push({ kind: 'char', ch });
        continue;
      }
      const body = part.slice(start, end);
      const ranges: Array<[string, string]> = [];
      for (let k = 0; k < body.length; k++) {
        if (body.charAt(k + 1) === '-' && k + 2 < body.length) {
          ranges.push([body.charAt(k), body.charAt(k + 2)]);
          k += 2;
        } else {
          ranges.push([body.charAt(k), body.charAt(k)]);
        }
      }
      tokens.push({ kind: 'set', negate, ranges });
      i = end;
    } else {
      tokens.push({ kind: 'char', ch });
    }
  }
  return tokens;
}

function globTokenMatches(token: GlobToken, ch: string): boolean {
  if (token.kind === 'char') return token.ch === ch;
  if (token.kind === 'any') return true;
  if (token.kind === 'set') return token.ranges.some(([lo, hi]) => ch >= lo && ch <= hi) !== token.negate;
  return false;
}

/** `*` backtracks to the last star only, so a component matches in O(tokens x name length); no regex, no ReDoS. */
function matchGlobComponent(tokens: GlobToken[], name: string): boolean {
  let t = 0;
  let n = 0;
  let starT = -1;
  let starN = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token?.kind === 'star') {
      starT = t++;
      starN = n;
    } else if (token && globTokenMatches(token, name.charAt(n))) {
      t++;
      n++;
    } else if (starT >= 0) {
      t = starT + 1;
      n = ++starN;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === 'star') t++;
  return t === tokens.length;
}

/** Compile a Cargo member glob to a predicate over a `/`-separated relative path. `**` as a whole component spans zero or more directories. */
function compileCargoGlob(member: string): (rel: string) => boolean {
  const parts = member.split('/').map((part) => (part === '**' ? null : compileGlobComponent(part)));
  return (rel) => {
    const names = rel.split('/');
    let reach = new Array<boolean>(names.length + 1).fill(false);
    reach[0] = true;
    for (const part of parts) {
      const next = new Array<boolean>(names.length + 1).fill(false);
      for (let j = 0; j <= names.length; j++) {
        next[j] = part === null
          ? !!reach[j] || (j > 0 && !!next[j - 1])
          : j > 0 && !!reach[j - 1] && matchGlobComponent(part, names[j - 1] ?? '');
      }
      reach = next;
    }
    return !!reach[names.length];
  };
}

function expandGlobMember(member: string, context: ResolutionContext): string[] {
  if (!context.listDirectories) return [];

  const firstGlobIdx = member.search(GLOB_CHARS);
  const staticPrefix = member
    .slice(0, firstGlobIdx)
    .replace(/[^/]*$/, '')
    .replace(/\/$/, '');

  // Own matcher instead of picomatch: Cargo has no extglob or braces, and picomatch <= 4.0.7 has a ReDoS (CVE-2026-112366, no fixed version)
  const matcher = compileCargoGlob(member);
  const matches: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > MAX_GLOB_WALK_DEPTH) return;
    const children = context.listDirectories!(dir);
    for (const child of children) {
      if (SKIP_DIRS.has(child) || child.startsWith('.')) continue;
      const rel = dir === '.' ? child : `${dir}/${child}`;
      if (matcher(rel) && !seen.has(rel)) {
        seen.add(rel);
        matches.push(rel);
      }
      walk(rel, depth + 1);
    }
  }

  walk(staticPrefix || '.', 0);
  return matches;
}

function expandMembers(members: string[], context: ResolutionContext): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const candidates = GLOB_CHARS.test(member)
      ? expandGlobMember(member, context)
      : [member];
    for (const candidate of candidates) {
      const cleaned = cleanPath(candidate);
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      expanded.push(cleaned);
    }
  }
  return expanded;
}

/**
 * Build a map from crate-name aliases to workspace member directory paths.
 * Example: "mytool-core" and "mytool_core" -> "crates/mytool-core"
 *
 * Supports glob members (e.g. `members = ["crates/*"]`, Cargo glob syntax)
 * when the context exposes `listDirectories`.
 */
export function getCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const result = new Map<string, string>();
  const rootCargoToml = context.readFile('Cargo.toml');
  if (!rootCargoToml) return result;

  const rawMembers = parseWorkspaceMembers(rootCargoToml);
  const members = expandMembers(rawMembers, context);

  for (const memberPath of members) {
    const memberCargoPath = `${memberPath}/Cargo.toml`;
    const memberCargoToml = context.readFile(memberCargoPath);
    if (!memberCargoToml) continue;

    const packageName = parsePackageName(memberCargoToml);
    if (!packageName) continue;

    addCrateAlias(result, packageName, memberPath);
  }

  return result;
}
