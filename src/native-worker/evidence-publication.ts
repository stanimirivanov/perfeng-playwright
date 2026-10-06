import type { PreparedNativeAttempt } from './attempt-preparation.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import {
  publishNativeArtifact,
  type NativeArtifactPublicationTransport,
  type NativeRevisionSource,
} from './artifact-publication.js';
import { loadNativeV2Measurements } from './local-artifacts.js';
import {
  publishNativeRawResultManifest,
  type PublishedNativeRawResultManifest,
} from './raw-result-publication.js';
import type { NativeArtifactReference } from './types.js';

export interface NativeV2EvidencePublicationRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeV2Lease;
  expectedRunRevision: NativeRevisionSource;
  prepared: PreparedNativeAttempt;
  /** Preserve this value when retrying a locally committed manifest. */
  createdAt?: string;
  signal: AbortSignal;
}

export interface PublishedNativeV2Evidence {
  measurements: NativeArtifactReference;
  manifest: PublishedNativeRawResultManifest;
}

/**
 * Publishes validated v2 measurements, then the manifest that references their
 * registered identity. The caller owns lease renewal and terminal reporting.
 * Partial remote publication is retained for explicit, lease-fenced recovery.
 * The caller must reuse the original createdAt for an exact manifest retry.
 */
export async function publishNativeV2Evidence(
  request: NativeV2EvidencePublicationRequest,
  transport?: NativeArtifactPublicationTransport,
  now: () => string = () => new Date().toISOString(),
): Promise<PublishedNativeV2Evidence> {
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('V2 evidence publication requires acquired v2 authority');
  }
  assertNotCancelled(request.signal);
  const loaded = await loadNativeV2Measurements(
    request.authority,
    request.prepared,
  );
  assertNotCancelled(request.signal);
  const measurementRequest = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    authority: request.authority,
    expectedRunRevision: request.expectedRunRevision,
    slot: 'measurements',
    path: loaded.artifact.path,
    size: loaded.artifact.size,
    sha256: loaded.artifact.sha256,
    mediaType: loaded.artifact.mediaType,
    signal: request.signal,
  };
  const measurements =
    transport === undefined
      ? await publishNativeArtifact(measurementRequest)
      : await publishNativeArtifact(measurementRequest, transport);
  assertNotCancelled(request.signal);

  const manifestRequest = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    authority: request.authority,
    expectedRunRevision: request.expectedRunRevision,
    path: request.prepared.manifestPath,
    measurements: loaded.measurements,
    registeredArtifacts: [measurements],
    createdAt: request.createdAt ?? now(),
    signal: request.signal,
  };
  const manifest =
    transport === undefined
      ? await publishNativeRawResultManifest(manifestRequest)
      : await publishNativeRawResultManifest(manifestRequest, transport);
  assertNotCancelled(request.signal);
  return { measurements, manifest };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Native v2 evidence publication was cancelled');
  }
}
