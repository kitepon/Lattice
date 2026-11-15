import path from 'node:path';

/*
 * Function-level PR scope (common rule verification.minimal; Owner 2026-11-15: scope tests by the
 * function and data-flow diagrams, not by whole files). ci-scope.mjs realises the function map's
 * "Callers / connections" column per file; this module realises it per top-level function:
 * a changed function selects the tests that reach it through the functions that name it.
 *
 * Nodes are `file#name` (a top-level declaration) and `file#*` (the module-level code that runs on
 * import). An edge consumer -> dependency exists when the consumer's text names the dependency;
 * naming is matched by identifier, so it only ever over-approximates. What the graph cannot place
 * (module-level code, an opaque path/namespace reference) widens to the whole file, never narrower.
 * Pure: no git, no I/O; ci-scope.mjs supplies the texts, the diff and its `referencesIn`.
 */

const ANY = '*';
const COLUMN0_CONTINUATION = /^[}\])`;.,?:|&+\-*=<>]/u;
const FUNCTION_OR_CLASS = /^(export\s+)?(default\s+)?(?:async\s+)?(?:function\*?\s*([\w$]+)|class\s+([\w$]+))/u;
const VARIABLE = /^(export\s+)?(?:const|let|var)\s*(?:([\w$]+)|[{[]([^}\]]*)[}\]])/u;

/** Names bound by a destructuring list: `a, b: c = 1, ...d` -> a, c, d. */
function boundNames(list) {
  return list.split(',').map((item) => item.split('=')[0].split(':').at(-1).replace('...', '').trim())
    .filter((name) => /^[\w$]+$/u.test(name));
}

/** Split a module into contiguous statements (1-based inclusive line ranges); every line is in one. */
export function parseModule(text) {
  const lines = text.split('\n');
  const starts = [];
  let pending = -1;
  let inBlock = false;
  lines.forEach((line, index) => {
    if (inBlock) { inBlock = !line.includes('*/'); return; }
    if (line.trim() === '') { pending = -1; return; }
    if (line.startsWith('//') || line.startsWith('/*')) {
      if (pending < 0) pending = index;
      inBlock = line.startsWith('/*') && !line.includes('*/', 2);
      return;
    }
    if (/^\s/u.test(line) || COLUMN0_CONTINUATION.test(line)) { pending = -1; return; }
    starts.push({ head: index, start: pending >= 0 ? pending : index });
    pending = -1;
  });
  const statements = [];
  if (starts.length === 0 || starts[0].start > 0) statements.push({ start: 0, head: -1 });
  statements.push(...starts);
  return statements.map((statement, index) => {
    const end = (statements[index + 1]?.start ?? lines.length) - 1;
    const body = lines.slice(statement.start, end + 1).join('\n');
    const head = statement.head >= 0 ? lines[statement.head] : '';
    const base = { first: statement.start + 1, last: end + 1, body, names: [], exported: false };
    if (/^import\b(?!\s*\()/u.test(head)) return { ...base, kind: 'import' };
    if (/^export\s*(\{|\*)/u.test(head)) return { ...base, kind: 'exports' };
    const fn = FUNCTION_OR_CLASS.exec(head);
    if (fn) {
      const names = [fn[3] ?? fn[4], ...(fn[2] ? ['default'] : [])];
      return { ...base, kind: 'unit', names, exported: Boolean(fn[1]) };
    }
    const variable = VARIABLE.exec(body.slice(body.indexOf(head)));
    if (variable) {
      const names = variable[2] ? [variable[2]] : boundNames(variable[3]);
      return { ...base, kind: 'unit', names, exported: Boolean(variable[1]) };
    }
    if (/^export\s+default\b/u.test(head)) return { ...base, kind: 'unit', names: ['default'], exported: true };
    return { ...base, kind: 'other' };
  });
}

function tokens(text) {
  return new Set(text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/^\s*\/\/.*$/gmu, ' ')
    .match(/[A-Za-z_$][\w$]*/gu) ?? []);
}

/** Static import/re-export bindings of one statement: [{target, local, imported}], imported '*' = namespace. */
function bindingsOf(statement, file) {
  const resolveRef = (ref) => (ref.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), ref)) : null);
  const text = statement.body.replace(/\/\*[\s\S]*?\*\//gu, ' ');
  const from = /from\s*['"]([^'"]+)['"]/u.exec(text) ?? /^\s*import\s*['"]([^'"]+)['"]/mu.exec(text);
  const target = from ? resolveRef(from[1]) : null;
  if (!target) return [];
  const bindings = [];
  const named = /\{([^}]*)\}/u.exec(text)?.[1] ?? '';
  for (const item of named.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [imported, local = imported] = item.split(/\s+as\s+/u);
    bindings.push({ target, local, imported });
  }
  const namespace = /\*\s+as\s+([\w$]+)/u.exec(text)?.[1];
  if (namespace) bindings.push({ target, local: namespace, imported: ANY });
  const defaultName = statement.kind === 'import' ? /^\s*import\s+([\w$]+)/u.exec(text)?.[1] : null;
  if (defaultName) bindings.push({ target, local: defaultName, imported: 'default' });
  if (bindings.length === 0) bindings.push({ target, local: null, imported: ANY });
  return bindings;
}

/** Reverse dependency graph over `files` (Map posix path -> text). `modules` feeds basename path references. */
export function buildFunctionGraph(files, modules, referencesIn) {
  const parsed = new Map([...files].map(([file, text]) => [file, parseModule(text)]));
  const exportsOf = new Map(); // file -> Map(exported name -> {node} | {from, imported} | star list)
  const stars = new Map();
  const importsOf = new Map(); // file -> Map(local name -> binding)
  for (const [file, statements] of parsed) {
    const bound = new Map();
    for (const statement of statements) if (statement.kind === 'import') for (const binding of bindingsOf(statement, file)) if (binding.local) bound.set(binding.local, binding);
    importsOf.set(file, bound);
  }
  for (const [file, statements] of parsed) {
    const table = new Map();
    const starList = [];
    for (const statement of statements) {
      if (statement.kind === 'unit' && statement.exported) for (const name of statement.names) table.set(name, { node: `${file}#${name}` });
      if (statement.kind !== 'exports') continue;
      const [binding] = bindingsOf(statement, file);
      if (/export\s*\*\s+(?!as\s)/u.test(statement.body) && binding) { starList.push(binding.target); continue; }
      if (binding) for (const { imported, local, target } of bindingsOf(statement, file)) table.set(local, { from: target, imported });
      else for (const item of (/\{([^}]*)\}/u.exec(statement.body)?.[1] ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
        const [localName, exportedName = localName] = item.split(/\s+as\s+/u);
        const imported = importsOf.get(file).get(localName); // `import { x } ...; export { x }` re-exports x
        table.set(exportedName, imported ? { from: imported.target, imported: imported.imported } : { node: `${file}#${localName}` });
      }
    }
    exportsOf.set(file, table);
    stars.set(file, starList);
  }
  const resolve = (file, name, seen = new Set()) => {
    if (seen.has(`${file}#${name}`)) return null;
    seen.add(`${file}#${name}`);
    const entry = exportsOf.get(file)?.get(name);
    if (entry?.node) return entry.node;
    if (entry?.from) return entry.imported === ANY ? `${entry.from}#${ANY}` : resolve(entry.from, entry.imported, seen);
    for (const star of stars.get(file) ?? []) {
      const hit = resolve(star, name, seen);
      if (hit) return hit;
    }
    return null;
  };
  const dependents = new Map();
  const depend = (consumer, dependency) => {
    if (!dependents.has(dependency)) dependents.set(dependency, new Set());
    dependents.get(dependency).add(consumer);
  };
  const wholeFile = (consumer, target) => {
    if (!parsed.has(target)) return;
    depend(consumer, `${target}#${ANY}`);
    for (const statement of parsed.get(target)) for (const name of statement.names) depend(consumer, `${target}#${name}`);
  };
  for (const [file, statements] of parsed) {
    const local = new Map();
    const bindings = importsOf.get(file);
    for (const statement of statements) {
      if (statement.kind === 'unit') for (const name of statement.names) local.set(name, `${file}#${name}`);
    }
    const moduleNode = `${file}#${ANY}`;
    for (const statement of statements) {
      if (statement.kind === 'exports') {
        for (const { target } of bindingsOf(statement, file)) depend(moduleNode, `${target}#${ANY}`);
        continue;
      }
      const consumers = statement.kind === 'unit' ? statement.names.map((name) => `${file}#${name}`) : [moduleNode];
      if (statement.kind === 'import') {
        for (const { target } of bindingsOf(statement, file)) if (parsed.has(target)) depend(moduleNode, `${target}#${ANY}`);
        continue;
      }
      let text = statement.body;
      // `const { a } = await import('./x.mjs')` names what it takes; any other reference widens to the file.
      for (const [match, list, ref] of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref));
        for (const consumer of consumers) {
          depend(consumer, `${target}#${ANY}`);
          for (const item of list.split(',').map((part) => part.trim()).filter(Boolean)) {
            const name = item.split(':')[0].trim();
            depend(consumer, resolve(target, name) ?? `${target}#${name}`);
          }
        }
        text = text.replace(match, ' ');
      }
      for (const ref of referencesIn(text, file, modules)) for (const consumer of consumers) wholeFile(consumer, ref);
      const names = tokens(text);
      for (const consumer of consumers) {
        for (const name of names) {
          if (local.has(name)) depend(consumer, local.get(name));
          const binding = bindings.get(name);
          if (!binding) continue;
          depend(consumer, `${binding.target}#${ANY}`);
          if (binding.imported === ANY) {
            const members = [...text.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/gu, '\\$')}\\.([\\w$]+)`, 'gu'))].map((match) => match[1]);
            const bare = new RegExp(`(?<![\\w$.])${name.replace(/\$/gu, '\\$')}(?![\\w$]|\\s*\\.[\\w$])`, 'u').test(text);
            if (bare) wholeFile(consumer, binding.target);
            else for (const member of members) depend(consumer, resolve(binding.target, member) ?? `${binding.target}#${member}`);
          } else {
            depend(consumer, resolve(binding.target, binding.imported) ?? `${binding.target}#${binding.imported}`);
          }
        }
      }
    }
  }
  return { parsed, dependents };
}

/** Every node that reaches a seed through the graph (the seeds included). */
export function affectedNodes({ dependents }, seeds) {
  const affected = new Set(seeds);
  const queue = [...affected];
  while (queue.length > 0) {
    for (const consumer of dependents.get(queue.pop()) ?? []) {
      if (!affected.has(consumer)) { affected.add(consumer); queue.push(consumer); }
    }
  }
  return affected;
}

/**
 * Seed nodes for one changed module from `git diff -U0` line ranges ([from, to], 1-based, inclusive)
 * in the old and new text. A range touching module-level code (imports, exports, top-level calls,
 * header comments) changes the whole file; a deleted function still seeds its old name.
 */
export function changedNodes(file, { oldText = '', newText, oldRanges, newRanges }) {
  const seeds = new Set();
  const whole = (statements) => { seeds.add(`${file}#${ANY}`); for (const { names } of statements) for (const name of names) seeds.add(`${file}#${name}`); };
  for (const [text, ranges] of [[oldText, oldRanges], [newText, newRanges]]) {
    const statements = parseModule(text);
    for (const [from, to] of ranges) {
      const hit = statements.filter((statement) => statement.last >= from && statement.first <= to);
      if (hit.length === 0 || hit.some((statement) => statement.kind !== 'unit')) { whole(parseModule(newText)); whole(statements); }
      for (const statement of hit) for (const name of statement.names) seeds.add(`${file}#${name}`);
    }
  }
  return seeds;
}

/** Line ranges of a `git diff -U0` text: { oldRanges, newRanges }. A pure insertion/deletion covers the line pair around it. */
export function hunkRanges(diffText) {
  const range = (start, count) => (Number(count) === 0 ? [Number(start), Number(start) + 1] : [Number(start), Number(start) + Number(count) - 1]);
  const oldRanges = [];
  const newRanges = [];
  for (const [, oldStart, oldCount = '1', newStart, newCount = '1'] of diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)) {
    oldRanges.push(range(oldStart, oldCount));
    newRanges.push(range(newStart, newCount));
  }
  return { oldRanges, newRanges };
}
