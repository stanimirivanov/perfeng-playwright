import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  PlaywrightMeasurements,
  WrittenMeasurementArtifact,
} from './types.js';

/** Writes exact artifact bytes once and returns their transport integrity fields. */
export async function writeMeasurementArtifact(
  path: string,
  payload: PlaywrightMeasurements,
): Promise<WrittenMeasurementArtifact> {
  const content = `${JSON.stringify(payload, undefined, 2)}\n`;
  const bytes = Buffer.from(content, 'utf8');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}
