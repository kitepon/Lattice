# Runtime error reporting: signed send and verified receipt

Owner: Lattice Runtime (`src/runtime-error-reporting.mjs`, config reader in `src/runtime-errors.mjs`, CLI entry in
`bin/lattice.mjs`). Decision: [ADR 0207](../adr/0207-runtime-error-report-signed-by-signer-command.md), on the base
of [ADR 0193](../adr/0193-product-owned-runtime-error-reporting.md). Part of the *Error reporting + infrastructure* row
of the [function map](function-map.md). The reporting config and the store are the only state; BugHub and the auth module
are reached through their public contracts (HTTP intake, the configured signer argv), never through their files.

## Functions and state ownership

| Function / owner | Inputs and callers | Output / owned state | Failure handling |
|---|---|---|---|
| `readRuntimeErrorReportingConfig` / `runtime-errors.mjs` | Every reporting function; `runtimeErrorReportingEnabled` is its `enabled` | `{enabled, signer, url}` or `null` from `runtime-error-reporting.json`; the file is written only by `setRuntimeErrorReporting` | No file, wrong schema, symlink or unreadable: `null` (not enabled). A `signer` or `url` of the wrong shape reads as absent. `LATTICE_RUNTIME_ERROR_REPORTING=0` skips the default location. |
| `setRuntimeErrorReporting(enabled, options, {signer, url})` / reporting module; called by `reporting enable\|disable` | CLI flags `--key-id --signer-cwd --url -- argv` | Atomic write of the config; keeps the current signer/url when none is given | `invalid_signer` / `invalid_url` throw before any write; a bad flag set is a usage error (exit 2). |
| `reportRuntimeErrors`, `verifyRuntimeErrorReporting` / reporting module; called by `report`, the detached `report --auto` child and `reporting verify` | Config, store snapshot of pending records (verify: empty arrays), delivery state | One `result` (outcome, reason, http status, counts); delivery state `runtime-errors-delivery.json`; store ack | Every outcome below is returned, none throws; no outcome ends reporting for good. |
| `sendReport` / reporting module | Config, snapshot | Report body (7 fields), signature, one POST, verified receipt | Returns an outcome; never writes the ack itself. |
| `signWithSigner` / reporting module | `signer` argv/cwd, `<ts>\n<sha256 hex>` | 64-byte r||s or an outcome | Input file in the store's owner-only folder, removed on every exit; 30 s timeout kills the signer. |
| Signer command / auth module caller (main-server: `auth sign` with a fixed cwd; other hosts: ssh forced command) | stdin = the input file | stdout = base64 r||s or 64 raw bytes; exit code | Not owned by Lattice; Lattice only reads exit code and stdout. |
| `receiptSignatureValid` / reporting module | `report_id`, `received_at`, reply `sig`, BugHub response public key (constant in the module, injectable in tests) | boolean | Any malformed input is `false`. |
| `runtimeErrorAutoReportDue` / reporting module; called by the CLI before it spawns the child | Config, store diagnostics, delivery state | boolean | Any error: `false`. Runs no signer. |
| `acknowledgeRuntimeErrors` / store (`runtime-errors.mjs`) | Called only after a verified receipt | `acknowledged_through` | A failed ack is `unconfirmed ack_not_recorded`; the next send repeats the total. |

## Data flow of one send

| Stage | Producer → consumer | Fields / transform | Persistence |
|---|---|---|---|
| 1 Gate | CLI → `reportRuntimeErrors` | enabled? supported OS? signer set? | None. Without a signer: `signer_missing`, no process, no network. |
| 2 Pending | store → reporting | `runtimeErrorsSnapshot(acknowledged_through, 256)` | None. Empty: `nothing_pending`. `--auto` also applies the pacing (`throttled`). |
| 3 Body | reporting | 7-field report, `observed_at` = max(now, record times); over 512 KiB: `rejected report_too_large` | None. |
| 4 Signing input | reporting → file | `<ts>\n<sha256 hex of body bytes>` | Temporary file in the store folder, removed after the run. |
| 5 Sign | signer → reporting | exit 0: r||s; exit 1: `signer_refused`; other / timeout / malformed: `signer_failed` | None. The signer's stdout is read up to 1 KiB and never recorded. |
| 6 Send | reporting → BugHub intake | `Authorization: BugHub-ES256 key_id, ts, sig`; body bytes | None. No answer: `unconfirmed`. |
| 7 Receipt | BugHub → reporting | 200 + `accepted` + same `report_id` + `sig_alg` `ES256` + valid `sig`; else `unconfirmed` (200) or `rejected`/`unconfirmed` (other status) | None. |
| 8 Ack and pacing | reporting → store, delivery state | ack `next`; `last_attempt_at`, `last_outcome`, `attempted_through` | Written for every attempt that reached stage 4 or later, success or not. |

## States and exits

Every end state is an exit: the next CLI run (or a manual `report`) starts again from the gate. Nothing is held.

| Outcome | Means | Records | Next |
|---|---|---|---|
| `delivered` | verified receipt, ack written | acked | none pending |
| `nothing_pending`, `disabled`, `unsupported`, `signer_missing`, `store_unavailable` | nothing was sent | unchanged | `signer_missing`: `reporting enable --key-id`; others: environment |
| `throttled` | pacing (1/min, same report 1/h) | unchanged | after the interval |
| `signer_refused`, `signer_failed` | not signed, not sent | pending | pacing retries it like a failed send; the total sent later may be larger |
| `rejected` | BugHub answered 4xx (or the report is too large) | pending | pacing; the operator reads `reason` |
| `unconfirmed` | no answer, 5xx, or a receipt that does not verify | pending | pacing; BugHub does not count the same total twice |
