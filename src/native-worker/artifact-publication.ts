import type { AcquiredNativeLease } from './acquisition.js';
import type { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { registerNativeArtifact } from './artifact-registration.js';
import { uploadNativeArtifact } from './artifact-upload.js';
import type { NativeArtifactReference } from './types.js';
import { createNativeUploadGrant } from './upload-grant.js';

export interface NativeArtifactPublicationRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: number;
  slot: string;
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
  signal?: AbortSignal;
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
      expectedRunRevision: request.expectedRunRevision,
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

  return registerNativeArtifact(
    {
      controlPlaneOrigin: request.controlPlaneOrigin,
      token: request.token,
      authority: request.authority,
      grant,
      expectedRunRevision: request.expectedRunRevision,
      size: request.size,
      sha256: request.sha256,
      ...cancellation,
    },
    transport.controlPlane,
  );
}
