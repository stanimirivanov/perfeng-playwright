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
- `src/trace`: bounded Chromium CDP performance-trace capture and stream handling.

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

`baseline`, `lightweight`, and `trace` modes are executable. Memory and
smoothness still fail before the browser starts; those modes remain unavailable
until their collectors implement the required evidence contracts. The
environment profile and fingerprint identify a separately captured
`browser-environment/v1` artifact. This runner validates that identity but does
not invent or probe host characteristics.

## Lightweight page observations

`startPageObservation` and `finishPageObservation` provide an opt-in raw
`browser-page-observation/v1` capture around owned browser work. The observer
records navigation and paint timings, LCP, layout shifts without recent input,
long tasks, event timing, resource totals, JavaScript heap counters when the
browser exposes them, and animation-frame intervals. Unsupported browser APIs
remain explicit through `supportedEntryTypes` and nullable fields.

In `lightweight` mode the journey executor captures one observation for every
measured iteration. Warm-up activity is excluded. The CLI requires a separate
`--observations-output` path and writes a `BrowserObservations` sidecar so
diagnostic evidence is never embedded in the semantic measurement payload.

Frame intervals over 50 ms are observations, not a claim that an exact number
of frames was dropped. Resource timing also cannot identify every failed
request or HTTP status. Network-event and precise rendering diagnosis remain
CDP responsibilities.

## CDP performance trace capture

`capturePerformanceTrace` captures one owned action through a Chromium
`CDPSession`. It requests the DevTools timeline, frame, loading, scheduler,
User Timing, and V8 execution categories and returns Chrome's raw JSON trace as
gzip bytes. The result preserves Chrome's `dataLossOccurred` signal instead of
assuming that a completed stream contains all events.

Trace transfer is streamed from Chrome in bounded chunks. The default output
limit is 128 MiB and callers may select a smaller limit or raise it to at most
512 MiB. Trace completion has a bounded timeout, and the collector releases the
CDP session after successful captures, action failures, and output failures.

Chrome traces are sensitive even though this preset does not request
screenshots. They may contain URLs, script locations, function names, and User
Timing values.

Runner `trace` mode requires `diagnostics.captureIterations` to contain exactly
one measured iteration. The selected journey is traced from its start through
semantic completion; warm-ups and other measured iterations are not traced.
The measurement payload remains separate from the raw gzip trace. Its integrity
receipt includes the selected iteration, trace format, media type, capture
window, and `dataLossOccurred` value so the surrounding platform can construct
the later `browser-diagnostics/v1` manifest without guessing.

`writeMeasurementArtifact` writes one payload as deterministic UTF-8 JSON.
`writeJourneyArtifacts` reserves all requested destinations before writing the
measurement and diagnostic payloads, and removes only outputs it created if
the operation fails. Both return SHA-256 and byte-count integrity fields for
`raw-result/v1` references. Existing paths are never overwritten. Upload and
manifest registration remain storage and control-plane responsibilities.

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

For lightweight capture, set `diagnosticMode` to `lightweight` and provide both
immutable destinations:

```sh
pnpm run run -- run --config examples/search-run.json --output results/playwright-measurements.json --observations-output results/browser-observations.json
```

For a selected Chromium performance trace, use the trace configuration and a
separate gzip destination:

```sh
pnpm run run -- run --config examples/search-trace-run.json --output results/playwright-measurements.json --trace-output results/chrome-trace.json.gz
```

The v2 configuration is a closed, versioned JSON object. The target must be an
absolute HTTP or HTTPS URL without embedded credentials, query parameters, or
fragments. Put authentication in a future credential adapter, never in this
file. Output paths must be distinct and must not already exist. On success the
CLI prints a JSON integrity receipt for the measurements and requested
diagnostic evidence. Logs, the `browser-diagnostics/v1` manifest, upload, and
artifact registration remain the caller's responsibility.

The included search page is a deterministic test fixture for the timing
library and journey executor, not a production benchmark or claimed latency
baseline. The runner container remains a separate implementation step.

## Prototype boundary

The original `tests/playwright` directory contained generated Nx configuration
and one placeholder title assertion. This repository does not retain Nx or the
placeholder because neither defines useful performance behavior. The initial
commit in this repository remains its history boundary; no orchestration or
monorepo configuration is copied here.
