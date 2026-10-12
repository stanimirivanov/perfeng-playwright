# Explicit Native Worker manual recovery

## TL;DR

- Use `recover` after an interrupted run, lost acquisition response or uncertain terminal acknowledgement.
- Stop and exclude every worker/browser process using the identity. Confirmation is an operator assertion, not a process scan.
- Acknowledge UNAVAILABLE and inspect server capacity plus retained attempts. Current capacity blocks recovery; no capability is restored.
- Preserve the whole spool in an exclusive same-filesystem archive, including incomplete evidence and the old owner marker.
- Provision a fresh protected spool separately before another explicit `run-once`. Live Windows/control-plane acceptance remains an M03 gate.

## Preconditions

Deploy discovery serialization to **all** control-plane writers first. The client pins contracts 0.21.0 / Native Worker API 2.2.0; unsupported routes fail closed. Captured baseline manifests retain their 0.19.0 recipe identity.

Use a clean, reviewed, built Windows checkout and the same HTTPS configuration and worker-audience credential as the interrupted worker. An updated source may be unqualified for new work; acknowledged withdrawal and observation do not require acquisition qualification. Recovery does not check browser readiness or launch a browser.

Stop the old agent, heartbeat, runner and entire browser tree. Exclude other hosts, installations, scheduled tasks and sessions using that identity or writing to the spool. `--confirm-processes-stopped` is **not** a distributed lock or proof of termination. Shared credentials across running installations cannot satisfy this procedure. Do not kill unrelated browsers indiscriminately.

Spool and archive roots must be existing absolute real directories on the same filesystem, separate from each other and the source checkout. Provision restrictive Windows ACLs on both roots; mode bits are not an ACL policy, and archive containers inherit their parent's ACLs. Unexpected top-level paths, nested links/junctions and special entries are rejected. Bounds are 32 retained attempts, 4,096 inventoried entries and 16 nested directory levels.

## Invoke recovery

Build from the reviewed clean revision, provision a protected archive root on the spool's volume, then run:

```powershell
$env:PERFENG_NATIVE_WORKER_TOKEN = Read-Host "Native worker token" -MaskInput
try {
  node dist/worker-cli.js recover `
    --config C:\perfeng-config\native-worker-presence.json `
    --spool-root C:\perfeng-spool `
    --archive-root C:\perfeng-archives `
    --confirm-processes-stopped
} finally {
  Remove-Item Env:PERFENG_NATIVE_WORKER_TOKEN
}
```

Credentials are environment-only. HTTPS requests refuse redirects and carry no lease capability. Reconciliation uses a 120-second cancellation signal, bounded presence/inspection requests and no implicit polling or retries. Local filesystem calls finish before cancellation is checked; the signal is not a hard interrupt for a stalled volume. Cancellation before archival preserves the spool. Once rename commits, cancellation does not undo preservation.

## BLOCKED: exit code 2

A FOUND slot blocks archival, including terminal state whose retained lease still occupies capacity. The result names the slot expiry but supplies no capability. Do not renew, release, upload or resume from this observation. Leave the spool retained and invoke recovery again explicitly when the server can confirm no slot. A local sleep or wall clock is not proof of expiry.

A known retained attempt reported ACTIVE also blocks, even if discovery says NONE. Reconcile the discrepancy instead of choosing the convenient response. No archive is created. The invocation-owned recovery nonce is released, but the old owner remains.

## ARCHIVED: exit code 0

After acknowledged withdrawal, recovery discovers NONE, inspects each known attempt and attempts receipt-bound local measurement verification. A second discovery immediately before archival must still report NONE and UNAVAILABLE with server time not predating withdrawal. The inventory is rechecked for detectable changes.

The complete original spool is renamed to:

```text
ARCHIVE_ROOT/native-recovery-UUID/
  recovery.json
  spool/
    .native-worker-owner
    retained attempt directories and their exact files
```

The destination container is exclusive: never reused, merged or replaced. There is no cross-volume copy/delete fallback. The original spool path is **not recreated**. Its owner marker is preserved byte-for-byte in the archive. Only the current invocation's recovery nonce is removed.

The operator record contains server observations and local integrity outcomes; it is not a runner receipt, remote publication commitment or recovered authority. `unverified` means local measurement integrity could not be established, but those bytes remain preserved. `not-found` does not distinguish unknown from foreign ownership. NONE does not prove acquisition never succeeded. A verified receipt establishes local bytes only, not semantic validity, upload, registration or deletion permission.

Review the archive and output. If another run is appropriate, provision a new empty dedicated spool with suitable ACLs and invoke `run-once` separately. Do not restore archived owner markers or attempt directories into it. Recovery itself never acquires work.

## Failure: exit code 1

Missing acknowledgement, changed/unreported intent, stale clocks, unsupported routes, transport/authentication failures, cancellation, changed inventory and unsafe paths stop recovery. Server bodies and transport secrets are not printed. If the spool had no owner, recovery creates one before network access and retains it on failure to block acquisition.

Before rename, the original spool remains. An exclusive archive container or record may remain **without** a `spool` directory; that is not a completed archive. After a successful rename followed by cleanup failure, the evidence and owner are in the archive and the old spool path is absent. Inspect both roots after any failure; never delete either because of a nonzero exit.

A crash may leave `.native-worker-recovery`. After proving process exclusion again, inspect both roots and server state before explicitly removing **only that stale invocation nonce** to retry. Never remove `.native-worker-owner` instead of reconciliation. Foreign paths, corrupt markers, links or cross-volume destinations need separate investigation; there is no `--force` bypass.

## Limits and verification

Nonce files coordinate cooperating invocations sharing the spool, not machines or hostile local writers. Metadata checks detect changes but are not an atomic tree snapshot. Protected roots and process exclusion must hold throughout. Rename preserves files but does not promise a power-loss-durable transaction with the operator record.

Recovery does not normalize results, report terminal success, delete remote objects, change measurements or qualify a laptop. Windows tests exercise disposable filesystems and mocked protocol boundaries; `make validate` covers repository acceptance. Representative Windows/Chromium and live control-plane recovery remain the separate M03 completion gate.

See [ADR-0013](decisions/0013-preserve-native-spool-in-explicit-manual-recovery.md) and [presence and execution](native-worker-presence.md).
