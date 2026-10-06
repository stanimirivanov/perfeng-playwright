# ADR-0006: Release stopped Native Worker attempts within proven authority

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Release a cancelled or shutting-down v2 attempt only after abort-aware work has settled.
- Use the latest accepted Run revision and a deadline bounded by lease expiry and, for server cancellation, `stopBy`.
- Do not claim release after failed process termination, expired or lost authority, or an uncertain renewal.
- Keep restart recovery and CLI acquisition disabled until separately reviewed.

## Context

The Native Worker contract asks the agent to stop the complete browser process tree and release a
server-cancelled lease with `CANCELLATION_REQUESTED`. The v2 supervisor already aborts and waits for
work to settle, but the attempt coordinator did not call the release operation. A release sent before
the process stops would free the Run for a new attempt while the old browser may still be active.
Likewise, a release sent after `stopBy` or lease expiry could claim authority that the worker no
longer has. Worker shutdown also needs an independent request signal: the signal that stopped work
cannot be reused to send release.

## Decision

The supervisor offers a single release opportunity after the abort-aware callback has settled with
a recognized process or publication cancellation outcome. It also offers that opportunity when an initial renewal reports
server cancellation before any work starts, or when shutdown arrives after a successful initial
renewal but before work starts. The opportunity carries the latest accepted Run revision, a reason
and a remaining monotonic deadline:

- server cancellation uses `CANCELLATION_REQUESTED` and the earlier of `stopBy` and lease expiry;
- worker shutdown uses `WORKER_SHUTDOWN` and lease expiry.

The deadline is derived from server timestamps and conservatively anchored at the renewal request
start, so response latency cannot extend local authority. No opportunity is offered when its
deadline has passed, the process failed to terminate, the callback returned success despite abort,
or there was no accepted renewal. The attempt coordinator uses a fresh, bounded release signal that
does not inherit the shutdown signal. A successful release does not turn the interruption into a
terminal success. A release error is preserved together with the original interruption.

The worker does not send a release after `lost`/`conflict`, expiry or uncertain renewal. Although the
contract says a worker _should_ release on local lease loss, the server's `410`/`409` fencing means
this worker can no longer prove the authority or revision for such a mutation. Avoiding an
unverifiable release is the fail-closed choice until a separate recovery protocol is defined.

## Alternatives considered

### Release immediately when abort is requested

- Benefits: More time before `stopBy` and faster scheduling of another attempt.
- Costs and risks: The old browser process tree may still be running.
- Reason not selected: It violates the stop-before-release requirement.

### Release on every interruption

- Benefits: One uniform cleanup path.
- Costs and risks: Expired, lost and uncertain leases lack proven authority; a failed process-tree
  stop may leave old work active.
- Reason not selected: A best-effort request would not establish a truthful release claim.

## Consequences

### Positive

- Server cancellation and worker shutdown can release a stopped attempt within a proven deadline.
- Release requests use the latest revision and cannot be pre-cancelled by the shutdown signal.
- A failed release cannot mask the interruption that prompted it.

### Negative

- A missed deadline or failed process termination leaves the lease for server-side expiry and
  operator inspection.
- The release request may still race server state changes; the server's conditional mutation remains
  authoritative.

### Neutral or follow-up

- Exact retained-evidence recovery, ambiguous terminal resolution, host requalification and the
  acquisition loop remain separate work. The CLI continues to report `UNAVAILABLE`.

## Compatibility and migration

No wire schema, artifact format, package entry point or CLI behavior changes. Existing release
transport semantics are reused. The supervisor and attempt coordinator gain an internal stopped-work
callback and release port.

## Security and operations

The worker token and lease capability remain in the worker process and are never forwarded to the
runner child. Release uses only a lease-fenced, five-second-bounded protocol operation and the
shorter remaining authority window. No local or remote evidence is deleted. Operators must not
interpret a skipped or rejected release as proof that no server attempt remains.

## Measurement and environment limitations

Release timing governs attempt authority, not browser Performance-clock measurements. Deterministic
tests exercise fake clocks and stubbed protocol responses; they do not prove Windows laptop
performance comparability or a live control-plane transaction.

## Validation

Tests cover stop-before-release ordering, the latest revision, initial cancellation, shutdown during
execution and publication, missed `stopBy`, lost authority, process termination failure, and
preservation of release failure.
The existing release transport fixture pins the v2 request shape.
