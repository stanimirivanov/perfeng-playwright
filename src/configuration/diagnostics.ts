import type { DiagnosticMode } from '../journey/types.js';
import { exactKeys, integer, record } from './primitives.js';
import type { RunnerConfiguration } from './types.js';

export function parseDiagnostics(
  value: unknown,
  mode: DiagnosticMode,
  measurementIterations: number,
): RunnerConfiguration['diagnostics'] {
  if (value === undefined) {
    if (mode === 'trace') {
      throw new Error('Trace mode requires diagnostics.captureIterations');
    }
    return undefined;
  }
  if (mode !== 'trace') {
    throw new Error('diagnostics is only supported for trace mode');
  }
  const source = record(value, 'diagnostics');
  exactKeys(source, 'diagnostics', ['captureIterations']);
  if (
    !Array.isArray(source.captureIterations) ||
    source.captureIterations.length !== 1
  ) {
    throw new Error(
      'diagnostics.captureIterations must contain exactly one iteration',
    );
  }
  const iteration = integer(
    source.captureIterations[0],
    'diagnostics.captureIterations[0]',
    1,
  );
  if (iteration > measurementIterations) {
    throw new Error(
      'diagnostics.captureIterations must select a measured iteration',
    );
  }
  return { captureIterations: [iteration] };
}
