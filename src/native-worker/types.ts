import type { SourceCheckoutArtifact } from '../source-checkout.js';

export type WorkerArchitecture = 'x64' | 'arm64';
export type BrowserFamily = 'chromium' | 'chrome' | 'edge';
export type WorkerAvailability = 'AVAILABLE' | 'DRAINING' | 'UNAVAILABLE';
export type QualificationStatus = 'QUALIFIED' | 'UNQUALIFIED' | 'STALE';

export interface WorkerPresenceConfiguration {
  schemaVersion: 1;
  controlPlaneOrigin: string;
  browsers: BrowserFamily[];
  environment: {
    id: string;
    sha256: string;
  };
}

export interface WorkerPresence {
  protocolVersion: 1;
  agentVersion: string;
  availability: 'UNAVAILABLE';
  capabilities: {
    capacity: 1;
    tool: 'playwright';
    operatingSystem: 'windows';
    architecture: WorkerArchitecture;
    browsers: BrowserFamily[];
    runnerContract: 1;
    executionArtifacts: ['source-checkout'];
    artifactKinds: ['measurements', 'diagnostics'];
    diagnosticModes: ['lightweight', 'trace', 'heap'];
  };
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

export interface QualificationDecision {
  status: QualificationStatus;
  reasons: string[];
  validUntil?: string;
}

export interface WorkerPresenceStatus {
  workerId: string;
  serverTime: string;
  nextHeartbeatSeconds: number;
  availability: WorkerAvailability;
  qualification: QualificationDecision;
  authorizedToAcquire: boolean;
}

export type WorkerDiagnosticMode =
  'lightweight' | 'trace' | 'heap' | 'cpu-profile';

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

export interface NativeExecutionAssignment {
  catalogueTestId: string;
  workloadId: string;
  profile: string;
  target: {
    environmentId: string;
    baseUrl: string;
  };
  browser: BrowserFamily;
  diagnosticMode: WorkerDiagnosticMode;
  executionArtifact: NativeExecutionArtifact;
}

export interface NativeArtifactPlanItem {
  slot: string;
  kind: string;
  mediaType: string;
  format: string;
  maximumBytes: number;
  required: boolean;
}

export interface NativeLease {
  leaseId: string;
  attemptId: string;
  runId: string;
  runRevision: number;
  issuedAt: string;
  expiresAt: string;
  renewAfterSeconds: number;
  assignment: NativeExecutionAssignment;
  artifactPlan: NativeArtifactPlanItem[];
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
