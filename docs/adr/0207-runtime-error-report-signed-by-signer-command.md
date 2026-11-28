# ADR 0207: Runtime error reports are signed by a configured signer command (BugHub-ES256)

- Status: accepted
- Date: 2026-11-28
- Supersedes: [ADR 0193](0193-product-owned-runtime-error-reporting.md) Decisions 2, 4 and 5 (the key file and the HMAC
  signature) and Decision 6's receipt signature; [ADR 0194](0194-runtime-error-store-on-windows.md) Decisions 5 (the
  key file location) and 6 (the key file ACL check). The rest of ADRs 0193–0196 stands.
- Plan: `lattice-bughub-es256-20261128` (task e2-impl; the callers are named in e1-callers)

## Context

Lattice reported runtime errors to BugHub with an HMAC-SHA256 signature. The HMAC secret lived in a file on every
reporting host (`~/.config/bughub/product-credentials/lattice.json`, Windows `%LOCALAPPDATA%\bughub\product-credentials\`).
A secret on a host leaks when the host is compromised. BugHub now accepts `BugHub-ES256` and will revoke the HMAC keys:
the per-host private key lives only in BellTeam's auth module (item `signkey bughub-product-lattice-<host>`), and BugHub
holds only public keys. BugHub signs its own 200 replies with ES256 too.

## Decision

1. **No secret on the host.** Lattice reads no key file. `runtime-error-reporting.json` carries a signer instead:
   `signer: { key_id, command: [argv...], cwd: string|null }` and an optional `url` (default: the BugHub LAN intake,
   `http://192.168.1.2:39310/api/products/v1/runtime-errors`). Set by
   `lattice runtime-errors reporting enable --key-id <key_id> [--signer-cwd <dir>] [--url <url>] -- <signer argv...>`.
   `enable` without those flags and `disable` keep the signer already set. Nothing in the file is secret.
2. **Signing.** Lattice writes `<ts>\n<sha256 hex of the body>` (no trailing newline) to a file in the store's own
   owner-only folder, runs the argv with that file as stdin (never a pipe: Windows ssh hangs on pipes; never the user temp
   dir), cwd as configured, 30 s timeout, and deletes the file on every exit. Exit 0: stdout is base64 of the 64-byte
   r||s, or exactly 64 raw bytes. Exit 1 is `signer_refused`; any other exit, a timeout, a start failure or a malformed
   output is `signer_failed`. The signer's output is never copied into a result or a record.
3. **Header.** `Authorization: BugHub-ES256 key_id=<key_id>, ts=<ts>, sig=<base64 r||s>`. `ts` and `observed_at` come
   from the same instant as before (ADR 0195).
4. **Receipt.** A 200 counts as received only when `accepted: true`, `report_id` matches, `sig_alg` is `ES256` and `sig`
   (base64 r||s) verifies over `report_id + "\n" + received_at` with BugHub's response public key. The key is a constant
   in `src/runtime-error-reporting.mjs` (so it ships in the package); a new key means a new release. Anything else is
   "unconfirmed" and the records stay pending (unchanged from ADR 0193 Decision 6).
5. **A signer failure is a failed send.** Not signed means not sent: the records stay pending, the attempt is written to
   the delivery state with outcome `signer_refused` / `signer_failed`, and the existing pacing retries it (once a minute at
   most, the same unchanged report once an hour). When the signer works again the next attempt sends the then-current
   total with a new `report_id`. No records are lost and no new exit state exists.
6. **Outcomes and status.** `credential_missing` and `credential_unsafe` are replaced by `signer_missing`,
   `signer_refused` and `signer_failed`. `reporting status` drops `credential` and `credential_reason` and reports
   `signer: configured|missing` and `key_id`. A `signer` or `url` of the wrong shape in the file reads as absent.
7. **Removed.** The HMAC signature, the receipt HMAC, `productCredentialPath`, `readProductCredential` and the Windows
   key-file ACL check.

## Consequences

- Reporting needs the signer path to work: on main-server the Lattice CLI runs `auth sign` directly with a fixed cwd
  (the auth module identifies the caller by folder); on rabbit, mac-kite and the Windows host it runs an ssh forced
  command to main-server (`ssh -i <key> -o BatchMode=yes ...`). If the path is down, records wait on the host and arrive
  later. Every signature costs one auth-module (or ssh) call; automatic reports stay at most one per minute.
- The container seats do not report, so they set no signer.
- A host with the old key file and no signer stops reporting (`signer_missing`) until `reporting enable --key-id` is run.
- Tests use a fake signer (a P-256 key in the test) and a receiver that verifies the ES256 header and the
  `observed_at` order. The CLI test cannot reach `delivered` because the embedded BugHub key cannot sign test replies; the
  library tests inject the response key (`options.responseKeyPem`) and cover delivery.

## Acceptance

- The signing input, the header and the receipt verification are checked against keys generated in the test.
- A refusing, failing, hanging or malformed signer sends nothing, keeps the records, leaves no input file and is retried
  by the existing pacing.
- A host with no signer never opens a connection.
- Flow and state ownership: [runtime error reporting flow](../architecture/dfd-runtime-error-reporting.md).
