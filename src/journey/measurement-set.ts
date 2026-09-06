import type { InteractionMeasurement } from '../interaction/types.js';
import { assertMetricName } from '../metric-name.js';

export interface ValidatedMeasurementSet {
  measurements: InteractionMeasurement[];
  names: string[];
}

export function validateMeasurementSet(
  measurements: InteractionMeasurement[],
  expectedNames: string[] | undefined,
): ValidatedMeasurementSet {
  if (measurements.length === 0) {
    throw new Error('Journey must produce at least one measurement');
  }
  const sorted = [...measurements].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const names = sorted.map((measurement) => measurement.name);
  for (const measurement of sorted) {
    assertMetricName(measurement.name);
    if (
      !Number.isFinite(measurement.durationMs) ||
      measurement.durationMs < 0
    ) {
      throw new Error(`Invalid duration for metric: ${measurement.name}`);
    }
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Journey produced duplicate metric names in one iteration');
  }
  if (
    expectedNames !== undefined &&
    names.join('\0') !== expectedNames.join('\0')
  ) {
    throw new Error('Journey metric names changed between iterations');
  }
  return { measurements: sorted, names };
}
