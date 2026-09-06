import type { Page } from '@playwright/test';

import {
  finishPageObservation,
  startPageObservation,
} from '../observation/observe-page.js';
import type { PageObservation } from '../observation/types.js';
import { capturePerformanceTrace } from '../trace/capture.js';
import type { IterationPerformanceTrace, RunJourneyOptions } from './types.js';

export interface IterationExecution {
  measurements: Awaited<ReturnType<RunJourneyOptions['journey']>>;
  observation?: PageObservation;
  trace?: IterationPerformanceTrace;
}

async function observedIteration(
  page: Page,
  journey: RunJourneyOptions['journey'],
): Promise<IterationExecution> {
  await startPageObservation(page);
  let measurements: Awaited<ReturnType<RunJourneyOptions['journey']>>;
  try {
    measurements = await journey(page);
  } catch (error) {
    await finishPageObservation(page).catch(() => undefined);
    throw error;
  }
  return {
    measurements,
    observation: await finishPageObservation(page),
  };
}

export async function executeIteration(
  page: Page,
  options: RunJourneyOptions,
  iteration?: number,
): Promise<IterationExecution> {
  if (iteration === undefined) {
    return { measurements: await options.journey(page) };
  }
  if (options.diagnosticMode === 'lightweight') {
    return observedIteration(page, options.journey);
  }
  if (
    options.diagnosticMode === 'trace' &&
    options.captureIterations?.[0] === iteration
  ) {
    const capture = await capturePerformanceTrace(page, () =>
      options.journey(page),
    );
    return {
      measurements: capture.result,
      trace: { iteration, ...capture.trace },
    };
  }
  return { measurements: await options.journey(page) };
}
