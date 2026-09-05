import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { chromium, expect, test } from '@playwright/test';

import {
  measureInteraction,
  runJourney,
  writeMeasurementArtifact,
  type RunJourneyOptions,
} from '../src/index.js';

function options(
  cacheProfile: RunJourneyOptions['cacheProfile'],
  cacheObservations: boolean[],
  contexts: Set<object>,
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
    warmupIterations: 1,
    measurementIterations: 2,
    journey: async (page) => {
      contexts.add(page.context());
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
  const payload = await runJourney(
    chromium,
    options('warm', cacheObservations, contexts),
  );

  expect(cacheObservations).toEqual([false, true, true]);
  expect(contexts.size).toBe(1);
  expect(payload.scenario).toEqual({
    cacheProfile: 'warm',
    contextReuse: 'per-run',
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
