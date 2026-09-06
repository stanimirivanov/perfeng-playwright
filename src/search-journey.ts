import { chromium, type BrowserType } from '@playwright/test';

import { measureInteraction } from './measure-interaction.js';
import { runJourney, type PlaywrightMeasurements } from './run-journey.js';
import type { RunnerConfiguration } from './configuration.js';

/** Runs the repository-owned search action-to-visible journey. */
export function runSearchJourney(
  configuration: RunnerConfiguration,
  browserType: BrowserType = chromium,
): Promise<PlaywrightMeasurements> {
  return runJourney(browserType, {
    runId: configuration.runId,
    testId: configuration.testId,
    workload: configuration.workload,
    cacheProfile: configuration.scenario.cacheProfile,
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
  });
}
