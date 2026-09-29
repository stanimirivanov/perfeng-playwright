import { createHash } from 'node:crypto';

import { publishImmutableFile } from '../filesystem/immutable-publication.js';
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

/**
 * Atomically persists, uploads, and registers the final raw-result manifest.
 *
 * Remote effects start only after complete local bytes are visible. A retry
 * may reuse an exact regular file left after remote failure; mismatched or
 * unsafe destinations fail without contacting the control plane. Cancellation
 * is forwarded to grant, upload, and registration requests.
 */
export async function publishNativeRawResultManifest(
  request: NativeRawResultPublicationRequest,
  transport?: NativeArtifactPublicationTransport,
): Promise<PublishedNativeRawResultManifest> {
  const bytes = serializeNativeRawResultManifest(request);
  await publishImmutableFile(
    {
      path: request.path,
      bytes,
      description: 'native raw-result manifest',
    },
    'reuse-exact',
  );
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
