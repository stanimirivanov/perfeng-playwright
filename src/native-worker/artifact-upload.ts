import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';

import { requiredString } from '../configuration/primitives.js';
import {
  absoluteHttpsUrl,
  boundedInteger,
  contractSha256,
  patternString,
} from './contract-values.js';
import { discardResponse } from './transport.js';
import type { AcquiredNativeUploadGrant } from './upload-grant.js';

const uploadTimeoutMilliseconds = 5 * 60 * 1_000;
const maximumArtifactBytes = 512 * 1024 * 1024;
const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

export type NativeArtifactUploadFailureKind =
  'cancelled' | 'local-artifact' | 'rejected' | 'retryable';

export class NativeArtifactUploadFailure extends Error {
  readonly kind: NativeArtifactUploadFailureKind;

  constructor(message: string, kind: NativeArtifactUploadFailureKind) {
    super(message);
    this.name = 'NativeArtifactUploadFailure';
    this.kind = kind;
  }
}

export interface NativeArtifactUploadRequest {
  grant: AcquiredNativeUploadGrant;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
  signal?: AbortSignal;
}

interface ArtifactDeclaration {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

export async function uploadNativeArtifact(
  request: NativeArtifactUploadRequest,
  send: typeof fetch = fetch,
): Promise<void> {
  const declaration = artifactDeclaration(request);
  const timeout = AbortSignal.timeout(uploadTimeoutMilliseconds);
  const signal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  if (signal.aborted) {
    throw new NativeArtifactUploadFailure(
      'Native artifact upload was cancelled',
      'cancelled',
    );
  }

  let artifact: Blob;
  try {
    artifact = await openAsBlob(declaration.path, {
      type: declaration.mediaType,
    });
  } catch {
    throw localArtifactFailure();
  }
  if (artifact.size !== declaration.size) {
    throw localArtifactFailure();
  }
  const digest = await hashArtifact(artifact, signal);
  if (digest !== declaration.sha256) {
    throw localArtifactFailure();
  }

  await request.grant.useAuthorization(async (authorization) => {
    validateAuthorization(request.grant, declaration, authorization);
    let response: Response;
    try {
      response = await send(authorization.url, {
        method: authorization.method,
        redirect: 'error',
        headers: authorization.headers,
        body: artifact,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new NativeArtifactUploadFailure(
          'Native artifact upload was cancelled',
          'cancelled',
        );
      }
      if (error instanceof DOMException && error.name === 'NotReadableError') {
        throw localArtifactFailure();
      }
      throw new NativeArtifactUploadFailure(
        'Native artifact upload request failed',
        'retryable',
      );
    }
    await discardResponse(response);
    if (response.status !== 200) {
      throw uploadFailure(response.status);
    }
  });
}

function artifactDeclaration(
  request: NativeArtifactUploadRequest,
): ArtifactDeclaration {
  const path = requiredString(request.path, 'path');
  const size = boundedInteger(request.size, 'size', 1, maximumArtifactBytes);
  const sha256 = contractSha256(request.sha256, 'sha256');
  const mediaType = patternString(
    request.mediaType,
    'mediaType',
    mediaTypePattern,
  );
  if (
    request.grant.grant.sha256 !== sha256 ||
    size > request.grant.grant.maximumBytes
  ) {
    throw new Error('Artifact declaration does not match the upload grant');
  }

  return { path, size, sha256, mediaType };
}

async function hashArtifact(
  artifact: Blob,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const reader = artifact.stream().getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (signal.aborted) {
        await reader.cancel();
        throw new NativeArtifactUploadFailure(
          'Native artifact upload was cancelled',
          'cancelled',
        );
      }
      hash.update(result.value);
      result = await reader.read();
    }
  } catch (error) {
    if (error instanceof NativeArtifactUploadFailure) {
      throw error;
    }
    throw localArtifactFailure();
  } finally {
    reader.releaseLock();
  }

  return hash.digest('hex');
}

function validateAuthorization(
  grant: AcquiredNativeUploadGrant,
  declaration: ArtifactDeclaration,
  authorization: {
    url: string;
    method: 'PUT';
    headers: {
      'content-type': string;
      'x-amz-checksum-sha256': string;
    };
  },
): void {
  const url = absoluteHttpsUrl(authorization.url, 'uploadUrl');
  const parsed = new URL(url);
  const expectedChecksum = Buffer.from(declaration.sha256, 'hex').toString(
    'base64',
  );
  if (
    parsed.search === '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith(`/${grant.grant.objectKey}`) ||
    authorization.headers['content-type'] !== declaration.mediaType ||
    authorization.headers['x-amz-checksum-sha256'] !== expectedChecksum
  ) {
    throw new Error('Upload authorization does not match the artifact');
  }
}

function localArtifactFailure(): NativeArtifactUploadFailure {
  return new NativeArtifactUploadFailure(
    'Native artifact bytes do not match the upload grant',
    'local-artifact',
  );
}

function uploadFailure(status: number): NativeArtifactUploadFailure {
  const retryable = new Set([408, 429, 500, 502, 503, 504]).has(status);
  return new NativeArtifactUploadFailure(
    `Native artifact upload was rejected with status ${String(status)}`,
    retryable ? 'retryable' : 'rejected',
  );
}
