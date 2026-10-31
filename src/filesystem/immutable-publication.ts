import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Complete bytes and destination identity for one immutable file. */
export interface ImmutablePublicationFile {
  path: string;
  bytes: Buffer;
  description: string;
}

/** A fully written sibling file that has not yet been exposed at its destination. */
export interface StagedImmutableFile {
  file: ImmutablePublicationFile;
  directory: string;
  path: string;
}

type ExistingFilePolicy = 'reject' | 'reuse-exact';
type ExistingFileState = 'missing' | 'exact';

/** Filesystem effects used by immutable publication and its failure-focused tests. */
export interface ImmutablePublicationOperations {
  inspect(
    file: ImmutablePublicationFile,
    policy: ExistingFilePolicy,
  ): Promise<ExistingFileState>;
  stage(file: ImmutablePublicationFile): Promise<StagedImmutableFile>;
  publish(staged: StagedImmutableFile): Promise<void>;
  discardStage(staged: StagedImmutableFile): Promise<void>;
}

/**
 * Node filesystem adapter for process-crash-safe immutable publication.
 *
 * Staging uses the destination directory so a hard link can expose complete,
 * flushed bytes atomically without ever replacing an existing pathname.
 */
export const nodeImmutablePublicationOperations: ImmutablePublicationOperations =
  {
    inspect: inspectExistingFile,
    stage: stageFile,
    publish: ({ path, file }) => link(path, file.path),
    discardStage,
  };

/**
 * Publishes one complete file without exposing partially written bytes.
 *
 * `reuse-exact` makes retry after an interrupted return path idempotent. It
 * accepts only a regular, non-symlink file whose bytes match exactly.
 */
export async function publishImmutableFile(
  file: ImmutablePublicationFile,
  existing: ExistingFilePolicy,
  operations: ImmutablePublicationOperations = nodeImmutablePublicationOperations,
): Promise<void> {
  await prepareDestinations([file]);
  const state = await operations.inspect(file, existing);
  if (state === 'exact') {
    return;
  }

  let staged: StagedImmutableFile | undefined;
  let failure: Error | undefined;
  try {
    staged = await operations.stage(file);
    await exposeStagedFile(staged, existing, operations);
  } catch (error) {
    failure = thrownError(error);
  }

  const cleanupFailures =
    staged === undefined ? [] : await discardStages([staged], operations);
  throwPublicationFailure(failure, cleanupFailures);
}

/**
 * Publishes payloads before an exact receipt that commits the complete set.
 *
 * A retry may reuse complete payloads left by an interruption. An existing
 * receipt is accepted only when every payload and the receipt still match;
 * missing or changed files beneath a commit marker are treated as corruption.
 */
export async function publishCommittedFileSet(
  payloads: readonly ImmutablePublicationFile[],
  receipt: ImmutablePublicationFile,
  operations: ImmutablePublicationOperations = nodeImmutablePublicationOperations,
): Promise<void> {
  const files = [...payloads, receipt];
  await prepareDestinations(files);

  const receiptState = await operations.inspect(receipt, 'reuse-exact');
  const payloadStates: ExistingFileState[] = [];
  for (const payload of payloads) {
    payloadStates.push(await operations.inspect(payload, 'reuse-exact'));
  }
  if (receiptState === 'exact') {
    const missing = payloadStates.findIndex((state) => state === 'missing');
    if (missing !== -1) {
      throw committedSetIncomplete(receipt, payloads[missing]);
    }
    return;
  }

  const stagedByPath = new Map<string, StagedImmutableFile>();
  let failure: Error | undefined;
  try {
    for (const [index, payload] of payloads.entries()) {
      if (payloadStates[index] === 'missing') {
        stagedByPath.set(payload.path, await operations.stage(payload));
      }
    }
    stagedByPath.set(receipt.path, await operations.stage(receipt));

    for (const payload of payloads) {
      const staged = stagedByPath.get(payload.path);
      if (staged !== undefined) {
        await exposeStagedFile(staged, 'reuse-exact', operations);
      }
    }
    await exposeStagedFile(
      requiredStage(stagedByPath, receipt),
      'reuse-exact',
      operations,
    );
  } catch (error) {
    failure = thrownError(error);
  }

  const cleanupFailures = await discardStages(
    [...stagedByPath.values()],
    operations,
  );
  throwPublicationFailure(failure, cleanupFailures);
}

async function prepareDestinations(
  files: readonly ImmutablePublicationFile[],
): Promise<void> {
  const parents = [...new Set(files.map(({ path }) => dirname(path)))];
  await Promise.all(
    parents.map((directory) => mkdir(directory, { recursive: true })),
  );

  const canonical = await Promise.all(
    files.map(async ({ path }) => {
      const parent = await realpath(dirname(path));
      const key = join(parent, basename(path));
      return key;
    }),
  );
  if (new Set(canonical).size !== canonical.length) {
    throw new Error('Artifact output paths must be distinct');
  }
}

async function inspectExistingFile(
  file: ImmutablePublicationFile,
  policy: ExistingFilePolicy,
): Promise<ExistingFileState> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(file.path, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }

  if (policy === 'reject') {
    throw existingFileError(
      file,
      `Existing ${file.description} is not reusable`,
    );
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw existingFileError(
      file,
      `Existing ${file.description} is not a regular file`,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(file.path, 'r');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }
  let failure: Error | undefined;
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    const contentMatches = await fileHandleEquals(handle, file.bytes);
    const verifiedMetadata = await handle.stat({ bigint: true });
    const currentPathMetadata = await lstat(file.path, { bigint: true });
    if (
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino ||
      openedMetadata.size !== BigInt(file.bytes.length) ||
      !contentMatches ||
      verifiedMetadata.dev !== openedMetadata.dev ||
      verifiedMetadata.ino !== openedMetadata.ino ||
      verifiedMetadata.size !== openedMetadata.size ||
      verifiedMetadata.mtimeNs !== openedMetadata.mtimeNs ||
      currentPathMetadata.dev !== openedMetadata.dev ||
      currentPathMetadata.ino !== openedMetadata.ino ||
      !currentPathMetadata.isFile() ||
      currentPathMetadata.isSymbolicLink()
    ) {
      throw existingFileError(
        file,
        `Existing ${file.description} does not match`,
      );
    }
  } catch (error) {
    failure = thrownError(error);
  }
  const cleanupFailures: unknown[] = [];
  try {
    await handle.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  throwPublicationFailure(
    failure,
    cleanupFailures,
    'Existing file verification',
  );
  return 'exact';
}

async function fileHandleEquals(
  handle: FileHandle,
  expected: Buffer,
): Promise<boolean> {
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expected.length || 1));
  let position = 0;
  while (position < expected.length) {
    const length = Math.min(chunk.length, expected.length - position);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (
      bytesRead !== length ||
      !chunk
        .subarray(0, bytesRead)
        .equals(expected.subarray(position, position + bytesRead))
    ) {
      return false;
    }
    position += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(
    trailing,
    0,
    trailing.length,
    expected.length,
  );
  return bytesRead === 0;
}

async function stageFile(
  file: ImmutablePublicationFile,
): Promise<StagedImmutableFile> {
  const directory = await mkdtemp(
    join(dirname(file.path), '.perfeng-publication-'),
  );
  const staged: StagedImmutableFile = {
    file,
    directory,
    path: join(directory, 'content'),
  };
  let handle: FileHandle | undefined;
  let failure: Error | undefined;
  try {
    handle = await open(staged.path, 'wx');
    await handle.writeFile(file.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    failure = thrownError(error);
  }
  if (failure === undefined) {
    return staged;
  }

  const cleanupFailures: unknown[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  cleanupFailures.push(...(await discardStagePaths(staged)));
  throwPublicationFailure(failure, cleanupFailures, 'Immutable staging');
  throw new Error('Unreachable immutable publication state');
}

async function exposeStagedFile(
  staged: StagedImmutableFile,
  existing: ExistingFilePolicy,
  operations: ImmutablePublicationOperations,
): Promise<void> {
  try {
    await operations.publish(staged);
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST') || existing === 'reject') {
      throw error;
    }
    await operations.inspect(staged.file, 'reuse-exact');
  }
}

async function discardStage(staged: StagedImmutableFile): Promise<void> {
  const failures = await discardStagePaths(staged);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to remove staging for ${staged.file.description}`,
    );
  }
}

async function discardStagePaths(
  staged: StagedImmutableFile,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await unlink(staged.path);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      failures.push(error);
    }
  }
  try {
    await rmdir(staged.directory);
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) {
      failures.push(error);
    }
  }
  return failures;
}

async function discardStages(
  staged: readonly StagedImmutableFile[],
  operations: ImmutablePublicationOperations,
): Promise<unknown[]> {
  const outcomes = await Promise.allSettled(
    staged.map((value) => operations.discardStage(value)),
  );
  const failures: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      failures.push(outcome.reason as unknown);
    }
  }
  return failures;
}

function requiredStage(
  stagedByPath: ReadonlyMap<string, StagedImmutableFile>,
  file: ImmutablePublicationFile,
): StagedImmutableFile {
  const staged = stagedByPath.get(file.path);
  if (staged === undefined) {
    throw new Error(`Missing staging for ${file.description}`);
  }
  return staged;
}

function committedSetIncomplete(
  receipt: ImmutablePublicationFile,
  missing: ImmutablePublicationFile | undefined,
): Error {
  return new Error(
    `Existing ${receipt.description} commits an incomplete artifact set; ${missing?.description ?? 'a payload'} is missing`,
  );
}

function existingFileError(
  file: ImmutablePublicationFile,
  message: string,
): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  error.path = file.path;
  return error;
}

function throwPublicationFailure(
  failure: Error | undefined,
  cleanupFailures: readonly unknown[],
  operation = 'Immutable publication',
): void {
  if (failure !== undefined && cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures],
      `${operation} and cleanup failed`,
    );
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `${operation} completed but cleanup failed`,
    );
  }
}

function thrownError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('Immutable publication failed with a non-error value', {
        cause: value,
      });
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
