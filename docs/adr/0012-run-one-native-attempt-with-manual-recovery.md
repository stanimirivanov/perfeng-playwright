# ADR-0012: Run one Native Worker attempt with manual recovery

- Status: Accepted
- Date: 2026-10-07
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Add an explicit `run-once` command that offers one immediate acquisition window and coordinates
  at most one v2 attempt.
- Claim an empty, dedicated local spool before reporting availability; withdraw availability
  before executing an acquired lease.
- Keep an owner marker on uncertain acquisition or attempt outcomes. Never infer recovery authority
  from local files or silently remove evidence.
- Defer an unattended worker service and automatic restart recovery.

## Context

The v2 presence, acquisition, supervision, execution, publication and terminal boundaries are now
implemented and independently tested. Presence and heartbeat intentionally report `UNAVAILABLE`.
An unattended acquisition loop would need durable, authoritative recovery after process death,
including ambiguous acquisition, partial publication and terminal acknowledgement. The lease
capability is process-private, so local files cannot prove that the worker may resume an attempt.
The first executable slice needs a narrower operational boundary.

## Decision

Expose `run-once --config FILE --spool-root DIRECTORY --timeout-ms INTEGER`. The command accepts
only Native Worker v2 configuration and the reviewed baseline Chromium capability. It rejects an
invalid timeout, cancelled startup, and any worker token in the runner child environment before
network access. It requires an existing absolute, non-symlink, empty spool; operators must place
that spool outside the source checkout. An exclusively created owner marker serializes invocations
using that spool; an existing
marker or any retained path prevents acquisition.

The worker first reports `UNAVAILABLE` and requires qualified, authorized server status. It then
reports `AVAILABLE`, requires the matching accepted status, and makes one acquisition request with
zero server wait. It reports `UNAVAILABLE` again before coordinating an acquired attempt. On an
idle reply it exits without execution. On a lease, the existing coordinator owns renewal,
process-tree cancellation, evidence ordering, terminal acknowledgement and release. It releases
the owner marker only when acquisition is known idle or the terminal result is acknowledged and
availability has been withdrawn. Attempt evidence is never deleted by this command.

An uncertain acquisition response, unacknowledged terminal outcome, authority loss or failed
availability withdrawal leaves the marker for explicit operator reconciliation. No automatic
restart, lease replay or attempt cleanup is introduced. Presence and heartbeat remain unavailable.

## Alternatives considered

### Unattended long-running acquisition loop

- Benefits: Continuously accepts work without operator invocation.
- Costs and risks: Requires durable recovery, process supervision, and stronger host deployment
  guarantees before a crashed worker can safely acquire again.
- Reason not selected: These guarantees are not yet established.

### Recover authority from retained files

- Benefits: Could automatically resume partial publication.
- Costs and risks: Local files do not hold current server authority, revision or a valid lease
  capability and cannot distinguish an accepted but lost terminal acknowledgement.
- Reason not selected: It would turn uncertain evidence into an unsafe authority claim.

## Consequences

### Positive

- The browser decision loop can be exercised end-to-end under one explicit operator action.
- A local owner marker and empty-spool gate prevent a second local invocation from overlooking
  retained evidence.
- Availability is withdrawn before browser execution and never maintained by the heartbeat.

### Negative

- Each attempt requires an operator invocation and subsequent review of retained evidence.
- A process crash or ambiguous response can leave a marker even when no lease was acquired.
- The marker coordinates only cooperating processes using the same spool; it is not a distributed
  lock or a server-state guarantee.

### Neutral or follow-up

- Representative Windows/Chromium and live control-plane acceptance are needed before unattended
  rollout. A future recovery design must define server-state reconciliation and archival policy.

## Compatibility and migration

This adds a CLI action but changes no v2 wire endpoint or artifact schema. Existing presence and
heartbeat behavior is unchanged. A spool with prior attempts must be inspected and separately
archived before it can be used by `run-once`.

## Security and operations

The worker credential stays in the process environment and is removed from the runner child
environment. The owner marker contains only a random nonce, not the token or lease capability.
Operators must protect the spool with Windows ACLs and ensure no other process writes to it. On
uncertainty, stop local worker/browser processes, inspect retained paths, reconcile server lease
and Run/attempt status, preserve evidence and verify availability is withdrawn or expired before
explicitly clearing the marker. No automated cleanup is authorized by this decision.

## Measurement and environment limitations

This change does not prove that the host is a representative average Windows laptop or make Linux
CI results comparable to native Windows measurements. A successful one-shot test proves protocol
and lifecycle wiring only; environment qualification and browser timing remain separate concerns.

## Validation

Unit tests exercise empty-spool gating, one acquisition, idle and acquired outcomes, availability
withdrawal, credential isolation, cancellation and marker retention on uncertainty. Repository
validation checks packaging and browser behavior. Live Windows/control-plane verification is a
separate rollout gate.
