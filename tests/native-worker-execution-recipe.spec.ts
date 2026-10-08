import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  maximumNativeMeasurementDocumentBytes,
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';

const leasePath = 'vendor/contracts/native-worker/v2/examples/lease.json';
const presencePath = 'vendor/contracts/native-worker/v2/examples/presence.json';

async function fixture(): Promise<{
  leaseText: string;
  evidence: NativeWorkerQualificationEvidence;
}> {
  const [leaseText, presenceText] = await Promise.all([
    readFile(leasePath, 'utf8'),
    readFile(presencePath, 'utf8'),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  return { leaseText, evidence: presence.qualificationEvidence };
}

function withValue(text: string, path: string[], value: unknown): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  let target = document;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined) {
    throw new Error('Mutation path must not be empty');
  }
  target[key] = value;
  return JSON.stringify(document);
}

function withoutValue(text: string, path: string[]): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  let target = document;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined) {
    throw new Error('Mutation path must not be empty');
  }
  Reflect.deleteProperty(target, key);
  return JSON.stringify(document);
}

test('projects the reviewed v2 lease into exact baseline runner configuration', async () => {
  const { leaseText, evidence } = await fixture();
  const result = parseNativeExecutionRecipe(leaseText, evidence);

  expect(result).toMatchObject({
    leaseId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    runRevision: 4,
    targetEnvironmentId: 'local-demo',
  });
  expect(result.configuration).toEqual({
    schemaVersion: 2,
    runId: 'perf-20260918-120000-a1b2c3d4',
    testId: 'search-journey',
    workload: {
      id: 'browser-smoke',
      version: '1.0.0',
      profile: 'smoke',
      sha256: 'f'.repeat(64),
    },
    scenario: {
      cacheProfile: 'cold',
      pageReuse: 'per-iteration',
      warmupIterations: 1,
      measurementIterations: 5,
    },
    diagnosticMode: 'baseline',
    environment: {
      profile: { id: 'windows-mainstream', version: '1.0.0' },
      fingerprint: '9'.repeat(64),
    },
    target: { baseUrl: 'https://sut.perfeng.invalid/' },
    browser: {
      headless: false,
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1,
    },
  });
  expect(result.artifactPlan.map((slot) => slot.slot)).toEqual([
    'measurements',
    'manifest',
  ]);
  expect(
    parseNativeExecutionRecipe(
      withValue(leaseText, ['runRevision'], 2 ** 31),
      evidence,
    ).runRevision,
  ).toBe(2 ** 31);
});

test('rejects incomplete, incompatible and worker-selected recipes before execution', async () => {
  const { leaseText, evidence } = await fixture();
  for (const path of [
    ['assignment', 'recipe'],
    ['assignment', 'recipe', 'journeyId'],
    ['assignment', 'recipe', 'workloadSha256'],
    ['assignment', 'recipe', 'scenario'],
    ['assignment', 'recipe', 'environment'],
    ['assignment', 'recipe', 'browserSettings'],
  ]) {
    expect(() =>
      parseNativeExecutionRecipe(withoutValue(leaseText, path), evidence),
    ).toThrow();
  }
  for (const [path, value] of [
    [['assignment', 'recipe', 'journeyId'], 'arbitrary-command'],
    [['assignment', 'profile'], 'windows-mainstream'],
    [['assignment', 'browser'], 'edge'],
    [['assignment', 'diagnosticMode'], 'trace'],
    [['assignment', 'recipe', 'scenario', 'measurementIterations'], 0],
    [['assignment', 'recipe', 'scenario', 'warmupIterations'], 101],
    [['assignment', 'recipe', 'scenario', 'pageReuse'], 'per-run'],
    [['assignment', 'recipe', 'browserSettings', 'deviceScaleFactor'], 5],
    [['assignment', 'recipe', 'browserSettings', 'viewport', 'width'], 0],
    [['assignment', 'target', 'baseUrl'], 'https://user@sut.perfeng.invalid'],
    [['assignment', 'recipe', 'workloadVersion'], '1.0.0-beta'],
    [['assignment', 'recipe', 'environment', 'profileVersion'], '1.0.0-beta'],
  ] as const) {
    expect(() =>
      parseNativeExecutionRecipe(
        withValue(leaseText, [...path], value),
        evidence,
      ),
    ).toThrow();
  }
  expect(() =>
    parseNativeExecutionRecipe(
      withValue(leaseText, ['assignment', 'recipe', 'diagnostics'], {}),
      evidence,
    ),
  ).toThrow();
  expect(() =>
    parseNativeExecutionRecipe(
      withValue(leaseText, ['runRevision'], Number.MAX_SAFE_INTEGER + 1),
      evidence,
    ),
  ).toThrow();
});

test('rejects stale host and runner evidence without exposing their values', async () => {
  const { leaseText, evidence } = await fixture();
  for (const changed of [
    { ...evidence, environmentId: 'other-host' },
    { ...evidence, environmentSha256: '1'.repeat(64) },
    { ...evidence, runner: { ...evidence.runner, revision: 'd'.repeat(40) } },
  ]) {
    expect(() => parseNativeExecutionRecipe(leaseText, changed)).toThrow(
      /differs from current qualification evidence/,
    );
  }
});

test('rejects noncanonical baseline artifact plans', async () => {
  const { leaseText, evidence } = await fixture();
  const original = JSON.parse(leaseText) as {
    artifactPlan: Record<string, unknown>[];
  };
  for (const plan of [
    [],
    [original.artifactPlan[0]],
    [...original.artifactPlan].reverse(),
    [...original.artifactPlan, original.artifactPlan[0]],
  ]) {
    expect(() =>
      parseNativeExecutionRecipe(
        withValue(leaseText, ['artifactPlan'], plan),
        evidence,
      ),
    ).toThrow();
  }
  expect(() =>
    parseNativeExecutionRecipe(
      withValue(leaseText, ['artifactPlan', '0', 'required'], false),
      evidence,
    ),
  ).toThrow();
  expect(() =>
    parseNativeExecutionRecipe(
      withValue(
        leaseText,
        ['artifactPlan', '0', 'maximumBytes'],
        maximumNativeMeasurementDocumentBytes + 1,
      ),
      evidence,
    ),
  ).toThrow('maximumBytes');
});

test('pins byte-identical v2 acquisition fixtures and reviewed OpenAPI identity', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as {
    v2SourceRevision: string;
    v2BundleVersion: string;
    nativeWorkerApiV2Version: string;
    reviewedV2OpenApiSha256: string;
    files: Record<string, string>;
  };
  expect(lock).toMatchObject({
    v2SourceRevision: '48917099b522e769b8fe533a166089ae2cd8914d',
    v2BundleVersion: '0.20.0',
    nativeWorkerApiV2Version: '2.1.0',
    reviewedV2OpenApiSha256:
      'ce55777c3cb3d0dee5e5d81820bd512757655d05c9c99997ceb2c31d366abdd6',
  });
  for (const path of [
    'native-worker/v2/examples/acquire.json',
    'native-worker/v2/examples/lease.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
