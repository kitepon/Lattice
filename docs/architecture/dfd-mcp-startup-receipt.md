# MCP startup receipt publication flow

Canonical publication design for the wrapper's private observation worker.
[Receipt contract](../mcp-startup-receipts.md) owns the data/privacy/capacity
contract; the [function map](function-map.md) owns the infrastructure boundary.
This is separate from the todo lifecycle path.

## Functions and state ownership

| Function / owner | Inputs and callers | Output / owned state | Failure handling |
|---|---|---|---|
| createMcpStartupReceipt / startup infrastructure | bin/lattice-mcp wrapper; direct/proxy sensor observation callbacks | Unref worker and deduplicated mode/phase messages | Never blocks MCP initialize or shutdown; no JSON-RPC bodies sent to worker. |
| prepare / receipt worker | Home, wrapper version, PID/start metadata; first queued observation | Exclusive mkdir claims one of 64 slots; private receipt record and process birth | Enforces existing directory/ACL rules; full/unsafe slot disables observation only. Reserved slots remain counted. |
| receive / receipt worker | Fixed mode/version or initialize phase and timestamp | Ordered bounded record; slot/pending.json → slot/receipt.json | Same schema, four-KiB cap and privacy fields; validates target/temp paths and ACLs before publication. |
| replaceStoreFile / existing runtime-errors storage helper | Safe complete temp file + destination, called by receive | Atomic rename, reusing existing bounded Windows retry | Windows EPERM/EACCES/EBUSY: up to eight attempts, bounded backoff (at most 127ms total sleep); other/persistent errors propagate. |
| Queue error handler / receipt worker | Terminal observation error | disabled worker and closed message port | Fail-open MCP operation; no fabricated success, public error body or extra runtime-error count. |

The receipt worker alone writes its claimed slot. The parent MCP process owns
observations and never synchronously performs receipt I/O. The existing storage
helper imports no receipt feature and does not change ownership of the slot.

## Field and publication flow

| Stage | Producer → consumer | Fields / transform | Persistence |
|---|---|---|---|
| Mode selected | wrapper → createMcpStartupReceipt → worker | wrapperVersion, sensorVersion, direct/proxy, run UUID, PID, start time | None in main process. |
| Initialize callbacks | sensor direct/proxy → observer → worker queue | initialize_received / initialize_response_written and timestamp; written only after successful stream callback | No clientInfo/request/response/path/stack data. |
| Preparation | worker → existing safe-storage/process identity helpers | Claim slot by exclusive mkdir; observe process birth or null | Owner-only directory; no overwrite/reclamation of old slots. |
| Serialize | queued receive → pending file | lattice.mcp_startup.v1, fixed identity/version/mode/events; verify size | One exclusive pending.json, closed and ACL checked before publish. |
| Publish (repair) | receive → replaceStoreFile | Same temp/destination; retry only named transient Windows errors | Atomic replace of receipt.json; existing receipt stays readable until replacement succeeds. |
| Observation failure | helper/error → queue handler | Stop recording; preserve best-effort/missing distinction | Reserved/pending state remains counted; MCP continues normally. |

## Publication states and bounded exit

`claimed → pending → published → next pending` is the normal sequence. A transient
Windows rename error moves `pending → retry → published`; eight failed attempts
or another error moves `pending → recording disabled`. The worker is unref and
does not keep MCP alive. ACL/path failure follows the existing disabled path.
No timeout increase, capacity change, cleanup policy or result schema change.

## Evidence and verification scope

PR36 Windows job 128319924739 timed out waiting for the final receipt in the
64-slot concurrent test. The saved log lacks its last receipt/error state; it
does not prove rename contention caused that particular timeout. The concrete
defect being repaired is single-attempt publication bypassing the house storage
helper's documented Windows retry contract.

Verify a deterministic transient publication failure followed by a final receipt,
plus bounded permanent failure with MCP initialize still responsive. Preserve
existing ACL/privacy/capacity assertions. Improve only the capacity fixture's
failure evidence if needed, keeping its existing deadlines. Run the affected
receipt suite and normal automatic Windows check; do not repeat unchanged CI.
