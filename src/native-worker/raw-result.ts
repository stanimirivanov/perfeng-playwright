import type { PlaywrightMeasurements } from '../journey/types.js';
import type { AcquiredNativeLease } from './acquisition.js';
import {
  contractSha256,
  contractTimestamp,
  leaseUuid,
  patternString,
} from './contract-values.js';
import type {
  NativeArtifactPlanItem,
  NativeArtifactReference,
  NativeExecutionArtifact,
} from './types.js';

const contractsVersion = '0.17.0';
const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface NativeRawArtifactReference {
  id: string;
  runId: string;
  kind: 'raw';
  uri: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  format: string;
}

export type NativeRawResultExecutionArtifact =
  | {
      kind: 'source-checkout';
      repository: string;
      gitSha: string;
      dependencyLock: {
        path: string;
        sha256: string;
      };
    }
  | {
      kind: 'release-archive';
      url: string;
      archiveSha256: string;
      executableSha256: string;
    };

export interface NativeRawResultManifest {
  schemaVersion: 2;
  kind: 'RawResult';
  contractsVersion: typeof contractsVersion;
  runId: string;
  testId: string;
  workload: {
    id: string;
    version: string;
    sha256: string;
  };
  producer: {
    name: 'playwright';
    version: string;
    artifact: NativeRawResultExecutionArtifact;
  };
  measurementWindow: {
    start: string;
    end: string;
  };
  createdAt: string;
  artifacts: NativeRawArtifactReference[];
}

export interface NativeRawResultRequest {
  authority: AcquiredNativeLease;
  measurements: PlaywrightMeasurements;
  registeredArtifacts: readonly NativeArtifactReference[];
  createdAt: string;
}

/** Builds a raw-result/v2 manifest from lease-fenced, registered evidence. */
export function createNativeRawResultManifest(
  request: NativeRawResultRequest,
): NativeRawResultManifest {
  const lease = request.authority.lease;
  const createdAt = contractTimestamp(request.createdAt, 'createdAt');
  validateMeasurementIdentity(request);
  validateTimeline(
    request.measurements,
    lease.issuedAt,
    lease.expiresAt,
    createdAt,
  );

  const manifestPlan = lease.artifactPlan.find(
    (item) => item.slot === 'manifest',
  );
  const measurementsPlan = lease.artifactPlan.find(
    (item) => item.slot === 'measurements',
  );
  if (
    manifestPlan?.kind !== 'manifest' ||
    manifestPlan.format !== 'raw-result/v2' ||
    manifestPlan.mediaType !== 'application/json' ||
    !manifestPlan.required ||
    measurementsPlan?.format !== 'playwright-measurements/v2' ||
    !measurementsPlan.required
  ) {
    throw new Error(
      'Native lease does not require the canonical result artifacts',
    );
  }

  const references = registeredReferences(request, createdAt);
  return {
    schemaVersion: 2,
    kind: 'RawResult',
    contractsVersion,
    runId: lease.runId,
    testId: request.measurements.testId,
    workload: {
      id: request.measurements.workload.id,
      version: patternString(
        request.measurements.workload.version,
        'measurements.workload.version',
        semanticVersionPattern,
      ),
      sha256: contractSha256(
        request.measurements.workload.sha256,
        'measurements.workload.sha256',
      ),
    },
    producer: {
      name: 'playwright',
      version: patternString(
        request.measurements.runtime.playwrightVersion,
        'measurements.runtime.playwrightVersion',
        semanticVersionPattern,
      ),
      artifact: resultExecutionArtifact(lease.assignment.executionArtifact),
    },
    measurementWindow: { ...request.measurements.measurementWindow },
    createdAt,
    artifacts: references,
  };
}

/** Serializes a raw-result/v2 manifest into stable UTF-8 JSON bytes. */
export function serializeNativeRawResultManifest(
  request: NativeRawResultRequest,
): Buffer {
  const manifest = createNativeRawResultManifest(request);
  const bytes = Buffer.from(
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    'utf8',
  );
  const maximumBytes = request.authority.lease.artifactPlan.find(
    (item) => item.slot === 'manifest',
  )?.maximumBytes;
  if (maximumBytes === undefined || bytes.length > maximumBytes) {
    throw new Error('Native raw-result manifest exceeds its artifact plan');
  }
  return bytes;
}

function validateMeasurementIdentity(request: NativeRawResultRequest): void {
  const lease = request.authority.lease;
  const measurements = request.measurements;
  if (
    measurements.runId !== lease.runId ||
    measurements.testId !== lease.assignment.catalogueTestId ||
    measurements.workload.id !== lease.assignment.workloadId ||
    measurements.workload.profile !== lease.assignment.profile
  ) {
    throw new Error('Measurements do not match the native lease assignment');
  }
}

function validateTimeline(
  measurements: PlaywrightMeasurements,
  issuedAt: string,
  expiresAt: string,
  createdAt: string,
): void {
  const start = Date.parse(
    contractTimestamp(
      measurements.measurementWindow.start,
      'measurementWindow.start',
    ),
  );
  const end = Date.parse(
    contractTimestamp(
      measurements.measurementWindow.end,
      'measurementWindow.end',
    ),
  );
  const measurementsCreated = Date.parse(
    contractTimestamp(measurements.createdAt, 'measurements.createdAt'),
  );
  if (
    start < Date.parse(issuedAt) ||
    start >= end ||
    end > measurementsCreated ||
    measurementsCreated > Date.parse(createdAt) ||
    Date.parse(createdAt) > Date.parse(expiresAt)
  ) {
    throw new Error('Native result timeline is outside its active lease');
  }
}

function registeredReferences(
  request: NativeRawResultRequest,
  createdAt: string,
): NativeRawArtifactReference[] {
  const lease = request.authority.lease;
  const plans = lease.artifactPlan.filter((item) => item.slot !== 'manifest');
  const plansBySlot = new Map(plans.map((item) => [item.slot, item]));
  const referencesBySlot = new Map<string, NativeArtifactReference>();

  for (const reference of request.registeredArtifacts) {
    if (reference.slot === 'manifest') {
      throw new Error('Native raw-result manifest cannot contain itself');
    }
    const plan = plansBySlot.get(reference.slot);
    if (plan === undefined || referencesBySlot.has(reference.slot)) {
      throw new Error(
        'Registered evidence does not match the native artifact plan',
      );
    }
    validateRegisteredReference(reference, plan, request, createdAt);
    referencesBySlot.set(reference.slot, reference);
  }

  const missing = plans.find(
    (plan) => plan.required && !referencesBySlot.has(plan.slot),
  );
  if (missing !== undefined) {
    throw new Error(
      `Required native artifact ${missing.slot} is not registered`,
    );
  }

  return plans.flatMap((plan) => {
    const reference = referencesBySlot.get(plan.slot);
    return reference === undefined ? [] : [rawReference(reference, plan)];
  });
}

function validateRegisteredReference(
  reference: NativeArtifactReference,
  plan: NativeArtifactPlanItem,
  request: NativeRawResultRequest,
  createdAt: string,
): void {
  const lease = request.authority.lease;
  const registeredAt = contractTimestamp(
    reference.registeredAt,
    `${reference.slot}.registeredAt`,
  );
  if (
    reference.runId !== lease.runId ||
    reference.attemptId !== lease.attemptId ||
    reference.kind !== plan.kind ||
    reference.mediaType !== plan.mediaType ||
    Date.parse(registeredAt) < Date.parse(lease.issuedAt) ||
    Date.parse(registeredAt) > Date.parse(createdAt)
  ) {
    throw new Error('Registered evidence changed its native lease fence');
  }
}

function rawReference(
  reference: NativeArtifactReference,
  plan: NativeArtifactPlanItem,
): NativeRawArtifactReference {
  return {
    id: leaseUuid(reference.artifactId, `${reference.slot}.artifactId`),
    runId: reference.runId,
    kind: 'raw',
    uri: reference.uri,
    sha256: contractSha256(reference.sha256, `${reference.slot}.sha256`),
    sizeBytes: reference.size,
    mediaType: reference.mediaType,
    format: plan.format,
  };
}

function resultExecutionArtifact(
  artifact: NativeExecutionArtifact,
): NativeRawResultExecutionArtifact {
  if (artifact.kind === 'source-checkout') {
    return {
      kind: 'source-checkout',
      repository: artifact.repository,
      gitSha: artifact.revision,
      dependencyLock: {
        path: artifact.lockfile,
        sha256: artifact.lockfileSha256,
      },
    };
  }
  return { ...artifact };
}
