import { createHash } from 'node:crypto';

import {
  publishCommittedFileSet,
  publishImmutableFile,
  type ImmutablePublicationFile,
} from '../filesystem/immutable-publication.js';

import type {
  JourneyCapture,
  PlaywrightRunnerReceipt,
  PlaywrightMeasurements,
  WrittenJourneyArtifacts,
  WrittenMeasurementArtifact,
} from './types.js';
import type { SourceCheckoutArtifact } from '../source-checkout.js';

/** Immutable destinations for measurement, receipt, and optional diagnostic artifacts. */
export interface JourneyArtifactPaths {
  measurements: string;
  receipt: string;
  observations?: string;
  trace?: string;
  memory?: {
    before: string;
    after: string;
  };
}

interface PendingArtifact {
  path: string;
  bytes: Buffer;
  integrity: WrittenMeasurementArtifact;
}

function pendingBytes(path: string, bytes: Buffer): PendingArtifact {
  return {
    path,
    bytes,
    integrity: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  };
}

function pendingJson(path: string, payload: unknown): PendingArtifact {
  const content = JSON.stringify(payload, undefined, 2) + '\n';
  return pendingBytes(path, Buffer.from(content, 'utf8'));
}

function publicationFile(
  artifact: PendingArtifact,
  description: string,
): ImmutablePublicationFile {
  return { path: artifact.path, bytes: artifact.bytes, description };
}

/**
 * Publishes deterministic measurement bytes at one previously unused path.
 *
 * The final path appears atomically after its bytes are flushed. Any existing
 * destination or unsupported hard-link filesystem fails without replacement.
 */
export async function writeMeasurementArtifact(
  path: string,
  payload: PlaywrightMeasurements,
): Promise<WrittenMeasurementArtifact> {
  const artifact = pendingJson(path, payload);
  await publishImmutableFile(
    publicationFile(artifact, `measurement artifact at ${path}`),
    'reject',
  );
  return artifact.integrity;
}

/**
 * Publishes journey payloads before the receipt that commits their exact set.
 *
 * Every final path appears atomically. Exact payloads left without a receipt
 * may be reused by a retry; an existing receipt is accepted only with the full
 * exact set. Mismatches and unsupported hard-link filesystems fail without
 * replacing or deleting final paths.
 */
export async function writeJourneyArtifacts(
  paths: JourneyArtifactPaths,
  capture: JourneyCapture,
  sourceCheckout: SourceCheckoutArtifact,
): Promise<WrittenJourneyArtifacts> {
  const measurements = pendingJson(paths.measurements, capture.measurements);
  let observations: PendingArtifact | undefined;
  if (capture.observations !== undefined) {
    if (paths.observations === undefined) {
      throw new Error(
        'Lightweight diagnostics require an observations output path',
      );
    }
    observations = pendingJson(paths.observations, capture.observations);
  } else if (paths.observations !== undefined) {
    throw new Error(
      'An observations output path requires lightweight diagnostic mode',
    );
  }
  let trace: PendingArtifact | undefined;
  if (capture.trace !== undefined) {
    if (paths.trace === undefined) {
      throw new Error('Trace diagnostics require a trace output path');
    }
    trace = pendingBytes(paths.trace, capture.trace.bytes);
  } else if (paths.trace !== undefined) {
    throw new Error('A trace output path requires trace diagnostic mode');
  }
  let memoryBefore: PendingArtifact | undefined;
  let memoryAfter: PendingArtifact | undefined;
  if (capture.memory !== undefined) {
    if (paths.memory === undefined) {
      throw new Error(
        'Memory diagnostics require before and after heap snapshot output paths',
      );
    }
    memoryBefore = pendingBytes(
      paths.memory.before,
      capture.memory.before.snapshot.bytes,
    );
    memoryAfter = pendingBytes(
      paths.memory.after,
      capture.memory.after.snapshot.bytes,
    );
  } else if (paths.memory !== undefined) {
    throw new Error(
      'Heap snapshot output paths require memory diagnostic mode',
    );
  }
  const written: WrittenJourneyArtifacts = {
    measurements: measurements.integrity,
  };
  if (observations !== undefined) {
    written.observations = observations.integrity;
  }
  if (trace !== undefined && capture.trace !== undefined) {
    written.trace = {
      ...trace.integrity,
      iteration: capture.trace.iteration,
      format: capture.trace.format,
      mediaType: capture.trace.mediaType,
      dataLossOccurred: capture.trace.dataLossOccurred,
      startedAt: capture.trace.startedAt,
      finishedAt: capture.trace.finishedAt,
    };
  }
  if (
    memoryBefore !== undefined &&
    memoryAfter !== undefined &&
    capture.memory !== undefined
  ) {
    written.memory = {
      captureIterations: [...capture.memory.captureIterations],
      before: {
        ...memoryBefore.integrity,
        capturedAt: capture.memory.before.snapshot.capturedAt,
        format: capture.memory.before.snapshot.format,
        mediaType: capture.memory.before.snapshot.mediaType,
        uncompressedSizeBytes:
          capture.memory.before.snapshot.uncompressedSizeBytes,
        census: capture.memory.before.census,
      },
      after: {
        ...memoryAfter.integrity,
        capturedAt: capture.memory.after.snapshot.capturedAt,
        format: capture.memory.after.snapshot.format,
        mediaType: capture.memory.after.snapshot.mediaType,
        uncompressedSizeBytes:
          capture.memory.after.snapshot.uncompressedSizeBytes,
        census: capture.memory.after.census,
      },
    };
  }
  const receiptValue: PlaywrightRunnerReceipt = {
    schema: 'playwright-runner-receipt/v2',
    runId: capture.measurements.runId,
    testId: capture.measurements.testId,
    producer: {
      name: 'playwright',
      version: capture.measurements.runtime.playwrightVersion,
      artifact: sourceCheckout,
    },
    artifacts: written,
  };
  const receipt = pendingJson(paths.receipt, receiptValue);
  const payloads = [
    publicationFile(
      measurements,
      `measurement artifact at ${measurements.path}`,
    ),
    ...(observations === undefined
      ? []
      : [
          publicationFile(
            observations,
            `observation artifact at ${observations.path}`,
          ),
        ]),
    ...(trace === undefined
      ? []
      : [publicationFile(trace, `trace artifact at ${trace.path}`)]),
    ...(memoryBefore === undefined
      ? []
      : [
          publicationFile(
            memoryBefore,
            `before-memory artifact at ${memoryBefore.path}`,
          ),
        ]),
    ...(memoryAfter === undefined
      ? []
      : [
          publicationFile(
            memoryAfter,
            `after-memory artifact at ${memoryAfter.path}`,
          ),
        ]),
  ];
  await publishCommittedFileSet(
    payloads,
    publicationFile(receipt, `integrity receipt at ${receipt.path}`),
  );
  return written;
}
