import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { parseCommand } from '../src/cli.js';
import { readRunnerConfiguration } from '../src/configuration/read.js';
import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition.js';
import { prepareNativeAttempt } from '../src/native-worker/attempt-preparation.js';
import {
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';

const capability = 'lease-capability-must-not-appear-on-disk';

async function assignedAttempt(): Promise<{
  authority: AcquiredNativeV2Lease;
  checkout: SourceCheckoutArtifact;
}> {
  const [leaseText, presenceText] = await Promise.all([
    readFile('vendor/contracts/native-worker/v2/examples/lease.json', 'utf8'),
    readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  const evidence = presence.qualificationEvidence;
  return {
    authority: new AcquiredNativeV2Lease(
      parseNativeExecutionRecipe(leaseText, evidence),
      capability,
    ),
    checkout: {
      kind: 'source-checkout',
      repository: evidence.runner.repository,
      gitSha: evidence.runner.revision,
      dependencyLock: {
        path: 'pnpm-lock.yaml',
        sha256: evidence.runner.lockfileSha256,
      },
    },
  };
}

test('prepares a closed baseline command in one exclusive attempt directory', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);

  const prepared = await prepareNativeAttempt({ authority, spoolRoot }, () =>
    Promise.resolve(checkout),
  );
  const configuration = await readRunnerConfiguration(
    prepared.configurationPath,
  );
  expect(configuration).toEqual(authority.recipe.configuration);
  expect(parseCommand([...prepared.runnerArguments])).toEqual({
    configurationPath: prepared.configurationPath,
    outputPath: prepared.measurementsPath,
    receiptOutputPath: prepared.receiptPath,
  });
  expect(prepared.directory).toBe(
    join(spoolRoot, `${authority.recipe.runId}-${authority.recipe.attemptId}`),
  );
  expect(await readdir(prepared.directory)).toEqual(['runner-config.json']);
  const bytes = await readFile(prepared.configurationPath, 'utf8');
  expect(bytes).not.toContain(capability);
  expect(bytes).not.toContain('PERFENG_NATIVE_WORKER_TOKEN');
});

test('rejects stale source evidence before creating attempt state', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);

  await expect(
    prepareNativeAttempt({ authority, spoolRoot }, () =>
      Promise.resolve({ ...checkout, gitSha: 'f'.repeat(40) }),
    ),
  ).rejects.toThrow('differs from the assigned revision');
  expect(await readdir(spoolRoot)).toEqual([]);
});

test('rejects mutated recipe data before creating attempt state', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);
  authority.recipe.configuration.target.baseUrl =
    'https://user:secret@sut.perfeng.invalid/';

  await expect(
    prepareNativeAttempt({ authority, spoolRoot }, () =>
      Promise.resolve(checkout),
    ),
  ).rejects.toThrow('target.baseUrl');
  expect(await readdir(spoolRoot)).toEqual([]);
});

test('rejects a changed artifact plan before creating attempt state', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);
  authority.recipe.artifactPlan[0].format = 'wrong-format';

  await expect(
    prepareNativeAttempt({ authority, spoolRoot }, () =>
      Promise.resolve(checkout),
    ),
  ).rejects.toThrow('differs from the v2 baseline recipe');
  expect(await readdir(spoolRoot)).toEqual([]);
});

test('does not reuse or replace an existing attempt directory', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool');
  const existing = join(
    spoolRoot,
    `${authority.recipe.runId}-${authority.recipe.attemptId}`,
  );
  await mkdir(existing, { recursive: true });
  const marker = join(existing, 'operator-file');
  await writeFile(marker, 'preserve me');

  await expect(
    prepareNativeAttempt({ authority, spoolRoot }, () =>
      Promise.resolve(checkout),
    ),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(marker, 'utf8')).toBe('preserve me');
  expect(await readdir(existing)).toEqual(['operator-file']);
});

test('rejects a non-directory spool root without creating outputs', async ({}, testInfo) => {
  const { authority, checkout } = await assignedAttempt();
  const spoolRoot = testInfo.outputPath('spool-file');
  await writeFile(spoolRoot, 'preserve me');

  await expect(
    prepareNativeAttempt({ authority, spoolRoot }, () =>
      Promise.resolve(checkout),
    ),
  ).rejects.toThrow('must be a real directory');
  expect(await readFile(spoolRoot, 'utf8')).toBe('preserve me');
});
