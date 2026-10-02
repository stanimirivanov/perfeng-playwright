import { boolean, exactKeys, record } from '../configuration/primitives.js';
import { parseRunnerConfiguration } from '../configuration/parse.js';
import type { RunnerConfiguration } from '../configuration/types.js';
import type { WorkloadProfile } from '../journey/types.js';
import {
  absoluteHttpsUrl,
  boundedInteger,
  contractIdentifier,
  contractSha256,
  contractTimestamp,
  enumMember,
  leaseUuid,
  patternString,
} from './contract-values.js';
import type { NativeArtifactPlanItem } from './types.js';

const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const lockfilePattern = /^[A-Za-z0-9._/-]+$/;
const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const workloadProfiles = new Set<WorkloadProfile>([
  'smoke',
  'average',
  'regression',
  'stress',
  'capacity',
  'soak',
]);
const maximumLeaseBytes = 64 * 1024;

/** Current, locally refreshed evidence used to verify a v2 assignment. */
export interface NativeWorkerQualificationEvidence {
  environmentId: string;
  environmentSha256: string;
  runner: {
    kind: 'source-checkout';
    repository: string;
    revision: string;
    lockfile: string;
    lockfileSha256: string;
  };
}

/** Reviewed v2 lease identity and the exact runner inputs derived from it. */
export interface NativeExecutionRecipe {
  leaseId: string;
  attemptId: string;
  runId: string;
  runRevision: number;
  issuedAt: string;
  expiresAt: string;
  renewAfterSeconds: number;
  targetEnvironmentId: string;
  executionArtifact: NativeWorkerQualificationEvidence['runner'];
  artifactPlan: [NativeArtifactPlanItem, NativeArtifactPlanItem];
  configuration: RunnerConfiguration;
}

/** Validates a v2 lease and projects it without worker-selected execution defaults. */
export function parseNativeExecutionRecipe(
  text: string,
  currentEvidence: NativeWorkerQualificationEvidence,
): NativeExecutionRecipe {
  if (Buffer.byteLength(text, 'utf8') > maximumLeaseBytes) {
    throw new Error('Native worker v2 lease exceeds 64 KiB');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker v2 lease must be valid JSON');
  }
  const lease = record(decoded, 'lease');
  exactKeys(lease, 'lease', [
    'leaseId',
    'attemptId',
    'runId',
    'runRevision',
    'issuedAt',
    'expiresAt',
    'renewAfterSeconds',
    'assignment',
    'artifactPlan',
  ]);
  const issuedAt = contractTimestamp(lease.issuedAt, 'issuedAt');
  const expiresAt = contractTimestamp(lease.expiresAt, 'expiresAt');
  const renewAfterSeconds = boundedInteger(
    lease.renewAfterSeconds,
    'renewAfterSeconds',
    5,
    300,
  );
  if (
    Date.parse(expiresAt) - Date.parse(issuedAt) <=
    renewAfterSeconds * 1000
  ) {
    throw new Error('Native worker v2 lease lacks a viable renewal window');
  }

  const assignment = record(lease.assignment, 'assignment');
  exactKeys(assignment, 'assignment', [
    'catalogueTestId',
    'workloadId',
    'profile',
    'target',
    'browser',
    'diagnosticMode',
    'executionArtifact',
    'recipe',
  ]);
  if (
    assignment.browser !== 'chromium' ||
    assignment.diagnosticMode !== 'baseline'
  ) {
    throw new Error('Native worker v2 supports baseline Chromium only');
  }
  const target = record(assignment.target, 'assignment.target');
  exactKeys(target, 'assignment.target', ['environmentId', 'baseUrl']);
  const baseUrl = absoluteHttpsUrl(
    target.baseUrl,
    'assignment.target.baseUrl',
    true,
  );
  const targetEnvironmentId = contractIdentifier(
    target.environmentId,
    'assignment.target.environmentId',
  );
  const executionArtifact = sourceCheckout(assignment.executionArtifact);
  if (
    executionArtifact.repository !== currentEvidence.runner.repository ||
    executionArtifact.revision !== currentEvidence.runner.revision ||
    executionArtifact.lockfile !== currentEvidence.runner.lockfile ||
    executionArtifact.lockfileSha256 !== currentEvidence.runner.lockfileSha256
  ) {
    throw new Error(
      'Assigned runner differs from current qualification evidence',
    );
  }

  const recipe = record(assignment.recipe, 'assignment.recipe');
  exactKeys(recipe, 'assignment.recipe', [
    'journeyId',
    'workloadVersion',
    'workloadSha256',
    'scenario',
    'environment',
    'browserSettings',
  ]);
  if (recipe.journeyId !== 'search') {
    throw new Error('Native worker v2 journey is unsupported');
  }
  const environment = record(
    recipe.environment,
    'assignment.recipe.environment',
  );
  exactKeys(environment, 'assignment.recipe.environment', [
    'profileId',
    'profileVersion',
    'fingerprint',
    'evidenceSha256',
  ]);
  const profileId = contractIdentifier(
    environment.profileId,
    'assignment.recipe.environment.profileId',
  );
  const evidenceSha256 = contractSha256(
    environment.evidenceSha256,
    'assignment.recipe.environment.evidenceSha256',
  );
  if (
    profileId !== currentEvidence.environmentId ||
    evidenceSha256 !== currentEvidence.environmentSha256
  ) {
    throw new Error(
      'Assigned environment differs from current qualification evidence',
    );
  }
  const scenario = boundedScenario(recipe.scenario);
  const browser = boundedBrowserSettings(recipe.browserSettings);
  const configuration = parseRunnerConfiguration(
    JSON.stringify({
      schemaVersion: 2,
      runId: patternString(lease.runId, 'runId', runIdPattern),
      testId: contractIdentifier(
        assignment.catalogueTestId,
        'assignment.catalogueTestId',
      ),
      workload: {
        id: contractIdentifier(assignment.workloadId, 'assignment.workloadId'),
        version: patternString(
          recipe.workloadVersion,
          'assignment.recipe.workloadVersion',
          semanticVersionPattern,
        ),
        profile: enumMember(
          assignment.profile,
          'assignment.profile',
          workloadProfiles,
        ),
        sha256: contractSha256(
          recipe.workloadSha256,
          'assignment.recipe.workloadSha256',
        ),
      },
      scenario,
      diagnosticMode: 'baseline',
      environment: {
        profile: {
          id: profileId,
          version: patternString(
            environment.profileVersion,
            'assignment.recipe.environment.profileVersion',
            semanticVersionPattern,
          ),
        },
        fingerprint: contractSha256(
          environment.fingerprint,
          'assignment.recipe.environment.fingerprint',
        ),
      },
      target: { baseUrl },
      browser,
    }),
  );
  return {
    leaseId: leaseUuid(lease.leaseId, 'leaseId'),
    attemptId: leaseUuid(lease.attemptId, 'attemptId'),
    runId: configuration.runId,
    runRevision: boundedInteger(
      lease.runRevision,
      'runRevision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    issuedAt,
    expiresAt,
    renewAfterSeconds,
    targetEnvironmentId,
    executionArtifact,
    artifactPlan: baselineArtifactPlan(lease.artifactPlan),
    configuration,
  };
}

function sourceCheckout(
  value: unknown,
): NativeWorkerQualificationEvidence['runner'] {
  const source = record(value, 'assignment.executionArtifact');
  exactKeys(source, 'assignment.executionArtifact', [
    'kind',
    'repository',
    'revision',
    'lockfile',
    'lockfileSha256',
  ]);
  if (source.kind !== 'source-checkout') {
    throw new Error('Native worker v2 requires a source-checkout runner');
  }
  return {
    kind: 'source-checkout',
    repository: absoluteHttpsUrl(
      source.repository,
      'executionArtifact.repository',
      true,
    ),
    revision: patternString(
      source.revision,
      'executionArtifact.revision',
      revisionPattern,
    ),
    lockfile: patternString(
      source.lockfile,
      'executionArtifact.lockfile',
      lockfilePattern,
    ),
    lockfileSha256: contractSha256(
      source.lockfileSha256,
      'executionArtifact.lockfileSha256',
    ),
  };
}

function boundedScenario(value: unknown): RunnerConfiguration['scenario'] {
  const source = record(value, 'assignment.recipe.scenario');
  exactKeys(source, 'assignment.recipe.scenario', [
    'cacheProfile',
    'pageReuse',
    'warmupIterations',
    'measurementIterations',
  ]);
  const cacheProfile = enumMember(
    source.cacheProfile,
    'scenario.cacheProfile',
    new Set(['cold', 'warm'] as const),
  );
  const pageReuse = enumMember(
    source.pageReuse,
    'scenario.pageReuse',
    new Set(['per-iteration', 'per-run'] as const),
  );
  if (cacheProfile === 'cold' && pageReuse !== 'per-iteration') {
    throw new Error('Cold cache profile requires per-iteration page reuse');
  }
  return {
    cacheProfile,
    pageReuse,
    warmupIterations: boundedInteger(
      source.warmupIterations,
      'warmupIterations',
      0,
      100,
    ),
    measurementIterations: boundedInteger(
      source.measurementIterations,
      'measurementIterations',
      1,
      1000,
    ),
  };
}

function boundedBrowserSettings(
  value: unknown,
): RunnerConfiguration['browser'] {
  const source = record(value, 'assignment.recipe.browserSettings');
  exactKeys(source, 'assignment.recipe.browserSettings', [
    'headless',
    'viewport',
    'deviceScaleFactor',
  ]);
  const viewport = record(source.viewport, 'browserSettings.viewport');
  exactKeys(viewport, 'browserSettings.viewport', ['width', 'height']);
  if (
    typeof source.deviceScaleFactor !== 'number' ||
    !Number.isFinite(source.deviceScaleFactor) ||
    source.deviceScaleFactor < 0.5 ||
    source.deviceScaleFactor > 4
  ) {
    throw new Error('browserSettings.deviceScaleFactor is outside v2 bounds');
  }
  return {
    headless: boolean(source.headless, 'browserSettings.headless'),
    viewport: {
      width: boundedInteger(
        viewport.width,
        'browserSettings.viewport.width',
        320,
        3840,
      ),
      height: boundedInteger(
        viewport.height,
        'browserSettings.viewport.height',
        240,
        2160,
      ),
    },
    deviceScaleFactor: source.deviceScaleFactor,
  };
}

function baselineArtifactPlan(
  value: unknown,
): [NativeArtifactPlanItem, NativeArtifactPlanItem] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Native worker v2 requires two artifact-plan slots');
  }
  return [
    baselineSlot(value[0], 'measurements', 'playwright-measurements/v2', 0),
    baselineSlot(value[1], 'manifest', 'raw-result/v2', 1),
  ];
}

function baselineSlot(
  value: unknown,
  slot: 'measurements' | 'manifest',
  format: 'playwright-measurements/v2' | 'raw-result/v2',
  index: number,
): NativeArtifactPlanItem {
  const source = record(value, `artifactPlan[${String(index)}]`);
  exactKeys(source, `artifactPlan[${String(index)}]`, [
    'slot',
    'kind',
    'mediaType',
    'format',
    'maximumBytes',
    'required',
  ]);
  if (
    source.slot !== slot ||
    source.kind !== slot ||
    source.mediaType !== 'application/json' ||
    source.format !== format ||
    source.required !== true
  ) {
    throw new Error(
      'Native worker v2 artifact plan differs from baseline contract',
    );
  }
  return {
    slot,
    kind: slot,
    mediaType: 'application/json',
    format,
    maximumBytes: boundedInteger(
      source.maximumBytes,
      'maximumBytes',
      1,
      512 * 1024 * 1024,
    ),
    required: true,
  };
}
