import type { Page } from '@playwright/test';

import { measureBlackBoxInteraction } from './black-box.js';
import { measureInstrumentedInteraction } from './instrumented.js';
import type { InteractionMeasurement, InteractionOptions } from './types.js';
import { validateInteractionOptions } from './validation.js';

/** Measures one semantic interaction entirely on the browser performance clock. */
export async function measureInteraction(
  page: Page,
  options: InteractionOptions,
): Promise<InteractionMeasurement> {
  const timeoutMs = validateInteractionOptions(options);
  return options.mode === 'instrumented'
    ? measureInstrumentedInteraction(page, options, timeoutMs)
    : measureBlackBoxInteraction(page, options, timeoutMs);
}
