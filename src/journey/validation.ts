import type { RunJourneyOptions, Viewport, WorkloadProfile } from './types.js';

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

export interface EffectiveBrowserOptions {
  headless: boolean;
  viewport: Viewport;
  deviceScaleFactor: number;
}

function assertInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${String(minimum)}`,
    );
  }
}

export function validateRunJourneyOptions(
  options: RunJourneyOptions,
): EffectiveBrowserOptions {
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
  return { headless: options.headless ?? true, viewport, deviceScaleFactor };
}
