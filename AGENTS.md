# Repository agent guide

## Agent skills

Use `mattpocock/skills` as the primary workflow for planning, ticketing,
implementation, TDD, review, and pull requests. The skills take precedence where
contributor guidance covers the same steps. Follow the repository's technical
requirements, CI gates, and authorization boundaries.

### Issue tracker

Use GitHub Issues in `stanimirivanov/perfeng-playwright`. See [issue tracker configuration](docs/agents/issue-tracker.md).

### Triage labels

Use the default Matt Pocock label mapping. See [triage labels](docs/agents/triage-labels.md).

### Domain docs

Single context with a root glossary and ADRs in `docs/adr/`. See [domain docs](docs/agents/domain.md).

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
- The intended comparable execution environment is a declared native Linux
  worker representing the chosen laptop profile. Linux CI proves correctness,
  not performance equivalence.

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
  behavior at the lowest boundary that proves it.
- Tests MUST use deterministic loopback fixtures and MUST NOT assert fixture
  latency as a performance baseline.
- Comments SHOULD explain measurement, browser-lifecycle, security or resource
  constraints and SHOULD NOT narrate syntax or silence lint findings.
- Long documents MUST include the TL;DR required by CONTRIBUTING.
- Types, configuration, examples, tests, exports and documentation change
  together.

## Verification

Run `make verify` and the applicable additional checks documented in
[CONTRIBUTING.md](CONTRIBUTING.md#verification-and-constrained-environments).
Use the [documentation map](docs/README.md) to find affected standards, operational
guides and decisions. Report checks as passed, failed or unavailable.
