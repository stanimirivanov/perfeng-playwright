# Native worker presence

## TL;DR

- Run this command only from a clean, reviewed checkout in an interactive Windows session.
- Put the non-secret endpoint, browser families, and environment evidence in the closed JSON
  configuration; never put a token there or on the command line.
- Supply the worker-audience token through `PERFENG_NATIVE_WORKER_TOKEN` for the process and use an
  HTTPS control-plane origin.
- This release always reports `UNAVAILABLE`; it validates identity and qualification wiring but
  cannot acquire or execute a Run yet.
- Treat `authorizedToAcquire` as server policy, not proof that this presence-only process is ready
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

## Current boundary

This command is intentionally one-shot and always sends `availability: "UNAVAILABLE"`. It does not
heartbeat, acquire or renew leases, observe cancellation, run a browser, upload evidence, register
artifacts, or report a terminal outcome. Those operations require later reviewed slices. Do not
wrap this command in a loop and reinterpret it as a ready worker; the server heartbeat interval is
returned for the future lifecycle implementation.

The vendored presence examples and lock under `vendor/contracts` pin byte-identical fixtures from
perfeng-contracts bundle 0.16.0 and record the reviewed full OpenAPI checksum. Updating the API
requires an explicit contract repin and compatibility review rather than accepting a moving schema.
