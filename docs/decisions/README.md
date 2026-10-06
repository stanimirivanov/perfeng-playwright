# Architecture decision records

## TL;DR

- Use an ADR for durable decisions affecting measurement meaning, environment comparability,
  diagnostics, compatibility, security, ownership or cross-component behavior.
- Number ADRs sequentially and never reuse a number.
- Allocate from fresh repository state and renumber concurrent collisions.
- Accepted ADRs are historical records; supersede rather than rewrite them.
- Record alternatives, consequences, measurement limitations and validation.

## When an ADR is required

Create an ADR when a decision materially affects semantic timing, cold/warm lifecycle, reference
environment, diagnostic capture or interpretation, public compatibility, artifact contracts,
security or privacy, repository ownership, foundational technology, packaging topology or
cross-component behavior. Cheap local implementation choices do not need one.

## Naming and lifecycle

Use a four-digit sequence and short kebab-case name:

```text
0001-select-native-windows-reference-worker.md
```

Statuses are Proposed, Accepted, Rejected, Deprecated or Superseded. Add every ADR to the index and
do not rewrite accepted decisions or consequences.

Immediately before creating an ADR, refresh the branch as the workflow allows and inspect this
index and directory. Allocate the lowest unused number. If concurrent work collides, rename the
later ADR to the next available number and update its title, index and references. Published numbers
remain immutable.

## Template

```markdown
# ADR-NNNN: Decision title

- Status: Proposed
- Date: YYYY-MM-DD
- Milestone: MNN — Outcome
- Deciders:
- Supersedes:
- Superseded by:

## Context

What forces a decision now? Include measurement, environment and compatibility constraints.

## Decision

State the decision and scope precisely.

## Alternatives considered

### Alternative

- Benefits:
- Costs and risks:
- Reason not selected:

## Consequences

### Positive

### Negative

### Neutral or follow-up

## Compatibility and migration

## Security and operations

## Measurement and environment limitations

## Validation

How will assumptions and consequences be verified?
```

## Index

- [ADR-0001: Publish artifacts with receipt-last commitment](0001-publish-artifacts-with-receipt-last-commitment.md)
  — Accepted
- [ADR-0002: Select Native Worker presence generation explicitly](0002-select-native-worker-presence-generation-explicitly.md)
  — Accepted
- [ADR-0003: Bound Native Worker measurement parsing](0003-bound-native-measurement-parsing.md)
  — Proposed
- [ADR-0004: Fail closed on Native Worker lease-supervision failure](0004-fail-closed-native-lease-supervision.md)
  — Proposed
- [ADR-0005: Report Native Worker terminal outcomes within lease supervision](0005-report-native-attempt-terminal-within-lease-supervision.md)
  — Proposed
- [ADR-0006: Release stopped Native Worker attempts within proven authority](0006-release-stopped-native-attempts-within-proven-authority.md)
  — Proposed
- [ADR-0007: Inspect retained Native Worker attempts without resuming](0007-inspect-retained-native-attempts-without-resuming.md)
  — Proposed
- [ADR-0008: Retry exact Native Worker terminal claims once](0008-retry-exact-native-terminal-claims-once.md)
  — Proposed
- [ADR-0009: Retry exact Native Worker artifact registration once](0009-retry-exact-native-artifact-registration-once.md)
  — Proposed
- [ADR-0010: Retry exact Native Worker upload grant once](0010-retry-exact-native-upload-grant-once.md)
  — Proposed
