import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { inspectSourceCheckout, type GitCommand } from '../src/index.js';

function gitOutput(values: Record<string, string>): GitCommand {
  return (arguments_) => {
    const value = values[arguments_.join(' ')];
    if (value === undefined) {
      return Promise.reject(
        new Error(`Unexpected Git command: ${arguments_.join(' ')}`),
      );
    }
    return Promise.resolve(value);
  };
}

test('identifies a clean native source checkout and exact dependency lock', async ({}, testInfo) => {
  const lock = Buffer.from('lockfileVersion: 9.0\n', 'utf8');
  await writeFile(testInfo.outputPath('pnpm-lock.yaml'), lock);
  const artifact = await inspectSourceCheckout(
    testInfo.outputDir,
    gitOutput({
      'status --porcelain=v1 --untracked-files=all': '',
      'rev-parse HEAD': `${'a'.repeat(40)}\n`,
      'remote get-url origin':
        'https://github.com/stanimirivanov/perfeng-playwright.git\n',
    }),
  );

  expect(artifact).toEqual({
    kind: 'source-checkout',
    repository: 'https://github.com/stanimirivanov/perfeng-playwright',
    gitSha: 'a'.repeat(40),
    dependencyLock: {
      path: 'pnpm-lock.yaml',
      sha256: createHash('sha256').update(lock).digest('hex'),
    },
  });
});

test('rejects a dirty checkout before claiming provenance', async ({}, testInfo) => {
  await expect(
    inspectSourceCheckout(
      testInfo.outputDir,
      gitOutput({
        'status --porcelain=v1 --untracked-files=all': ' M src/cli.ts\n',
      }),
    ),
  ).rejects.toThrow('must be clean');
});

test('rejects invalid revisions and unsafe repository locations', async ({}, testInfo) => {
  await writeFile(testInfo.outputPath('pnpm-lock.yaml'), 'lock');
  const base = {
    'status --porcelain=v1 --untracked-files=all': '',
    'rev-parse HEAD': `${'a'.repeat(40)}\n`,
    'remote get-url origin': 'https://github.com/example/runner.git\n',
  };
  await expect(
    inspectSourceCheckout(
      testInfo.outputDir,
      gitOutput({ ...base, 'rev-parse HEAD': 'main\n' }),
    ),
  ).rejects.toThrow('revision is invalid');
  await expect(
    inspectSourceCheckout(
      testInfo.outputDir,
      gitOutput({
        ...base,
        'remote get-url origin': 'ssh://git@example.com/runner.git\n',
      }),
    ),
  ).rejects.toThrow('credential-free HTTPS');
});
