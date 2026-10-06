# ADR-0008: Retry exact Native Worker terminal claims once

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Repeat one unchanged v2 terminal claim once when its first response is retryably uncertain.
- Keep the same attempt, expected Run revision, outcome and manifest or failure body.
- Never retry a conflict, lost authority, cancellation or a response with `Retry-After` immediately.
- A second failure remains ambiguous and requires explicit recovery; this does not enable acquisition.

## Context

The v2 attempt coordinator reports terminal completion or failure while lease renewal remains active.
A transport error or HTTP 500 can leave the worker unsure whether the control plane accepted its
report. The server persists the first terminal outcome atomically and returns `ALREADY_ACCEPTED` for
an identical later claim, even when the first response was lost. Constructing a new claim from a
later lease revision would no longer be an exact retry. The worker currently surfaces every such
failure without using this idempotency contract.

## Decision

The attempt coordinator constructs its terminal request once and passes that same request object to
at most two report calls. It retries immediately only when the first call returns a classified
`retryable` terminal failure, has no server `Retry-After`, and the supervised attempt signal remains
active. A returned `ACCEPTED` or `ALREADY_ACCEPTED` acknowledgement ends the attempt normally.

The worker does not retry conflicts, lost authority, permanent failures, cancellation, unclassified
errors or server-paced retries. If the second call fails, its error is surfaced; a prior local work
failure remains preserved by the coordinator's existing aggregate-error path. Neither an error nor
an absent acknowledgement is interpreted as proof that the server rejected the report.

## Alternatives considered

### Rebuild the request using the latest revision

- Benefits: Might match a renewal that completed between calls.
- Costs and risks: A committed first report would no longer be an identical retry.
- Reason not selected: It undermines the server's idempotency check.

### Retry indefinitely or wait through `Retry-After`

- Benefits: More chances to receive an acknowledgement.
- Costs and risks: The lease may expire or be cancelled, and a loop could delay shutdown.
- Reason not selected: A single immediate retry is bounded; paced recovery needs separate policy.

## Consequences

### Positive

- A lost first response can resolve to the server's `ALREADY_ACCEPTED` acknowledgement.
- The retry uses the exact first claim and remains within lease supervision.

### Negative

- A second failure or a concurrent lease interruption still leaves terminal state uncertain.
- An immediate retry may add one request during a transient server failure.

### Neutral or follow-up

- Restart recovery, server-paced retry and work acquisition remain separate work.

## Compatibility and migration

No wire contract, artifact bytes, public configuration, CLI action or database migration changes.
This extends the coordinator behavior described in ADR-0005 without changing its fail-closed
handling of conflict, lost authority or uncertain outcomes after the bounded retry.

## Security and operations

Both calls use the same in-memory worker token and lease capability and the same cancellation
signal. Neither credential is written to disk or included in errors. Operators must still inspect
an unresolved terminal outcome; do not assume a failed second request means the first did not
commit.

## Measurement and environment limitations

Terminal retry does not change browser Performance-clock measurements, environment identity or
artifact meaning. Tests use deterministic protocol stubs rather than a representative Windows
laptop or a live control plane.

## Validation

Tests cover exact completed and failed retries, `ALREADY_ACCEPTED`, server `Retry-After`,
cancellation before retry, a second conflict, preserved local failure, and the existing
non-retryable conflict and authority-loss behavior.
