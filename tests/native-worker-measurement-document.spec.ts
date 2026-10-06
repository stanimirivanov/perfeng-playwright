import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { writeJourneyArtifacts } from '../src/journey/artifact.js';
import type { PlaywrightMeasurements } from '../src/journey/types.js';
import { prepareNativeAttempt } from '../src/native-worker/attempt-preparation.js';
import { maximumNativeMeasurementDocumentBytes } from '../src/native-worker/execution-recipe.js';
import { loadNativeV2Measurements } from '../src/native-worker/local-artifacts.js';
import { parseNativeV2Measurements } from '../src/native-worker/measurement-document.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

function documentBytes(measurements: PlaywrightMeasurements): Buffer {
  return Buffer.from(`${JSON.stringify(measurements)}\n`, 'utf8');
}

async function completeFixture() {
  const source = await nativeV2RawResultRequest();
  const first = source.measurements.measurements[0];
  assert.ok(first);
  const measurements: PlaywrightMeasurements = {
    ...source.measurements,
    measurements: Array.from({ length: 5 }, (_, index) => ({
      ...first,
      iteration: index + 1,
    })),
  };
  return { authority: source.authority, measurements };
}

test('parses complete v2 baseline measurements against the assigned recipe', async () => {
  const { authority, measurements } = await completeFixture();

  expect(
    parseNativeV2Measurements(documentBytes(measurements), authority.recipe),
  ).toEqual(measurements);
});

test('rejects foreign identity, invalid runtime, and unknown payload fields', async () => {
  const { authority, measurements } = await completeFixture();
  for (const changed of [
    { ...measurements, runId: 'perf-20260918-120000-deadbeef' },
    {
      ...measurements,
      environment: { ...measurements.environment, fingerprint: 'f'.repeat(64) },
    },
    {
      ...measurements,
      runtime: { ...measurements.runtime, platform: 'linux' },
    },
    { ...measurements, unexpected: true },
  ]) {
    expect(() =>
      parseNativeV2Measurements(
        Buffer.from(JSON.stringify(changed)),
        authority.recipe,
      ),
    ).toThrow();
  }
});

test('rejects missing iterations, duplicate names, changed metric sets, and invalid durations', async () => {
  const { authority, measurements } = await completeFixture();
  const metrics = measurements.measurements;
  const first = metrics[0];
  assert.ok(first);
  const changed = [
    metrics.slice(0, -1),
    [...metrics, { ...first, iteration: 1 }],
    metrics.map((metric) =>
      metric.iteration === 5
        ? { ...metric, name: 'ui.search.different_ms' }
        : metric,
    ),
    metrics.map((metric) =>
      metric.iteration === 5 ? { ...metric, durationMs: -1 } : metric,
    ),
  ];
  for (const candidate of changed) {
    expect(() =>
      parseNativeV2Measurements(
        documentBytes({ ...measurements, measurements: candidate }),
        authority.recipe,
      ),
    ).toThrow();
  }
});

test('rejects measurements outside the lease window and oversized parsing input', async () => {
  const { authority, measurements } = await completeFixture();
  expect(() =>
    parseNativeV2Measurements(
      documentBytes({
        ...measurements,
        measurementWindow: {
          ...measurements.measurementWindow,
          start: '2026-09-18T11:59:59Z',
        },
      }),
      authority.recipe,
    ),
  ).toThrow('outside its lease');
  authority.recipe.artifactPlan[0].maximumBytes =
    maximumNativeMeasurementDocumentBytes + 1;
  expect(() =>
    parseNativeV2Measurements(
      Buffer.alloc(maximumNativeMeasurementDocumentBytes + 1),
      authority.recipe,
    ),
  ).toThrow('local parsing bound');
});

test('rejects malformed UTF-8 and malformed JSON before interpreting measurements', async () => {
  const { authority } = await completeFixture();
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{')]) {
    expect(() => parseNativeV2Measurements(bytes, authority.recipe)).toThrow(
      'not valid UTF-8 JSON',
    );
  }
});

test('loads only receipt-verified, recipe-valid local measurements', async ({}, testInfo) => {
  const { authority, measurements } = await completeFixture();
  const runner = authority.recipe.executionArtifact;
  const checkout: SourceCheckoutArtifact = {
    kind: 'source-checkout',
    repository: runner.repository,
    gitSha: runner.revision,
    dependencyLock: { path: 'pnpm-lock.yaml', sha256: runner.lockfileSha256 },
  };
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);
  const prepared = await prepareNativeAttempt({ authority, spoolRoot }, () =>
    Promise.resolve(checkout),
  );
  await writeJourneyArtifacts(
    { measurements: prepared.measurementsPath, receipt: prepared.receiptPath },
    { measurements },
    checkout,
  );

  const loaded = await loadNativeV2Measurements(authority, prepared);
  expect(loaded.measurements).toEqual(measurements);
  expect(loaded.artifact).toMatchObject({
    path: prepared.measurementsPath,
    mediaType: 'application/json',
  });

  const receipt = JSON.parse(await readFile(prepared.receiptPath, 'utf8')) as {
    producer: { version: string };
  };
  receipt.producer.version = '9.9.9';
  await writeFile(prepared.receiptPath, JSON.stringify(receipt));
  await expect(loadNativeV2Measurements(authority, prepared)).rejects.toThrow(
    'version differs from the runner receipt',
  );
});
