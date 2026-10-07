import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { validateNativeRunnerReadiness } from '../src/native-worker/readiness.js';
import type { WorkerPresence } from '../src/native-worker/types.js';

async function fixture(root: string): Promise<{
  checkoutRoot: string;
  spoolRoot: string;
  presence: WorkerPresence;
  source: SourceCheckoutArtifact;
}> {
  const checkoutRoot = join(root, 'checkout');
  const spoolRoot = join(root, 'spool');
  await mkdir(join(checkoutRoot, 'dist'), { recursive: true });
  await mkdir(spoolRoot);
  await writeFile(join(checkoutRoot, 'dist', 'cli.js'), 'reviewed runner');
  const presence = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ) as WorkerPresence;
  const runner = presence.qualificationEvidence.runner;
  return {
    checkoutRoot,
    spoolRoot,
    presence,
    source: {
      kind: 'source-checkout',
      repository: runner.repository,
      gitSha: runner.revision,
      dependencyLock: {
        path: 'pnpm-lock.yaml',
        sha256: runner.lockfileSha256,
      },
    },
  };
}

test('accepts matching local runner evidence and a separate spool', async ({}, testInfo) => {
  const setup = await fixture(testInfo.outputPath('readiness'));
  const inspected: string[] = [];
  await validateNativeRunnerReadiness(setup, (root) => {
    inspected.push(root);
    return Promise.resolve(setup.source);
  });
  expect(inspected).toEqual([resolve(setup.checkoutRoot)]);
  expect(await readdir(setup.spoolRoot)).toEqual([]);
});

test('rejects source evidence changed since presence construction', async ({}, testInfo) => {
  const setup = await fixture(testInfo.outputPath('readiness'));
  await expect(
    validateNativeRunnerReadiness(setup, () =>
      Promise.resolve({ ...setup.source, gitSha: 'd'.repeat(40) }),
    ),
  ).rejects.toThrow('no longer matches advertised evidence');
  await expect(
    validateNativeRunnerReadiness(setup, () =>
      Promise.resolve({
        ...setup.source,
        dependencyLock: {
          path: 'pnpm-lock.yaml',
          sha256: 'b'.repeat(64),
        },
      }),
    ),
  ).rejects.toThrow('no longer matches advertised evidence');
  expect(await readdir(setup.spoolRoot)).toEqual([]);
});

test('refuses missing build and a spool inside the checkout', async ({}, testInfo) => {
  const setup = await fixture(testInfo.outputPath('readiness'));
  await expect(
    validateNativeRunnerReadiness(
      { ...setup, spoolRoot: setup.checkoutRoot },
      () => Promise.resolve(setup.source),
    ),
  ).rejects.toThrow('outside the runner checkout');
  const nestedSpool = join(setup.checkoutRoot, 'nested-spool');
  await mkdir(nestedSpool);
  await expect(
    validateNativeRunnerReadiness({ ...setup, spoolRoot: nestedSpool }, () =>
      Promise.resolve(setup.source),
    ),
  ).rejects.toThrow('outside the runner checkout');
  const unbuiltCheckout = join(testInfo.outputPath('readiness'), 'unbuilt');
  await mkdir(unbuiltCheckout);
  await expect(
    validateNativeRunnerReadiness(
      { ...setup, checkoutRoot: unbuiltCheckout },
      () => Promise.resolve(setup.source),
    ),
  ).rejects.toThrow();
  expect(await readdir(setup.spoolRoot)).toEqual([]);
});
