// Bounded reproduction of index-command.test.ts's real init/index/index flow.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2]);
const debuggerPath = process.argv[3];
const bin = path.join(root, 'sensor/dist/bin/lattice-sensor.js');
const preload = path.join(root, 'scripts/diagnostics/windows-index-av-preload.cjs');
const require = createRequire(import.meta.url);
const { WASM_RUNTIME_FLAGS, NODE_RUNTIME_FLAGS } = require(path.join(root, 'sensor/dist/extraction/wasm-runtime-flags.js'));
const { LatticeSensor } = require(path.join(root, 'sensor/dist/index.js'));
await mkdir(output, { recursive: true });
const isolatedHome = path.join(output, 'home');
await mkdir(isolatedHome, { recursive: true });
await writeFile(path.join(output, 'runtime.json'), JSON.stringify({ node: process.versions.node,
  v8: process.versions.v8, platform: process.platform, arch: process.arch,
  runtimeFlags: [...NODE_RUNTIME_FLAGS, ...WASM_RUNTIME_FLAGS], source: process.env.GITHUB_SHA || null }, null, 2));
const results = [];
function fixtureEnvironment(dir, trace) {
  // Dumps contain only a synthetic fixture process. Do not inherit credentials,
  // user host settings, service tokens, or the Actions runner's environment.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|pathext|systemroot|windir|comspec|processor_architecture|number_of_processors)$/i.test(key)) env[key] = value;
  }
  Object.assign(env, { HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: path.join(isolatedHome, 'appdata'),
    LOCALAPPDATA: path.join(isolatedHome, 'localappdata'), TMP: output, TEMP: output,
    LATTICE_SENSOR_NO_DAEMON: '1', LATTICE_RUNTIME_ERROR_REPORTING: '0', NO_COLOR: '1' });
  if (trace) {
    env.NODE_OPTIONS = `--require="${preload.replaceAll('\\', '/')}"`;
    env.LATTICE_AV_TRACE_DIR = path.join(output, 'traces');
  }
  return env;
}
async function execute(mode, dir, command, lane, iteration) {
  const direct = mode === 'debug';
  const nodeArgs = [...(direct ? [...NODE_RUNTIME_FLAGS, ...WASM_RUNTIME_FLAGS] : []), bin, command];
  const dumpDir = path.join(output, 'dumps');
  await mkdir(dumpDir, { recursive: true });
  const args = direct ? ['-accepteula', '-mm', '-e', '-n', '1', '-x', dumpDir, process.execPath, ...nodeArgs] : nodeArgs;
  const executable = direct ? debuggerPath : process.execPath;
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(executable, args, { cwd: dir, env: fixtureEnvironment(dir, mode !== 'baseline'), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    const timeout = setTimeout(() => {
      timedOut = true;
      // Only the process tree just created by this fixture is eligible.
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      } else child.kill('SIGKILL');
    }, 90_000);
    child.on('error', error => { clearTimeout(timeout); resolve({ pid: child.pid, error: String(error), stdout, stderr, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ pid: child.pid, code,
      hex: Number.isInteger(code) ? `0x${(code >>> 0).toString(16)}` : null, signal, stdout, stderr, timedOut }); });
  });
  // ProcDump's own exit status does not represent the debuggee's exit status.
  // Its redirected Windows output is UTF-16; strip NULs before parsing the
  // ASCII exit record while retaining the original stream as evidence.
  const childExit = direct ? [...result.stdout.replaceAll('\0', '').matchAll(/Process Exit: PID \d+, Exit Code (0x[0-9a-f]+)/gi)].at(-1) : null;
  const actualCode = childExit ? Number.parseInt(childExit[1].slice(2), 16) : result.code;
  const item = { mode, lane, iteration, command, elapsedMs: Date.now() - started, ...result,
    wrapperCode: result.code, code: actualCode, hex: Number.isInteger(actualCode) ? `0x${(actualCode >>> 0).toString(16)}` : null };
  results.push(item);
  await appendFile(path.join(output, 'commands.jsonl'), JSON.stringify(item) + '\n');
  process.stdout.write(JSON.stringify({ mode, lane, iteration, command, code: item.code, hex: item.hex, elapsedMs: item.elapsedMs }) + '\n');
  if (/MODULE_NOT_FOUND|looks like your home directory/.test(item.stdout + item.stderr)) {
    throw new Error(`Diagnostic setup failed for ${mode}; see commands.jsonl`);
  }
  return item;
}
function counts(dir) {
  const sensor = LatticeSensor.openSync(dir);
  try { const s = sensor.getStats(); return { nodes: s.nodeCount, edges: s.edgeCount }; }
  finally { sensor.close(); }
}
async function sequence(mode, lane, iteration) {
  const dir = path.join(output, 'fixtures', `${mode}-${lane}-${iteration}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'a.ts'), "export function greet(name: string) { return hello(name); }\nexport function hello(n: string) { return 'hi ' + n; }\n");
  await writeFile(path.join(dir, 'b.ts'), "import { greet } from './a';\nexport function main() { return greet('world'); }\n");
  let firstCounts;
  let indexCalls = 0;
  for (const command of ['init', 'index', 'index']) {
    const result = await execute(mode, dir, command, lane, iteration);
    if (result.code !== 0 || result.timedOut || result.error) return;
    if (command === 'index') {
      try {
        const current = counts(dir);
        if (++indexCalls === 1) firstCounts = current;
        else await appendFile(path.join(output, 'graph-counts.jsonl'), JSON.stringify({ mode, lane, iteration,
          first: firstCounts, second: current, consistent: current.nodes === firstCounts.nodes && current.edges === firstCounts.edges }) + '\n');
      } catch (error) {
        await appendFile(path.join(output, 'graph-counts.jsonl'), JSON.stringify({ mode, lane, iteration, error: String(error) }) + '\n');
        return;
      }
    }
  }
}
// First preserve the original uninstrumented launch path, then add flushed
// phase probes, and finally debug the same canonical inner Node invocation.
for (const mode of ['baseline', 'trace', 'debug']) {
  for (let iteration = 0; iteration < 4; iteration++) {
    await Promise.all(Array.from({ length: mode === 'debug' ? 2 : 4 }, (_, lane) => sequence(mode, lane, iteration)));
    if (results.filter(x => x.hex === '0xc0000005').length >= 3 && mode === 'debug') break;
  }
}
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ commands: results.length,
  failures: results.filter(x => x.code !== 0 || x.error || x.timedOut).map(({ stdout, stderr, ...x }) => x),
  note: 'No failure is a bounded non-reproduction result, not a fix or a root-cause verdict.' }, null, 2));
