import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  publishNativeArtifact,
  type NativeArtifactPublicationTransport,
} from './artifact-publication.js';
import {
  serializeNativeRawResultManifest,
  type NativeRawResultRequest,
} from './raw-result.js';
import type { NativeArtifactReference } from './types.js';

export interface NativeRawResultPublicationRequest extends NativeRawResultRequest {
  controlPlaneOrigin: string;
  token: string;
  expectedRunRevision: number;
  path: string;
  signal?: AbortSignal;
}

export interface PublishedNativeRawResultManifest {
  reference: NativeArtifactReference;
  localArtifact: {
    path: string;
    size: number;
    sha256: string;
  };
}

/** Persists and publishes a manifest after its required evidence is registered. */
export async function publishNativeRawResultManifest(
  request: NativeRawResultPublicationRequest,
  transport?: NativeArtifactPublicationTransport,
): Promise<PublishedNativeRawResultManifest> {
  const bytes = serializeNativeRawResultManifest(request);
  await writeOrReuseExact(request.path, bytes);
  const integrity = {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const cancellation =
    request.signal === undefined ? {} : { signal: request.signal };
  const publication = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    authority: request.authority,
    expectedRunRevision: request.expectedRunRevision,
    slot: 'manifest',
    path: request.path,
    size: integrity.size,
    sha256: integrity.sha256,
    mediaType: 'application/json',
    ...cancellation,
  };
  const reference =
    transport === undefined
      ? await publishNativeArtifact(publication)
      : await publishNativeArtifact(publication, transport);

  return {
    reference,
    localArtifact: { path: request.path, ...integrity },
  };
}

async function writeOrReuseExact(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    } else if (isAlreadyExists(error)) {
      await verifyExisting(path, bytes);
      return;
    }
    throw error;
  }
}

async function verifyExisting(path: string, expected: Buffer): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      'Existing native raw-result manifest is not a regular file',
    );
  }
  const actual = await readFile(path);
  if (!actual.equals(expected)) {
    throw new Error('Existing native raw-result manifest does not match');
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
