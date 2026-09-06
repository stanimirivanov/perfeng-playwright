import type { InteractionMeasurement } from './types.js';

export function interactionMeasurement(
  name: string,
  durationMs: number,
): InteractionMeasurement {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Browser returned an invalid interaction duration');
  }
  return { name, durationMs };
}
