# Browser-runner engineering standards

## TL;DR

- Measure semantic interactions with the browser Performance clock, not controller time.
- Keep cold/warm lifecycle, environment identity and browser/runtime versions explicit.
- Treat Linux CI as functional verification; comparable measurements come from the declared native
  Windows reference worker.
- Keep lightweight observations, traces, heap snapshots and smoothness evidence separate from
  semantic measurements and verdicts.
- Bound diagnostic time, memory and output, preserve partial/data-loss signals, and release CDP
  sessions on every path.
- Publish artifacts atomically and exclusively with exact integrity receipts.

## Policy strength

Normative terms use the meanings in
[CONTRIBUTING.md](../../CONTRIBUTING.md#policy-language-and-sources-of-truth). MUST and MUST NOT are
requirements; SHOULD and SHOULD NOT are strong defaults requiring a recorded reason to deviate; MAY
is optional.

## Architecture and ownership

Organize around configuration, semantic interaction timing, journey orchestration, browser
execution, bounded observation/diagnostics, artifact persistence and public package entry points.
The module model and dependency direction are defined in the
[browser-runner architecture](architecture.md).

- Interaction modules define semantic start/completion and return raw named durations.
- Journey orchestration owns repetitions and lifecycle but does not redefine interaction timing.
- Browser execution owns Playwright browser/context/page resources and deterministic cleanup.
- Observation, trace, memory and smoothness modules collect bounded raw evidence. They do not infer
  performance diagnoses.
- Artifact modules serialize exact payloads, reserve destinations and return integrity fields. They
  do not upload or register artifacts. The separate native-worker adapter may transfer and register
  those exact bytes only through lease-scoped server-issued grants.
- Root modules are public/compatibility façades and CLI/configuration adapters. Implementation
  modules depend on responsibility-focused modules, not back through façades.
- Scheduling, environment provisioning, storage, normalization, baselines and verdicts remain in
  their owning components.

Use SOLID and patterns as reasoning tools, not quotas. Prefer cohesive modules, explicit lifecycle
ownership, immutable configuration and direct data flow over generic managers, service locators or
speculative collector abstractions.

## Measurement semantics

- Use the browser's monotonic high-resolution Performance clock for authoritative interaction
  duration. Controller-side time is diagnostic only.
- Define semantic start and completion in terms of user-visible/application-owned behavior.
  Network idle, arbitrary sleeps and selector presence alone are not semantic completion.
- Instrumented measurement reads an application-owned `PerformanceMeasure`; black-box measurement
  observes a declared event and a newly visible completion element plus explicit animation frames.
- Reject stale completion state that existed before the interaction.
- One measured metric occurs exactly once per declared measured iteration. Missing, duplicate or
  non-finite values invalidate the payload.
- Warm-up observations are validated but excluded from measurement output.
- Cold and warm profiles are distinct experiments. Preserve cache, context and page-lifetime
  semantics; do not compare them as interchangeable samples.
- Navigation-spanning journeys require timing established in the destination application. Do not
  silently substitute controller or navigation duration.
- Fixture latency is not a benchmark and MUST NOT become an asserted baseline.

## Environment and comparability

- Record exact Playwright runtime, actual browser version, operating system, architecture, viewport,
  headless mode, diagnostic mode and environment-profile identity.
- Bind measurements to a separately captured `browser-environment/v1` artifact. The runner validates
  supplied identity but does not invent host characteristics.
- The reference execution model is a native Windows worker configured to represent the chosen
  average laptop profile. Hardware, power plan, display/refresh configuration, browser channel,
  background load and worker version belong in that environment artifact or provisioning policy.
- Linux CI proves deterministic functional behavior and packaging. It does not demonstrate Windows
  timing equivalence or authorize cross-environment baseline comparison.
- Browser, Playwright, Node, OS/driver or worker-image updates are measurement-environment changes
  and require explicit review, environment-version advancement and baseline policy consideration.
- Do not run comparable benchmarks concurrently on a shared worker unless the environment contract
  explicitly allows and records that contention.

## Configuration and TypeScript design

- Use the Node and pnpm versions declared in repository metadata and exact dependencies from
  `pnpm-lock.yaml`.
- Keep strict TypeScript enabled. Normalize `unknown` input at closed configuration boundaries and
  avoid spreading unchecked values into domain code.
- Reject unknown configuration properties, embedded URL credentials, queries/fragments where
  prohibited, duplicate outputs, unsupported mode combinations and unsafe numeric/resource limits.
- Prefer discriminated unions for diagnostic modes and lifecycle combinations whose valid fields
  differ. Make impossible states unrepresentable where practical.
- Use dependency injection only for meaningful browser/time/filesystem seams, not as a default
  abstraction layer.
- Preserve errors and causes. Cleanup failures must not silently replace the primary action/capture
  failure without retaining both facts.
- Public exports, declaration output, compatibility façades and CLI behavior are compatibility
  boundaries.

## Browser serialization and lifecycle

- Functions passed to `page.evaluate`, `page.addInitScript` or equivalent serialization boundaries
  MUST be self-contained. Imported runtime helpers, closures over module state and Node globals are
  unavailable in the browser execution realm.
- Distinguish Node/controller values from page-realm values and validate data crossing the boundary.
- Make browser, context, page and CDP-session ownership explicit. The owner closes resources on
  success, action failure, timeout and output failure.
- Bound navigation, semantic completion, frame stabilization, CDP completion and stream reads.
- Do not use unbounded retries or sleeps to hide readiness races.
- Preserve the original action error when cleanup also fails and expose cleanup diagnostics safely.

## Diagnostics and sensitive evidence

- Lightweight observation, performance trace, memory comparison and smoothness trace are opt-in
  modes with separate payloads and immutable destinations.
- Trace categories are explicit, reviewed presets. Expanding categories may change overhead,
  sensitivity and output bounds and is a behavioral change.
- Preserve Chrome's `dataLossOccurred` and other completeness signals. A completed stream is not
  necessarily complete evidence.
- Stream trace and heap-snapshot data into bounded output. Enforce minimum/maximum configuration and
  timeouts before allocating or capturing.
- Heap snapshots, traces and observations may contain URLs, script/function names, DOM text,
  application values and User Timing data. Treat them as sensitive artifacts.
- A before/after heap increase is not a memory-leak verdict. A long frame interval is not an exact
  dropped-frame count. Raw collectors MUST NOT overstate these conclusions.
- Diagnostics can perturb the measured system. Baseline timing and diagnostic runs remain separate
  unless an explicit methodology justifies combined capture.
- Avoid invasive Chrome leak-preparation or cache/worker destruction unless a separate reviewed mode
  documents the changed experiment.

## Artifact and filesystem safety

- Treat configuration, URLs, output paths, browser payloads and checkout metadata as untrusted
  input.
- Reserve every requested destination before writing a multi-artifact result.
- Write deterministic bytes and publish atomically and exclusively. Existing outputs are never
  overwritten, and failed operations remove only files they created.
- Keep semantic measurements, diagnostic sidecars and integrity receipts separate.
- Integrity receipts bind run/test identity, capture metadata, exact checksums, byte counts,
  timestamps, selected iterations and native source provenance.
- Verify the source checkout before and after execution when producing native-runner provenance.
  Refuse publication if tracked source or the lockfile changes during the run.
- Upload, durable storage, manifest construction and artifact registration remain caller
  responsibilities.
- Never log credentials, full sensitive payloads, heap content or trace content.

## Formatting, testing and packaging

- Prettier owns formatting; ESLint and strict TypeScript checks remain fail-closed. Do not add
  suppression comments merely to silence findings.
- Browser tests use the repository's deterministic loopback server, one worker, no retries and
  retained failure evidence.
- Test semantic success and stale/missing completion, lifecycle modes, invalid configurations,
  serialization, timeouts, partial/data-loss evidence, resource cleanup, size limits, output
  collision and rollback.
- Defect fixes SHOULD begin with a failing regression test.
- Tests MUST be isolated from external targets, credentials, user browser profiles and machine
  state. Wall-clock/browser scheduling may be asserted only with tolerant functional invariants,
  never as benchmark values.
- `pnpm build` must produce only the intended library/CLI declarations and JavaScript. Generated
  `dist`, Playwright reports, test results and captured artifacts remain ignored.
- Changes to root exports or compatibility façades require package-consumer tests and documented
  migration where applicable.

## Documentation and dependencies

- Document semantic start/completion, lifecycle, environment requirements, diagnostic overhead and
  sensitivity, output contracts, limitations and caller responsibilities.
- Comments explain timing, lifecycle, serialization, security and resource constraints, not syntax.
- TSDoc is required for functions, classes, interfaces and type aliases exposed through
  `src/index.ts`, `src/cli.ts` or `src/worker-cli.ts`. Put the comment on the owning declaration so
  emitted declarations retain it; a re-export comment is not a substitute.
- Public TSDoc states the contract, ownership, side effects, failure or cancellation behavior when
  those facts matter. It MUST NOT restate names or add placeholder parameter and return prose.
- An export used only for composition or tests inside a feature folder is not automatically a
  supported API. Document internal declarations only when their non-obvious constraints need to
  survive refactoring.
- `pnpm docs:check` uses the pinned TypeDoc version and MUST remain fail-closed for missing or invalid
  documentation on the configured boundary. Generated documentation is not committed.
- Long documents follow the TL;DR policy in CONTRIBUTING.
- Dependency and browser updates require a current need, compatible license, maintained release,
  exact lock, security review, release-note review and isolated validation. Do not combine them with
  application-performance conclusions.

## Required verification

Install exact dependencies and the pinned Chromium build, then run the exact checks in CONTRIBUTING.
Changes affecting native Windows execution also require focused verification on the declared worker;
Linux CI remains necessary but is not a substitute for environment-specific acceptance.
