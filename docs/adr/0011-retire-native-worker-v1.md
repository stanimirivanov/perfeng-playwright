# ADR-0011: Retire Native Worker v1 from the Playwright worker

- Status: Accepted
- Date: 2026-10-07
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes: ADR-0002
- Superseded by:

## TL;DR

- Accept only Native Worker v2 configuration, leases and mutation endpoints.
- Keep other independently versioned artifacts, including `browser-environment/v1`, unchanged.
- Continue reporting `UNAVAILABLE` until the complete worker acquisition loop is ready.

## Context

Native Worker v1 was never deployed. Dual-generation code and fixtures now obscure the v2-only
execution path and add maintenance without providing a compatibility benefit. The control plane
and contracts repositories have retired Native Worker v1 separately.

## Decision

The Playwright worker accepts only presence configuration `schemaVersion: 2`, reports only
`protocolVersion: 2` capability, and uses `/native-worker/v2` for presence, acquisition, renewal,
release, grants, registration and terminal claims. Lease authority is always a validated v2
execution recipe. Remove v1 source paths, fixture snapshots and examples, and use unsuffixed
source filenames for the single supported implementation. Retain the wire-level v2 identifier.

## Alternatives considered

### Keep v1 as an inactive compatibility path

- Benefits: Could support a future v1 peer.
- Costs and risks: Retains code and test branches for an API never deployed.
- Reason not selected: No deployed peer requires it.

### Silently upgrade v1 configuration

- Benefits: Existing local files might appear to keep working.
- Costs and risks: V1 browser and diagnostic claims do not map to the reviewed v2 baseline.
- Reason not selected: Operators must make the capability change explicitly.

## Consequences

### Positive

- One authority type and one endpoint generation govern the worker lifecycle.
- The remaining tests concentrate on the production v2 path.

### Negative

- Any retained v1 local configuration fails validation and must be replaced.

### Neutral or follow-up

- This decision does not enable acquisition or advertise availability.
- Updating the pinned v2 contracts bundle is a separate compatibility review.

## Compatibility and migration

No deployed v1 worker is migrated. Operators using an old local example must adopt the v2-only
example and verify qualification against a v2 control plane. Independently versioned browser
evidence and raw-result formats are not renamed.

## Security and operations

The worker credential remains process-environment-only. V2 requests retain HTTPS, bounded
responses, redirect refusal, lease capability encapsulation and cancellation fencing. Removed
v1 routes cannot receive accidental worker requests.

## Measurement and environment limitations

The worker continues to claim only baseline Chromium capability on the reviewed Windows host.
This change does not alter measurement semantics or prove live Windows execution readiness.

## Validation

Type-check and run the v2 transport, lifecycle, publication and browser test suites. Reject v1
configuration and unsupported presence protocol before network access. Verify no Native Worker
v1 endpoint or vendored fixture remains in the active tree.
