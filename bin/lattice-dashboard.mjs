#!/usr/bin/env node

import { TODO_STATUS_DISPATCH_ONLY, projectTodoStatus } from '../src/todo-status.mjs';
import { createTodoStoreCache, todoStoreReadFailurePhase } from '../src/todo-store-cache.mjs';
import { ganttLiveHeadDigest, renderTodoGanttForProject } from '../src/todo-cli.mjs';
import { readProjectExternalPane } from '../src/project-identity.mjs';
import {
  forgetTodoDashboardDaemonRecord,
  readVisibleTodoDashboardProjects,
  todoDashboardMemberNeedsVisibility,
  writeTodoDashboardDaemonRecord,
} from '../src/todo-dashboard-registry.mjs';
import {
  createTodoGanttProjectRegistry,
  startTodoGanttDashboardServer,
} from '../src/todo-gantt-live.mjs';
import { dashboardLifecyclePhase } from '../src/dashboard-lifecycle-ipc.mjs';

const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '--supervised-runtime' && process.connected
  && args[1] === process.env.LATTICE_DASHBOARD_RUNTIME_DIR) args.splice(0, 2);
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write('Usage: lattice-dashboard\n');
  process.exit(0);
}
if (args.length > 0) {
  process.stderr.write('Usage: lattice-dashboard\n');
  process.exit(2);
}

const env = process.env;
const configured = env.LATTICE_DASHBOARD_PORT;
const port = typeof configured === 'string' && /^(?:0|[1-9][0-9]{0,4})$/u.test(configured)
  && Number(configured) <= 65_535 ? Number(configured) : 0;
const registry = createTodoGanttProjectRegistry();
const roots = new Map();
const reportedStoreReadFailures = new Map();
// room 2488's "gantt serve固着" symptom (a dashboard stuck on stale/broken state that
// only a process restart cleared, with the store and git both already fixed) traced to
// this cache — see src/todo-store-cache.mjs for why it is content-digest keyed rather
// than stat()-fingerprint keyed.
const storeCache = createTodoStoreCache();
const readCachedStore = (repoRoot) => storeCache.read(repoRoot);

async function synchronize() {
  dashboardLifecyclePhase('registry');
  const active = await readVisibleTodoDashboardProjects({ env,
    projectHasActiveRun: async (entry) => {
      dashboardLifecyclePhase('store');
      try {
        const store = await readCachedStore(entry.repo_root);
        const active = projectTodoStatus(store, TODO_STATUS_DISPATCH_ONLY).active_set.length > 0
          || store.members.some(todoDashboardMemberNeedsVisibility);
        reportedStoreReadFailures.delete(entry.project_id);
        return active;
      } catch (error) {
        const phase = todoStoreReadFailurePhase(error);
        if (reportedStoreReadFailures.get(entry.project_id) !== phase) {
          reportedStoreReadFailures.set(entry.project_id, phase);
          // This finite stage survives in the parent's receipt without project/error text.
          // A lost supervisor leaves no stderr reader; do not create an EPIPE failure
          // in an otherwise serving daemon by writing to its abandoned pipe.
          dashboardLifecyclePhase(phase);
        }
        return false;
      }
    },
  });
  const activeIds = new Set(active.map(({ project_id: projectId }) => projectId));
  for (const projectId of roots.keys()) {
    if (!activeIds.has(projectId)) {
      registry.unregister(projectId);
      roots.delete(projectId);
    }
  }
  for (const entry of active) {
    const binding = `${entry.repo_root}\0${entry.display_name}`;
    if (roots.get(entry.project_id) === binding) continue;
    registry.unregister(entry.project_id);
    registry.register({
      projectId: entry.project_id,
      displayName: entry.display_name,
      render: async ({ displayName }) => {
        const store = await readCachedStore(entry.repo_root);
        const result = await renderTodoGanttForProject({ repoRoot: entry.repo_root,
          stable: true, displayName, readModel: store });
        return {
          html: result.rendered.html,
          head_digest: await ganttLiveHeadDigest({ repoRoot: entry.repo_root, store }),
          // 配信のたびに読む。外部ペインを差した／外した側にdaemon再起動を要求しない。
          external_pane: await readProjectExternalPane({
            repoRoot: entry.repo_root, projectId: entry.project_id,
          }),
        };
      },
      readHead: async () => ganttLiveHeadDigest({
        repoRoot: entry.repo_root, store: await readCachedStore(entry.repo_root),
      }),
    });
    roots.set(entry.project_id, binding);
  }
  return active.length;
}

let closing = null;

/**
 * 終了経路はsignalだけではない——配信するprojectが尽きた時と同期に失敗した時も
 * ここを通る。どの経路でも自分の登録簿記録を落とす。消し損ねても次のdaemon起動が
 * 掃除するので、後始末の失敗で終了を止めない。
 */
function close() {
  if (closing === null) {
    dashboardLifecyclePhase('close');
    clearInterval(timer);
    closing = (async () => {
      let cleanupFailure = false;
      try { await forgetTodoDashboardDaemonRecord({ env }); }
      catch { cleanupFailure = true; dashboardLifecyclePhase('cleanup_failed'); }
      try { await dashboard.close(); }
      catch (error) { dashboardLifecyclePhase('close_failed'); throw error; }
      if (cleanupFailure) throw new Error('dashboard record cleanup failed');
    })();
  }
  return closing;
}

function exit(code) {
  close().then(() => process.exit(code), () => process.exit(code === 0 ? 1 : code));
}

await synchronize();
dashboardLifecyclePhase('listen');
const dashboard = await startTodoGanttDashboardServer({
  registry,
  port,
  onShutdown: process.platform === 'win32' ? () => {
    dashboardLifecyclePhase('shutdown_request'); exit(0);
  } : null,
});
await writeTodoDashboardDaemonRecord({ port: dashboard.port, env });
dashboardLifecyclePhase('ready');
const timer = setInterval(() => synchronize().then((count) => {
  dashboardLifecyclePhase('periodic_sync');
  if (count === 0) { dashboardLifecyclePhase('empty_shutdown'); exit(0); }
}).catch(() => { dashboardLifecyclePhase('sync_failed'); exit(1); }), 1_000);
process.on('message', (message) => {
  if (message?.type === 'dashboard_shutdown') {
    dashboardLifecyclePhase('shutdown_request'); exit(0);
  }
});
process.once('SIGINT', () => { dashboardLifecyclePhase('shutdown_request'); exit(0); });
process.once('SIGTERM', () => { dashboardLifecyclePhase('shutdown_request'); exit(0); });
