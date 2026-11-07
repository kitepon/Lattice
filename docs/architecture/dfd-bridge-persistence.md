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
| `todo dashboard ensure` → `ensureProjectDashboardDelivery` → `recoverConfiguredBridge` → `bridgeDiagnostics` → `verifyBridgeHubDelivery` | `bridge.json`, adapter snapshot, hub heartbeat | `lattice.dashboard_delivery.v1` receipt: `hub_delivered` / `local_only` / `failed(reason)`; CLI exit follows the receipt | dashboard-delivery (receipt on stderr), no files |

## Linux adapter (`bridge-detached-supervisor.mjs`)

| Operation | Sequence | Files under `<seat root>/bridge-linux/` |
|---|---|---|
| snapshot | mkdir 0700; read `descriptor.json` (strict file, ≤64 KiB) | read |
| describe | parse descriptor → `{node_path, node_exists, bridge_path, bridge_exists}` | read |
| install | resolve node/bridge/supervisor executables → stop the running supervisor (pidfile → SIGTERM → wait ≤10 s) → write descriptor atomically (0600; schema `lattice.bridge_supervisor_descriptor.v1` + `nodePath`) → `spawn(node, [supervisor, descriptor], {detached, stdio: ignore})` → `waitForBridgeStartupReady` | write `descriptor.json`; supervisor writes `supervisor.pid` |
| disable | stop running supervisor → rm descriptor + pidfile → `{removed, stopped}` | remove |
| restore | stop running supervisor → if snapshot installed: rewrite descriptor, spawn again | rewrite |

Guards: none added. The only stop is the shared start timeout (typed, 5 s, with
rollback), identical to the other two adapters. Self-exit: `disable` and
`restore` always clear the pidfile; a stale pid that is not alive is ignored.

shortcut: no boot/login persistence on Linux (containers restart the seat's
`setup.sh`, which re-runs `bridge reconfigure`); upgrade to a `systemd --user`
unit when a Linux seat runs on a host with a user session manager.
