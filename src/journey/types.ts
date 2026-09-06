import type { Page } from '@playwright/test';

import type { InteractionMeasurement } from '../interaction/types.js';
import type { MemoryCensus, MemoryEvidence } from '../memory/types.js';
import type { PageObservation } from '../observation/types.js';
import type { PerformanceTrace } from '../trace/types.js';

export type CacheProfile = 'cold' | 'warm';
export type PageReuse = 'per-iteration' | 'per-run';
export type DiagnosticMode =
  'baseline' | 'lightweight' | 'trace' | 'memory' | 'smoothness';
export type WorkloadProfile =
  'smoke' | 'average' | 'regression' | 'stress' | 'capacity' | 'soak';

export interface WorkloadIdentity {
  id: string;
  version: string;
  profile: WorkloadProfile;
  sha256: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface EnvironmentIdentity {
  profile: {
    id: string;
    version: string;
  };
  fingerprint: string;
}

export interface RunJourneyOptions {
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  cacheProfile: CacheProfile;
  pageReuse: PageReuse;
  diagnosticMode: DiagnosticMode;
  environment: EnvironmentIdentity;
  warmupIterations: number;
  measurementIterations: number;
  captureIterations?: number[];
  journey: (page: Page) => Promise<InteractionMeasurement[]>;
  headless?: boolean;
  viewport?: Viewport;
  deviceScaleFactor?: number;
}

export interface PlaywrightMeasurement extends InteractionMeasurement {
  iteration: number;
}

export interface PlaywrightMeasurements {
  schemaVersion: 2;
  kind: 'PlaywrightMeasurements';
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  scenario: {
    cacheProfile: CacheProfile;
    contextReuse: 'per-iteration' | 'per-run';
    pageReuse: PageReuse;
    warmupIterations: number;
    measurementIterations: number;
  };
  diagnosticMode: DiagnosticMode;
  environment: EnvironmentIdentity;
  runtime: {
    playwrightVersion: string;
    nodeVersion: string;
    platform: 'linux' | 'darwin' | 'win32';
    architecture: 'x64' | 'arm64';
  };
  browser: {
    name: 'chromium' | 'firefox' | 'webkit';
    version: string;
    headless: boolean;
    viewport: Viewport;
    deviceScaleFactor: number;
  };
  measurementWindow: {
    start: string;
    end: string;
  };
  createdAt: string;
  measurements: PlaywrightMeasurement[];
}

export interface WrittenMeasurementArtifact {
  sha256: string;
  sizeBytes: number;
}

export interface IterationPageObservation {
  iteration: number;
  observation: PageObservation;
}

export interface BrowserObservations {
  schemaVersion: 1;
  kind: 'BrowserObservations';
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  environment: EnvironmentIdentity;
  execution: {
    mode: 'lightweight';
    contextReuse: 'per-iteration' | 'per-run';
    pageReuse: PageReuse;
    captureIterations: number[];
  };
  captureWindow: {
    start: string;
    end: string;
  };
  observations: IterationPageObservation[];
  createdAt: string;
}

export interface IterationPerformanceTrace extends PerformanceTrace {
  iteration: number;
}

export interface JourneyMemoryCapture {
  captureIterations: number[];
  before: MemoryEvidence;
  after: MemoryEvidence;
}

export interface JourneyCapture {
  measurements: PlaywrightMeasurements;
  observations?: BrowserObservations;
  trace?: IterationPerformanceTrace;
  memory?: JourneyMemoryCapture;
}

export interface WrittenTraceArtifact extends WrittenMeasurementArtifact {
  iteration: number;
  format: 'chrome-trace-json-gzip';
  mediaType: 'application/gzip';
  dataLossOccurred: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface WrittenHeapSnapshotArtifact extends WrittenMeasurementArtifact {
  capturedAt: string;
  format: 'chrome-heap-snapshot-json-gzip';
  mediaType: 'application/gzip';
  uncompressedSizeBytes: number;
  census: MemoryCensus;
}

export interface WrittenMemoryArtifacts {
  captureIterations: number[];
  before: WrittenHeapSnapshotArtifact;
  after: WrittenHeapSnapshotArtifact;
}

export interface WrittenJourneyArtifacts {
  measurements: WrittenMeasurementArtifact;
  observations?: WrittenMeasurementArtifact;
  trace?: WrittenTraceArtifact;
  memory?: WrittenMemoryArtifacts;
}

export interface PlaywrightRunnerReceipt {
  schema: 'playwright-runner-receipt/v1';
  runId: string;
  testId: string;
  artifacts: WrittenJourneyArtifacts;
}
