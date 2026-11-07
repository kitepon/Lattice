# DFD — bridge persistence across OS adapters (t08, 2026-11-07)

Scope: how `lattice bridge setup|reconfigure|disable|status` and the delivery
recovery inside `lattice todo dashboard ensure` reach the OS persistence entry,
and what each adapter owns. The claimed product logic (plan/impact/runtime) is
not touched; this is the display-and-delivery seam of
[function-map.md](function-map.md) row "Dashboard + network".

## Selection (bridge-cli.mjs `platformLaunchAgent`)

| `process.platform` | Adapter module | Persistence entry | Supervision after start |
|---|---|---|---|
| `darwin` | `bridge-launch-agent.mjs` | LaunchAgent plist `dev.kitepon.lattice.bridge` (launchctl bootstrap) | launchd KeepAlive |
| `win32` | `bridge-startup-folder.mjs` | `%APPDATA%\…\Startup\LatticeBridge.vbs` + descriptor/pidfile under `%LOCALAPPDATA%\Lattice\bridge-startup` | `bin/lattice-bridge-supervisor.mjs` (restart loop) |
| anything else (Linux containers, BSD) | `bridge-detached-supervisor.mjs` | `<seat root>/bridge-linux/descriptor.json` + `supervisor.pid` (`<seat root>` = `bridgeConfigPaths(env).root`, per seat since t07) | `bin/lattice-bridge-supervisor.mjs`, spawned detached by the installer; no login/boot entry |

The adapter is the only code that touches its OS tool. Before t08 the fallback
branch was the macOS adapter, so every Linux `dashboard ensure` probed
`/bin/launchctl`, raised `BRIDGE_LAUNCHCTL_UNAVAILABLE` inside delivery recovery
and exited non-zero although the lifecycle write had already succeeded.

## Flows

| Step / function | Input and reader | Output / failure | Persistence owner |
|---|---|---|---|
| `runBridgeCli setup/reconfigure` → `configureBridge` | argv listen/hub/dashboard; `bridge.json` | new config (`updated_at`), operation lock | bridge-config |
| `launchAgent.snapshot({env})` | adapter state files (plist / launcher+descriptor / descriptor) | `{installed, split, …Content}`; fs errors typed | adapter (read only) |
| `launchAgent.install({config, previousListen, env})` | config, resolved node/bridge/supervisor executables, registrar env | starts the bridge under supervision; waits for `bridge-daemon.json` + `/__lattice/bridge-health` carrying the new `instanceToken`; timeout → `BRIDGE_*_START_FAILED`; rollback via `restore(snapshot)` | adapter writes its entry; bridge daemon writes `bridge-daemon.json` |
| `runBridgeCli disable` → `launchAgent.disable({snapshot, listen})` | snapshot, witnessed listen | stops supervision + bridge, removes entry; `{removed, stopped}`; rollback via `restore` | adapter |
| `runBridgeCli status` / `bridgeDiagnostics` → `bridgePersistence` | `snapshot` + `describe` | `{state: installed/not_installed/unreadable, node_path, node_exists, bridge_path, bridge_exists, loaded}`; any string-coded error → `unreadable`, never thrown | none |
| `todo dashboard ensure` → `ensureProjectDashboardDelivery` → `recoverConfiguredBridge` → `bridgeDiagnostics`; missing/broken persistence or runtime → `runBridgeCli reconfigure` → `configureBridge` → `launchAgent.install`; then `verifyBridgeHubDelivery` | `bridge.json`, adapter snapshot, runtime identity, hub heartbeat | `lattice.dashboard_delivery.v1` receipt: `hub_delivered` / `local_only` / `failed(reason)`; CLI exit follows the receipt | bridge-config rewrites `bridge.json`; adapter rewrites its entry and starts supervision; dashboard-delivery writes the receipt on stderr |

## Linux adapter (`bridge-detached-supervisor.mjs`)

| Operation | Sequence | Files under `<seat root>/bridge-linux/` |
|---|---|---|
| snapshot | mkdir 0700; read `descriptor.json` as UTF-8 (`optionalFile`: ENOENT → null; other fs errors propagate; no strict-file or size validation) | read |
| describe | parse descriptor → `{node_path, node_exists, bridge_path, bridge_exists}` | read |
| install | resolve node/bridge/supervisor executables → read pidfile identity → observe process birth → SIGTERM only on exact identity match → wait for that identity to exit ≤10 s → write descriptor atomically (0600; schema `lattice.bridge_supervisor_descriptor.v1` + `nodePath`) → await launch (`spawn(node, [supervisor, descriptor], {detached, stdio: ignore})`, then `unref`) → `waitForBridgeStartupReady` | write `descriptor.json`; supervisor writes `supervisor.pid` (Linux: JSON `{pid,birth}`, birth = `linux:<boot_id>:<starttime>`; Windows keeps its numeric pidfile) |
| disable | stop running supervisor → rm descriptor + pidfile → `{removed, stopped}` | remove |
| restore | stop identified supervisor → if snapshot installed: rewrite descriptor, await launch again, optionally await readiness for rollback config | rewrite |

Shared helper ownership: `bridge-startup-folder.mjs` is the canonical owner of
`supervisorDescriptor` (descriptor schema, forwarded registrar/config environment)
and `waitForBridgeStartupReady` (5 s token-authenticated health wait). Linux imports
these two functions; its `optionalFile`, `atomicFile`, executable validation and
`stopRunning` remain local. Windows alone uses its local `strictFile`/64 KiB check.
Linux startup timeout is `BRIDGE_DETACHED_SUPERVISOR_START_FAILED`; rollback readiness
uses `BRIDGE_DETACHED_SUPERVISOR_ROLLBACK_FAILED`.

Identity protection prevents a stale pidfile from signaling a reused PID. Stop-state
transitions: valid saved identity + same observed birth → signal → observed identity
exits/changes → remove pidfile → continue install/disable/restore; missing, malformed,
legacy numeric, unknown-birth or mismatched identity → no signal → remove pidfile →
continue. An unavailable process observation also takes the no-signal transition.
A matching supervisor that does not exit within 10 s produces
`BRIDGE_DETACHED_SUPERVISOR_STOP_FAILED`; install/CLI rollback retains its existing
error handling. The writer records identity before spawning the bridge. Non-Windows
fallback hosts use the same observer's native birth value; Windows's numeric writer
and taskkill reader are unchanged.

A dead legacy numeric record is discarded and the next install starts a fresh
identity-aware supervisor. A live legacy supervisor cannot be authenticated from
its numeric record and is neither adopted nor stopped; its owner must retire it
through an authenticated mechanism before upgrading, or both supervisors may
remain running. Clearing its pidfile does not prove that process has exited.

shortcut: no boot/login persistence on Linux (containers restart the seat's
`setup.sh`, which re-runs `bridge reconfigure`); upgrade to a `systemd --user`
unit when a Linux seat runs on a host with a user session manager.
