# ADR-0005: Report Native Worker terminal outcomes within lease supervision

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Keep lease renewal active through local execution, ordered evidence publication and terminal acknowledgement.
- Report fixed, stage-specific failure codes without sending local error details to the control plane.
- Never turn cancellation, lost authority or an invalid phase into a terminal failure claim.
- Preserve partial evidence and ambiguous terminal responses for explicit recovery; do not enable acquisition yet.

## Context

The v2 lease supervisor stops work when authority is interrupted, while local execution, evidence
publication and terminal reporting have separate implementations. Without one attempt owner these
operations could report a stale phase or revision, publish a manifest before its measurements, or
claim success after lease interruption. The process adapter already distinguishes preparation,
runner execution and measurement validation, but the combined local helper did not expose those
boundaries to lease supervision.

## Decision

An internal attempt coordinator wraps the existing local execution and ordered evidence publication
operations in one v2 lease supervisor. Local execution calls synchronous hooks after preparation and
after successful runner exit. The coordinator advances the lease phase to `RUNNING` after preparation,
to `UPLOADING` after local validation and to `FINALIZING` after publication. Terminal reporting occurs
inside the supervised callback, while renewal remains active. Publication reads the latest accepted
revision separately for each grant and registration, including after a potentially long object-store
upload. Terminal reporting reads it immediately before its request.

If a local stage fails while authority is still active, the coordinator reports one `FAILED` outcome:

| Stage                  | Failure code         |
| :--------------------- | :------------------- |
| Preparation            | `PREPARATION_FAILED` |
| Runner execution       | `TOOL_FAILED`        |
| Measurement validation | `CAPTURE_FAILED`     |
| Evidence publication   | `UPLOAD_FAILED`      |

The message is a fixed stage description and `retryable` is false. Local errors and potentially
sensitive paths or target details are never copied into the wire message. A terminal-report failure
is preserved alongside the original local failure. A successful evidence publication is followed
by one `COMPLETED` report naming the registered manifest. A conflict or lost response during terminal
reporting is not recast as a work failure and is not retried automatically.

Cancellation, lost or expired lease authority, a grant or registration conflict, and invalid phase
transitions produce no terminal claim. The coordinator does not acquire or release a lease, retry a
partially published artifact, or reconstruct state after restart. These require a separate policy
before worker availability can be enabled.

## Alternatives considered

### Report terminal state after lease supervision returns

- Benefits: A simpler callback that only executes and publishes.
- Costs and risks: Renewal would have stopped before the terminal request, leaving no current
  authority during finalization.
- Reason not selected: A terminal request is part of the active attempt lifecycle.

### Automatically retry terminal conflict

- Benefits: May resolve a renewal/revision race or ambiguous response.
- Costs and risks: Needs an explicit idempotency and restart-recovery policy, including the case where
  the first report succeeded but its response was lost.
- Reason not selected: The policy has not been reviewed or tested end to end.

## Consequences

### Positive

- Phase and stage boundaries are visible to the lease supervisor without duplicating process logic.
- A completed report names only a manifest registered after its measurements.
- Stage failure messages are bounded, deterministic and do not expose local error details.

### Negative

- A terminal/renewal conflict can leave a locally complete attempt with an uncertain server state.
- A renewal can still race between reading the current revision and the server accepting a mutation;
  such a conflict fails closed for explicit recovery rather than claiming success.
- The returned failure may contain both the local and terminal error for the operator to inspect.

### Neutral or follow-up

- Release decisions, cancellation deadlines, restart recovery and retry of exact retained evidence
  remain separate work. The worker CLI continues to report `UNAVAILABLE`.

## Compatibility and migration

No wire schema, artifact bytes, package entry point or CLI behavior changes. The local execution
hooks and attempt coordinator are internal composition interfaces. Existing attempts are not
recovered or modified by this change.

## Security and operations

The runner child receives no worker credential. The lease capability remains encapsulated. Attempt
files and partial remote publications are retained. Operators must inspect an uncertain terminal
outcome rather than assuming a failed request means the server rejected it. No external target or
GitHub artifact is contacted by the deterministic tests.

## Measurement and environment limitations

The coordinator does not alter browser Performance-clock measurements, cold/warm profiles or
environment identity. Local tests use stubbed protocol operations and do not prove a comparable
Windows-laptop run or a real control-plane transaction.

## Validation

Focused tests cover successful ordering, every local failure stage, cancellation and publication
authority loss without a terminal claim, terminal conflict without a second claim, and preservation
of local plus report failures.
The complete suite exercises the existing process, artifact and protocol boundaries separately.
