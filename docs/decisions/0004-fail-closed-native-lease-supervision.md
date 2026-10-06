# ADR-0004: Fail closed on Native Worker lease-supervision failure

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Renew an acquired v2 lease before starting work and then at the server-directed interval.
- Abort active work on server cancellation, lost authority, missed expiry or any renewal failure.
- Do not claim release or terminal completion until the abort-aware operation has settled.
- Keep retries, final reporting and restart recovery in the future lifecycle coordinator.

## Context

The local runner can now execute and publish evidence, but long browser runs may outlive the initial
lease. A detached renewal loop could continue reporting a stale phase, while execution could continue
after the server cancels or loses the attempt. The v2 renewal response provides the authoritative
revision, server time, expiry, next interval and optional cancellation deadline. The worker must not
infer success or release merely because an abort was requested; the child process must actually stop.

## Decision

One supervisor wraps the entire attempt callback, starting with an immediate v2 renewal. It reports
only explicit forward phase transitions and exposes the latest accepted Run revision to the callback.
It renews again at the server-directed interval while work remains active. Expiry is tracked on a
monotonic clock using the response's server-time-to-expiry interval, conservatively anchored at the
request start so network latency cannot extend local authority.

A cancellation response, lost or conflicting authority, expiry, external shutdown, or any failed
renewal aborts the callback signal. The supervisor waits for that callback to settle before returning
the interruption. It preserves a separate termination failure when work cannot stop cleanly. A
single retryable renewal failure also stops work; this first slice has no automatic retry policy.
The supervisor never acquires a lease, releases it, reports a terminal outcome or deletes evidence.

## Alternatives considered

### Continue work through retryable renewal errors

- Benefits: Better tolerance of transient control-plane failures.
- Costs and risks: Requires a bounded retry schedule and proof that the attempt cannot outlive its
  authority while the server is unreachable.
- Reason not selected: That recovery policy is not yet defined or tested.

### Renew only between execution stages

- Benefits: Simpler synchronous control flow.
- Costs and risks: A long browser run or upload can outlive its lease without an opportunity to renew.
- Reason not selected: It cannot preserve authority during active work.

## Consequences

### Positive

- The attempt callback sees an abort promptly when renewal reports cancellation or fails.
- An accepted revision is available at each publication or terminal boundary.
- No successful result is returned after the accepted lease lifetime expires.

### Negative

- A transient renewal failure aborts work even if the server might still accept a retry.
- An uncooperative callback can delay completion; the supervisor cannot by itself kill arbitrary
  work. The local process adapter must remain the owned, bounded cancellation boundary.

### Neutral or follow-up

- The lifecycle coordinator must decide release versus terminal failure and may later add a bounded
  retry policy without allowing work past the last proven expiry.
- The coordinator must check the server's `stopBy` deadline before claiming cancellation release.

## Compatibility and migration

No wire or artifact format changes. The supervisor is an internal composition operation; the CLI
continues to report `UNAVAILABLE` and does not acquire work. Existing focused renewal and release
transports retain their behavior.

## Security and operations

The lease capability remains inside the acquired authority object. Renewal failures retain safe
classifications and causes without logging response bodies or credentials. Attempt files and partial
remote publications are not deleted. A later coordinator must not send release or terminal success
before its abort-aware work has settled and current authority has been confirmed.

## Measurement and environment limitations

Lease timestamps govern execution authority, not browser interaction duration. The browser
Performance clock remains authoritative for measurements. Mocked renewal tests do not prove timing
comparability or process termination on the representative Windows laptop.

## Validation

Deterministic tests cover initial renewal, current revision and phase, periodic renewal, server
cancellation, lost authority, delayed response and wake expiry, prior shutdown, and callback errors.
The complete coordinator and real Windows/Chromium path require separate acceptance before enabling
availability.
