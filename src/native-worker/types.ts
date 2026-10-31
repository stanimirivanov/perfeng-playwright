import type { SourceCheckoutArtifact } from '../source-checkout.js';

/** Host architectures accepted by the Native Worker contract. */
export type WorkerArchitecture = 'x64' | 'arm64';
/** Server-authoritative scheduling availability of a Native Worker. */
export type WorkerAvailability = 'AVAILABLE' | 'DRAINING' | 'UNAVAILABLE';
/** Qualification outcome for the reported environment and runner provenance. */
export type QualificationStatus = 'QUALIFIED' | 'UNQUALIFIED' | 'STALE';

interface WorkerPresenceConfigurationFields {
  controlPlaneOrigin: string;
  environment: {
    id: string;
    sha256: string;
  };
}

/** Non-secret configuration for the Native Worker v2 presence endpoint. */
export type WorkerPresenceConfiguration = WorkerPresenceConfigurationFields & {
  schemaVersion: 2;
  browsers: ['chromium'];
};

interface WorkerPresenceFields {
  agentVersion: string;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  qualificationEvidence: {
    environmentId: string;
    environmentSha256: string;
    runner: {
      kind: 'source-checkout';
      repository: string;
      revision: string;
      lockfile: 'pnpm-lock.yaml';
      lockfileSha256: string;
    };
  };
}

interface WorkerCapabilities {
  capacity: 1;
  tool: 'playwright';
  operatingSystem: 'linux';
  architecture: WorkerArchitecture;
  executionArtifacts: ['source-checkout'];
}

/** Closed Native Worker v2 presence document. */
export type WorkerPresence = WorkerPresenceFields & {
  protocolVersion: 2;
  capabilities: WorkerCapabilities & {
    browsers: ['chromium'];
    runnerContract: 2;
    artifactKinds: ['measurements', 'manifest'];
    diagnosticModes: ['baseline'];
  };
};

/** Server decision explaining whether the reported worker is qualified. */
export interface QualificationDecision {
  status: QualificationStatus;
  reasons: string[];
  validUntil?: string;
}

/** Server acknowledgement and next-heartbeat instruction for worker presence. */
export interface WorkerPresenceStatus {
  workerId: string;
  serverTime: string;
  nextHeartbeatSeconds: number;
  availability: WorkerAvailability;
  qualification: QualificationDecision;
  authorizedToAcquire: boolean;
}

export type NativeExecutionArtifact =
  | {
      kind: 'source-checkout';
      repository: string;
      revision: string;
      lockfile: string;
      lockfileSha256: string;
    }
  | {
      kind: 'release-archive';
      url: string;
      archiveSha256: string;
      executableSha256: string;
    };

export interface NativeArtifactPlanItem {
  slot: string;
  kind: string;
  mediaType: string;
  format: string;
  maximumBytes: number;
  required: boolean;
}

export type NativeExecutionPhase =
  'PREPARING' | 'RUNNING' | 'UPLOADING' | 'FINALIZING';

export type NativeLeaseReleaseReason =
  | 'CANCELLATION_REQUESTED'
  | 'LEASE_LOST'
  | 'WORKER_SHUTDOWN'
  | 'PREPARATION_FAILED';

export type NativeLeaseMutationFailureKind =
  'cancelled' | 'conflict' | 'lost' | 'permanent' | 'retryable';

export interface NativeUploadGrantDetails {
  grantId: string;
  leaseId: string;
  attemptId: string;
  runId: string;
  slot: string;
  objectKey: string;
  method: 'PUT';
  expiresAt: string;
  maximumBytes: number;
  sha256: string;
}

export interface NativeUploadAuthorization {
  url: string;
  method: 'PUT';
  headers: {
    'content-type': string;
    'x-amz-checksum-sha256': string;
  };
}

export interface NativeArtifactReference {
  artifactId: string;
  runId: string;
  attemptId: string;
  slot: string;
  kind: string;
  uri: string;
  size: number;
  sha256: string;
  mediaType: string;
  registeredAt: string;
}

export type NativeTerminalFailureCode =
  | 'PREPARATION_FAILED'
  | 'TOOL_FAILED'
  | 'CAPTURE_FAILED'
  | 'UPLOAD_FAILED'
  | 'HOST_BECAME_UNQUALIFIED';

export interface NativeTerminalFailure {
  code: NativeTerminalFailureCode;
  message: string;
  retryable: boolean;
}

export type NativeTerminalDisposition = 'ACCEPTED' | 'ALREADY_ACCEPTED';

export interface NativeTerminalAcknowledgement {
  attemptId: string;
  runRevision: number;
  disposition: NativeTerminalDisposition;
}

interface NativeLeaseRenewalFields {
  leaseId: string;
  attemptId: string;
  runRevision: number;
  serverTime: string;
  expiresAt: string;
  renewAfterSeconds: number;
}

export type NativeLeaseRenewal = NativeLeaseRenewalFields &
  (
    | { cancellationRequested: false }
    | { cancellationRequested: true; stopBy: string }
  );

export interface PresenceInputs {
  configuration: WorkerPresenceConfiguration;
  source: SourceCheckoutArtifact;
  agentVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
}
