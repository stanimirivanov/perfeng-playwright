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

function integrity(bytes: Buffer): { sha256: string; sizeBytes: number } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

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
  invalid.diagnosticMode = 'smoothness';
  await expect(captureJourney(chromium, invalid)).rejects.toThrow(
    'Unsupported diagnostic mode: smoothness',
  );
});

test('requires memory diagnostics to span repeated work on one warm page', async () => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'memory';

  await expect(captureJourney(chromium, diagnostic)).rejects.toThrow(
    'requires a warm cache profile and per-run page reuse',
  );
  diagnostic.pageReuse = 'per-run';
  diagnostic.captureIterations = [1];
  await expect(captureJourney(chromium, diagnostic)).rejects.toThrow(
    'requires at least two capture iterations',
  );
  diagnostic.measurementIterations = 3;
  diagnostic.captureIterations = [1, 3];
  await expect(captureJourney(chromium, diagnostic)).rejects.toThrow(
    'requires consecutive measured capture iterations',
  );
});

test('requires trace selection to identify one measured iteration', async () => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'trace';

  await expect(captureJourney(chromium, diagnostic)).rejects.toThrow(
    'requires exactly one capture iteration',
  );
  diagnostic.captureIterations = [3];
  await expect(captureJourney(chromium, diagnostic)).rejects.toThrow(
    'must select one measured iteration',
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

test('captures a trace only around the selected measured iteration', async () => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'trace';
  diagnostic.captureIterations = [2];

  const capture = await captureJourney(chromium, diagnostic);

  expect(capture.measurements.diagnosticMode).toBe('trace');
  expect(capture.trace?.iteration).toBe(2);
  expect(capture.trace?.format).toBe('chrome-trace-json-gzip');
  expect(capture.trace?.mediaType).toBe('application/gzip');
  expect(capture.trace?.bytes.subarray(0, 2)).toEqual(
    Buffer.from([0x1f, 0x8b]),
  );
  expect(Date.parse(capture.trace?.startedAt ?? '')).toBeLessThanOrEqual(
    Date.parse(capture.trace?.finishedAt ?? ''),
  );
  expect(capture.observations).toBeUndefined();
});

test('captures and writes memory evidence around repeated same-page iterations', async ({}, testInfo) => {
  const diagnostic = options('warm', [], new Set());
  diagnostic.diagnosticMode = 'memory';
  diagnostic.pageReuse = 'per-run';
  diagnostic.measurementIterations = 3;
  diagnostic.captureIterations = [1, 2, 3];
  diagnostic.journey = async (page) => {
    await page.evaluate(() => {
      const target = window as Window & { __retained?: HTMLElement[] };
      const element = document.createElement('button');
      element.addEventListener('click', () => undefined);
      document.body.append(element);
      target.__retained = [...(target.__retained ?? []), element];
    });
    return [{ name: 'ui.search.action_to_visible_ms', durationMs: 1 }];
  };

  const capture = await captureJourney(chromium, diagnostic);
  const measurementPath = testInfo.outputPath('memory', 'measurements.json');
  const beforePath = testInfo.outputPath('memory', 'before.heapsnapshot.gz');
  const afterPath = testInfo.outputPath('memory', 'after.heapsnapshot.gz');
  const written = await writeJourneyArtifacts(
    {
      measurements: measurementPath,
      memory: { before: beforePath, after: afterPath },
    },
    capture,
  );
  const beforeBytes = await readFile(beforePath);
  const afterBytes = await readFile(afterPath);

  expect(capture.memory?.captureIterations).toEqual([1, 2, 3]);
  expect(capture.memory?.after.census.dom.nodes).toBeGreaterThan(
    capture.memory?.before.census.dom.nodes ?? Number.POSITIVE_INFINITY,
  );
  expect(beforeBytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  expect(afterBytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  expect(written.memory?.captureIterations).toEqual([1, 2, 3]);
  expect(written.memory?.before).toMatchObject({
    ...integrity(beforeBytes),
    format: 'chrome-heap-snapshot-json-gzip',
    mediaType: 'application/gzip',
  });
  expect(written.memory?.after).toMatchObject({
    ...integrity(afterBytes),
    format: 'chrome-heap-snapshot-json-gzip',
    mediaType: 'application/gzip',
  });
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
