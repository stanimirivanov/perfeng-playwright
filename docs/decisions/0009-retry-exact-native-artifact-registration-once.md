# ADR-0009: Retry exact Native Worker artifact registration once

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Repeat a v2 artifact registration claim once when the first response is retryably uncertain.
- Freeze the grant and expected Run revision; never repeat the object-store upload.
- Respect server pacing and stop after one retry. Unresolved outcomes require explicit recovery.
- V1 behavior and the acquisition gate remain unchanged.

## Context

The v2 worker uploads bytes before asking the control plane to register the verified object. A
transport failure or HTTP 500 after upload can mean the registration committed but its response
was lost. Repeating the signed object `PUT` would violate the worker's no-overwrite boundary. The
control plane deduplicates an identical registration by grant, so the claim—not the transfer—is
the narrow operation that can be retried.

## Decision

The publication operation constructs one v2 registration request after a successful upload. It
calls the registration transport at most twice with the same grant, declaration and expected Run
revision. A second call occurs only when the first returns a classified `retryable` failure without
`Retry-After` and the caller's cancellation signal remains active. Any second failure is surfaced.
Conflicts, lost authority, permanent failures, cancellation, server-paced responses and
unclassified errors do not trigger an immediate retry. V1 registration remains single-shot.

## Alternatives considered

### Repeat the whole publication operation

- Benefits: Could obtain a fresh upload grant and revision.
- Costs and risks: Would repeat a successful object transfer and may overwrite attempt-scoped bytes.
- Reason not selected: It crosses the signed transfer boundary without proof that the first upload
  was absent.

### Retry indefinitely or use a newly read Run revision

- Benefits: Could recover from longer outages or concurrent lease renewal.
- Costs and risks: Extends latency and turns the claim into a different revision-fenced request.
- Reason not selected: Bounded exact replay preserves the server's deduplication contract.

## Consequences

### Positive

- A lost first response can resolve to the already-registered immutable reference.
- Only the idempotent claim is repeated; no second grant or object transfer occurs.

### Negative

- Two uncertain responses still leave registration ambiguous.
- A lease renewal between calls can make the frozen revision stale, causing the replay to fail.

### Neutral or follow-up

- Restart recovery and server-paced retry require separate work.
- This does not permit v2 acquisition or reinterpret a failed claim as an absent object.

## Compatibility and migration

No wire contract, persisted artifact, public option or database migration changes. V1 publication
still makes one registration request. The v2 server's existing exact-grant idempotency is required.

## Security and operations

The two requests use the same in-memory lease capability, worker credential and cancellation
signal. Neither credential nor provider response body is logged. Operators should inspect an
unresolved claim under current lease authority before any recovery; the client must not delete or
overwrite the attempt object.

## Measurement and environment limitations

This changes neither browser-clock measurements nor the Windows reference environment. Tests use
deterministic transport fixtures; they do not exercise a live object store or a concurrent renewal.

## Validation

Tests verify one grant, one upload and two byte-identical registration bodies after a lost response,
including the frozen Run revision; no immediate retry for `Retry-After` or conflict; and a strict
two-attempt ceiling when both responses fail.
