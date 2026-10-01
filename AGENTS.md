# Repository working agreement

## TL;DR

- Read `CONTRIBUTING.md`; it is the canonical workflow policy.
- Preserve semantic browser timing, environment identity, and cold/warm profile meaning.
- Keep measurements, diagnostics, artifact persistence, and analysis verdicts separate.
- Run the exact checks and report their results honestly.

This file is the concise, tool-facing entry point for contributors and coding
agents. [CONTRIBUTING.md](CONTRIBUTING.md) is the canonical workflow policy.
Normative terms such as MUST, SHOULD and MAY have the meanings defined there.

## Before changing anything

1. You MUST read [CONTRIBUTING.md](CONTRIBUTING.md), especially its ambiguity,
   issue-timing, verification and external-side-effect rules.
2. You MUST inspect the branch and working tree and preserve pre-existing work.
3. You MUST use the [documentation map](docs/README.md) to select the relevant
   engineering standards, public entry points, example configuration,
   diagnostic limitation and accepted ADR. You MUST NOT bulk-read unrelated
   guides merely because they exist.
4. You MUST use repository-local checks and MUST NOT claim an unavailable or
   unexecuted check passed.

If implementation, types, tests, artifact contracts and documented measurement
meaning disagree, you MUST NOT silently pick one. Correct an obvious local
defect or propose a superseding ADR. Ordinary ambiguity follows CONTRIBUTING.

## Repository responsibility

`perfeng-playwright` owns browser journeys, semantic interaction measurement,
browser execution, bounded Chromium diagnostics, raw browser payloads, integrity
receipts, and the distributable native runner. Its native worker adapter may
transfer and register exact runner artifacts through server-issued, lease-scoped
grants. It does not own scheduling, host provisioning, object-store
administration or durable storage policy, normalization, baseline selection or
performance verdicts.

- The browser Performance clock owns measured interaction durations;
  controller timestamps are diagnostic only.
- Environment identity is supplied through a separately captured
  `browser-environment/v1` artifact and is never inferred by this runner.
- Diagnostic traces, heap snapshots and observations remain raw evidence. The
  runner does not diagnose leaks, dropped frames or regressions.
- The intended comparable execution environment is a declared native Windows
  worker representing the chosen laptop profile. Linux CI proves correctness,
  not performance equivalence.

## Shape of work

- Each task and pull request MUST deliver one coherent, independently
  reviewable browser-runner outcome.
- Measurement semantics, diagnostic collectors, dependency/browser updates and
  broad cleanup MUST stay separate unless inseparable for correctness.
- Scope, assumptions, browser/environment requirements, timing effects,
  artifact compatibility, affected consumers and verification evidence MUST be
  explicit.
- Prefer an end-to-end journey-to-artifact path over speculative frameworks or
  unused collectors.

## Browser and implementation rules

- Only exercise targets the operator owns or is authorized to test. Automated
  tests remain loopback-only.
- Preserve semantic start and completion, Performance-clock timing, cold/warm
  lifecycle, cache/context/page reuse, warm-up exclusion and iteration identity.
- Functions passed across a Playwright serialization boundary MUST be
  self-contained; imported helpers and module state do not exist in the page.
- Browser version, Playwright version, platform, architecture, viewport,
  headless mode, diagnostic mode and environment identity remain explicit.
- CDP collectors are Chromium-specific, bounded, cancellation-safe and release
  sessions on success and failure. Preserve data-loss signals.
- Diagnostic evidence is sensitive and stays separate from semantic
  measurements and derived conclusions.
- Artifact output is atomic and exclusive; retries MUST NOT overwrite evidence.

Follow the engineering standards and relevant README sections.

## Quality and documentation

- Test observable browser, lifecycle, serialization, diagnostic and artifact
  behavior at the lowest boundary that proves it. Defect fixes SHOULD begin
  with a failing regression test.
- Tests MUST use deterministic loopback fixtures and MUST NOT assert fixture
  latency as a performance baseline.
- Comments SHOULD explain measurement, browser-lifecycle, security or resource
  constraints and SHOULD NOT narrate syntax or silence lint findings.
- Long documents MUST include the TL;DR required by CONTRIBUTING.
- Types, configuration, examples, tests, exports and documentation change
  together.

## Completion

The canonical required checks and completion-report format are defined in
[CONTRIBUTING.md](CONTRIBUTING.md). Follow them after every work item.
