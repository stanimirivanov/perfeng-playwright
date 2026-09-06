import { createHash } from 'node:crypto';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  JourneyCapture,
  PlaywrightMeasurements,
  WrittenJourneyArtifacts,
  WrittenMeasurementArtifact,
} from './types.js';

export interface JourneyArtifactPaths {
  measurements: string;
  observations?: string;
}

interface PendingArtifact {
  path: string;
  bytes: Buffer;
  integrity: WrittenMeasurementArtifact;
}

interface OpenArtifact extends PendingArtifact {
  handle: FileHandle;
}

function pendingArtifact(path: string, payload: unknown): PendingArtifact {
  const content = JSON.stringify(payload, undefined, 2) + '\n';
  const bytes = Buffer.from(content, 'utf8');
  return {
    path,
    bytes,
    integrity: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  };
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
  const artifact = pendingArtifact(path, payload);
  await writeArtifacts([artifact]);
  return artifact.integrity;
}

/** Writes a journey's measurement and optional observation artifacts once. */
export async function writeJourneyArtifacts(
  paths: JourneyArtifactPaths,
  capture: JourneyCapture,
): Promise<WrittenJourneyArtifacts> {
  const measurements = pendingArtifact(
    paths.measurements,
    capture.measurements,
  );
  let observations: PendingArtifact | undefined;
  if (capture.observations !== undefined) {
    if (paths.observations === undefined) {
      throw new Error(
        'Lightweight diagnostics require an observations output path',
      );
    }
    observations = pendingArtifact(paths.observations, capture.observations);
  } else if (paths.observations !== undefined) {
    throw new Error(
      'An observations output path requires lightweight diagnostic mode',
    );
  }
  await writeArtifacts(
    observations === undefined ? [measurements] : [measurements, observations],
  );
  return observations === undefined
    ? { measurements: measurements.integrity }
    : {
        measurements: measurements.integrity,
        observations: observations.integrity,
      };
}
