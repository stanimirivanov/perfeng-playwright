import type { DiagnosticMode } from '../journey/types.js';
import { exactKeys, integer, record } from './primitives.js';
import type { RunnerConfiguration } from './types.js';

const diagnosticNames: Record<DiagnosticMode, string> = {
  baseline: 'Baseline',
  lightweight: 'Lightweight',
  trace: 'Trace',
  memory: 'Memory',
  smoothness: 'Smoothness',
};

export function parseDiagnostics(
  value: unknown,
  mode: DiagnosticMode,
  measurementIterations: number,
): RunnerConfiguration['diagnostics'] {
  if (value === undefined) {
    if (mode === 'trace' || mode === 'memory' || mode === 'smoothness') {
      throw new Error(
        `${diagnosticNames[mode]} mode requires diagnostics.captureIterations`,
      );
    }
    return undefined;
  }
  if (mode !== 'trace' && mode !== 'memory' && mode !== 'smoothness') {
    throw new Error(
      'diagnostics is only supported for trace, memory, and smoothness modes',
    );
  }
  const source = record(value, 'diagnostics');
  exactKeys(source, 'diagnostics', ['captureIterations']);
  if (!Array.isArray(source.captureIterations)) {
    throw new Error('diagnostics.captureIterations must be an array');
  }
  if (
    (mode === 'trace' || mode === 'smoothness') &&
    source.captureIterations.length !== 1
  ) {
    throw new Error(
      'diagnostics.captureIterations must contain exactly one iteration',
    );
  }
  if (mode === 'memory' && source.captureIterations.length < 2) {
    throw new Error(
      'Memory diagnostics must capture at least two measured iterations',
    );
  }
  const captureIterations = source.captureIterations.map((value, index) =>
    integer(value, `diagnostics.captureIterations[${String(index)}]`, 1),
  );
  if (
    captureIterations.some((iteration) => iteration > measurementIterations)
  ) {
    throw new Error(
      'diagnostics.captureIterations must select measured iterations',
    );
  }
  if (
    mode === 'memory' &&
    captureIterations.some((iteration, index) => {
      const previous = captureIterations[index - 1];
      return (
        index > 0 && (previous === undefined || iteration !== previous + 1)
      );
    })
  ) {
    throw new Error(
      'Memory diagnostics require consecutive capture iterations in ascending order',
    );
  }
  return { captureIterations };
}
