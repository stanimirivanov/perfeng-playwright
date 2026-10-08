import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { exactKeys, integer, record } from '../configuration/primitives.js';
import { inspectRegularFile } from '../filesystem/inspect-regular-file.js';
import type { PlaywrightMeasurements } from '../journey/types.js';
import { AcquiredNativeV2Lease } from './acquisition.js';
import type { PreparedNativeAttempt } from './attempt-preparation.js';
import { contractSha256, patternString } from './contract-values.js';
import { maximumNativeMeasurementDocumentBytes } from './execution-recipe.js';
import { parseNativeV2Measurements } from './measurement-document.js';

const maximumReceiptBytes = 64 * 1024;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface VerifiedNativeMeasurements {
  path: string;
  size: number;
  sha256: string;
  mediaType: 'application/json';
}

/** Receipt-verified artifact declaration paired with its validated v2 payload. */
export interface ParsedNativeAttemptArtifacts {
  artifact: VerifiedNativeMeasurements;
  measurements: PlaywrightMeasurements;
}

/** Loads a receipt-verified local payload and validates its v2 measurement meaning. */
export async function loadNativeV2Measurements(
  authority: AcquiredNativeV2Lease,
  prepared: PreparedNativeAttempt,
): Promise<ParsedNativeAttemptArtifacts> {
  const { artifact, producerVersion } = await inspectNativeAttemptArtifacts(
    authority,
    prepared,
  );
  const inspected = await inspectRegularFile(
    artifact.path,
    Math.min(
      authority.recipe.artifactPlan[0].maximumBytes,
      maximumNativeMeasurementDocumentBytes,
    ),
    true,
  );
  if (
    inspected.size !== artifact.size ||
    inspected.sha256 !== artifact.sha256 ||
    inspected.bytes === undefined
  ) {
    throw new Error('Native measurements changed before semantic validation');
  }
  const measurements = parseNativeV2Measurements(
    inspected.bytes,
    authority.recipe,
  );
  if (measurements.runtime.playwrightVersion !== producerVersion) {
    throw new Error(
      'Native measurement version differs from the runner receipt',
    );
  }
  return { artifact, measurements };
}

/**
 * Checks the runner's receipt and exact measurement bytes before remote use.
 * The receipt commits only the baseline measurements slot. This does not parse
 * or approve measurement semantics; later result validation owns that check.
 */
export async function verifyNativeAttemptArtifacts(
  authority: AcquiredNativeV2Lease,
  prepared: PreparedNativeAttempt,
): Promise<VerifiedNativeMeasurements> {
  return (await inspectNativeAttemptArtifacts(authority, prepared)).artifact;
}

async function inspectNativeAttemptArtifacts(
  authority: AcquiredNativeV2Lease,
  prepared: PreparedNativeAttempt,
): Promise<{ artifact: VerifiedNativeMeasurements; producerVersion: string }> {
  if (!(authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('Native artifact verification requires v2 authority');
  }
  validatePreparedPaths(authority, prepared);
  const directory = await lstat(prepared.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Native attempt directory is not a real directory');
  }
  const plan = authority.recipe.artifactPlan[0];
  if (
    plan.slot !== 'measurements' ||
    plan.kind !== 'measurements' ||
    plan.mediaType !== 'application/json' ||
    plan.format !== 'playwright-measurements/v2' ||
    !plan.required
  ) {
    throw new Error('Native measurements plan is invalid');
  }
  const receiptFile = await inspectRegularFile(
    prepared.receiptPath,
    maximumReceiptBytes,
    true,
  );
  const receipt = parseNativeRunnerReceipt(
    receiptFile.bytes,
    {
      runId: authority.recipe.runId,
      testId: authority.recipe.configuration.testId,
      executionArtifact: authority.recipe.executionArtifact,
    },
    plan.maximumBytes,
  );
  const measured = await inspectRegularFile(
    prepared.measurementsPath,
    plan.maximumBytes,
    false,
  );
  if (measured.size !== receipt.size || measured.sha256 !== receipt.sha256) {
    throw new Error('Native measurements differ from the runner receipt');
  }
  return {
    artifact: {
      path: prepared.measurementsPath,
      size: measured.size,
      sha256: measured.sha256,
      mediaType: 'application/json',
    },
    producerVersion: receipt.producerVersion,
  };
}

function validatePreparedPaths(
  authority: AcquiredNativeV2Lease,
  prepared: PreparedNativeAttempt,
): void {
  const { runId, attemptId } = authority.recipe;
  if (
    basename(prepared.directory) !== `${runId}-${attemptId}` ||
    prepared.configurationPath !==
      join(prepared.directory, 'runner-config.json') ||
    prepared.measurementsPath !==
      join(prepared.directory, 'measurements.json') ||
    prepared.receiptPath !== join(prepared.directory, 'receipt.json') ||
    prepared.manifestPath !== join(prepared.directory, 'manifest.json')
  ) {
    throw new Error('Prepared native attempt paths differ from the lease');
  }
}

export interface NativeRunnerReceiptExpectation {
  runId: string;
  testId: string;
  executionArtifact?: {
    repository: string;
    revision: string;
    lockfile: string;
    lockfileSha256: string;
  };
}

/** Parses a closed receipt and checks the expected local or lease-bound identity. */
export function parseNativeRunnerReceipt(
  bytes: Buffer | undefined,
  expected: NativeRunnerReceiptExpectation,
  maximumBytes: number,
): { size: number; sha256: string; producerVersion: string } {
  if (bytes === undefined) {
    throw new Error('Native runner receipt bytes are missing');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error('Native runner receipt is not valid UTF-8 JSON');
  }
  const receipt = record(decoded, 'native runner receipt');
  exactKeys(receipt, 'native runner receipt', [
    'schema',
    'runId',
    'testId',
    'producer',
    'artifacts',
  ]);
  const producer = record(receipt.producer, 'native runner producer');
  exactKeys(producer, 'native runner producer', [
    'name',
    'version',
    'artifact',
  ]);
  const artifact = record(producer.artifact, 'native runner source');
  exactKeys(artifact, 'native runner source', [
    'kind',
    'repository',
    'gitSha',
    'dependencyLock',
  ]);
  const lock = record(artifact.dependencyLock, 'native runner dependency lock');
  exactKeys(lock, 'native runner dependency lock', ['path', 'sha256']);
  const plan = record(receipt.artifacts, 'native runner artifacts');
  exactKeys(plan, 'native runner artifacts', ['measurements']);
  const measurements = record(plan.measurements, 'native runner measurements');
  exactKeys(measurements, 'native runner measurements', [
    'sha256',
    'sizeBytes',
  ]);
  if (
    receipt.schema !== 'playwright-runner-receipt/v2' ||
    receipt.runId !== expected.runId ||
    receipt.testId !== expected.testId ||
    producer.name !== 'playwright' ||
    artifact.kind !== 'source-checkout' ||
    typeof artifact.repository !== 'string' ||
    typeof artifact.gitSha !== 'string' ||
    typeof lock.path !== 'string' ||
    (expected.executionArtifact !== undefined &&
      (artifact.repository !== expected.executionArtifact.repository ||
        artifact.gitSha !== expected.executionArtifact.revision ||
        lock.path !== expected.executionArtifact.lockfile ||
        lock.sha256 !== expected.executionArtifact.lockfileSha256))
  ) {
    throw new Error(
      expected.executionArtifact === undefined
        ? 'Native runner receipt differs from the local configuration'
        : 'Native runner receipt differs from the lease',
    );
  }
  contractSha256(lock.sha256, 'native runner dependency lock SHA-256');
  const producerVersion = patternString(
    producer.version,
    'native runner producer version',
    versionPattern,
  );
  const size = integer(
    measurements.sizeBytes,
    'native runner measurement size',
    1,
  );
  if (size > maximumBytes) {
    throw new Error('Native measurements exceed the artifact plan');
  }
  return {
    size,
    producerVersion,
    sha256: contractSha256(
      measurements.sha256,
      'native runner measurement SHA-256',
    ),
  };
}
