# perfeng-playwright

Standalone Playwright performance runner and browser-side semantic timing
library. This repository owns browser journeys, browser execution, and raw
browser measurements. Scheduling, run lifecycle, artifact storage,
normalization, and performance verdicts belong to their respective platform
components.

Implementation is organized by responsibility:

- `src/interaction`: semantic interaction contracts, validation, and timing strategies;
- `src/configuration`: closed input parsing and configuration section validation;
- `src/journey`: generic repetition, browser lifecycle, payload, and artifact mechanics;
- `src/journeys`: concrete repository-owned browser journeys;
- `src/observation`: page-observation state, browser installation, and snapshot projection.

The short files at the `src` root are package entry points, command and
configuration adapters, or compatibility façades. Implementation modules depend
on domain types directly instead of importing through those façades.

## Development

Use Node.js 24.18.0 and the pinned pnpm version. Install the Chromium build
managed by the pinned Playwright package, then run the complete validation:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm validate
```

Validation checks formatting, linting, strict TypeScript compilation, the
distributable library build, and browser behavior. Failed browser tests retain
traces, screenshots, and video in ignored local output directories; CI uploads
that evidence only when validation fails.

## Semantic measurements

`measureInteraction` returns a metric name and duration compatible with the
`playwright-measurements-json` raw payload. Both strategies use the browser's
high-resolution Performance clock:

- `instrumented` reads a named `PerformanceMeasure` emitted from
  application-owned semantic start and completion marks.
- `black-box` records a browser DOM event, observes a semantic completion
  element, verifies visibility, and waits for a configured number of animation
  frames before completing.

Black-box measurement rejects completion elements that were already visible
before the interaction. This avoids recording stale UI as successful work.
Application-assisted instrumentation remains preferred when the application can
identify the true semantic completion point. Both initial strategies are scoped
to one document; journeys that navigate must establish timing in the destination
application rather than treating controller or navigation latency as a browser
semantic measure.

`runJourney` executes warm-up and measurement repetitions with explicit cache,
context, and page-lifetime semantics. Warm profiles reuse one browser context;
cold profiles create one context and page per iteration. Warm profiles may
either create a page per iteration or reuse one page for stateful SPA journeys.
It records the pinned Playwright runtime, actual browser version, platform,
architecture, viewport, headless mode, diagnostic mode, and caller-provided
environment identity in a `playwright-measurements/v2` payload. Warm-up
observations are validated and discarded. Every measured metric must occur
exactly once per iteration.

Only `baseline` diagnostic mode is executable in this release. Configurations
requesting lightweight, trace, memory, or smoothness capture fail before the
browser starts; later collectors must implement their evidence contracts before
those modes can be accepted. The environment profile and fingerprint identify
a separately captured `browser-environment/v1` artifact. This runner validates
that identity but does not invent or probe host characteristics.

## Lightweight page observations

`startPageObservation` and `finishPageObservation` provide an opt-in raw
`browser-page-observation/v1` capture around owned browser work. The observer
records navigation and paint timings, LCP, layout shifts without recent input,
long tasks, event timing, resource totals, JavaScript heap counters when the
browser exposes them, and animation-frame intervals. Unsupported browser APIs
remain explicit through `supportedEntryTypes` and nullable fields.

Frame intervals over 50 ms are observations, not a claim that an exact number
of frames was dropped. Resource timing also cannot identify every failed
request or HTTP status. Network-event and precise rendering diagnosis remain
CDP responsibilities. These observations are not yet wired to the runner's
`lightweight` mode or artifact output; that boundary remains disabled until the
runner can preserve the evidence independently from baseline measurements.

`writeMeasurementArtifact` writes the payload once as deterministic UTF-8 JSON
and returns its SHA-256 and byte count for a `raw-result/v1` reference. Existing
paths are never overwritten. Upload and manifest registration remain storage
and control-plane responsibilities.

## Run the search journey

Build the CLI, start an authorized target, and supply an explicit run
configuration. The checked-in example targets the local development fixture;
replace its identity and target fields for an actual run.

Start the fixture in a separate terminal for the example command:

```sh
node tests/fixture-server.mjs
```

```sh
pnpm build
pnpm run run -- run --config examples/search-run.json --output results/playwright-measurements.json
```

The v2 configuration is a closed, versioned JSON object. The target must be an
absolute HTTP or HTTPS URL without embedded credentials, query parameters, or
fragments. Put authentication in a future credential adapter, never in this
file. The output path must not already exist. On success the CLI prints only a
JSON integrity receipt containing `sha256` and `sizeBytes`; logs and artifact
registration remain the caller's responsibility.

The included search page is a deterministic test fixture for the timing
library and journey executor, not a production benchmark or claimed latency
baseline. The runner container remains a separate implementation step.

## Prototype boundary

The original `tests/playwright` directory contained generated Nx configuration
and one placeholder title assertion. This repository does not retain Nx or the
placeholder because neither defines useful performance behavior. The initial
commit in this repository remains its history boundary; no orchestration or
monorepo configuration is copied here.
