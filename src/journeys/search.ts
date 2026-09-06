import { chromium, type BrowserType } from '@playwright/test';

import type { RunnerConfiguration } from '../configuration/types.js';
import { measureInteraction } from '../interaction/measure-interaction.js';
import { captureJourney, runJourney } from '../journey/run-journey.js';
import type {
  JourneyCapture,
  PlaywrightMeasurements,
  RunJourneyOptions,
} from '../journey/types.js';

function searchJourneyOptions(
  configuration: RunnerConfiguration,
): RunJourneyOptions {
  const options: RunJourneyOptions = {
    runId: configuration.runId,
    testId: configuration.testId,
    workload: configuration.workload,
    cacheProfile: configuration.scenario.cacheProfile,
    pageReuse: configuration.scenario.pageReuse,
    diagnosticMode: configuration.diagnosticMode,
    environment: configuration.environment,
    warmupIterations: configuration.scenario.warmupIterations,
    measurementIterations: configuration.scenario.measurementIterations,
    headless: configuration.browser.headless,
    viewport: configuration.browser.viewport,
    deviceScaleFactor: configuration.browser.deviceScaleFactor,
    journey: async (page) => {
      await page.goto(configuration.target.baseUrl, { waitUntil: 'load' });
      return [
        await measureInteraction(page, {
          mode: 'black-box',
          metricName: 'ui.search.action_to_visible_ms',
          startSelector: '#search',
          completionSelector: '#results',
          startEvent: 'click',
          renderFrames: 2,
          action: () => page.locator('#search').click(),
        }),
      ];
    },
  };
  if (configuration.diagnostics !== undefined) {
    options.captureIterations = configuration.diagnostics.captureIterations;
  }
  return options;
}

/** Runs the repository-owned search action-to-visible baseline journey. */
export function runSearchJourney(
  configuration: RunnerConfiguration,
  browserType: BrowserType = chromium,
): Promise<PlaywrightMeasurements> {
  return runJourney(browserType, searchJourneyOptions(configuration));
}

/** Runs the search journey with optional independently persisted diagnostics. */
export function captureSearchJourney(
  configuration: RunnerConfiguration,
  browserType: BrowserType = chromium,
): Promise<JourneyCapture> {
  return captureJourney(browserType, searchJourneyOptions(configuration));
}
