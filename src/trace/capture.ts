import type { Page } from '@playwright/test';

import { captureChromeTrace } from './collector.js';
import { traceCaptureOptions } from './configuration.js';
import { performanceTracePreset } from './presets.js';
import type { TraceCapture, TraceCaptureOptions } from './types.js';

/** Captures Chrome DevTools performance evidence around one owned action. */
export async function capturePerformanceTrace<T>(
  page: Page,
  action: () => Promise<T>,
  options: TraceCaptureOptions = {},
): Promise<TraceCapture<T>> {
  const effective = traceCaptureOptions(options);
  return captureChromeTrace(page, action, performanceTracePreset, effective);
}
