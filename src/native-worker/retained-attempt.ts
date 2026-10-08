import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { parseRunnerConfiguration } from '../configuration/parse.js';
import { inspectRegularFile } from '../filesystem/inspect-regular-file.js';
import { parseNativeRunnerReceipt } from './local-artifacts.js';

const attemptNamePattern =
  /^(perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const maximumMetadataBytes = 64 * 1024;
const maximumMeasurementsBytes = 32 * 1024 * 1024;

/** Local receipt-bound integrity, explicitly excluding server or lease state. */
export interface RetainedAttemptIntegrity {
  schema: 'native-retained-attempt-integrity/v1';
  runId: string;
  attemptId: string;
  measurements: { sizeBytes: number; sha256: string };
  serverStateVerified: false;
}

/**
 * Checks only local runner-committed measurement bytes against their receipt.
 * This cannot establish lease authority, publication, or a terminal outcome.
 */
export async function verifyRetainedAttemptMeasurements(
  spoolRoot: string,
  attemptName: string,
): Promise<RetainedAttemptIntegrity> {
  if (!isAbsolute(spoolRoot)) {
    throw new Error('Native attempt spool root must be absolute');
  }
  const match = attemptNamePattern.exec(attemptName);
  const runId = match?.[1];
  const attemptId = match?.[2];
  if (runId === undefined || attemptId === undefined) {
    throw new Error('Native attempt name is invalid');
  }
  const root = await lstat(spoolRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Native attempt spool root must be a real directory');
  }
  const directory = join(spoolRoot, attemptName);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Native attempt must be a real directory');
  }
  const configurationFile = await inspectRegularFile(
    join(directory, 'runner-config.json'),
    maximumMetadataBytes,
    true,
  );
  const configuration = parseRunnerConfiguration(
    new TextDecoder('utf-8', { fatal: true }).decode(configurationFile.bytes),
  );
  if (
    configuration.runId !== runId ||
    configuration.diagnosticMode !== 'baseline'
  ) {
    throw new Error(
      'Retained runner configuration differs from attempt identity',
    );
  }

  const receiptFile = await inspectRegularFile(
    join(directory, 'receipt.json'),
    maximumMetadataBytes,
    true,
  );
  const receipt = parseNativeRunnerReceipt(
    receiptFile.bytes,
    { runId: configuration.runId, testId: configuration.testId },
    maximumMeasurementsBytes,
  );
  const measured = await inspectRegularFile(
    join(directory, 'measurements.json'),
    maximumMeasurementsBytes,
    false,
  );
  if (measured.size !== receipt.size || measured.sha256 !== receipt.sha256) {
    throw new Error('Retained measurements differ from the runner receipt');
  }
  return {
    schema: 'native-retained-attempt-integrity/v1',
    runId,
    attemptId,
    measurements: { sizeBytes: measured.size, sha256: measured.sha256 },
    serverStateVerified: false,
  };
}
