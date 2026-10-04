import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { parseRunnerConfiguration } from '../configuration/parse.js';
import { publishImmutableFile } from '../filesystem/immutable-publication.js';
import {
  inspectSourceCheckout,
  type SourceCheckoutArtifact,
} from '../source-checkout.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { leaseUuid, patternString } from './contract-values.js';
import type { NativeArtifactPlanItem } from './types.js';

const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const maximumConfigurationBytes = 64 * 1024;

export interface NativeAttemptPreparationRequest {
  authority: AcquiredNativeV2Lease;
  spoolRoot: string;
}

export interface PreparedNativeAttempt {
  directory: string;
  configurationPath: string;
  measurementsPath: string;
  receiptPath: string;
  manifestPath: string;
  runnerArguments: readonly string[];
}

/**
 * Creates one exclusive local attempt directory and publishes the lease-derived
 * runner configuration. It never launches a browser or transfers artifacts.
 * An existing attempt directory is not reused or removed automatically.
 */
export async function prepareNativeAttempt(
  request: NativeAttemptPreparationRequest,
  inspectCheckout: () => Promise<SourceCheckoutArtifact> = inspectSourceCheckout,
): Promise<PreparedNativeAttempt> {
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('Native attempt requires acquired v2 authority');
  }
  const recipe = request.authority.recipe;
  const runId = patternString(recipe.runId, 'runId', runIdPattern);
  const attemptId = leaseUuid(recipe.attemptId, 'attemptId');
  const configuration = parseRunnerConfiguration(
    JSON.stringify(recipe.configuration),
  );
  if (
    configuration.runId !== runId ||
    configuration.diagnosticMode !== 'baseline'
  ) {
    throw new Error('Native attempt differs from the v2 baseline recipe');
  }
  validateBaselinePlan(recipe.artifactPlan);
  const bytes = Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`);
  if (bytes.length > maximumConfigurationBytes) {
    throw new Error('Native runner configuration exceeds 64 KiB');
  }
  const source = await inspectCheckout();
  if (
    source.repository !== recipe.executionArtifact.repository ||
    source.gitSha !== recipe.executionArtifact.revision ||
    source.dependencyLock.path !== recipe.executionArtifact.lockfile ||
    source.dependencyLock.sha256 !== recipe.executionArtifact.lockfileSha256
  ) {
    throw new Error(
      'Native runner checkout differs from the assigned revision',
    );
  }
  if (!isAbsolute(request.spoolRoot)) {
    throw new Error('Native attempt spool root must be absolute');
  }
  const rootMetadata = await lstat(request.spoolRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Native attempt spool root must be a real directory');
  }
  const root = await realpath(request.spoolRoot);
  const directory = join(root, `${runId}-${attemptId}`);
  const configurationPath = join(directory, 'runner-config.json');
  const measurementsPath = join(directory, 'measurements.json');
  const receiptPath = join(directory, 'receipt.json');
  const manifestPath = join(directory, 'manifest.json');

  await mkdir(directory, { mode: 0o700 });
  await publishImmutableFile(
    {
      path: configurationPath,
      bytes,
      description: 'native attempt runner configuration',
    },
    'reject',
  );
  return {
    directory,
    configurationPath,
    measurementsPath,
    receiptPath,
    manifestPath,
    runnerArguments: [
      'run',
      '--config',
      configurationPath,
      '--output',
      measurementsPath,
      '--receipt-output',
      receiptPath,
    ],
  };
}

function validateBaselinePlan(plan: readonly NativeArtifactPlanItem[]): void {
  if (
    plan.length !== 2 ||
    plan[0]?.slot !== 'measurements' ||
    plan[0].kind !== 'measurements' ||
    plan[0].format !== 'playwright-measurements/v2' ||
    plan[0].mediaType !== 'application/json' ||
    !plan[0].required ||
    plan[1]?.slot !== 'manifest' ||
    plan[1].kind !== 'manifest' ||
    plan[1].format !== 'raw-result/v2' ||
    plan[1].mediaType !== 'application/json' ||
    !plan[1].required
  ) {
    throw new Error('Native attempt differs from the v2 baseline recipe');
  }
}
