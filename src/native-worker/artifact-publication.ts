import type { AcquiredNativeLease } from './acquisition.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import {
  ArtifactRegistrationFailure,
  registerNativeArtifact,
  type ArtifactRegistrationRequest,
} from './artifact-registration.js';
import { uploadNativeArtifact } from './artifact-upload.js';
import type { NativeArtifactReference } from './types.js';
import { createNativeUploadGrant } from './upload-grant.js';

export interface NativeArtifactPublicationRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: NativeRevisionSource;
  slot: string;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
  signal?: AbortSignal;
}

/** A fixed revision or a live lease-supervisor revision read at each mutation. */
export type NativeRevisionSource = number | (() => number);

export function currentNativeRevision(source: NativeRevisionSource): number {
  return typeof source === 'number' ? source : source();
}

export interface NativeArtifactPublicationTransport {
  controlPlane: typeof fetch;
  objectStore: typeof fetch;
}

const defaultTransport: NativeArtifactPublicationTransport = {
  controlPlane: fetch,
  objectStore: fetch,
};

export async function publishNativeArtifact(
  request: NativeArtifactPublicationRequest,
  transport: NativeArtifactPublicationTransport = defaultTransport,
): Promise<NativeArtifactReference> {
  const cancellation =
    request.signal === undefined ? {} : { signal: request.signal };
  const grant = await createNativeUploadGrant(
    {
      controlPlaneOrigin: request.controlPlaneOrigin,
      token: request.token,
      authority: request.authority,
      expectedRunRevision: currentNativeRevision(request.expectedRunRevision),
      slot: request.slot,
      size: request.size,
      sha256: request.sha256,
      mediaType: request.mediaType,
      ...cancellation,
    },
    transport.controlPlane,
  );

  await uploadNativeArtifact(
    {
      grant,
      path: request.path,
      size: request.size,
      sha256: request.sha256,
      mediaType: request.mediaType,
      ...cancellation,
    },
    transport.objectStore,
  );

  const registration: ArtifactRegistrationRequest = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    authority: request.authority,
    grant,
    expectedRunRevision: currentNativeRevision(request.expectedRunRevision),
    size: request.size,
    sha256: request.sha256,
    ...cancellation,
  };
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    return registerNativeArtifact(registration, transport.controlPlane);
  }
  return registerNativeV2ArtifactWithExactRetry(
    registration,
    transport.controlPlane,
  );
}

/** Repeats only the registration claim, never the completed object transfer. */
async function registerNativeV2ArtifactWithExactRetry(
  request: ArtifactRegistrationRequest,
  send: typeof fetch,
): Promise<NativeArtifactReference> {
  try {
    return await registerNativeArtifact(request, send);
  } catch (error) {
    if (
      !(error instanceof ArtifactRegistrationFailure) ||
      error.kind !== 'retryable' ||
      error.retryAfterSeconds !== undefined
    ) {
      throw error;
    }
    if (request.signal?.aborted) {
      throw new ArtifactRegistrationFailure(
        'Native artifact registration was cancelled',
        'cancelled',
      );
    }
  }
  return registerNativeArtifact(request, send);
}
