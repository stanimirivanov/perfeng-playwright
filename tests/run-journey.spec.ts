import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { chromium, expect, test } from '@playwright/test';

import {
  captureJourney,
  measureInteraction,
  runJourney,
  writeJourneyArtifacts,
  writeMeasurementArtifact,
  type RunJourneyOptions,
} from '../src/index.js';

function options(
  cacheProfile: RunJourneyOptions['cacheProfile'],
  cacheObservations: boolean[],
  contexts: Set<object>,
  pages: Set<object> = new Set<object>(),
): RunJourneyOptions {
  return {
    runId: 'perf-20260902-130000-a1b2c3d5',
    testId: 'search-browser',
    workload: {
      id: 'search-browser-smoke',
      version: '1.0.0',
      profile: 'smoke',
      sha256: 'd'.repeat(64),
    },
    cacheProfile,
    pageReuse: 'per-iteration',
    diagnosticMode: 'baseline',
    environment: {
      profile: { id: 'windows-mainstream', version: '1.0.0' },
      fingerprint: 'f'.repeat(64),
    },
    warmupIterations: 1,
    measurementIterations: 2,
    journey: async (page) => {
      contexts.add(page.context());
      pages.add(page);
      await page.goto('/');
      cacheObservations.push(
        await page.evaluate(() => {
          const present = localStorage.getItem('perfeng-warmed') === 'true';
          localStorage.setItem('perfeng-warmed', 'true');
          return present;
        }),
      );
      return [
        await measureInteraction(page, {
          mode: 'black-box',
          metricName: 'ui.search.action_to_visible_ms',
          startSelector: '#search',
          completionSelector: '#results',
          action: () => page.locator('#search').click(),
        }),
      ];
    },
  };
}

test('reuses one context and discards warm-up measurements for a warm profile', async () => {
  const cacheObservations: boolean[] = [];
  const contexts = new Set<object>();
  const pages = new Set<object>();
  const payload = await runJourney(
    chromium,
    options('warm', cacheObservations, contexts, pages),
  );

  expect(cacheObservations).toEqual([false, true, true]);
  expect(contexts.size).toBe(1);
  expect(pages.size).toBe(3);
  expect(payload.scenario).toEqual({
    cacheProfile: 'warm',
    contextReuse: 'per-run',
    pageReuse: 'per-iteration',
    warmupIterations: 1,
    measurementIterations: 2,
  });
  expect(payload.measurements.map(({ iteration }) => iteration)).toEqual([
    1, 2,
  ]);
  expect(payload.measurements.every(({ durationMs }) => durationMs > 0)).toBe(
    true,
  );
});

test('can reuse one page for warm stateful scenarios', async () => {
  const cacheObservations: boolean[] = [];
  const contexts = new Set<object>();
  const pages = new Set<object>();
  const runOptions = options('warm', cacheObservations, contexts, pages);
  runOptions.pageReuse = 'per-run';

  const payload = await runJourney(chromium, runOptions);

  expect(cacheObservations).toEqual([false, true, true]);
  expect(contexts.size).toBe(1);
  expect(pages.size).toBe(1);
  expect(payload.schemaVersion).toBe(2);
  expect(payload.scenario.pageReuse).toBe('per-run');
  expect(payload.diagnosticMode).toBe('baseline');
  expect(payload.environment).toEqual(runOptions.environment);
});

test('uses an isolated context for every cold-profile iteration', async () => {
  const cacheObservations: boolean[] = [];
  const contexts = new Set<object>();
  const payload = await runJourney(
    chromium,
    options('cold', cacheObservations, contexts),
  );

  expect(cacheObservations).toEqual([false, false, false]);
  expect(contexts.size).toBe(3);
  expect(payload.scenario.contextReuse).toBe('per-iteration');
  expect(payload.scenario.pageReuse).toBe('per-iteration');
  expect(payload.browser.name).toBe('chromium');
  expect(payload.browser.version).not.toHaveLength(0);
  expect(payload.runtime.playwrightVersion).toBe('1.62.1');
  expect(Date.parse(payload.measurementWindow.start)).toBeLessThan(
    Date.parse(payload.measurementWindow.end),
  );
  expect(Date.parse(payload.measurementWindow.end)).toBeLessThanOrEqual(
    Date.parse(payload.createdAt),
  );
});

test('rejects changing or duplicate metric sets', async () => {
  let invocation = 0;
  const base = options('warm', [], new Set());
  base.warmupIterations = 0;
  const measurementSets = [
    [{ name: 'ui.search.action_to_visible_ms', durationMs: 1 }],
    [{ name: 'ui.search.other_ms', durationMs: 1 }],
  ];
  base.journey = () => Promise.resolve(measurementSets[invocation++] ?? []);
  await expect(runJourney(chromium, base)).rejects.toThrow(
    'Journey metric names changed between iterations',
  );

  base.measurementIterations = 1;
  base.journey = () =>
    Promise.resolve([
      { name: 'ui.search.action_to_visible_ms', durationMs: 1 },
      { name: 'ui.search.action_to_visible_ms', durationMs: 2 },
    ]);
  await expect(runJourney(chromium, base)).rejects.toThrow(
    'Journey produced duplicate metric names',
  );
});

test('rejects invalid contract identity before launching a browser', async () => {
  const invalid = options('warm', [], new Set());
  invalid.runId = 'run-1';
  await expect(runJourney(chromium, invalid)).rejects.toThrow('Invalid run ID');
});

test('rejects a page lifetime that outlives a cold context', async () => {
  const invalid = options('cold', [], new Set());
  invalid.pageReuse = 'per-run';
  await expect(runJourney(chromium, invalid)).rejects.toThrow(
    'Cold cache profile requires per-iteration page reuse',
  );
});

test('rejects unimplemented diagnostic modes before launching a browser', async () => {
  const invalid = options('warm', [], new Set());
  invalid.diagnosticMode = 'trace';
  await expect(captureJourney(chromium, invalid)).rejects.toThrow(
    'Unsupported diagnostic mode: trace',
  );
});

test('captures lightweight observations only for measured iterations', async () => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'lightweight';

  const capture = await captureJourney(chromium, diagnostic);

  expect(capture.measurements.diagnosticMode).toBe('lightweight');
  expect(capture.observations?.execution).toEqual({
    mode: 'lightweight',
    contextReuse: 'per-run',
    pageReuse: 'per-iteration',
    captureIterations: [1, 2],
  });
  expect(
    capture.observations?.observations.map(({ iteration }) => iteration),
  ).toEqual([1, 2]);
  expect(
    capture.observations?.observations.every(
      ({ observation }) => observation.supportedEntryTypes.length > 0,
    ),
  ).toBe(true);
  expect(
    Date.parse(capture.observations?.captureWindow.start ?? ''),
  ).toBeLessThanOrEqual(
    Date.parse(capture.observations?.captureWindow.end ?? ''),
  );
});

test('prevents measurement-only callers from discarding diagnostics', async () => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'lightweight';

  await expect(runJourney(chromium, diagnostic)).rejects.toThrow(
    'use captureJourney for diagnostics',
  );
});

test('writes immutable deterministic artifact bytes and reports integrity', async ({}, testInfo) => {
  const payload = await runJourney(chromium, options('warm', [], new Set()));
  const path = testInfo.outputPath('raw', 'playwright-measurements.json');
  const integrity = await writeMeasurementArtifact(path, payload);
  const bytes = await readFile(path);

  expect(JSON.parse(bytes.toString('utf8'))).toEqual(payload);
  expect(integrity).toEqual({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
  await expect(writeMeasurementArtifact(path, payload)).rejects.toMatchObject({
    code: 'EEXIST',
  });
});

test('writes measurement and observation artifacts as one owned operation', async ({}, testInfo) => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'lightweight';
  diagnostic.warmupIterations = 0;
  diagnostic.measurementIterations = 1;
  const capture = await captureJourney(chromium, diagnostic);
  const measurementPath = testInfo.outputPath('artifacts', 'measurements.json');
  const observationsPath = testInfo.outputPath(
    'artifacts',
    'observations.json',
  );

  const written = await writeJourneyArtifacts(
    { measurements: measurementPath, observations: observationsPath },
    capture,
  );
  const measurementBytes = await readFile(measurementPath);
  const observationBytes = await readFile(observationsPath);

  expect(written).toEqual({
    measurements: {
      sha256: createHash('sha256').update(measurementBytes).digest('hex'),
      sizeBytes: measurementBytes.length,
    },
    observations: {
      sha256: createHash('sha256').update(observationBytes).digest('hex'),
      sizeBytes: observationBytes.length,
    },
  });
  expect(JSON.parse(observationBytes.toString('utf8'))).toEqual(
    capture.observations,
  );
});

test('removes newly created output when another artifact already exists', async ({}, testInfo) => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'lightweight';
  diagnostic.warmupIterations = 0;
  diagnostic.measurementIterations = 1;
  const capture = await captureJourney(chromium, diagnostic);
  const measurementPath = testInfo.outputPath('rollback-measurements.json');
  const observationsPath = testInfo.outputPath('rollback-observations.json');
  await writeFile(observationsPath, 'existing', 'utf8');

  await expect(
    writeJourneyArtifacts(
      { measurements: measurementPath, observations: observationsPath },
      capture,
    ),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(readFile(measurementPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(observationsPath, 'utf8')).resolves.toBe('existing');
});
