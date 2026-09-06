import type { BrowserType } from '@playwright/test';

import { executeJourney } from './browser-execution.js';
import {
  browserName,
  playwrightVersion,
  runtimeArchitecture,
  runtimePlatform,
} from './runtime.js';
import type { PlaywrightMeasurements, RunJourneyOptions } from './types.js';
import { validateRunJourneyOptions } from './validation.js';

/** Executes warm-up and measured repetitions and returns a v2 native payload. */
export async function runJourney(
  browserType: BrowserType,
  options: RunJourneyOptions,
): Promise<PlaywrightMeasurements> {
  const effective = validateRunJourneyOptions(options);
  const browser = await browserType.launch({ headless: effective.headless });
  try {
    const execution = await executeJourney(browser, options, {
      viewport: effective.viewport,
      deviceScaleFactor: effective.deviceScaleFactor,
    });
    const created = new Date();
    if (execution.start >= execution.end) {
      throw new Error('Measurement window start must precede end');
    }
    if (created < execution.end) {
      throw new Error('Artifact creation must not precede measurement end');
    }
    return {
      schemaVersion: 2,
      kind: 'PlaywrightMeasurements',
      runId: options.runId,
      testId: options.testId,
      workload: { ...options.workload },
      scenario: {
        cacheProfile: options.cacheProfile,
        contextReuse:
          options.cacheProfile === 'warm' ? 'per-run' : 'per-iteration',
        pageReuse: options.pageReuse,
        warmupIterations: options.warmupIterations,
        measurementIterations: options.measurementIterations,
      },
      diagnosticMode: options.diagnosticMode,
      environment: {
        profile: { ...options.environment.profile },
        fingerprint: options.environment.fingerprint,
      },
      runtime: {
        playwrightVersion: playwrightVersion(),
        nodeVersion: process.versions.node,
        platform: runtimePlatform(),
        architecture: runtimeArchitecture(),
      },
      browser: {
        name: browserName(browser),
        version: browser.version(),
        headless: effective.headless,
        viewport: { ...effective.viewport },
        deviceScaleFactor: effective.deviceScaleFactor,
      },
      measurementWindow: {
        start: execution.start.toISOString(),
        end: execution.end.toISOString(),
      },
      createdAt: created.toISOString(),
      measurements: execution.measurements,
    };
  } finally {
    await browser.close();
  }
}
