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

export interface PresenceInputs {
  configuration: WorkerPresenceConfiguration;
  source: SourceCheckoutArtifact;
  agentVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
}
