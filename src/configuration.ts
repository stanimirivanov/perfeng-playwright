import { readFile } from 'node:fs/promises';

import type {
  CacheProfile,
  DiagnosticMode,
  EnvironmentIdentity,
  PageReuse,
  Viewport,
  WorkloadIdentity,
  WorkloadProfile,
} from './run-journey.js';

const maximumConfigurationBytes = 64 * 1024;
const workloadProfiles = new Set<string>([
  'smoke',
  'average',
  'regression',
  'stress',
  'capacity',
  'soak',
]);
const cacheProfiles = new Set<string>(['cold', 'warm']);
const pageReusePolicies = new Set<string>(['per-iteration', 'per-run']);
const diagnosticModes = new Set<string>(['baseline']);

export interface RunnerConfiguration {
  schemaVersion: 2;
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  scenario: {
    cacheProfile: CacheProfile;
    pageReuse: PageReuse;
    warmupIterations: number;
    measurementIterations: number;
  };
  diagnosticMode: DiagnosticMode;
  environment: EnvironmentIdentity;
  target: {
    baseUrl: string;
  };
  browser: {
    headless: boolean;
    viewport: Viewport;
    deviceScaleFactor: number;
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  name: string,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${name} has missing or unknown fields`);
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${String(minimum)}`,
    );
  }
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function workload(value: unknown): WorkloadIdentity {
  const source = record(value, 'workload');
  exactKeys(source, 'workload', ['id', 'version', 'profile', 'sha256']);
  const profile = string(source.profile, 'workload.profile');
  if (!workloadProfiles.has(profile)) {
    throw new Error(`Unsupported workload profile: ${profile}`);
  }
  return {
    id: string(source.id, 'workload.id'),
    version: string(source.version, 'workload.version'),
    profile: profile as WorkloadProfile,
    sha256: string(source.sha256, 'workload.sha256'),
  };
}

function scenario(value: unknown): RunnerConfiguration['scenario'] {
  const source = record(value, 'scenario');
  exactKeys(source, 'scenario', [
    'cacheProfile',
    'pageReuse',
    'warmupIterations',
    'measurementIterations',
  ]);
  const cacheProfile = string(source.cacheProfile, 'scenario.cacheProfile');
  if (!cacheProfiles.has(cacheProfile)) {
    throw new Error(`Unsupported cache profile: ${cacheProfile}`);
  }
  const pageReuse = string(source.pageReuse, 'scenario.pageReuse');
  if (!pageReusePolicies.has(pageReuse)) {
    throw new Error(`Unsupported page reuse policy: ${pageReuse}`);
  }
  if (cacheProfile === 'cold' && pageReuse !== 'per-iteration') {
    throw new Error('Cold cache profile requires per-iteration page reuse');
  }
  return {
    cacheProfile: cacheProfile as CacheProfile,
    pageReuse: pageReuse as PageReuse,
    warmupIterations: integer(
      source.warmupIterations,
      'scenario.warmupIterations',
      0,
    ),
    measurementIterations: integer(
      source.measurementIterations,
      'scenario.measurementIterations',
      1,
    ),
  };
}

function environment(value: unknown): EnvironmentIdentity {
  const source = record(value, 'environment');
  exactKeys(source, 'environment', ['profile', 'fingerprint']);
  const profile = record(source.profile, 'environment.profile');
  exactKeys(profile, 'environment.profile', ['id', 'version']);
  return {
    profile: {
      id: string(profile.id, 'environment.profile.id'),
      version: string(profile.version, 'environment.profile.version'),
    },
    fingerprint: string(source.fingerprint, 'environment.fingerprint'),
  };
}

function diagnosticMode(value: unknown): DiagnosticMode {
  const mode = string(value, 'diagnosticMode');
  if (!diagnosticModes.has(mode)) {
    throw new Error(`Unsupported diagnostic mode: ${mode}`);
  }
  return mode as DiagnosticMode;
}

function baseUrl(value: unknown): string {
  const text = string(value, 'target.baseUrl');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('target.baseUrl must be an absolute HTTP or HTTPS URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'target.baseUrl must be an HTTP or HTTPS URL without credentials or suffixes',
    );
  }
  return parsed.toString();
}

function target(value: unknown): RunnerConfiguration['target'] {
  const source = record(value, 'target');
  exactKeys(source, 'target', ['baseUrl']);
  return { baseUrl: baseUrl(source.baseUrl) };
}

function browser(value: unknown): RunnerConfiguration['browser'] {
  const source = record(value, 'browser');
  exactKeys(source, 'browser', ['headless', 'viewport', 'deviceScaleFactor']);
  const viewportSource = record(source.viewport, 'browser.viewport');
  exactKeys(viewportSource, 'browser.viewport', ['width', 'height']);
  return {
    headless: boolean(source.headless, 'browser.headless'),
    viewport: {
      width: integer(viewportSource.width, 'browser.viewport.width', 1),
      height: integer(viewportSource.height, 'browser.viewport.height', 1),
    },
    deviceScaleFactor: positiveNumber(
      source.deviceScaleFactor,
      'browser.deviceScaleFactor',
    ),
  };
}

export function parseRunnerConfiguration(text: string): RunnerConfiguration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Runner configuration must be valid JSON');
  }
  const source = record(decoded, 'configuration');
  exactKeys(source, 'configuration', [
    'schemaVersion',
    'runId',
    'testId',
    'workload',
    'scenario',
    'diagnosticMode',
    'environment',
    'target',
    'browser',
  ]);
  if (source.schemaVersion !== 2) {
    throw new Error('Unsupported runner configuration schemaVersion');
  }
  return {
    schemaVersion: 2,
    runId: string(source.runId, 'runId'),
    testId: string(source.testId, 'testId'),
    workload: workload(source.workload),
    scenario: scenario(source.scenario),
    diagnosticMode: diagnosticMode(source.diagnosticMode),
    environment: environment(source.environment),
    target: target(source.target),
    browser: browser(source.browser),
  };
}

export async function readRunnerConfiguration(
  path: string,
): Promise<RunnerConfiguration> {
  const bytes = await readFile(path);
  if (bytes.length > maximumConfigurationBytes) {
    throw new Error('Runner configuration exceeds 64 KiB');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Runner configuration must be UTF-8');
  }
  return parseRunnerConfiguration(text);
}
