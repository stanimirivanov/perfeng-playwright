import type {
  CacheProfile,
  DiagnosticMode,
  EnvironmentIdentity,
  PageReuse,
  WorkloadIdentity,
  WorkloadProfile,
} from '../journey/types.js';
import {
  boolean,
  exactKeys,
  integer,
  positiveNumber,
  record,
  requiredString,
} from './primitives.js';
import type { RunnerConfiguration } from './types.js';

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
const diagnosticModes = new Set<string>(['baseline', 'lightweight']);

export function parseWorkload(value: unknown): WorkloadIdentity {
  const source = record(value, 'workload');
  exactKeys(source, 'workload', ['id', 'version', 'profile', 'sha256']);
  const profile = requiredString(source.profile, 'workload.profile');
  if (!workloadProfiles.has(profile)) {
    throw new Error(`Unsupported workload profile: ${profile}`);
  }
  return {
    id: requiredString(source.id, 'workload.id'),
    version: requiredString(source.version, 'workload.version'),
    profile: profile as WorkloadProfile,
    sha256: requiredString(source.sha256, 'workload.sha256'),
  };
}

export function parseScenario(value: unknown): RunnerConfiguration['scenario'] {
  const source = record(value, 'scenario');
  exactKeys(source, 'scenario', [
    'cacheProfile',
    'pageReuse',
    'warmupIterations',
    'measurementIterations',
  ]);
  const cacheProfile = requiredString(
    source.cacheProfile,
    'scenario.cacheProfile',
  );
  if (!cacheProfiles.has(cacheProfile)) {
    throw new Error(`Unsupported cache profile: ${cacheProfile}`);
  }
  const pageReuse = requiredString(source.pageReuse, 'scenario.pageReuse');
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

export function parseEnvironment(value: unknown): EnvironmentIdentity {
  const source = record(value, 'environment');
  exactKeys(source, 'environment', ['profile', 'fingerprint']);
  const profile = record(source.profile, 'environment.profile');
  exactKeys(profile, 'environment.profile', ['id', 'version']);
  return {
    profile: {
      id: requiredString(profile.id, 'environment.profile.id'),
      version: requiredString(profile.version, 'environment.profile.version'),
    },
    fingerprint: requiredString(source.fingerprint, 'environment.fingerprint'),
  };
}

export function parseDiagnosticMode(value: unknown): DiagnosticMode {
  const mode = requiredString(value, 'diagnosticMode');
  if (!diagnosticModes.has(mode)) {
    throw new Error(`Unsupported diagnostic mode: ${mode}`);
  }
  return mode as DiagnosticMode;
}

function parseBaseUrl(value: unknown): string {
  const text = requiredString(value, 'target.baseUrl');
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

export function parseTarget(value: unknown): RunnerConfiguration['target'] {
  const source = record(value, 'target');
  exactKeys(source, 'target', ['baseUrl']);
  return { baseUrl: parseBaseUrl(source.baseUrl) };
}

export function parseBrowser(value: unknown): RunnerConfiguration['browser'] {
  const source = record(value, 'browser');
  exactKeys(source, 'browser', ['headless', 'viewport', 'deviceScaleFactor']);
  const viewport = record(source.viewport, 'browser.viewport');
  exactKeys(viewport, 'browser.viewport', ['width', 'height']);
  return {
    headless: boolean(source.headless, 'browser.headless'),
    viewport: {
      width: integer(viewport.width, 'browser.viewport.width', 1),
      height: integer(viewport.height, 'browser.viewport.height', 1),
    },
    deviceScaleFactor: positiveNumber(
      source.deviceScaleFactor,
      'browser.deviceScaleFactor',
    ),
  };
}
