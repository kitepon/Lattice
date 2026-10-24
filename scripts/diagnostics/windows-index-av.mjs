// Bounded reproduction of index-command.test.ts's real init/index/index flow.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(process.argv[2]);
const debuggerPath = process.argv[3];
const experiment = process.argv[4] || 'index';
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
function fixtureEnvironment(dir, trace, traceDirectory = path.join(output, 'traces')) {
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
    env.LATTICE_AV_TRACE_DIR = traceDirectory;
  }
  return env;
}
async function execute(mode, dir, command, lane, iteration, target = bin, additionalFlags = [], commandArgs = [command], environmentOverrides = {}) {
  const direct = mode === 'debug';
  const ownershipMarker = `lattice-av-${randomUUID()}`;
  const traceDirectory = path.join(output, 'traces', ownershipMarker);
  const nodeArgs = [...additionalFlags, ...(direct ? [`--title=${ownershipMarker}`, ...NODE_RUNTIME_FLAGS, ...WASM_RUNTIME_FLAGS] : []), target, ...commandArgs];
  const dumpDir = path.join(output, 'dumps');
  await mkdir(dumpDir, { recursive: true });
  const dumpOptions = experiment === 'heapcheck' ? ['-ma', '-at', '15', '-e', '1', '-f', 'E0424C54,C0000374'] :
    experiment === 'heap' ? ['-mp', '-at', '15', '-f', 'C0000374'] : ['-mm'];
  const args = direct ? ['-accepteula', ...dumpOptions, ...(experiment === 'heapcheck' ? [] : ['-e']), '-n', '1', '-x', dumpDir, process.execPath, ...nodeArgs] : nodeArgs;
  const executable = direct ? debuggerPath : process.execPath;
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(executable, args, { cwd: dir,
      env: { ...fixtureEnvironment(dir, mode !== 'baseline', traceDirectory), ...environmentOverrides }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let drainTimer;
    const finish = (code, signal, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      let cleanup = null;
      const decoded = stdout.replaceAll('\0', '');
      const debuggeePid = /Process:\s*node\.exe\s*\((\d+)\)/i.exec(decoded)?.[1];
      if (direct && process.platform === 'win32' && debuggeePid && !/Process Exit: PID/i.test(decoded)) {
        // The debugger can detach after its first dump while the debuggee
        // still owns stdout. Authenticate that exact synthetic process by its
        // random argv marker, then retain its handle and creation-time match.
        // Never terminate a process by PID alone or alter host crash policy.
        const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${debuggeePid}'; ` +
          `if($p -and $p.CommandLine.Contains('${ownershipMarker}')) { ` +
          `$owned=Get-Process -Id ${debuggeePid} -ErrorAction Stop; ` +
          `if($owned.StartTime.ToUniversalTime() -eq $p.CreationDate.ToUniversalTime()) { ` +
          `$owned.Kill(); $owned.WaitForExit(5000); 'owned-process-exited' } } else { 'already-gone-or-identity-mismatch' }`;
        try { cleanup = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
          { encoding: 'utf8', timeout: 10_000, env: fixtureEnvironment(dir, false) }).trim(); }
        catch (error) { cleanup = `incomplete: ${error.code || error.message}`; }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ pid: child.pid, code, signal, stdout, stderr, timedOut, cleanup, ...extra });
    };
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    const timeout = setTimeout(() => {
      timedOut = true;
      // Only the process tree just created by this fixture is eligible.
      if (process.platform === 'win32') {
        if (child.exitCode === null) {
          try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
        }
      } else child.kill('SIGKILL');
      // A timeout must itself be bounded, even if a pipe remains inherited.
      drainTimer = setTimeout(() => finish(child.exitCode, child.signalCode, { streamsIncomplete: true }), 2000);
    }, 30_000);
    child.on('error', error => finish(null, null, { error: String(error) }));
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(() => finish(code, signal, { streamsIncomplete: true }), 2000);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
  // ProcDump's own exit status does not represent the debuggee's exit status.
  // Its redirected Windows output is UTF-16; strip NULs before parsing the
  // ASCII exit record while retaining the original stream as evidence.
  const childExit = direct ? [...result.stdout.replaceAll('\0', '').matchAll(/Process Exit: PID \d+, Exit Code (0x[0-9a-f]+)/gi)].at(-1) : null;
  const nativeException = [...result.stdout.replaceAll('\0', '').matchAll(/Unhandled:\s*([0-9a-f]{8})/gi)].at(-1);
  const probeException = /(?:Exception|Unhandled):\s*E0424C54/i.test(result.stdout.replaceAll('\0', ''));
  const actualCode = direct ? (childExit ? Number.parseInt(childExit[1].slice(2), 16) : null) : result.code;
  const item = { mode, lane, iteration, command, ownershipMarker, traceDirectory, environmentOverrides,
    elapsedMs: Date.now() - started, ...result,
    exceptionCode: nativeException ? `0x${nativeException[1].toLowerCase()}` : probeException ? '0xe0424c54' : null,
    diagnosticHeapInvalid: probeException,
    debuggeeExitObserved: direct ? Boolean(childExit) : true,
    wrapperCode: result.code, code: actualCode, hex: Number.isInteger(actualCode) ? `0x${(actualCode >>> 0).toString(16)}` : null };
  results.push(item);
  await appendFile(path.join(output, 'commands.jsonl'), JSON.stringify(item) + '\n');
  process.stdout.write(JSON.stringify({ mode, lane, iteration, command, code: item.code, hex: item.hex, elapsedMs: item.elapsedMs }) + '\n');
  if (/MODULE_NOT_FOUND|looks like your home directory|Kill after dump is only valid/.test((item.stdout + item.stderr).replaceAll('\0', ''))) {
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
if (experiment === 'heapcheck') {
  const target = path.join(root, 'scripts/diagnostics/windows-worker-race.cjs');
  const addon = path.join(root, 'heap-probe-build', 'heap-probe.node');
  for (let iteration = 0; iteration < 8; iteration++) {
    await Promise.all(Array.from({ length: 2 }, (_, lane) => execute('debug', root, 'pool-heap-check', lane, iteration,
      target, [], ['pool', '8'], { NODE_DISABLE_COMPILE_CACHE: '1', LATTICE_AV_HEAP_PROBE: addon })));
    if (results.some(x => x.diagnosticHeapInvalid || x.exceptionCode === '0xc0000374')) break;
  }
} else if (experiment === 'heap') {
  const target = path.join(root, 'scripts/diagnostics/windows-worker-race.cjs');
  // The previous Mini dump omitted referenced heap blocks. Capture Private
  // memory only in the failing cache-disabled real-pool condition.
  for (let iteration = 0; iteration < 8; iteration++) {
    await Promise.all(Array.from({ length: 2 }, (_, lane) => execute('debug', root, 'pool-heap-metadata', lane, iteration,
      target, [], ['pool', '8'], { NODE_DISABLE_COMPILE_CACHE: '1' })));
    // FAST_FAIL7 during worker startup does not contain the heap-failure
    // record sought here; keep the fixed bound instead of stopping on it.
    if (results.some(x => x.exceptionCode === '0xc0000374')) break;
  }
} else if (experiment === 'cache') {
  const target = path.join(root, 'scripts/diagnostics/windows-worker-race.cjs');
  // Necessary matched control on the failing pre-repair real pool. Only the
  // cache environment changes; do not rerun the successful natural/after set.
  for (const variant of ['pool-cache-enabled', 'pool-cache-disabled']) {
    for (let iteration = 0; iteration < 8; iteration++) {
      await Promise.all(Array.from({ length: 2 }, (_, lane) => execute('debug', root, variant, lane, iteration,
        target, [], ['pool', '8'], variant === 'pool-cache-disabled' ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {})));
      if (results.filter(x => x.command === variant && x.exceptionCode).length >= 3) break;
    }
  }
} else if (experiment === 'race' || experiment === 'pool') {
  const target = path.join(root, 'scripts/diagnostics/windows-worker-race.cjs');
  const variants = experiment === 'pool' ? ['pool', 'pool-marker-off'] : ['cooperative', 'settled', 'natural', 'marker-off', 'serial', 'early'];
  for (const variant of variants) {
    for (let iteration = 0; iteration < 8; iteration++) {
      await Promise.all(Array.from({ length: 2 }, (_, lane) => execute('debug', root, variant, lane, iteration,
        target, variant.includes('marker-off') ? ['--no-concurrent-marking'] : variant === 'settled' ? ['--expose-gc'] : [],
        [variant === 'marker-off' ? 'cooperative' : variant === 'pool-marker-off' ? 'pool' : variant, experiment === 'pool' ? '8' : '4'])));
      if (results.filter(x => x.command === variant && x.exceptionCode).length >= 3) break;
    }
  }
} else {
  for (const mode of ['baseline', 'trace', 'debug']) {
    for (let iteration = 0; iteration < 4; iteration++) {
      await Promise.all(Array.from({ length: mode === 'debug' ? 2 : 4 }, (_, lane) => sequence(mode, lane, iteration)));
      if (results.filter(x => x.hex === '0xc0000005').length >= 3 && mode === 'debug') break;
    }
  }
}
await writeFile(path.join(output, 'summary.json'), JSON.stringify({ commands: results.length,
  failures: results.filter(x => x.code !== 0 || x.error || x.timedOut).map(({ stdout, stderr, ...x }) => x),
  note: 'No failure is a bounded non-reproduction result, not a fix or a root-cause verdict.' }, null, 2));
