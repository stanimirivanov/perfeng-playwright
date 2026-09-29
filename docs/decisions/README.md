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
