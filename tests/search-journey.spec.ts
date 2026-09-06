import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { main } from '../src/cli.js';
import { parseRunnerConfiguration, runSearchJourney } from '../src/index.js';

function runnerConfiguration(
  diagnosticMode: 'baseline' | 'lightweight' = 'baseline',
): object {
  return {
    schemaVersion: 2,
    runId: 'perf-20260902-130000-a1b2c3d5',
    testId: 'search-browser',
    workload: {
      id: 'search-browser-smoke',
      version: '1.0.0',
      profile: 'smoke',
      sha256: 'd'.repeat(64),
    },
    scenario: {
      cacheProfile: 'warm',
      pageReuse: 'per-iteration',
      warmupIterations: 0,
      measurementIterations: 1,
    },
    diagnosticMode,
    environment: {
      profile: { id: 'windows-mainstream', version: '1.0.0' },
      fingerprint: 'f'.repeat(64),
    },
    target: { baseUrl: 'http://127.0.0.1:4173/' },
    browser: {
      headless: true,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    },
  };
}

function integrity(bytes: Buffer): { sha256: string; sizeBytes: number } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

test('executes the owned search journey from an explicit configuration', async () => {
  const configuration = parseRunnerConfiguration(
    JSON.stringify(runnerConfiguration()),
  );
  const payload = await runSearchJourney(configuration);

  expect(payload.runId).toBe(configuration.runId);
  expect(payload.testId).toBe(configuration.testId);
  expect(payload.workload).toEqual(configuration.workload);
  expect(payload.measurements).toHaveLength(1);
  expect(payload.measurements[0]?.name).toBe('ui.search.action_to_visible_ms');
});

test('runs the baseline command into one immutable artifact', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath('configuration.json');
  const outputPath = testInfo.outputPath(
    'results',
    'playwright-measurements.json',
  );
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration()),
    'utf8',
  );

  const written = await main([
    'run',
    '--config',
    configurationPath,
    '--output',
    outputPath,
  ]);
  const bytes = await readFile(outputPath);
  const payload = JSON.parse(bytes.toString('utf8')) as { kind: string };

  expect(payload.kind).toBe('PlaywrightMeasurements');
  expect(written).toEqual({ measurements: integrity(bytes) });
});

test('writes lightweight observations independently from measurements', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath(
    'lightweight-configuration.json',
  );
  const measurementPath = testInfo.outputPath(
    'lightweight',
    'playwright-measurements.json',
  );
  const observationsPath = testInfo.outputPath(
    'lightweight',
    'browser-observations.json',
  );
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration('lightweight')),
    'utf8',
  );

  await expect(
    main(['run', '--config', configurationPath, '--output', measurementPath]),
  ).rejects.toThrow('require --observations-output');

  const written = await main([
    'run',
    '--config',
    configurationPath,
    '--output',
    measurementPath,
    '--observations-output',
    observationsPath,
  ]);
  const measurementBytes = await readFile(measurementPath);
  const observationBytes = await readFile(observationsPath);
  const observations = JSON.parse(observationBytes.toString('utf8')) as {
    kind: string;
    execution: { captureIterations: number[] };
    observations: unknown[];
  };

  expect(observations.kind).toBe('BrowserObservations');
  expect(observations.execution.captureIterations).toEqual([1]);
  expect(observations.observations).toHaveLength(1);
  expect(written).toEqual({
    measurements: integrity(measurementBytes),
    observations: integrity(observationBytes),
  });
});
