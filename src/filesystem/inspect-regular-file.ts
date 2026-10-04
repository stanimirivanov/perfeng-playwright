import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

const readChunkBytes = 64 * 1024;

export interface InspectedRegularFile {
  size: number;
  sha256: string;
  bytes?: Buffer;
}

/** Reads a bounded regular file through one handle and rejects changed path identity. */
export async function inspectRegularFile(
  path: string,
  maximumBytes: number,
  collectBytes: boolean,
): Promise<InspectedRegularFile> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new Error('Artifact is not a bounded regular file');
  }
  const handle = await open(path, 'r');
  let failure: Error | undefined;
  let result: InspectedRegularFile | undefined;
  try {
    result = await readStableFile(handle, path, before, collectBytes);
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error('Artifact read failed', { cause: error });
  }
  try {
    await handle.close();
  } catch (error) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, error],
        'Artifact read and close failed',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (result === undefined) {
    throw new Error('Artifact read produced no result');
  }
  return result;
}

async function readStableFile(
  handle: FileHandle,
  path: string,
  before: BigIntStats,
  collectBytes: boolean,
): Promise<InspectedRegularFile> {
  const opened = await handle.stat({ bigint: true });
  if (!sameFile(before, opened)) {
    throw new Error('Artifact changed before reading');
  }
  const size = Number(before.size);
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  const chunk = Buffer.allocUnsafe(readChunkBytes);
  let position = 0;
  while (position < size) {
    const length = Math.min(chunk.length, size - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead !== length) {
      throw new Error('Artifact changed while reading');
    }
    const bytes = chunk.subarray(0, bytesRead);
    hash.update(bytes);
    if (collectBytes) {
      chunks.push(Buffer.from(bytes));
    }
    position += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  const current = await lstat(path, { bigint: true });
  if (!sameFile(opened, after) || !sameFile(opened, current)) {
    throw new Error('Artifact changed while reading');
  }
  return {
    size,
    sha256: hash.digest('hex'),
    ...(collectBytes ? { bytes: Buffer.concat(chunks, size) } : {}),
  };
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}
