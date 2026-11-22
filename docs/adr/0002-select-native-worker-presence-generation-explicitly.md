# ADR-0002: Select Native Worker presence generation explicitly

- Status: Accepted
- Date: 2026-10-02
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Keep existing version 1 worker configuration and presence behavior unchanged.
- Require configuration `schemaVersion: 2` to send baseline Chromium presence to the v2 endpoint.
- Continue reporting `UNAVAILABLE` until lease acquisition and execution form a complete worker.

## Context

The control plane now accepts version 2 presence, and the reviewed version 2 contract narrows
browser, artifact, and diagnostic capabilities. The Windows worker already emits version 1
presence. The two generations must not be mixed: a v1 browser list or diagnostic mode must not
be sent with a v2 protocol version. A server may authorize acquisition before the worker is
capable of honoring a lease.

## Decision

The non-secret worker configuration selects the presence generation explicitly. Version 1 retains
its existing browser choices, v1 capability set, and `/native-worker/v1/presence` endpoint. Version
2 requires exactly `browsers: ["chromium"]`, derives the reviewed baseline-only v2 capability set,
and uses `/native-worker/v2/presence`. Both generations derive immutable source-checkout evidence
from a clean Windows checkout. Both always report `UNAVAILABLE` and never acquire work through
the presence command or heartbeat.

## Alternatives considered

### Automatically upgrade every worker to v2

- Benefits: No new configuration choice.
- Costs and risks: Existing Edge or Chrome profiles would be rejected or silently misrepresented.
- Reason not selected: The generations have different capability contracts.

### Advertise `AVAILABLE` when the server qualifies a worker

- Benefits: Scheduler could issue work immediately.
- Costs and risks: The current CLI has no complete lease-execution loop.
- Reason not selected: Qualification alone does not prove local execution readiness.

## Consequences

### Positive

- Operators can exercise the v2 identity and qualification path without enabling execution.
- V1 deployments retain their existing configuration and endpoint.

### Negative

- Operators must choose and maintain the intended configuration version.
- V2 remains presence-only until the lifecycle coordinator is implemented and verified.

### Neutral or follow-up

- A later decision must define when the worker may advertise `AVAILABLE` and acquire a v2 lease.

## Compatibility and migration

V1 configuration requires no migration. Operators who opt into v2 must use the new example, have
a control plane with the v2 presence endpoint, and provide server-approved environment evidence.
Switching the configuration version does not enable work acquisition.

## Security and operations

The worker token remains process-environment-only. Both endpoints require the same protected
worker-audience credential and HTTPS origin. Responses are bounded and redirects are rejected.
An `authorizedToAcquire` response is observed but never acted upon by this presence-only process.

## Measurement and environment limitations

Presence validates declared provenance, not a live browser measurement. V2 advertises only the
baseline Chromium contract and does not claim Edge, Chrome, trace, heap, or CPU diagnostics.

## Validation

Compare emitted v2 capability structure against the byte-identical reviewed fixture; test both
endpoint routes, configuration rejection, Windows-only provenance, continued `UNAVAILABLE`, and
the unchanged v1 behavior. Run the repository verification and supply-chain checks.
