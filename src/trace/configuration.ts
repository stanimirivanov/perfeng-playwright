import type { TraceCaptureOptions } from './types.js';

const defaultMaximumBytes = 128 * 1024 * 1024;
const maximumAllowedBytes = 512 * 1024 * 1024;
const defaultCompletionTimeoutMs = 30_000;
const maximumCompletionTimeoutMs = 300_000;

export interface EffectiveTraceCaptureOptions {
  maxBytes: number;
  completionTimeoutMs: number;
}

function positiveInteger(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be an integer between 1 and ${String(maximum)}`,
    );
  }
}

export function traceCaptureOptions(
  options: TraceCaptureOptions,
): EffectiveTraceCaptureOptions {
  const maxBytes = options.maxBytes ?? defaultMaximumBytes;
  const completionTimeoutMs =
    options.completionTimeoutMs ?? defaultCompletionTimeoutMs;
  positiveInteger('maxBytes', maxBytes, maximumAllowedBytes);
  positiveInteger(
    'completionTimeoutMs',
    completionTimeoutMs,
    maximumCompletionTimeoutMs,
  );
  return { maxBytes, completionTimeoutMs };
}
