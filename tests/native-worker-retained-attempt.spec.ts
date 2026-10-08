import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { parseNativeExecutionRecipe } from '../src/native-worker/execution-recipe.js';
import { verifyRetainedAttemptMeasurements } from '../src/native-worker/retained-attempt.js';
import { parseWorkerCommand, workerMain } from '../src/worker-cli.js';

const attemptId = '22222222-2222-4222-8222-222222222222';

async function retainedAttempt(root: string): Promise<{
  name: string;
  directory: string;
  measurements: Buffer;
}> {
  const [leaseText, presenceText] = await Promise.all([
    readFile('vendor/contracts/native-worker/v2/examples/lease.json', 'utf8'),
    readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: Parameters<typeof parseNativeExecutionRecipe>[1];
  };
  const recipe = parseNativeExecutionRecipe(
    leaseText,
    presence.qualificationEvidence,
  );
  const name = `${recipe.runId}-${attemptId}`;
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const configuration = recipe.configuration;
  const measurements = Buffer.from('{"local":"bytes only"}\n');
  const receipt = {
    schema: 'playwright-runner-receipt/v2',
    runId: recipe.runId,
    testId: recipe.configuration.testId,
    producer: {
      name: 'playwright',
      version: '1.62.1',
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
    artifacts: {
      measurements: {
        sizeBytes: measurements.length,
        sha256: createHash('sha256').update(measurements).digest('hex'),
      },
    },
  };
  await writeFile(
    join(directory, 'runner-config.json'),
    JSON.stringify(configuration),
  );
  await writeFile(join(directory, 'measurements.json'), measurements);
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
  return { name, directory, measurements };
}

test('checks retained local bytes without a worker token or remote request', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  const retained = await retainedAttempt(root);
  const args = [
    'spool-verify',
    '--spool-root',
    root,
    '--attempt',
    retained.name,
  ];
  expect(parseWorkerCommand(args)).toEqual({
    action: 'spool-verify',
    spoolRoot: root,
    attemptName: retained.name,
  });
  expect(await workerMain(args, {})).toEqual({
    schema: 'native-retained-attempt-integrity/v1',
    runId: retained.name.slice(0, 29),
    attemptId,
    measurements: {
      sizeBytes: retained.measurements.length,
      sha256: createHash('sha256').update(retained.measurements).digest('hex'),
    },
    serverStateVerified: false,
  });
  expect((await readdir(retained.directory)).sort()).toEqual([
    'measurements.json',
    'receipt.json',
    'runner-config.json',
  ]);
});

test('rejects changed or missing measurements without editing retained files', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  const retained = await retainedAttempt(root);
  const path = join(retained.directory, 'measurements.json');
  await writeFile(path, 'different bytes');
  await expect(
    verifyRetainedAttemptMeasurements(root, retained.name),
  ).rejects.toThrow('differ from the runner receipt');
  expect(await readFile(path, 'utf8')).toBe('different bytes');
});

test('refuses missing and foreign receipts without claiming local integrity', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  const retained = await retainedAttempt(root);
  const receiptPath = join(retained.directory, 'receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<
    string,
    unknown
  >;
  receipt.runId = 'perf-20261007-120000-ffffffff';
  await writeFile(receiptPath, JSON.stringify(receipt));
  await expect(
    verifyRetainedAttemptMeasurements(root, retained.name),
  ).rejects.toThrow('receipt differs from the local configuration');
  await unlink(receiptPath);
  await expect(
    verifyRetainedAttemptMeasurements(root, retained.name),
  ).rejects.toThrow();
  expect(await readFile(join(retained.directory, 'measurements.json'))).toEqual(
    retained.measurements,
  );
});

test('rejects a foreign attempt name before reading outside the spool', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  await expect(
    verifyRetainedAttemptMeasurements(root, '../outside'),
  ).rejects.toThrow('attempt name is invalid');
});
