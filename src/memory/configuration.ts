import type { MemoryCaptureOptions } from './types.js';

const defaultMaximumSnapshotBytes = 256 * 1024 * 1024;
const maximumAllowedSnapshotBytes = 512 * 1024 * 1024;
const defaultSnapshotTimeoutMs = 120_000;
const maximumSnapshotTimeoutMs = 600_000;

export interface EffectiveMemoryCaptureOptions {
  maxSnapshotBytes: number;
  snapshotTimeoutMs: number;
}

function positiveInteger(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be an integer between 1 and ${String(maximum)}`,
    );
  }
}

export function memoryCaptureOptions(
  options: MemoryCaptureOptions,
): EffectiveMemoryCaptureOptions {
  const maxSnapshotBytes =
    options.maxSnapshotBytes ?? defaultMaximumSnapshotBytes;
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? defaultSnapshotTimeoutMs;
  positiveInteger(
    'maxSnapshotBytes',
    maxSnapshotBytes,
    maximumAllowedSnapshotBytes,
  );
  positiveInteger(
    'snapshotTimeoutMs',
    snapshotTimeoutMs,
    maximumSnapshotTimeoutMs,
  );
  return { maxSnapshotBytes, snapshotTimeoutMs };
}
