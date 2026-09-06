import { createHash } from 'node:crypto';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  JourneyCapture,
  PlaywrightRunnerReceipt,
  PlaywrightMeasurements,
  WrittenJourneyArtifacts,
  WrittenMeasurementArtifact,
} from './types.js';

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

interface OpenArtifact extends PendingArtifact {
  handle: FileHandle;
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

async function writeArtifacts(artifacts: PendingArtifact[]): Promise<void> {
  if (new Set(artifacts.map(({ path }) => path)).size !== artifacts.length) {
    throw new Error('Artifact output paths must be distinct');
  }
  await Promise.all(
    [...new Set(artifacts.map(({ path }) => dirname(path)))].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const opened: OpenArtifact[] = [];
  try {
    for (const artifact of artifacts) {
      opened.push({
        ...artifact,
        handle: await open(artifact.path, 'wx'),
      });
    }
    await Promise.all(
      opened.map(({ handle, bytes }) => handle.writeFile(bytes)),
    );
    await Promise.all(opened.map(({ handle }) => handle.close()));
  } catch (error) {
    await Promise.allSettled(opened.map(({ handle }) => handle.close()));
    await Promise.allSettled(opened.map(({ path }) => unlink(path)));
    throw error;
  }
}

/** Writes exact artifact bytes once and returns their transport integrity fields. */
export async function writeMeasurementArtifact(
  path: string,
  payload: PlaywrightMeasurements,
): Promise<WrittenMeasurementArtifact> {
  const artifact = pendingJson(path, payload);
  await writeArtifacts([artifact]);
  return artifact.integrity;
}

/** Writes a journey's measurement, diagnostics, and integrity receipt once. */
export async function writeJourneyArtifacts(
  paths: JourneyArtifactPaths,
  capture: JourneyCapture,
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
    schema: 'playwright-runner-receipt/v1',
    runId: capture.measurements.runId,
    testId: capture.measurements.testId,
    artifacts: written,
  };
  const receipt = pendingJson(paths.receipt, receiptValue);
  await writeArtifacts([
    measurements,
    ...(observations === undefined ? [] : [observations]),
    ...(trace === undefined ? [] : [trace]),
    ...(memoryBefore === undefined ? [] : [memoryBefore]),
    ...(memoryAfter === undefined ? [] : [memoryAfter]),
    receipt,
  ]);
  return written;
}
