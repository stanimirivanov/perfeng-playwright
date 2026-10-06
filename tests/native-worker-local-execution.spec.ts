import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type TestInfo } from '@playwright/test';

import { writeJourneyArtifacts } from '../src/journey/artifact.js';
import type { PlaywrightMeasurements } from '../src/journey/types.js';
import type { NativeLocalExecutionRequest } from '../src/native-worker/local-execution.js';
import { executeNativeLocalAttempt } from '../src/native-worker/local-execution.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

async function fixture(testInfo: TestInfo) {
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
  const runner = source.authority.recipe.executionArtifact;
  const checkout: SourceCheckoutArtifact = {
    kind: 'source-checkout',
    repository: runner.repository,
    gitSha: runner.revision,
    dependencyLock: { path: 'pnpm-lock.yaml', sha256: runner.lockfileSha256 },
  };
  const checkoutRoot = testInfo.outputPath('checkout');
  const spoolRoot = testInfo.outputPath('spool');
  const evidenceRoot = testInfo.outputPath('evidence');
  await Promise.all([
    mkdir(join(checkoutRoot, 'dist'), { recursive: true }),
    mkdir(spoolRoot),
    mkdir(evidenceRoot),
  ]);
  const payload = join(evidenceRoot, 'measurements.json');
  const receipt = join(evidenceRoot, 'receipt.json');
  await writeJourneyArtifacts(
    { measurements: payload, receipt },
    { measurements },
    checkout,
  );
  const entrypoint = join(checkoutRoot, 'dist', 'cli.js');
  const request: NativeLocalExecutionRequest = {
    authority: source.authority,
    checkoutRoot,
    spoolRoot,
    runnerEnvironment: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
    },
    signal: new AbortController().signal,
    timeoutMilliseconds: 5_000,
  };
  const inspectCheckout = () => Promise.resolve(checkout);
  return {
    request,
    inspectCheckout,
    entrypoint,
    spoolRoot,
    payload,
    receipt,
    measurements,
  };
}

function copyingRunner(payload: string, receipt: string): string {
  return `import fs from 'node:fs';const a=process.argv.slice(2);if(a.length!==7||a[0]!=='run'||a[1]!=='--config'||a[3]!=='--output'||a[5]!=='--receipt-output'||'PERFENG_NATIVE_WORKER_TOKEN' in process.env)process.exit(17);const config=JSON.parse(fs.readFileSync(a[2],'utf8'));if(config.schemaVersion!==2)process.exit(18);fs.copyFileSync(${JSON.stringify(payload)},a[4]);fs.copyFileSync(${JSON.stringify(receipt)},a[6]);`;
}

test('runs the exact prepared command then returns only validated local evidence', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  const transitions: string[] = [];
  const attemptDirectory = join(
    source.spoolRoot,
    `${source.request.authority.recipe.runId}-${source.request.authority.recipe.attemptId}`,
  );
  await writeFile(
    source.entrypoint,
    copyingRunner(source.payload, source.receipt),
  );

  const result = await executeNativeLocalAttempt(
    {
      ...source.request,
      onPrepared: () => {
        transitions.push('prepared');
        expect(existsSync(join(attemptDirectory, 'runner-config.json'))).toBe(
          true,
        );
        expect(existsSync(join(attemptDirectory, 'measurements.json'))).toBe(
          false,
        );
      },
      onRunnerCompleted: () => {
        transitions.push('runner-completed');
        expect(existsSync(join(attemptDirectory, 'measurements.json'))).toBe(
          true,
        );
        expect(existsSync(join(attemptDirectory, 'receipt.json'))).toBe(true);
      },
    },
    source.inspectCheckout,
  );

  expect(transitions).toEqual(['prepared', 'runner-completed']);
  expect(result.measurements).toEqual(source.measurements);
  expect(result.artifact.path).toBe(result.prepared.measurementsPath);
  expect(await readFile(result.prepared.receiptPath, 'utf8')).toContain(
    'playwright-runner-receipt/v2',
  );
  expect(await readdir(result.prepared.directory)).toEqual([
    'measurements.json',
    'receipt.json',
    'runner-config.json',
  ]);
});

test('rejects unsafe inputs before creating attempt state', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  await writeFile(
    source.entrypoint,
    copyingRunner(source.payload, source.receipt),
  );
  const cancelled = new AbortController();
  cancelled.abort();
  for (const request of [
    { ...source.request, timeoutMilliseconds: 0 },
    { ...source.request, signal: cancelled.signal },
    {
      ...source.request,
      runnerEnvironment: { PERFENG_NATIVE_WORKER_TOKEN: 'private' },
    },
  ]) {
    await expect(
      executeNativeLocalAttempt(request, source.inspectCheckout),
    ).rejects.toThrow();
    expect(await readdir(source.spoolRoot)).toEqual([]);
  }
});

test('requires the reviewed entry point and assigned checkout before creating state', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  await expect(
    executeNativeLocalAttempt(source.request, source.inspectCheckout),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(source.spoolRoot)).toEqual([]);

  await writeFile(
    source.entrypoint,
    copyingRunner(source.payload, source.receipt),
  );
  const checkout = await source.inspectCheckout();
  await expect(
    executeNativeLocalAttempt(source.request, () =>
      Promise.resolve({ ...checkout, gitSha: 'f'.repeat(40) }),
    ),
  ).rejects.toThrow('differs from the assigned revision');
  expect(await readdir(source.spoolRoot)).toEqual([]);
});

test('retains attempt state after process failure without accepting evidence', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  const transitions: string[] = [];
  await writeFile(source.entrypoint, 'process.exit(17)');

  await expect(
    executeNativeLocalAttempt(
      {
        ...source.request,
        onPrepared: () => {
          transitions.push('prepared');
        },
        onRunnerCompleted: () => {
          transitions.push('runner-completed');
        },
      },
      source.inspectCheckout,
    ),
  ).rejects.toMatchObject({ kind: 'exit' });
  expect(transitions).toEqual(['prepared']);
  const [attempt] = await readdir(source.spoolRoot);
  assert.ok(attempt);
  expect(await readdir(join(source.spoolRoot, attempt))).toEqual([
    'runner-config.json',
  ]);
});

test('rejects changed runner bytes while retaining the committed receipt', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  await writeFile(source.payload, '{}');
  await writeFile(
    source.entrypoint,
    copyingRunner(source.payload, source.receipt),
  );

  await expect(
    executeNativeLocalAttempt(source.request, source.inspectCheckout),
  ).rejects.toThrow('differ from the runner receipt');
  const [attempt] = await readdir(source.spoolRoot);
  assert.ok(attempt);
  expect(
    await readFile(join(source.spoolRoot, attempt, 'receipt.json')),
  ).toBeTruthy();
});

test('stops a timed-out runner and preserves its attempt for inspection', async ({}, testInfo) => {
  const source = await fixture(testInfo);
  await writeFile(source.entrypoint, 'setInterval(()=>{},1000)');

  await expect(
    executeNativeLocalAttempt(
      { ...source.request, timeoutMilliseconds: 500 },
      source.inspectCheckout,
    ),
  ).rejects.toMatchObject({ kind: 'timeout' });
  const [attempt] = await readdir(source.spoolRoot);
  assert.ok(attempt);
  expect(await readdir(join(source.spoolRoot, attempt))).toEqual([
    'runner-config.json',
  ]);
});
