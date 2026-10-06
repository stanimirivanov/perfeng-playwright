import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { inspectNativeAttemptSpool } from '../src/native-worker/spool-inspection.js';
import { parseWorkerCommand, workerMain } from '../src/worker-cli.js';

const attempt =
  'perf-20261006-120000-abcdef12-123e4567-e89b-12d3-a456-426614174000';

test('reports an empty spool without requiring worker credentials', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);

  expect(parseWorkerCommand(['spool-status', '--spool-root', root])).toEqual({
    action: 'spool-status',
    spoolRoot: root,
  });
  expect(await workerMain(['spool-status', '--spool-root', root], {})).toEqual({
    schema: 'native-spool-inspection/v1',
    hasRetainedState: false,
    entries: [],
  });
});

test('inventories partial evidence without changing it', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  const directory = join(root, attempt);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'runner-config.json'), 'sensitive config');
  await writeFile(join(directory, 'measurements.json'), 'partial evidence');

  expect(await inspectNativeAttemptSpool(root)).toEqual({
    schema: 'native-spool-inspection/v1',
    hasRetainedState: true,
    entries: [
      {
        name: attempt,
        kind: 'attempt',
        files: ['measurements.json', 'runner-config.json'],
      },
    ],
  });
  expect((await readdir(directory)).sort()).toEqual([
    'measurements.json',
    'runner-config.json',
  ]);
});

test('marks foreign paths without interpreting their bytes', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  await writeFile(join(root, 'unexpected.txt'), 'do not delete');

  expect(await inspectNativeAttemptSpool(root)).toEqual({
    schema: 'native-spool-inspection/v1',
    hasRetainedState: true,
    entries: [{ name: 'unexpected.txt', kind: 'unexpected' }],
  });
  expect(await readdir(root)).toEqual(['unexpected.txt']);
});

test('rejects a non-directory spool root', async ({}, testInfo) => {
  const path = testInfo.outputPath('spool-file');
  await writeFile(path, 'preserve me');

  await expect(inspectNativeAttemptSpool(path)).rejects.toThrow(
    'must be a real directory',
  );
  await expect(inspectNativeAttemptSpool('relative-spool')).rejects.toThrow(
    'must be absolute',
  );
});
