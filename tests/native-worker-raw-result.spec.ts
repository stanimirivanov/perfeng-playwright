import { expect, test } from '@playwright/test';

import type { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import {
  createNativeRawResultManifest,
  serializeNativeRawResultManifest,
  type NativeRawResultRequest,
} from '../src/native-worker/raw-result.js';
import type {
  NativeArtifactPlanItem,
  NativeArtifactReference,
} from '../src/native-worker/types.js';
import { nativeRawResultRequest } from './native-worker-raw-result-fixture.js';

function measurementReference(
  input: NativeRawResultRequest & { authority: AcquiredNativeLease },
): NativeArtifactReference {
  const reference = input.registeredArtifacts[0];
  if (reference === undefined) {
    throw new Error('Test fixture has no measurement reference');
  }
  return reference;
}

function manifestPlan(
  input: NativeRawResultRequest & { authority: AcquiredNativeLease },
): NativeArtifactPlanItem {
  const plan = input.authority.lease.artifactPlan.find(
    (item) => item.slot === 'manifest',
  );
  if (plan === undefined) {
    throw new Error('Test fixture has no manifest plan');
  }
  return plan;
}

test('constructs a deterministic raw-result/v2 manifest from registered evidence', async () => {
  const input = await nativeRawResultRequest();

  expect(createNativeRawResultManifest(input)).toEqual({
    schemaVersion: 2,
    kind: 'RawResult',
    contractsVersion: '0.17.0',
    runId: input.authority.lease.runId,
    testId: 'search-journey',
    workload: {
      id: 'browser-smoke',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
    },
    producer: {
      name: 'playwright',
      version: '1.62.1',
      artifact: {
        kind: 'release-archive',
        url: 'https://example.invalid/releases/perfeng-playwright-1.0.0.zip',
        archiveSha256: 'd'.repeat(64),
        executableSha256: 'e'.repeat(64),
      },
    },
    measurementWindow: {
      start: '2026-09-18T12:00:20Z',
      end: '2026-09-18T12:01:00Z',
    },
    createdAt: '2026-09-18T12:01:20Z',
    artifacts: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        runId: input.authority.lease.runId,
        kind: 'raw',
        uri: `s3://perfeng/runs/${input.authority.lease.runId}/attempts/${input.authority.lease.attemptId}/measurements`,
        sha256: 'c'.repeat(64),
        sizeBytes: 2048,
        mediaType: 'application/json',
        format: 'playwright-measurements/v2',
      },
    ],
  });
  expect(serializeNativeRawResultManifest(input)).toEqual(
    serializeNativeRawResultManifest(input),
  );
});

test('maps source-checkout provenance without changing its identity', async () => {
  const input = await nativeRawResultRequest();
  input.authority.lease.assignment.executionArtifact = {
    kind: 'source-checkout',
    repository: 'https://github.com/stanimirivanov/perfeng-playwright',
    revision: 'f'.repeat(40),
    lockfile: 'pnpm-lock.yaml',
    lockfileSha256: 'd'.repeat(64),
  };

  expect(createNativeRawResultManifest(input).producer.artifact).toEqual({
    kind: 'source-checkout',
    repository: 'https://github.com/stanimirivanov/perfeng-playwright',
    gitSha: 'f'.repeat(40),
    dependencyLock: {
      path: 'pnpm-lock.yaml',
      sha256: 'd'.repeat(64),
    },
  });
});

test('requires every required non-manifest artifact', async () => {
  const input = await nativeRawResultRequest();
  input.registeredArtifacts = [];

  expect(() => createNativeRawResultManifest(input)).toThrow(
    'Required native artifact measurements is not registered',
  );
});

test('rejects self-reference, duplicate evidence, and a changed attempt fence', async () => {
  const input = await nativeRawResultRequest();
  const measurements = measurementReference(input);
  const manifest: NativeArtifactReference = {
    ...measurements,
    artifactId: '44444444-4444-4444-8444-444444444444',
    slot: 'manifest',
    kind: 'manifest',
  };

  expect(() =>
    createNativeRawResultManifest({
      ...input,
      registeredArtifacts: [manifest],
    }),
  ).toThrow('cannot contain itself');
  expect(() =>
    createNativeRawResultManifest({
      ...input,
      registeredArtifacts: [measurements, measurements],
    }),
  ).toThrow('does not match the native artifact plan');
  expect(() =>
    createNativeRawResultManifest({
      ...input,
      registeredArtifacts: [
        {
          ...measurements,
          attemptId: '99999999-9999-4999-8999-999999999999',
        },
      ],
    }),
  ).toThrow('changed its native lease fence');
});

test('rejects measurement identity and timeline outside the active lease', async () => {
  const input = await nativeRawResultRequest();
  expect(() =>
    createNativeRawResultManifest({
      ...input,
      measurements: { ...input.measurements, testId: 'other-test' },
    }),
  ).toThrow('do not match the native lease assignment');
  expect(() =>
    createNativeRawResultManifest({
      ...input,
      createdAt: '2026-09-18T12:02:01Z',
    }),
  ).toThrow('outside its active lease');
});

test('rejects manifest bytes above the assigned limit', async () => {
  const input = await nativeRawResultRequest();
  manifestPlan(input).maximumBytes = 1;

  expect(() => serializeNativeRawResultManifest(input)).toThrow(
    'exceeds its artifact plan',
  );
});
