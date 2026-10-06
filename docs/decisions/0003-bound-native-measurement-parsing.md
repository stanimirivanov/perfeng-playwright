# ADR-0003: Bound Native Worker measurement parsing

- Status: Proposed
- Date: 2026-10-06
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Accept Native Worker v2 measurement plans only up to 32 MiB, and reject larger plans before execution.
- Verify committed bytes, parse the complete payload, and check its recipe and lease identity before publication.
- Keep the versioned contract's 512 MiB ceiling unchanged; this is a narrower worker capability.

## Context

The v2 contract allows an artifact-plan ceiling up to 512 MiB. The local worker's baseline measurement
payload is JSON, and semantic validation currently requires loading and parsing the complete document.
Treating a 512 MiB payload as a normal in-memory document risks excessive process memory use on the
reference Windows laptop. Receipt and hash verification alone cannot establish measurement meaning.

## Decision

The worker accepts a v2 lease only when its measurements slot permits no more than 32 MiB. It applies
the same local bound when reading and parsing the committed file. The manifest slot retains the
contract's existing bound. The parser requires strict UTF-8 JSON, the closed v2 baseline structure,
complete metric sets for every assigned iteration, matching assignment identity and environment,
supported Windows Chromium runtime, and a measurement timeline inside the lease. The loader compares
the exact read bytes with the previously verified receipt hash and size before returning publication
inputs. It does not publish, register, or report completion.

## Alternatives considered

### Parse up to the contract's 512 MiB ceiling

- Benefits: Every contract-valid artifact plan is locally accepted.
- Costs and risks: High memory use and possible process failure on the reference laptop.
- Reason not selected: The worker has no streaming semantic validator or established memory budget.

### Accept larger plans, but reject only when the produced file exceeds 32 MiB

- Benefits: Small results from a larger plan could still pass.
- Costs and risks: A run could finish and then fail publication despite a valid assigned plan.
- Reason not selected: An explicit early capability failure is more predictable.

## Consequences

### Positive

- The worker has a bounded local JSON parse and a fail-closed pre-execution plan check.
- Semantic validation no longer relies solely on the receipt's integrity assertion.

### Negative

- A contract-valid lease with a measurement ceiling above 32 MiB is incompatible with this worker.
- The loader currently reads the file twice, trading additional I/O for a check against file changes.

### Neutral or follow-up

- Reconsider the ceiling using measured peak memory and realistic workload outputs, or implement a
  streaming validator before increasing it.

## Compatibility and migration

No contract or server schema changes. Control-plane artifact plans for this worker must set the
measurements ceiling at or below 32 MiB. The worker remains `UNAVAILABLE`; this ADR does not enable
lease acquisition in the CLI. Larger plans are rejected by the local recipe parser before attempt
preparation.

## Security and operations

The loader rejects symlinked, missing, changing, oversized, malformed, and identity-mismatched local
evidence without contacting the control plane. A matching receipt is not cryptographic attestation
of an untrusted local writer; the control plane remains authoritative for registered evidence.

## Measurement and environment limitations

The payload's Windows runtime claim and assigned environment identity are checked, but the JSON alone
cannot prove the physical host, browser installation, or process provenance. Qualification and runner
process supervision remain separate boundaries.

## Validation

Unit tests cover the plan bound, valid parsing, malformed and foreign payloads, incomplete metric sets,
invalid timing and runtime, and loading committed local evidence. Representative Windows runs should
measure output size and worker peak memory before the ceiling is accepted as operationally sufficient.
