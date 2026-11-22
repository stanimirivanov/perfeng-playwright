# ADR-0007: Inspect retained Native Worker attempts without resuming

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Provide a local, read-only inventory of the Native Worker attempt spool.
- A retained directory or foreign path is evidence for operator review, not proof of a resumable lease.
- Never deserialize a lease capability from disk, infer a terminal outcome from filenames or remove evidence automatically.
- Keep work acquisition and availability disabled until the complete recovery and single-worker policy is reviewed.

## Context

The v2 attempt coordinator preserves local files after interruption or uncertain terminal reporting.
The lease capability is intentionally process-private, and the protocol has no endpoint to resume an
expired or interrupted lease from local evidence. The current CLI reports `UNAVAILABLE`. Operators
need a way to see retained state before the acquisition loop is introduced, without accidentally
claiming that a file is valid, that publication committed, or that server authority remains.

## Decision

Add a local `spool-status --spool-root DIRECTORY` command. It requires an absolute, existing,
non-symlink directory and reports only immediate entry names and immediate filenames within
attempt-shaped directories. It does not read artifact contents, contact a target, or mutate paths.
Unexpected root entries remain visible as unexpected rather than being skipped. Any retained entry
sets `hasRetainedState` to true. The result is a point-in-time operator inventory, not a concurrent
acquisition lock, a complete integrity check or a recovery instruction.

The command requires no worker token because it performs no server request. The local operator
must control filesystem access and treat paths as potentially sensitive. Cleanup, exact-evidence
retry, ambiguous terminal resolution, server-state reconciliation and single-worker exclusion are
deferred. No state is automatically resumed or deleted.

## Alternatives considered

### Reconstruct and resume the lease from retained files

- Benefits: Could continue partial publication automatically.
- Costs and risks: No durable capability or authoritative current revision is available after restart.
- Reason not selected: It would turn disk presence into unproven server authority.

### Delete incomplete attempt directories at startup

- Benefits: Avoids spool accumulation.
- Costs and risks: Destroys evidence of failed or ambiguous publication and may hide an active old process.
- Reason not selected: Operator review and explicit retention policy are required first.

## Consequences

### Positive

- Operators can distinguish an empty spool from retained or unexpected paths before future rollout.
- No token, artifact bytes or remote state are exposed by the inspection command.

### Negative

- Names themselves can contain operational identifiers and require protected local logs.
- A snapshot cannot prove another process will not create an attempt immediately afterward.

### Neutral or follow-up

- The CLI still reports `UNAVAILABLE`; acquisition and recovery remain separate work.

## Compatibility and migration

The command adds an optional CLI action and a local JSON inspection shape. It does not change wire
contracts, measurement artifacts, terminal semantics, existing attempts or presence behavior.

## Security and operations

Use an operator-owned spool with appropriate Windows ACLs. Do not paste spool output into public
issues if Run or attempt identifiers are sensitive. The command never removes files or exercises a
non-loopback target. A symlink or malformed root is rejected.

## Measurement and environment limitations

Spool inspection does not measure browser performance or qualify a Windows environment. Neither
an empty spool nor a list of filenames proves that local files match their receipt or the server's
attempt state.

## Validation

Deterministic filesystem tests cover empty, partial and unexpected state, unchanged files,
invalid roots and the token-free CLI path. They do not exercise live lease recovery.
