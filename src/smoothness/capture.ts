import type { Page } from '@playwright/test';

import { captureChromeTrace } from '../trace/collector.js';
import { traceCaptureOptions } from '../trace/configuration.js';
import { smoothnessTracePreset } from '../trace/presets.js';
import type { TraceCapture, TraceCaptureOptions } from '../trace/types.js';

/** Captures Chrome rendering-pipeline evidence around one owned action. */
export async function captureSmoothnessTrace<T>(
  page: Page,
  action: () => Promise<T>,
  options: TraceCaptureOptions = {},
): Promise<TraceCapture<T>> {
  const effective = traceCaptureOptions(options);
  return captureChromeTrace(page, action, smoothnessTracePreset, effective);
}
