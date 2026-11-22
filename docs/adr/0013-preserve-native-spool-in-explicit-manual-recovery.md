# ADR-0013: Preserve the Native Worker spool in explicit manual recovery

- Status: Proposed
- Date: 2026-10-12
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner (review pending)
- Supersedes: None
- Superseded by: None

## TL;DR

- Add explicit recovery with process-exclusion confirmation and a protected same-filesystem archive root.
- Acknowledge UNAVAILABLE and reconcile discovery plus known-attempt inspection; no observation restores authority.
- Block current capacity and ACTIVE known attempts. Preserve incomplete evidence without requiring successful integrity verification.
- Rename the complete spool into an exclusive archive, retaining its owner. Provision a fresh spool separately; never acquire automatically.

## Context

ADR-0012 retains ownership after uncertain acquisition or execution. Known inspection cannot resolve a lost response before identifiers are learned. Contracts and control plane now provide serialized current-slot discovery. The worker needs conservative evidence disposition, not capability recovery or a restart service.

## Decision

Add `recover --config FILE --spool-root DIRECTORY --archive-root DIRECTORY --confirm-processes-stopped`. Operators stop and exclude every process using the identity. Claim an exclusive recovery nonce and retain or create the acquisition owner before server access. Acknowledge UNAVAILABLE, discover, inspect each retained attempt and attempt local receipt verification. Discover again before archival; require NONE with UNAVAILABLE and post-withdrawal server time.

FOUND, including still-occupying terminal state, and ACTIVE known attempts block. Server/filesystem uncertainty fails closed. Incomplete evidence stays unverified and preserved; local integrity does not establish publication.

Validate separated real roots, same-filesystem identity and a bounded link-free inventory. Recheck it, create an exclusive archive container and operator record, then rename the complete spool inside it. Never replace/merge a destination or fall back to copy/delete. Preserve all evidence and the old owner; remove only this invocation's recovery nonce. Do not recreate the spool or acquire work.

## Alternatives considered

- Recover capabilities from files: valid authority is not persisted and inspection grants none.
- Delete partial files or clear the owner after NONE: destroys uncertainty and mistakes capacity for history.
- Archive individual files across volumes: adds partial copy/delete recovery states without a current requirement.
- Add another inspection-only command: leaves retained-spool disposition unfinished.

## Consequences

Marker-only acquisitions and partial publication can be preserved without inferred authority. A new run requires explicit fresh-spool provisioning. Recovery relies on genuine process exclusion and protected roots; local markers cannot enforce identity exclusion across machines. Metadata checks are not hostile-writer protection. Crashes can leave stale recovery nonces or incomplete containers requiring inspection; rename and the record are not a power-loss-durable transaction.

## Compatibility and migration

Pin contracts 0.21.0 / Native Worker API 2.2.0 without changing baseline raw-result identity. Upgrade all control-plane writers first. Existing presence, heartbeat, run-once, inspection and artifact meaning remain unchanged. No dependency, capability persistence or shared schema is added. Rollback stops recovery commands and retains archives.

## Security and operations

Credentials remain environment-only and scope is principal-bound. Protect archive output and identifiers. Windows mode bits do not replace ACLs. Bound attempts, inventory and depth; reject overlapping roots and links. No force bypass, target execution, artifact deletion, implicit retry or unattended service is introduced. See the [operator guide](../native-worker-manual-recovery.md) for partial-failure handling.

## Measurement and environment limitations

No browser is launched and measurement semantics do not change. Receipt checks prove only local byte integrity. Functional filesystem tests do not qualify a laptop or replace live Windows/control-plane acceptance.

## Validation

Run exact acceptance and focused contract, timestamp, transport, marker-only/partial preservation, terminal/inactive/missing inspection, current-slot, withdrawal, cancellation, concurrency, inventory mutation, overlap and junction tests. Prove live recovery separately in M03 acceptance.
