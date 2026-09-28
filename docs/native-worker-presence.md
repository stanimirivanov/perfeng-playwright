# Native worker presence

## TL;DR

- Run this command only from a clean, reviewed checkout in an interactive Windows session.
- Put the non-secret endpoint, browser families, and environment evidence in the closed JSON
  configuration; never put a token there or on the command line.
- Supply the worker-audience token through `PERFENG_NATIVE_WORKER_TOKEN` for the process and use an
  HTTPS control-plane origin.
- This release always reports `UNAVAILABLE`; it validates identity and qualification wiring but
  cannot acquire or execute a Run yet.
- Treat `authorizedToAcquire` as server policy, not proof that this heartbeat-only process is ready
  to accept work.

The presence command is the first executable slice of the outbound native Windows agent selected
by the Native Worker API architecture decision. It reports bounded capabilities and immutable
qualification evidence to the control plane without opening an inbound listener or receiving
Kubernetes or object-store credentials.

## Configuration

Copy [the example](../examples/native-worker-presence.json) outside the source checkout if local
values differ. The closed version 1 document contains only non-secret values:

```json
{
  "schemaVersion": 1,
  "controlPlaneOrigin": "https://control-plane.perfeng.invalid",
  "browsers": ["edge", "chromium"],
  "environment": {
    "id": "windows-mainstream",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

`controlPlaneOrigin` must be an HTTPS origin without credentials, a path, query, or fragment. The
environment identity and digest must name the separately captured and server-approved
`browser-environment/v1` evidence. Browser values describe installed, operator-reviewed families;
presence does not install or probe browsers in this slice.

The command derives these values instead of accepting them from configuration:

- Windows and the current `x64` or `arm64` process architecture;
- capacity one and the Playwright tool identity;
- source repository, exact Git revision, `pnpm-lock.yaml` path, and lock checksum from a clean
  checkout;
- the package version and Native Worker protocol generation; and
- only the artifact and diagnostic capabilities implemented by the current runner.

Dirty source, an unsupported platform or architecture, invalid evidence, an unsafe origin, or an
unknown configuration field fails before an HTTP request is made.

## Run once

Build from the clean revision that will be reported. Load the distinct worker-audience credential
from Windows Credential Manager or another operator-approved protected store into the process
environment. For an interactive local check, PowerShell can prompt without placing the value in
shell history:

```powershell
pnpm build
$env:PERFENG_NATIVE_WORKER_TOKEN = Read-Host "Native worker token" -MaskInput
node dist/worker-cli.js presence --config C:\path\to\native-worker-presence.json
Remove-Item Env:PERFENG_NATIVE_WORKER_TOKEN
```

The success output is the validated, non-secret server interpretation: worker ID, server time,
next heartbeat interval, reported availability, qualification decision, and acquisition policy.
The command never prints the credential, authorization header, server error body, or private
response content. It refuses redirects so a bearer credential cannot be forwarded to another
origin.

## Run heartbeats

Use the same reviewed configuration and protected process credential for the long-running mode:

```powershell
node dist/worker-cli.js heartbeat --config C:\path\to\native-worker-presence.json
```

The worker refreshes clean-checkout provenance before every report and schedules the next report
within the final ten percent of the server's `nextHeartbeatSeconds` interval. `SIGINT` and
`SIGTERM` stop both an in-flight request and the next scheduled wait. A request is bounded to 15
seconds.

Transport failures and HTTP 500 responses use exponential retry bases from five to 60 seconds,
jittered earlier by no more than ten percent. HTTP 429 and 503 responses may provide an integer
`Retry-After` value from one to 60 seconds; the worker waits at least that long. Authentication,
contract, malformed response, and other permanent errors terminate the process for operator
attention. Status output and retry messages contain no credentials or server response bodies.

## Current boundary

Both modes always send `availability: "UNAVAILABLE"`. The heartbeat maintains presence and observes
operator cancellation, but it does not acquire or renew leases, run a browser, upload evidence,
register artifacts, or report a terminal outcome. Those operations require later reviewed slices.
Do not reinterpret a running heartbeat as a ready worker; `authorizedToAcquire` remains server
policy and the process deliberately does not act on it.

The vendored presence examples and lock under `vendor/contracts` pin byte-identical fixtures from
perfeng-contracts bundle 0.16.0 and record the reviewed full OpenAPI checksum. Updating the API
requires an explicit contract repin and compatibility review rather than accepting a moving schema.

The package also contains contract-validated lease acquisition, renewal, release and upload-grant
transports needed by the next worker lifecycle slice. Acquisition distinguishes an acquired lease
from a `204` idle response, validates the complete assignment and artifact plan, and keeps the
`X-Perfeng-Lease` capability out of JSON and diagnostic inspection. Each long-poll request is
bounded to the requested server wait plus five seconds.

Renewal sends the current attempt fence and execution phase, is bounded to five seconds, validates
the authoritative revision and expiry schedule, and represents cancellation as a distinct state
with a bounded `stopBy` deadline. Conflict and lost-authority responses remain distinct from
retryable transport failures. Release sends the same attempt fence and one closed reason, is
idempotent for the same accepted reason, and optionally carries a bounded operator-safe message.
Cancellation release confirms that the complete process tree has already stopped; the transport
does not make that claim itself.

Upload-grant acquisition verifies the declared bytes against the assigned slot and validates the
server-selected object key, attempt fence, size ceiling, checksum, lease-bounded expiry and exact
signed headers. Its presigned URL query and header values are bearer material. They remain behind
an explicit callback and are omitted from JSON, string and diagnostic inspection.

The separate artifact-transfer step opens the declared local file as a file-backed Blob, verifies
its size and SHA-256 before network access, and sends it through one bounded presigned `PUT`. Node
rechecks the backing file while streaming, and the object store verifies the signed full-object
checksum. Only HTTP 200 is accepted. Provider response bodies and transport errors are discarded
without exposing the presigned URL. The transfer does not persist grant delivery material or make
the uploaded object authoritative.

Artifact registration repeats the attempt, revision, grant and slot fence after transfer. It
accepts only a server-issued immutable reference whose Run, attempt, slot, kind, object key, size,
checksum and media type match the active lease, upload grant and artifact plan. The control plane
remains responsible for verifying the stored object before returning that reference. Registration
does not report a terminal outcome, assert that all required evidence exists, or make the manifest
ordering decision owned by the later lifecycle coordinator.

The CLI does not call these lease transports yet. Acquiring work before process-tree cancellation,
execution preparation, and lifecycle coordination are composed could still abandon authority or
misrepresent execution, and would contradict the worker's `UNAVAILABLE` presence.
