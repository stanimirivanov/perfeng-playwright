import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { main } from '../src/cli.js';
import { parseRunnerConfiguration, runSearchJourney } from '../src/index.js';

test('executes the owned search journey from an explicit configuration', async () => {
  const configuration = parseRunnerConfiguration(
    JSON.stringify({
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
        warmupIterations: 1,
        measurementIterations: 2,
      },
      diagnosticMode: 'baseline',
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
    }),
  );
  const payload = await runSearchJourney(configuration);

  expect(payload.runId).toBe(configuration.runId);
  expect(payload.testId).toBe(configuration.testId);
  expect(payload.workload).toEqual(configuration.workload);
  expect(payload.measurements).toHaveLength(2);
  expect(payload.measurements.map(({ name }) => name)).toEqual([
    'ui.search.action_to_visible_ms',
    'ui.search.action_to_visible_ms',
  ]);
});

test('runs the command boundary from configuration file to immutable artifact', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath('configuration.json');
  const outputPath = testInfo.outputPath(
    'results',
    'playwright-measurements.json',
  );
  await writeFile(
    configurationPath,
    JSON.stringify({
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
        cacheProfile: 'cold',
        pageReuse: 'per-iteration',
        warmupIterations: 0,
        measurementIterations: 1,
      },
      diagnosticMode: 'baseline',
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
    }),
    'utf8',
  );

  const integrity = await main([
    'run',
    '--config',
    configurationPath,
    '--output',
    outputPath,
  ]);
  const bytes = await readFile(outputPath);
  const payload = JSON.parse(bytes.toString('utf8')) as { kind: string };

  expect(payload.kind).toBe('PlaywrightMeasurements');
  expect(integrity).toEqual({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
});
