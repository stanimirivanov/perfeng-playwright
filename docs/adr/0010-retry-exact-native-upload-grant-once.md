# ADR-0010: Retry exact Native Worker upload grant once

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Repeat a v2 upload-grant declaration once when its first response is retryably uncertain.
- Keep the lease, slot, digest, size, media type and expected Run revision unchanged.
- Never upload bytes until an accepted grant is validated; leave v1 single-shot.
- Respect server pacing and stop after one retry. Unresolved state requires explicit recovery.

## Context

The worker must reserve a slot before its first object-store PUT. A transport failure or HTTP 500
can hide an accepted reservation. The control plane deduplicates the same lease and slot when the
declaration matches, retaining the grant identity while issuing fresh, lease-bounded signed
delivery material. Repeating the request is safe before transfer, but rebuilding it with a later
Run revision would not be an exact replay.

## Decision

The v2 publication operation constructs one upload-grant request and sends it at most twice. It
retries immediately only when the first call produces a classified `retryable` failure without
`Retry-After` and the caller's cancellation signal remains active. The second request uses the
same declaration and revision. Only an accepted, validated grant can authorize one object PUT.
Conflict, lost authority, permanent failure, cancellation, server pacing or a second failure
stops the operation. V1 publication continues to request one grant.

## Alternatives considered

### Rebuild the declaration using the latest Run revision

- Benefits: Might succeed after a concurrent lease renewal.
- Costs and risks: The retry would no longer be the same revision-fenced claim.
- Reason not selected: Exact replay is easier to audit against the server reservation.

### Retry indefinitely or immediately ignore `Retry-After`

- Benefits: Could conceal a longer service interruption.
- Costs and risks: Extends work beyond the current lease or server pacing policy.
- Reason not selected: One immediate retry is bounded and leaves longer recovery explicit.

## Consequences

### Positive

- A lost first response may resolve to the same reserved grant identity.
- No object transfer occurs until the worker validates an accepted signed grant.

### Negative

- Two uncertain responses still leave reservation state ambiguous.
- Renewal between calls may cause the frozen revision to be rejected.

### Neutral or follow-up

- Signed URL bytes and expiry can differ on the replay; they are not durable artifact identity.
- Object PUT retry, restart recovery and acquisition remain separate work.

## Compatibility and migration

No wire contract, database migration, public option or artifact format changes. V1 grant behavior
remains single-shot. V2 relies on the server's existing exact-declaration reservation semantics.

## Security and operations

Both requests use the same in-memory worker credential and lease capability. Presigned URLs and
headers remain encapsulated and are not written to logs or local evidence. An unresolved grant
must not be interpreted as permission to upload, delete or overwrite an object.

## Measurement and environment limitations

This does not change semantic browser timing or the reference Windows environment. Deterministic
transport tests do not prove live object-store behavior or concurrent renewal timing.

## Validation

Tests verify byte-identical v2 grant requests with a frozen revision, one eventual upload after an
accepted replay, no transfer on server pacing, conflict or a second failure, and unchanged v1
single-shot behavior.
