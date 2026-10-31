import {
  exactKeys,
  record,
  requiredString,
} from '../configuration/primitives.js';
import {
  parseBrowser,
  parseEnvironment,
  parseScenario,
  parseWorkload,
} from '../configuration/sections.js';
import { validateMeasurementSet } from '../journey/measurement-set.js';
import type {
  PlaywrightMeasurement,
  PlaywrightMeasurements,
} from '../journey/types.js';
import {
  boundedInteger,
  contractTimestamp,
  patternString,
} from './contract-values.js';
import {
  maximumNativeMeasurementDocumentBytes,
  type NativeExecutionRecipe,
} from './execution-recipe.js';
import { validateV2MeasurementIdentity } from './measurement-identity.js';

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Parses the bounded runner payload and checks its complete v2 baseline recipe. */
export function parseNativeV2Measurements(
  bytes: Buffer,
  recipe: NativeExecutionRecipe,
): PlaywrightMeasurements {
  const maximumBytes = Math.min(
    recipe.artifactPlan[0].maximumBytes,
    maximumNativeMeasurementDocumentBytes,
  );
  if (bytes.length < 1 || bytes.length > maximumBytes) {
    throw new Error('Native measurements exceed the local parsing bound');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error('Native measurements are not valid UTF-8 JSON');
  }
  const document = record(decoded, 'native measurements');
  exactKeys(document, 'native measurements', [
    'schemaVersion',
    'kind',
    'runId',
    'testId',
    'workload',
    'scenario',
    'diagnosticMode',
    'environment',
    'runtime',
    'browser',
    'measurementWindow',
    'createdAt',
    'measurements',
  ]);
  if (
    document.schemaVersion !== 2 ||
    document.kind !== 'PlaywrightMeasurements' ||
    document.diagnosticMode !== 'baseline'
  ) {
    throw new Error('Native measurements are not a v2 baseline payload');
  }
  const scenario = record(document.scenario, 'native measurements scenario');
  exactKeys(scenario, 'native measurements scenario', [
    'cacheProfile',
    'contextReuse',
    'pageReuse',
    'warmupIterations',
    'measurementIterations',
  ]);
  if (
    scenario.contextReuse !== 'per-iteration' &&
    scenario.contextReuse !== 'per-run'
  ) {
    throw new Error('Native measurements context reuse is invalid');
  }
  const browser = record(document.browser, 'native measurements browser');
  exactKeys(browser, 'native measurements browser', [
    'name',
    'version',
    'headless',
    'viewport',
    'deviceScaleFactor',
  ]);
  if (browser.name !== 'chromium') {
    throw new Error('Native measurements require Chromium');
  }
  const runtime = record(document.runtime, 'native measurements runtime');
  exactKeys(runtime, 'native measurements runtime', [
    'playwrightVersion',
    'nodeVersion',
    'platform',
    'architecture',
  ]);
  if (
    runtime.platform !== 'linux' ||
    (runtime.architecture !== 'x64' && runtime.architecture !== 'arm64')
  ) {
    throw new Error('Native measurements require a supported Linux runtime');
  }
  const window = record(
    document.measurementWindow,
    'native measurement window',
  );
  exactKeys(window, 'native measurement window', ['start', 'end']);
  const rawMetrics = document.measurements;
  if (!Array.isArray(rawMetrics)) {
    throw new Error('Native measurements must contain an array');
  }
  const iterationCount = recipe.configuration.scenario.measurementIterations;
  const metrics = parseMetrics(rawMetrics as unknown[], iterationCount);
  const measurements: PlaywrightMeasurements = {
    schemaVersion: 2,
    kind: 'PlaywrightMeasurements',
    runId: requiredString(document.runId, 'runId'),
    testId: requiredString(document.testId, 'testId'),
    workload: parseWorkload(document.workload),
    scenario: {
      ...parseScenario({
        cacheProfile: scenario.cacheProfile,
        pageReuse: scenario.pageReuse,
        warmupIterations: scenario.warmupIterations,
        measurementIterations: scenario.measurementIterations,
      }),
      contextReuse: scenario.contextReuse,
    },
    diagnosticMode: 'baseline',
    environment: parseEnvironment(document.environment),
    runtime: {
      playwrightVersion: patternString(
        runtime.playwrightVersion,
        'playwrightVersion',
        versionPattern,
      ),
      nodeVersion: patternString(
        runtime.nodeVersion,
        'nodeVersion',
        versionPattern,
      ),
      platform: 'linux',
      architecture: runtime.architecture,
    },
    browser: {
      ...parseBrowser({
        headless: browser.headless,
        viewport: browser.viewport,
        deviceScaleFactor: browser.deviceScaleFactor,
      }),
      name: 'chromium',
      version: requiredString(browser.version, 'browser.version'),
    },
    measurementWindow: {
      start: contractTimestamp(window.start, 'measurementWindow.start'),
      end: contractTimestamp(window.end, 'measurementWindow.end'),
    },
    createdAt: contractTimestamp(document.createdAt, 'createdAt'),
    measurements: metrics,
  };
  validateV2MeasurementIdentity(recipe, measurements);
  validateLeaseWindow(recipe, measurements);
  return measurements;
}

function parseMetrics(
  raw: unknown[],
  iterationCount: number,
): PlaywrightMeasurement[] {
  const byIteration = new Map<number, PlaywrightMeasurement[]>();
  const measurements: PlaywrightMeasurement[] = [];
  for (const [index, value] of raw.entries()) {
    const metric = record(value, `measurements[${String(index)}]`);
    exactKeys(metric, `measurements[${String(index)}]`, [
      'iteration',
      'name',
      'durationMs',
    ]);
    const iteration = boundedInteger(
      metric.iteration,
      'iteration',
      1,
      iterationCount,
    );
    const duration = metric.durationMs;
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      throw new Error('Native measurement duration is invalid');
    }
    const parsed = {
      iteration,
      name: requiredString(metric.name, 'metric name'),
      durationMs: duration,
    };
    measurements.push(parsed);
    const group = byIteration.get(iteration) ?? [];
    group.push(parsed);
    byIteration.set(iteration, group);
  }
  let expectedNames: string[] | undefined;
  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    const group = byIteration.get(iteration) ?? [];
    expectedNames = validateMeasurementSet(group, expectedNames).names;
  }
  return measurements;
}

function validateLeaseWindow(
  recipe: NativeExecutionRecipe,
  measurements: PlaywrightMeasurements,
): void {
  const start = Date.parse(measurements.measurementWindow.start);
  const end = Date.parse(measurements.measurementWindow.end);
  const created = Date.parse(measurements.createdAt);
  if (
    start < Date.parse(recipe.issuedAt) ||
    start >= end ||
    end > created ||
    created > Date.parse(recipe.expiresAt)
  ) {
    throw new Error('Native measurement timeline is outside its lease');
  }
}
