import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
} from '@playwright/test';

import type { InteractionMeasurement } from './measure-interaction.js';
import { assertMetricName } from './metric-name.js';

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const cacheProfiles = new Set<string>(['cold', 'warm']);
const pageReusePolicies = new Set<string>(['per-iteration', 'per-run']);
const diagnosticModes = new Set<string>(['baseline']);
const workloadProfiles = new Set<WorkloadProfile>([
  'smoke',
  'average',
  'regression',
  'stress',
  'capacity',
  'soak',
]);
const playwrightPackage = createRequire(import.meta.url)(
  '@playwright/test/package.json',
) as {
  version: string;
};

export type CacheProfile = 'cold' | 'warm';
export type PageReuse = 'per-iteration' | 'per-run';
export type DiagnosticMode =
  'baseline' | 'lightweight' | 'trace' | 'memory' | 'smoothness';
export type WorkloadProfile =
  'smoke' | 'average' | 'regression' | 'stress' | 'capacity' | 'soak';

export interface WorkloadIdentity {
  id: string;
  version: string;
  profile: WorkloadProfile;
  sha256: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface EnvironmentIdentity {
  profile: {
    id: string;
    version: string;
  };
  fingerprint: string;
}

export interface RunJourneyOptions {
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  cacheProfile: CacheProfile;
  pageReuse: PageReuse;
  diagnosticMode: DiagnosticMode;
  environment: EnvironmentIdentity;
  warmupIterations: number;
  measurementIterations: number;
  journey: (page: Page) => Promise<InteractionMeasurement[]>;
  headless?: boolean;
  viewport?: Viewport;
  deviceScaleFactor?: number;
}

export interface PlaywrightMeasurement extends InteractionMeasurement {
  iteration: number;
}

export interface PlaywrightMeasurements {
  schemaVersion: 2;
  kind: 'PlaywrightMeasurements';
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  scenario: {
    cacheProfile: CacheProfile;
    contextReuse: 'per-iteration' | 'per-run';
    pageReuse: PageReuse;
    warmupIterations: number;
    measurementIterations: number;
  };
  diagnosticMode: DiagnosticMode;
  environment: EnvironmentIdentity;
  runtime: {
    playwrightVersion: string;
    nodeVersion: string;
    platform: 'linux' | 'darwin' | 'win32';
    architecture: 'x64' | 'arm64';
  };
  browser: {
    name: 'chromium' | 'firefox' | 'webkit';
    version: string;
    headless: boolean;
    viewport: Viewport;
    deviceScaleFactor: number;
  };
  measurementWindow: {
    start: string;
    end: string;
  };
  createdAt: string;
  measurements: PlaywrightMeasurement[];
}

export interface WrittenMeasurementArtifact {
  sha256: string;
  sizeBytes: number;
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${String(minimum)}`,
    );
  }
}

function validateOptions(options: RunJourneyOptions): void {
  if (!runIdPattern.test(options.runId)) {
    throw new Error(`Invalid run ID: ${options.runId}`);
  }
  if (!idPattern.test(options.testId)) {
    throw new Error(`Invalid test ID: ${options.testId}`);
  }
  if (!idPattern.test(options.workload.id)) {
    throw new Error(`Invalid workload ID: ${options.workload.id}`);
  }
  if (!versionPattern.test(options.workload.version)) {
    throw new Error(`Invalid workload version: ${options.workload.version}`);
  }
  if (!sha256Pattern.test(options.workload.sha256)) {
    throw new Error('Invalid workload SHA-256');
  }
  if (!workloadProfiles.has(options.workload.profile)) {
    throw new Error(`Invalid workload profile: ${options.workload.profile}`);
  }
  if (!cacheProfiles.has(options.cacheProfile)) {
    throw new Error(`Invalid cache profile: ${options.cacheProfile}`);
  }
  if (!pageReusePolicies.has(options.pageReuse)) {
    throw new Error(`Invalid page reuse policy: ${options.pageReuse}`);
  }
  if (
    options.cacheProfile === 'cold' &&
    options.pageReuse !== 'per-iteration'
  ) {
    throw new Error('Cold cache profile requires per-iteration page reuse');
  }
  if (!diagnosticModes.has(options.diagnosticMode)) {
    throw new Error(`Unsupported diagnostic mode: ${options.diagnosticMode}`);
  }
  if (!idPattern.test(options.environment.profile.id)) {
    throw new Error(
      `Invalid environment profile ID: ${options.environment.profile.id}`,
    );
  }
  if (!versionPattern.test(options.environment.profile.version)) {
    throw new Error('Invalid environment profile version');
  }
  if (!sha256Pattern.test(options.environment.fingerprint)) {
    throw new Error('Invalid environment fingerprint');
  }
  assertInteger('warmupIterations', options.warmupIterations, 0);
  assertInteger('measurementIterations', options.measurementIterations, 1);
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  assertInteger('viewport.width', viewport.width, 1);
  assertInteger('viewport.height', viewport.height, 1);
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) {
    throw new Error('deviceScaleFactor must be greater than zero');
  }
}

function runtimePlatform(): 'linux' | 'darwin' | 'win32' {
  if (
    process.platform === 'linux' ||
    process.platform === 'darwin' ||
    process.platform === 'win32'
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}

function runtimeArchitecture(): 'x64' | 'arm64' {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return process.arch;
  }
  throw new Error(`Unsupported runtime architecture: ${process.arch}`);
}

function browserName(browser: Browser): 'chromium' | 'firefox' | 'webkit' {
  const name = browser.browserType().name();
  if (name === 'chromium' || name === 'firefox' || name === 'webkit') {
    return name;
  }
  throw new Error(`Unsupported browser: ${name}`);
}

function validateMeasurements(
  measurements: InteractionMeasurement[],
  expectedNames: string[] | undefined,
): { measurements: InteractionMeasurement[]; names: string[] } {
  if (measurements.length === 0) {
    throw new Error('Journey must produce at least one measurement');
  }
  const sorted = [...measurements].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = sorted.map((measurement) => measurement.name);
  for (const measurement of sorted) {
    assertMetricName(measurement.name);
    if (
      !Number.isFinite(measurement.durationMs) ||
      measurement.durationMs < 0
    ) {
      throw new Error(`Invalid duration for metric: ${measurement.name}`);
    }
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Journey produced duplicate metric names in one iteration');
  }
  if (
    expectedNames !== undefined &&
    names.join('\0') !== expectedNames.join('\0')
  ) {
    throw new Error('Journey metric names changed between iterations');
  }
  return { measurements: sorted, names };
}

async function executeInContext(
  context: BrowserContext,
  journey: RunJourneyOptions['journey'],
  expectedNames: string[] | undefined,
): Promise<{ measurements: InteractionMeasurement[]; names: string[] }> {
  const page = await context.newPage();
  try {
    return validateMeasurements(await journey(page), expectedNames);
  } finally {
    await page.close();
  }
}

async function executeOnPage(
  page: Page,
  journey: RunJourneyOptions['journey'],
  expectedNames: string[] | undefined,
): Promise<{ measurements: InteractionMeasurement[]; names: string[] }> {
  return validateMeasurements(await journey(page), expectedNames);
}

async function withNewContext<T>(
  browser: Browser,
  viewport: Viewport,
  deviceScaleFactor: number,
  action: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  try {
    return await action(context);
  } finally {
    await context.close();
  }
}

/** Executes warm-up and measured repetitions and returns a v2 native payload. */
export async function runJourney(
  browserType: BrowserType,
  options: RunJourneyOptions,
): Promise<PlaywrightMeasurements> {
  validateOptions(options);
  const headless = options.headless ?? true;
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  const browser = await browserType.launch({ headless });
  let expectedNames: string[] | undefined;
  const collected: PlaywrightMeasurement[] = [];
  let start: Date;
  let end: Date;

  const execute = async (
    target: BrowserContext | Page,
    iteration?: number,
  ): Promise<void> => {
    const result =
      'newPage' in target
        ? await executeInContext(target, options.journey, expectedNames)
        : await executeOnPage(target, options.journey, expectedNames);
    expectedNames = result.names;
    if (iteration !== undefined) {
      collected.push(
        ...result.measurements.map((measurement) => ({
          ...measurement,
          iteration,
        })),
      );
    }
  };

  try {
    if (options.cacheProfile === 'warm') {
      const context = await browser.newContext({ viewport, deviceScaleFactor });
      try {
        const page =
          options.pageReuse === 'per-run' ? await context.newPage() : undefined;
        try {
          for (let index = 0; index < options.warmupIterations; index += 1) {
            await execute(page ?? context);
          }
          start = new Date();
          for (
            let iteration = 1;
            iteration <= options.measurementIterations;
            iteration += 1
          ) {
            await execute(page ?? context, iteration);
          }
          end = new Date();
        } finally {
          await page?.close();
        }
      } finally {
        await context.close();
      }
    } else {
      for (let index = 0; index < options.warmupIterations; index += 1) {
        await withNewContext(browser, viewport, deviceScaleFactor, execute);
      }
      start = new Date();
      for (
        let iteration = 1;
        iteration <= options.measurementIterations;
        iteration += 1
      ) {
        await withNewContext(browser, viewport, deviceScaleFactor, (context) =>
          execute(context, iteration),
        );
      }
      end = new Date();
    }

    const created = new Date();
    if (start >= end) {
      throw new Error('Measurement window start must precede end');
    }
    if (created < end) {
      throw new Error('Artifact creation must not precede measurement end');
    }

    return {
      schemaVersion: 2,
      kind: 'PlaywrightMeasurements',
      runId: options.runId,
      testId: options.testId,
      workload: { ...options.workload },
      scenario: {
        cacheProfile: options.cacheProfile,
        contextReuse:
          options.cacheProfile === 'warm' ? 'per-run' : 'per-iteration',
        pageReuse: options.pageReuse,
        warmupIterations: options.warmupIterations,
        measurementIterations: options.measurementIterations,
      },
      diagnosticMode: options.diagnosticMode,
      environment: {
        profile: { ...options.environment.profile },
        fingerprint: options.environment.fingerprint,
      },
      runtime: {
        playwrightVersion: playwrightPackage.version,
        nodeVersion: process.versions.node,
        platform: runtimePlatform(),
        architecture: runtimeArchitecture(),
      },
      browser: {
        name: browserName(browser),
        version: browser.version(),
        headless,
        viewport: { ...viewport },
        deviceScaleFactor,
      },
      measurementWindow: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      createdAt: created.toISOString(),
      measurements: collected,
    };
  } finally {
    await browser.close();
  }
}

/** Writes exact artifact bytes once and returns their transport integrity fields. */
export async function writeMeasurementArtifact(
  path: string,
  payload: PlaywrightMeasurements,
): Promise<WrittenMeasurementArtifact> {
  const content = `${JSON.stringify(payload, undefined, 2)}\n`;
  const bytes = Buffer.from(content, 'utf8');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}
