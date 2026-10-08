import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  createNativeRawResultManifest,
  serializeNativeRawResultManifest,
} from '../src/native-worker/raw-result.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

test('constructs deterministic v2 raw-result bytes from the reviewed recipe', async () => {
  const request = await nativeV2RawResultRequest();
  const recipe = request.authority.recipe;
  const manifest = createNativeRawResultManifest(request);
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { v2BundleVersion: string };
  expect(lock.v2BundleVersion).toBe('0.20.0');
  expect(manifest.contractsVersion).toBe('0.19.0');

  expect(manifest).toMatchObject({
    schemaVersion: 2,
    kind: 'RawResult',
    contractsVersion: '0.19.0',
    runId: recipe.runId,
    testId: recipe.configuration.testId,
    workload: {
      id: recipe.configuration.workload.id,
      version: recipe.configuration.workload.version,
      sha256: recipe.configuration.workload.sha256,
    },
    producer: {
      name: 'playwright',
      artifact: {
        kind: 'source-checkout',
        repository: recipe.executionArtifact.repository,
        gitSha: recipe.executionArtifact.revision,
        dependencyLock: {
          path: recipe.executionArtifact.lockfile,
          sha256: recipe.executionArtifact.lockfileSha256,
        },
      },
    },
    artifacts: [
      {
        id: request.registeredArtifacts[0]?.artifactId,
        runId: recipe.runId,
        kind: 'raw',
        format: 'playwright-measurements/v2',
      },
    ],
  });
  expect(serializeNativeRawResultManifest(request)).toEqual(
    serializeNativeRawResultManifest(request),
  );
});

test('rejects measurements that differ from the v2 execution recipe', async () => {
  const request = await nativeV2RawResultRequest();
  const measurements = request.measurements;
  const cases = [
    {
      ...measurements,
      workload: { ...measurements.workload, sha256: '0'.repeat(64) },
    },
    {
      ...measurements,
      scenario: { ...measurements.scenario, measurementIterations: 4 },
    },
    {
      ...measurements,
      environment: {
        ...measurements.environment,
        fingerprint: '0'.repeat(64),
      },
    },
    {
      ...measurements,
      browser: {
        ...measurements.browser,
        viewport: { ...measurements.browser.viewport, width: 1920 },
      },
    },
    {
      ...measurements,
      runtime: { ...measurements.runtime, platform: 'linux' as const },
    },
  ];
  for (const candidate of cases) {
    expect(() =>
      createNativeRawResultManifest({ ...request, measurements: candidate }),
    ).toThrow('do not match the native v2 execution recipe');
  }
});

test('rejects missing and foreign v2 registered evidence', async () => {
  const request = await nativeV2RawResultRequest();
  expect(() =>
    createNativeRawResultManifest({ ...request, registeredArtifacts: [] }),
  ).toThrow('Required native artifact measurements is not registered');
  const reference = request.registeredArtifacts[0];
  assert.ok(reference);
  expect(() =>
    createNativeRawResultManifest({
      ...request,
      registeredArtifacts: [
        { ...reference, attemptId: '99999999-9999-4999-8999-999999999999' },
      ],
    }),
  ).toThrow('changed its native lease fence');
});

test('rejects v2 result bytes above the server artifact limit', async () => {
  const request = await nativeV2RawResultRequest();
  request.authority.recipe.artifactPlan[1].maximumBytes = 1;
  expect(() => serializeNativeRawResultManifest(request)).toThrow(
    'exceeds its artifact plan',
  );
});
