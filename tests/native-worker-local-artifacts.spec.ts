import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { expect, test, type TestInfo } from '@playwright/test';

import { writeJourneyArtifacts } from '../src/journey/artifact.js';
import { prepareNativeAttempt } from '../src/native-worker/attempt-preparation.js';
import { verifyNativeAttemptArtifacts } from '../src/native-worker/local-artifacts.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

async function completedAttempt(testInfo: TestInfo) {
  const source = await nativeV2RawResultRequest();
  const { authority, measurements } = source;
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
  return { authority, prepared };
}

test('verifies exact baseline measurement bytes and committed receipt', async ({}, testInfo) => {
  const { authority, prepared } = await completedAttempt(testInfo);
  const bytes = await readFile(prepared.measurementsPath);

  expect(await verifyNativeAttemptArtifacts(authority, prepared)).toEqual({
    path: prepared.measurementsPath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'application/json',
  });
});

test('rejects changed measurement bytes after the receipt commit', async ({}, testInfo) => {
  const { authority, prepared } = await completedAttempt(testInfo);
  await writeFile(prepared.measurementsPath, '{"changed":true}\n');

  await expect(
    verifyNativeAttemptArtifacts(authority, prepared),
  ).rejects.toThrow('differ from the runner receipt');
});

test('rejects a receipt with foreign source provenance', async ({}, testInfo) => {
  const { authority, prepared } = await completedAttempt(testInfo);
  const receipt = JSON.parse(await readFile(prepared.receiptPath, 'utf8')) as {
    producer: { artifact: { gitSha: string } };
  };
  receipt.producer.artifact.gitSha = 'f'.repeat(40);
  await writeFile(prepared.receiptPath, JSON.stringify(receipt));

  await expect(
    verifyNativeAttemptArtifacts(authority, prepared),
  ).rejects.toThrow('receipt differs from the lease');
});

test('rejects unexpected diagnostic slots in a baseline receipt', async ({}, testInfo) => {
  const { authority, prepared } = await completedAttempt(testInfo);
  const receipt = JSON.parse(await readFile(prepared.receiptPath, 'utf8')) as {
    artifacts: Record<string, unknown>;
  };
  receipt.artifacts.observations = { sha256: 'a'.repeat(64), sizeBytes: 1 };
  await writeFile(prepared.receiptPath, JSON.stringify(receipt));

  await expect(
    verifyNativeAttemptArtifacts(authority, prepared),
  ).rejects.toThrow('missing or unknown fields');
});

test('rejects a missing receipt and preserves partial measurements', async ({}, testInfo) => {
  const source = await nativeV2RawResultRequest();
  const runner = source.authority.recipe.executionArtifact;
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);
  const prepared = await prepareNativeAttempt(
    { authority: source.authority, spoolRoot },
    () =>
      Promise.resolve({
        kind: 'source-checkout' as const,
        repository: runner.repository,
        gitSha: runner.revision,
        dependencyLock: {
          path: 'pnpm-lock.yaml' as const,
          sha256: runner.lockfileSha256,
        },
      }),
  );
  await writeFile(prepared.measurementsPath, 'partial evidence');

  await expect(
    verifyNativeAttemptArtifacts(source.authority, prepared),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(prepared.measurementsPath, 'utf8')).toBe(
    'partial evidence',
  );
});

test('rejects a receipt above the local bound and a redirected output path', async ({}, testInfo) => {
  const { authority, prepared } = await completedAttempt(testInfo);
  await writeFile(prepared.receiptPath, Buffer.alloc(64 * 1024 + 1));
  await expect(
    verifyNativeAttemptArtifacts(authority, prepared),
  ).rejects.toThrow('not a bounded regular file');
  await expect(
    verifyNativeAttemptArtifacts(authority, {
      ...prepared,
      measurementsPath: testInfo.outputPath('elsewhere'),
    }),
  ).rejects.toThrow('paths differ from the lease');
});
