import { defineConfig } from 'vitest/config';
import { WASM_RUNTIME_FLAGS } from './src/extraction/wasm-runtime-flags';

/**
 * Upstream splits this into a shared base plus `vitest.workspace.mts` so its
 * Svelte viewer package can test under jsdom. Lattice does not take the viewer
 * package (`ui/`, see UPSTREAM.json `skip`), so this is the whole config.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Lattice does not ship or invoke the absorbed standalone install/update
    // machinery. Keeping those upstream-only suites in the product gate would
    // preserve a second owner and contradict the bundled-sensor contract.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '__tests__/installer.test.ts',
      '__tests__/installer-targets.test.ts',
      '__tests__/npm-shim.test.ts',
      '__tests__/prepare-release.test.ts',
      '__tests__/remove-binary.test.ts',
      '__tests__/beta-signup.test.ts',
      '__tests__/install-sh-prune.test.ts',
      '__tests__/npm-sdk.test.ts',
      // Taken from upstream and kept in sync, but not run: each needs a surface
      // Lattice does not operate (UPSTREAM.json conflict_policy / skip).
      '__tests__/ui-package.test.ts', // Svelte + jsdom toolchain (vitest.workspace.mts is skipped)
      '__tests__/cli-ui-command.test.ts', // needs the built viewer (dist/viewer), which Lattice does not build
      '__tests__/ui-entrypoints-api.test.ts', // starts the UI server, which serves the built viewer
      '__tests__/cli-install-init.test.ts', // `install` is refused in Lattice (BUNDLING.md)
      '__tests__/wsl-shared-index.test.ts', // Lattice keeps one fixed state path; no WSL sibling dir
    ],
    // Suites that spawn the built CLI need a current dist/ (#1879).
    globalSetup: ['./__tests__/global-setup-dist.ts'],
    /**
     * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
     * mcp-roots) spawn `dist/bin/lattice-sensor.js serve --mcp` with `process.execPath`
     * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
     * the CLI's hard-block (src/bin/lattice-sensor.ts) would otherwise exit the child
     * before it ever responds, so every spawn-based test times out — see #478.
     *
     * Setting the override here keeps the CLI's runtime guard intact for end
     * users (it's still enforced when `lattice-sensor` is invoked directly) while
     * letting the test suite run on whatever Node the contributor happens to
     * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
     * there, so the variable is a no-op.
     */
    env: {
      LATTICE_SENSOR_ALLOW_UNSAFE_NODE: '1',
      /**
       * The suite spawns real CLI/MCP processes; without this they would write
       * telemetry state into the contributor's real ~/.lattice/sensor and count test
       * tool calls as real usage. The telemetry unit tests are unaffected —
       * they inject their own `env` via the Telemetry constructor.
       */
      LATTICE_SENSOR_TELEMETRY: '0',
    },
    /**
     * The same V8 flags every real launch path passes (the bundled launcher,
     * the CLI's self re-exec, refresh-launcher): keep tree-sitter grammar
     * compilation on the Liftoff baseline tier. Without them a pool worker
     * runs the grammars on the turboshaft optimizing tier, and once enough
     * parses have warmed a grammar function up, its background tier-up job
     * exhausts a compiler Zone and aborts the worker — `Fatal process out of
     * memory: Zone`, surfaced by vitest only as "Worker exited unexpectedly"
     * with the rest of the file's tests silently unrun (#1779; the product-side
     * story is in wasm-runtime-flags.ts, #293/#298). On Node 24 with a
     * 660-test extraction suite this reproduced on every run at the same test.
     * V8 flags are process-global, so the parse worker threads a test spawns
     * are covered too.
     */
    poolOptions: { forks: { execArgv: [...WASM_RUNTIME_FLAGS] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
