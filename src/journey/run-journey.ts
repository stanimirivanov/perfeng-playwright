import type { BrowserType } from '@playwright/test';

import { browserObservations } from '../observation/artifact.js';
import { executeJourney } from './browser-execution.js';
import {
  browserName,
  playwrightVersion,
  runtimeArchitecture,
  runtimePlatform,
} from './runtime.js';
import type {
  JourneyCapture,
  PlaywrightMeasurements,
  RunJourneyOptions,
} from './types.js';
import { validateRunJourneyOptions } from './validation.js';

/** Executes a baseline journey and returns its v2 semantic measurements. */
export async function runJourney(
  browserType: BrowserType,
  options: RunJourneyOptions,
): Promise<PlaywrightMeasurements> {
  if (options.diagnosticMode !== 'baseline') {
    throw new Error(
      'runJourney only returns baseline measurements; use captureJourney for diagnostics',
    );
  }
  return (await captureJourney(browserType, options)).measurements;
}

/** Executes a journey and returns semantic measurements and optional evidence. */
export async function captureJourney(
  browserType: BrowserType,
  options: RunJourneyOptions,
): Promise<JourneyCapture> {
  const effective = validateRunJourneyOptions(options);
  const browser = await browserType.launch({ headless: effective.headless });
  try {
    const name = browserName(browser);
    if (options.diagnosticMode === 'trace' && name !== 'chromium') {
      throw new Error('Trace diagnostic mode requires Chromium');
    }
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
    const measurements: PlaywrightMeasurements = {
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
        name,
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
    const observations = browserObservations(
      options,
      execution,
      created.toISOString(),
    );
    if (options.diagnosticMode === 'trace' && execution.trace === undefined) {
      throw new Error('Trace diagnostic mode produced no trace evidence');
    }
    const capture: JourneyCapture = { measurements };
    if (observations !== undefined) {
      capture.observations = observations;
    }
    if (execution.trace !== undefined) {
      capture.trace = execution.trace;
    }
    return capture;
  } finally {
    await browser.close();
  }
}
