import type { Page } from '@playwright/test';

import { interactionMeasurement } from './result.js';
import type {
  InstrumentedInteraction,
  InteractionMeasurement,
} from './types.js';

export async function measureInstrumentedInteraction(
  page: Page,
  options: InstrumentedInteraction,
  timeoutMs: number,
): Promise<InteractionMeasurement> {
  await page.evaluate((name) => {
    performance.clearMeasures(name);
  }, options.measureName);
  await options.action();
  const handle = await page.waitForFunction(
    (name) => {
      const entries = performance.getEntriesByName(name, 'measure');
      return entries.length === 0 ? null : entries.at(-1)?.duration;
    },
    options.measureName,
    { timeout: timeoutMs },
  );
  try {
    const durationMs = await handle.jsonValue();
    if (durationMs === null || durationMs === undefined) {
      throw new Error(
        `Performance measure was not recorded: ${options.measureName}`,
      );
    }
    return interactionMeasurement(options.metricName, durationMs);
  } finally {
    await handle.dispose();
  }
}
