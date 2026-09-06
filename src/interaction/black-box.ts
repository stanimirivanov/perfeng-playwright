import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import {
  discardBlackBoxObserver,
  installBlackBoxObserver,
  waitForBlackBoxResult,
} from './black-box-page.js';
import { interactionMeasurement } from './result.js';
import type { BlackBoxInteraction, InteractionMeasurement } from './types.js';

export async function measureBlackBoxInteraction(
  page: Page,
  options: BlackBoxInteraction,
  timeoutMs: number,
): Promise<InteractionMeasurement> {
  const token = randomUUID();
  await installBlackBoxObserver(page, {
    id: token,
    startSelector: options.startSelector,
    completionSelector: options.completionSelector,
    startEvent: options.startEvent,
    renderFrames: options.renderFrames,
    timeoutMs,
  });
  try {
    await options.action();
    const result = await waitForBlackBoxResult(page, token, timeoutMs);
    if (result.error !== undefined) {
      throw new Error(result.error);
    }
    if (result.durationMs === undefined) {
      throw new Error('Interaction observer returned no duration');
    }
    return interactionMeasurement(options.metricName, result.durationMs);
  } catch (error) {
    await discardBlackBoxObserver(page, token);
    throw error;
  }
}
