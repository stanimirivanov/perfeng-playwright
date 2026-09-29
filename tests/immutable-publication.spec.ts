import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  nodeImmutablePublicationOperations,
  publishCommittedFileSet,
  publishImmutableFile,
  type ImmutablePublicationFile,
  type ImmutablePublicationOperations,
} from '../src/filesystem/immutable-publication.js';

interface PublicationCallbacks {
  afterStage?: (file: ImmutablePublicationFile) => Promise<void>;
  beforePublish?: (file: ImmutablePublicationFile) => Promise<void>;
}

async function withTemporaryDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-publication-'));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function publicationFile(
  path: string,
  value: string,
): ImmutablePublicationFile {
  const bytes = Buffer.from(value, 'utf8');
  return {
    path,
    bytes,
    description: basename(path),
  };
}

function observingOperations(
  callbacks: PublicationCallbacks,
): ImmutablePublicationOperations {
  return {
    ...nodeImmutablePublicationOperations,
    stage: async (file) => {
      const staged = await nodeImmutablePublicationOperations.stage(file);
      await callbacks.afterStage?.(file);
      return staged;
    },
    publish: async (staged) => {
      await callbacks.beforePublish?.(staged.file);
      return nodeImmutablePublicationOperations.publish(staged);
    },
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

test('keeps staged files invisible and publishes the receipt last', async () => {
  await withTemporaryDirectory(async (directory) => {
    const measurements = publicationFile(
      join(directory, 'measurements.json'),
      '{"measurements":[1]}',
    );
    const observations = publicationFile(
      join(directory, 'observations.json'),
      '{"observations":[1]}',
    );
    const receipt = publicationFile(
      join(directory, 'receipt.json'),
      '{"committed":true}',
    );
    const files = [measurements, observations, receipt];
    const published: string[] = [];
    let payloadsCompleteBeforeReceipt = false;
    const operations = observingOperations({
      afterStage: async () => {
        for (const file of files) {
          await expectMissing(file.path);
        }
      },
      beforePublish: async (file) => {
        published.push(basename(file.path));
        await expectMissing(receipt.path);
        if (file === receipt) {
          const [measurementBytes, observationBytes] = await Promise.all([
            readFile(measurements.path),
            readFile(observations.path),
          ]);
          payloadsCompleteBeforeReceipt =
            measurementBytes.equals(measurements.bytes) &&
            observationBytes.equals(observations.bytes);
        }
      },
    });

    await publishCommittedFileSet(
      [measurements, observations],
      receipt,
      operations,
    );

    expect(published).toEqual([
      'measurements.json',
      'observations.json',
      'receipt.json',
    ]);
    expect(payloadsCompleteBeforeReceipt).toBe(true);
    await expect(readFile(receipt.path)).resolves.toEqual(receipt.bytes);
  });
});

test('retains complete payloads and preserves a late foreign receipt', async () => {
  await withTemporaryDirectory(async (directory) => {
    const measurements = publicationFile(
      join(directory, 'measurements.json'),
      '{"measurements":[1]}',
    );
    const observations = publicationFile(
      join(directory, 'observations.json'),
      '{"observations":[1]}',
    );
    const receipt = publicationFile(
      join(directory, 'receipt.json'),
      '{"committed":true}',
    );
    const foreignReceipt = Buffer.from('{"foreign":true}', 'utf8');
    const operations = observingOperations({
      beforePublish: async (file) => {
        if (file === receipt) {
          await writeFile(receipt.path, foreignReceipt, { flag: 'wx' });
        }
      },
    });

    await expect(
      publishCommittedFileSet(
        [measurements, observations],
        receipt,
        operations,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    await expect(readFile(measurements.path)).resolves.toEqual(
      measurements.bytes,
    );
    await expect(readFile(observations.path)).resolves.toEqual(
      observations.bytes,
    );
    await expect(readFile(receipt.path)).resolves.toEqual(foreignReceipt);
    expect((await readdir(directory)).sort()).toEqual([
      'measurements.json',
      'observations.json',
      'receipt.json',
    ]);
  });
});

test('ignores and preserves an orphaned staging directory', async () => {
  await withTemporaryDirectory(async (directory) => {
    const orphanDirectory = join(directory, '.perfeng-publication-orphan');
    const markerPath = join(orphanDirectory, 'owned-by-another-attempt');
    await mkdir(orphanDirectory);
    await writeFile(markerPath, 'preserve', 'utf8');
    const artifact = publicationFile(
      join(directory, 'artifact.json'),
      '{"value":1}',
    );

    await publishImmutableFile(artifact, 'reject');

    await expect(readFile(artifact.path)).resolves.toEqual(artifact.bytes);
    await expect(readFile(markerPath, 'utf8')).resolves.toBe('preserve');
  });
});

test('rejects an existing non-regular destination without changing it', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'artifact.json');
    await mkdir(path);
    const artifact = publicationFile(path, '{"value":1}');

    await expect(
      publishImmutableFile(artifact, 'reuse-exact'),
    ).rejects.toMatchObject({
      code: 'EEXIST',
      message: 'Existing artifact.json is not a regular file',
    });
    await expect(readdir(path)).resolves.toEqual([]);
  });
});

test('lets identical concurrent committed publishers converge', async () => {
  await withTemporaryDirectory(async (directory) => {
    const payload = publicationFile(
      join(directory, 'payload.json'),
      '{"value":1}',
    );
    const receipt = publicationFile(
      join(directory, 'receipt.json'),
      '{"payload":"one"}',
    );

    await Promise.all([
      publishCommittedFileSet([payload], receipt),
      publishCommittedFileSet([payload], receipt),
    ]);

    await expect(readFile(payload.path)).resolves.toEqual(payload.bytes);
    await expect(readFile(receipt.path)).resolves.toEqual(receipt.bytes);
    expect((await readdir(directory)).sort()).toEqual([
      'payload.json',
      'receipt.json',
    ]);
  });
});

test('does not repair missing payloads beneath an existing receipt', async () => {
  await withTemporaryDirectory(async (directory) => {
    const payload = publicationFile(
      join(directory, 'payload.json'),
      '{"value":1}',
    );
    const receipt = publicationFile(
      join(directory, 'receipt.json'),
      '{"payload":"one"}',
    );
    await publishCommittedFileSet([payload], receipt);
    await unlink(payload.path);

    await expect(publishCommittedFileSet([payload], receipt)).rejects.toThrow(
      'commits an incomplete artifact set',
    );

    await expectMissing(payload.path);
    await expect(readFile(receipt.path)).resolves.toEqual(receipt.bytes);
  });
});

test('never overwrites files from a conflicting concurrent publisher', async () => {
  await withTemporaryDirectory(async (directory) => {
    const payloadPath = join(directory, 'payload.json');
    const receiptPath = join(directory, 'receipt.json');
    const first = {
      payload: publicationFile(payloadPath, '{"value":"first"}'),
      receipt: publicationFile(receiptPath, '{"payload":"first"}'),
    };
    const second = {
      payload: publicationFile(payloadPath, '{"value":"second"}'),
      receipt: publicationFile(receiptPath, '{"payload":"second"}'),
    };

    const results = await Promise.allSettled([
      publishCommittedFileSet([first.payload], first.receipt),
      publishCommittedFileSet([second.payload], second.receipt),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejection = results.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'EEXIST' },
    });
    const publishedPair = [
      (await readFile(payloadPath)).toString('utf8'),
      (await readFile(receiptPath)).toString('utf8'),
    ];
    expect([
      [
        first.payload.bytes.toString('utf8'),
        first.receipt.bytes.toString('utf8'),
      ],
      [
        second.payload.bytes.toString('utf8'),
        second.receipt.bytes.toString('utf8'),
      ],
    ]).toContainEqual(publishedPair);
  });
});

test('fails closed when the filesystem cannot publish a hard link', async () => {
  await withTemporaryDirectory(async (directory) => {
    const artifact = publicationFile(
      join(directory, 'artifact.json'),
      '{"value":1}',
    );
    const unsupported = Object.assign(
      new Error('Hard links are not supported'),
      { code: 'EXDEV' },
    );
    const operations: ImmutablePublicationOperations = {
      ...nodeImmutablePublicationOperations,
      publish: () => Promise.reject(unsupported),
    };

    await expect(
      publishImmutableFile(artifact, 'reject', operations),
    ).rejects.toMatchObject({ code: 'EXDEV' });
    await expectMissing(artifact.path);
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});
