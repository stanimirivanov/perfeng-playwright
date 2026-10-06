# Native worker presence

## TL;DR

- Run presence from a clean, reviewed checkout in an interactive Windows session.
- Keep the endpoint and environment evidence in closed non-secret JSON; supply the worker-audience
  token through `PERFENG_NATIVE_WORKER_TOKEN` and use an HTTPS control-plane origin.
- Version 1 reports to `/native-worker/v1/presence`; version 2 reports baseline Chromium capability
  to `/native-worker/v2/presence`.
- Both versions report `UNAVAILABLE`. Treat `authorizedToAcquire` as server policy, not proof of
  execution readiness.
- V2 acquisition, renewal, release, supervised execution, artifact validation and publication
  boundaries are available for composition and tests; the CLI does not acquire or execute leases.
- A single lifecycle coordinator must own authority loss, publication and terminal reporting before
  the worker can advertise availability.
- `spool-status` inventories retained local attempt names without interpreting or modifying evidence;
  it does not recover a lease.

The presence command is the first executable slice of the outbound native Windows agent selected
by the Native Worker API architecture decision. It reports bounded capabilities and immutable
qualification evidence to the control plane without opening an inbound listener or receiving
Kubernetes or object-store credentials.

## Configuration

Copy the [v1 example](../examples/native-worker-presence.json) or
[v2 example](../examples/native-worker-v2-presence.json) outside the source checkout if local
values differ. Both closed documents contain only non-secret values; the v1 document is:

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

For v2, set `schemaVersion` to `2` and `browsers` to exactly `["chromium"]`. Do not
add Edge or Chrome: the reviewed v2 contract currently accepts baseline Chromium only.
The version selects both the protocol document and the endpoint. Existing v1 configuration
continues to send the original v1 capabilities and is not silently upgraded.

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
- the version-specific artifact and diagnostic capability identifiers from the reviewed contract.

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

The vendored v1 presence examples and lock under `vendor/contracts` pin byte-identical fixtures from
perfeng-contracts bundle 0.17.0; the v2 presence examples pin bundle 0.18.0. The lock records both
reviewed full OpenAPI checksums. Updating either API requires an explicit contract repin and
compatibility review rather than accepting a moving schema.

The same lock pins the Native Worker v2 acquisition and lease examples. The pure v2 recipe parser
verifies the closed baseline Chromium lease, exact two-slot artifact plan, supported search journey, and
current host and runner qualification evidence. It projects the reviewed values into the existing
runner configuration without choosing cache, repetition, environment or browser defaults. The
SUT target environment ID remains distinct from the qualified Windows host profile ID. This
parser itself does not contact the control plane or launch a browser. The separate v2 acquisition
transport sends the closed v2 request to `/native-worker/v2/leases`, bounds the long poll, distinguishes
`204` idle from a `200` lease, and parses the lease against current qualification evidence before
returning its capability-bearing authority. It refuses redirects, discards error bodies, and never
serializes the `X-Perfeng-Lease` capability. The presence command does not call this transport.
The worker continues to report `UNAVAILABLE` until the
complete v2 lifecycle is implemented and verified. A response with
`authorizedToAcquire: true` is server policy, not permission for this process to acquire work.

The package also contains contract-validated lease acquisition, renewal, release and upload-grant
transports needed by the next worker lifecycle slice. Acquisition distinguishes an acquired lease
from a `204` idle response, validates the complete assignment and artifact plan, and keeps the
`X-Perfeng-Lease` capability out of JSON and diagnostic inspection. Each long-poll request is
bounded to the requested server wait plus five seconds.

Renewal and release accept either v1 or v2 acquired authority. The authority selects the matching
versioned endpoint; the attempt ID, expected Run revision and opaque lease capability remain bound
to that same authority. V2 renewal validates the returned lease and attempt fence and cancellation
deadline; v2 release accepts only a `204` acknowledgement. Neither operation is called by the CLI.
Upload-grant and artifact-registration transports now accept v1 or v2 authority and use the
corresponding versioned endpoints. A grant carries its acquisition generation outside its JSON
body; registration refuses a grant from the other generation before any network call. The
terminal transport also accepts v1 or v2 authority, posts to the corresponding endpoint and
checks the acknowledgement against the acquired attempt and expected Run revision. Raw-result
construction and manifest publication also accept v2 authority: the builder checks measurements
against the complete v2 recipe and uses the reviewed 0.18.0 bundle identity; v1 keeps 0.17.0.
The worker rejects prerelease workload and environment-profile versions before execution because
the current measurement and raw-result schemas permit only `major.minor.patch` values.
The control plane's Run policy and runtime contracts version must also accept 0.18.0 before v2
issuance is enabled; a control plane still expecting 0.17.0 rejects the v2 manifest.
The CLI still cannot execute work, and the server must not issue v2 work until the complete worker
execution and terminal lifecycle is reviewed.

The current plan requires `playwright-measurements/v2` for the `measurements` slot and
`raw-result/v2` for the `manifest` slot. Acquisition rejects the obsolete hyphenated placeholders
and unknown formats before any assigned execution starts.

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

The artifact-publication operation composes the three authority boundaries in their required
order: acquire a grant, transfer the exact local file, then register the verified reference. It
returns only the immutable reference and never exposes or retains upload authorization. It does not
retry implicitly. If transfer succeeds but registration fails, the object remains non-authoritative
and attempt-scoped; a lifecycle coordinator may retry the same declaration while its lease remains
current. The worker receives no permission to inspect or delete that object.

The raw-result builder constructs deterministic `raw-result/v2` bytes only after every required
non-manifest artifact has a lease-fenced registered reference. It derives Run, test, workload,
measurement-window and producer provenance from the validated measurements and assignment, orders
references by the server artifact plan, and rejects duplicate, foreign, late or self-referential
evidence. The manifest remains unpublished until the lifecycle coordinator writes and publishes it
through the same grant, transfer and registration boundary.

The manifest-publication operation performs that ordering explicitly: it serializes and validates
the complete result, creates the local manifest without replacing an existing path, computes the
exact byte integrity, then requests the `manifest` grant, transfers those bytes and registers the
returned reference. Invalid input and output collisions cause no network request. Remote failure
retains the immutable local file for an explicit retry. A retry may reuse only a regular file whose
bytes exactly match the reconstructed manifest; it never replaces evidence or reports the Run as
completed.

Terminal reporting is an idempotent lease-fenced transport. A completed report names the required
registered manifest reference; a failed report carries one closed failure classification, a bounded
human-safe message and a retryability hint. The client validates whether the server accepted the
first report or acknowledged an identical retry. The control plane remains responsible for
checking complete registered evidence, enforcing manifest-last ordering, advancing the Run and
rejecting a conflicting terminal claim. Cancellation continues to use lease release rather than a
terminal report.

The CLI does not call these lease transports yet. Acquiring work before process-tree cancellation,
execution preparation, and lifecycle coordination are composed could still abandon authority or
misrepresent execution, and would contradict the worker's `UNAVAILABLE` presence.

The runner subprocess adapter now accepts a caller-reviewed executable, arguments, working directory,
explicit environment, cancellation signal and bounded timeout. It does not use a shell or inherit
output streams. Cancellation and timeout stop the owned process tree and wait for the direct child to
close before returning. On Windows this uses `taskkill /T /F`; on POSIX it signals the dedicated
process group. A failed tree-stop operation is reported as a termination failure, not as a completed
cancellation. The adapter does not validate the selected runner revision or prepare per-attempt
configuration; those remain lifecycle-coordinator responsibilities. In particular, the runner must
keep its browser descendants owned until its own exit. This boundary has process-level tests on the
development host, but still needs representative Windows/Chromium verification before the worker
reports `AVAILABLE` or acquires a lease.

V2 attempt preparation verifies the current clean source checkout against the assigned runner
revision and lock before creating state. It requires an existing, operator-owned, non-symlink spool
root; the operator must locate that root outside the source checkout. Preparation then creates one
exclusive directory named from the Run and attempt IDs. The directory contains a lease-derived
baseline configuration. Its fixed measurement, receipt and manifest paths do not exist until later
steps publish them. The returned command arguments are for the runner CLI after a separately
reviewed Node executable and entry point are selected. Neither worker credentials nor the opaque
lease capability are written to the
configuration. An existing attempt directory is never reused, replaced or removed automatically.
If preparation fails after directory creation, retain that directory for inspection; restart
recovery and cleanup policy belong to the lifecycle coordinator. Windows directory mode bits are
not an access-control policy, so the operator must provision a spool root with suitable ACLs.

Before a baseline measurement file can be offered for upload, local artifact verification requires
the runner's committed receipt. It verifies the receipt's Run, test and source-checkout identity
against the v2 lease, rejects diagnostic slots, and streams the measurement file to check its size
and SHA-256 against both the receipt and the lease's artifact-plan maximum. Missing, symlinked,
oversized, changing or mismatched files fail without deleting local evidence or contacting the
control plane. The receipt has a 64 KiB local bound. The separate semantic loader rereads those
committed bytes, compares their size and digest, then validates the complete baseline payload,
iteration metric sets, recipe identity, runner version and lease timeline before returning upload
inputs. The worker rejects measurement plans above the 32 MiB local parser bound before execution;
see [ADR-0003](decisions/0003-bound-native-measurement-parsing.md). Neither check proves that an
untrusted local writer told the truth. Publication still belongs to a later lifecycle coordinator,
and the server remains the authority for registered evidence.

The local execution helper connects these boundaries without enabling work acquisition. It requires
an acquired v2 lease, a source checkout matching that lease, a real `dist/cli.js` inside the checkout,
an operator-owned spool root, an explicit runner environment and a bounded timeout. It invokes the
current Node executable with only the prepared baseline arguments, supervises the process tree,
then loads the validated measurements. The worker-audience token is refused in the child environment.
Cancellation, timeout, nonzero exit or invalid output never produces publication inputs; the attempt
directory and any committed files remain for inspection. The ignored `dist/cli.js` build output is
not itself bound by the source-checkout digest, so operators must build it from the reviewed checkout.
The local helper alone does not renew, publish or report. The later attempt coordinator composes
those steps; restart recovery and acquisition remain required before the worker may report
`AVAILABLE`.

The v2 evidence-publication operation reloads the committed local measurements before any remote
request. It grants, uploads and registers that slot first, then builds the `raw-result/v2` manifest
from the registered reference and publishes the manifest last. It does not report terminal success.
The manifest timestamp is selected after measurement registration; if manifest publication fails
after local commitment, an explicit retry must reuse the original `createdAt` to reproduce the exact
bytes. Mismatched recovery state is preserved and rejected rather than replaced. The caller must
keep renewal, cancellation and revision authority current throughout this operation; the attempt
coordinator owns that policy. No CLI work acquisition or external target is enabled here.

The v2 lease supervisor can wrap an abort-aware attempt while it prepares, runs, uploads and
finalizes. It renews immediately, then at the server-directed interval, exposes the latest accepted
revision, and permits only forward phase transitions. Server cancellation, lost authority, expiry,
shutdown or a renewal failure aborts the operation and waits for it to settle. It does not claim
release or terminal completion, automatically retry renewal, or remove evidence; see
[ADR-0004](decisions/0004-fail-closed-native-lease-supervision.md). The complete worker loop still
needs restart-recovery and acquisition policy before the CLI can acquire work.

An internal v2 attempt coordinator now composes preparation, runner execution, measurement
validation, measurement-before-manifest publication and terminal reporting under that supervisor.
It reports fixed stage-specific failure codes only while authority remains active; local error
details are never copied into a terminal message. A cancelled or lost attempt makes no terminal
claim. Terminal uncertainty and partial evidence are retained for explicit recovery; see
[ADR-0005](decisions/0005-report-native-attempt-terminal-within-lease-supervision.md).

After server cancellation or worker shutdown, the supervisor offers release only once abort-aware
work has settled and the lease still has time before its expiry or `stopBy` deadline. The coordinator
uses the latest accepted revision and an independent bounded request signal. Lost authority,
uncertain renewal and failed process termination never claim release. Restart recovery and the
acquisition loop remain unfinished, so the CLI still reports `UNAVAILABLE`; see
[ADR-0006](decisions/0006-release-stopped-native-attempts-within-proven-authority.md).

## Inspect retained attempt state

An operator can inspect retained local state with
`perfeng-playwright-worker spool-status --spool-root ABSOLUTE_DIRECTORY`. The JSON result lists
attempt-shaped directories and their immediate filenames, plus unexpected root entries. It reads
no evidence bytes and needs no worker token. `hasRetainedState` means operator review is needed;
it does not mean the files are valid or the lease can be resumed. The command neither deletes
state nor contacts the control plane. A concurrent worker can change the spool after inspection,
so this is not an acquisition lock. See
[ADR-0007](decisions/0007-inspect-retained-native-attempts-without-resuming.md).
