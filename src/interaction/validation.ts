import { assertMetricName } from '../metric-name.js';
import type { InteractionOptions } from './types.js';

const defaultTimeoutMs = 5_000;

export function validateInteractionOptions(
  options: InteractionOptions,
): number {
  assertMetricName(options.metricName);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('timeoutMs must be an integer from 1 through 60000');
  }
  if (options.mode === 'instrumented') {
    if (options.measureName.trim() === '') {
      throw new Error('measureName is required');
    }
  } else {
    if (
      options.startSelector.trim() === '' ||
      options.completionSelector.trim() === ''
    ) {
      throw new Error('Black-box selectors are required');
    }
    const renderFrames = options.renderFrames ?? 2;
    if (
      !Number.isInteger(renderFrames) ||
      renderFrames < 1 ||
      renderFrames > 10
    ) {
      throw new Error('renderFrames must be an integer from 1 through 10');
    }
  }
  return timeoutMs;
}
