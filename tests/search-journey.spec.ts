import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { main } from '../src/cli.js';
import {
  parseRunnerConfiguration,
  runSearchJourney,
  type SourceCheckoutArtifact,
} from '../src/index.js';

const sourceCheckout: SourceCheckoutArtifact = {
  kind: 'source-checkout',
  repository: 'https://github.com/stanimirivanov/perfeng-playwright',
  gitSha: 'a'.repeat(40),
  dependencyLock: { path: 'pnpm-lock.yaml', sha256: 'b'.repeat(64) },
};

function runMain(args: string[]) {
  return main(args, () => Promise.resolve(sourceCheckout));
}

function runnerConfiguration(
  diagnosticMode:
    'baseline' | 'lightweight' | 'trace' | 'memory' | 'smoothness' = 'baseline',
): object {
  const memory = diagnosticMode === 'memory';
  const traceLike =
    diagnosticMode === 'trace' || diagnosticMode === 'smoothness';
  const diagnostics = traceLike
    ? { captureIterations: [1] }
    : memory
      ? { captureIterations: [1, 2] }
      : undefined;
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
      pageReuse: memory ? 'per-run' : 'per-iteration',
      warmupIterations: memory ? 1 : 0,
      measurementIterations: memory ? 2 : 1,
    },
    diagnosticMode,
    ...(diagnostics === undefined ? {} : { diagnostics }),
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
  const receiptPath = testInfo.outputPath('results', 'playwright-receipt.json');
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration()),
    'utf8',
  );

  const written = await runMain([
    'run',
    '--config',
    configurationPath,
    '--output',
    outputPath,
    '--receipt-output',
    receiptPath,
  ]);
  const bytes = await readFile(outputPath);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
  const payload = JSON.parse(bytes.toString('utf8')) as { kind: string };

  expect(payload.kind).toBe('PlaywrightMeasurements');
  expect(written).toEqual({ measurements: integrity(bytes) });
  expect(receipt).toEqual({
    schema: 'playwright-runner-receipt/v2',
    runId: 'perf-20260902-130000-a1b2c3d5',
    testId: 'search-browser',
    producer: {
      name: 'playwright',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      artifact: sourceCheckout,
    },
    artifacts: written,
  });
});

test('does not publish artifacts when source provenance changes during execution', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath(
    'changed-source-configuration.json',
  );
  const outputPath = testInfo.outputPath('changed-source', 'measurements.json');
  const receiptPath = testInfo.outputPath('changed-source', 'receipt.json');
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration()),
    'utf8',
  );
  let inspections = 0;

  await expect(
    main(
      [
        'run',
        '--config',
        configurationPath,
        '--output',
        outputPath,
        '--receipt-output',
        receiptPath,
      ],
      () => {
        inspections += 1;
        return Promise.resolve({
          ...sourceCheckout,
          gitSha: (inspections === 1 ? 'a' : 'c').repeat(40),
        });
      },
    ),
  ).rejects.toThrow('changed during execution');
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
  const receiptPath = testInfo.outputPath(
    'lightweight',
    'playwright-receipt.json',
  );
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration('lightweight')),
    'utf8',
  );

  await expect(
    runMain([
      'run',
      '--config',
      configurationPath,
      '--output',
      measurementPath,
      '--receipt-output',
      receiptPath,
    ]),
  ).rejects.toThrow('require --observations-output');

  const written = await runMain([
    'run',
    '--config',
    configurationPath,
    '--output',
    measurementPath,
    '--receipt-output',
    receiptPath,
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

test('writes a selected Chrome trace independently from measurements', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath('trace-configuration.json');
  const measurementPath = testInfo.outputPath(
    'trace',
    'playwright-measurements.json',
  );
  const tracePath = testInfo.outputPath('trace', 'chrome-trace.json.gz');
  const receiptPath = testInfo.outputPath('trace', 'playwright-receipt.json');
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration('trace')),
    'utf8',
  );

  await expect(
    runMain([
      'run',
      '--config',
      configurationPath,
      '--output',
      measurementPath,
      '--receipt-output',
      receiptPath,
    ]),
  ).rejects.toThrow('require --trace-output');

  const written = await runMain([
    'run',
    '--config',
    configurationPath,
    '--output',
    measurementPath,
    '--receipt-output',
    receiptPath,
    '--trace-output',
    tracePath,
  ]);
  const measurementBytes = await readFile(measurementPath);
  const traceBytes = await readFile(tracePath);
  const trace = JSON.parse(gunzipSync(traceBytes).toString('utf8')) as {
    traceEvents: unknown[];
  };

  expect(trace.traceEvents.length).toBeGreaterThan(0);
  expect(written.measurements).toEqual(integrity(measurementBytes));
  expect(written.trace).toMatchObject({
    ...integrity(traceBytes),
    iteration: 1,
    format: 'chrome-trace-json-gzip',
    mediaType: 'application/gzip',
  });
  expect(typeof written.trace?.dataLossOccurred).toBe('boolean');
  expect(Date.parse(written.trace?.startedAt ?? '')).toBeLessThanOrEqual(
    Date.parse(written.trace?.finishedAt ?? ''),
  );
});

test('writes a selected smoothness trace independently from measurements', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath(
    'smoothness-configuration.json',
  );
  const measurementPath = testInfo.outputPath(
    'smoothness',
    'playwright-measurements.json',
  );
  const tracePath = testInfo.outputPath(
    'smoothness',
    'chrome-smoothness-trace.json.gz',
  );
  const receiptPath = testInfo.outputPath(
    'smoothness',
    'playwright-receipt.json',
  );
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration('smoothness')),
    'utf8',
  );

  await expect(
    runMain([
      'run',
      '--config',
      configurationPath,
      '--output',
      measurementPath,
      '--receipt-output',
      receiptPath,
    ]),
  ).rejects.toThrow('Smoothness diagnostics require --trace-output');

  const written = await runMain([
    'run',
    '--config',
    configurationPath,
    '--output',
    measurementPath,
    '--receipt-output',
    receiptPath,
    '--trace-output',
    tracePath,
  ]);
  const measurementBytes = await readFile(measurementPath);
  const traceBytes = await readFile(tracePath);
  const measurement = JSON.parse(measurementBytes.toString('utf8')) as {
    diagnosticMode: string;
  };

  expect(measurement.diagnosticMode).toBe('smoothness');
  expect(gunzipSync(traceBytes).length).toBeGreaterThan(0);
  expect(written.measurements).toEqual(integrity(measurementBytes));
  expect(written.trace).toMatchObject({
    ...integrity(traceBytes),
    iteration: 1,
    format: 'chrome-trace-json-gzip',
    mediaType: 'application/gzip',
  });
});

test('writes memory snapshots independently from repeated measurements', async ({}, testInfo) => {
  const configurationPath = testInfo.outputPath('memory-configuration.json');
  const measurementPath = testInfo.outputPath(
    'memory',
    'playwright-measurements.json',
  );
  const beforePath = testInfo.outputPath('memory', 'before.heapsnapshot.gz');
  const afterPath = testInfo.outputPath('memory', 'after.heapsnapshot.gz');
  const receiptPath = testInfo.outputPath('memory', 'playwright-receipt.json');
  await writeFile(
    configurationPath,
    JSON.stringify(runnerConfiguration('memory')),
    'utf8',
  );

  await expect(
    runMain([
      'run',
      '--config',
      configurationPath,
      '--output',
      measurementPath,
      '--receipt-output',
      receiptPath,
      '--heap-snapshot-before-output',
      beforePath,
    ]),
  ).rejects.toThrow('require --heap-snapshot-before-output');

  const written = await runMain([
    'run',
    '--config',
    configurationPath,
    '--output',
    measurementPath,
    '--receipt-output',
    receiptPath,
    '--heap-snapshot-before-output',
    beforePath,
    '--heap-snapshot-after-output',
    afterPath,
  ]);
  const measurementBytes = await readFile(measurementPath);
  const beforeBytes = await readFile(beforePath);
  const afterBytes = await readFile(afterPath);

  expect(gunzipSync(beforeBytes).length).toBeGreaterThan(0);
  expect(gunzipSync(afterBytes).length).toBeGreaterThan(0);
  expect(written.measurements).toEqual(integrity(measurementBytes));
  expect(written.memory?.captureIterations).toEqual([1, 2]);
  expect(written.memory?.before).toMatchObject(integrity(beforeBytes));
  expect(written.memory?.after).toMatchObject(integrity(afterBytes));
});
