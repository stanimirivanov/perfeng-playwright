import type { Page } from '@playwright/test';

import type { InteractionMeasurement } from '../interaction/types.js';
import type { MemoryCensus, MemoryEvidence } from '../memory/types.js';
import type { PageObservation } from '../observation/types.js';
import type { SourceCheckoutArtifact } from '../source-checkout.js';
import type { PerformanceTrace } from '../trace/types.js';

/** Selects whether a measured iteration starts with cold or reused browser cache state. */
export type CacheProfile = 'cold' | 'warm';
/** Selects whether measured iterations receive isolated pages or share one page. */
export type PageReuse = 'per-iteration' | 'per-run';
/** Selects the optional diagnostic evidence captured beside semantic measurements. */
export type DiagnosticMode =
  'baseline' | 'lightweight' | 'trace' | 'memory' | 'smoothness';
/** Classifies the intent and intensity of a versioned workload. */
export type WorkloadProfile =
  'smoke' | 'average' | 'regression' | 'stress' | 'capacity' | 'soak';

/** Immutable identity of the workload executed by a journey. */
export interface WorkloadIdentity {
  id: string;
  version: string;
  profile: WorkloadProfile;
  sha256: string;
}

/** Browser viewport dimensions in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** Identity of the externally qualified environment in which a journey executes. */
export interface EnvironmentIdentity {
  profile: {
    id: string;
    version: string;
  };
  fingerprint: string;
}

/** Controls browser lifecycle, repetition, diagnostics, and the journey under measurement. */
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
  /** Executes one iteration and returns every semantic measurement exactly once. */
  journey: (page: Page) => Promise<InteractionMeasurement[]>;
  headless?: boolean;
  viewport?: Viewport;
  deviceScaleFactor?: number;
}

/** Associates one semantic interaction measurement with its measured iteration. */
export interface PlaywrightMeasurement extends InteractionMeasurement {
  iteration: number;
}

/** Versioned raw measurement payload produced by a completed browser journey. */
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

/** Integrity fields for immutable artifact bytes written by the runner. */
export interface WrittenMeasurementArtifact {
  sha256: string;
  sizeBytes: number;
}

/** Associates a lightweight page observation with its measured iteration. */
export interface IterationPageObservation {
  iteration: number;
  observation: PageObservation;
}

/** Versioned lightweight browser observations captured beside measurements. */
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

/** Associates one bounded Chrome trace with its measured iteration. */
export interface IterationPerformanceTrace extends PerformanceTrace {
  iteration: number;
}

/** Before-and-after memory evidence enclosing consecutive measured iterations. */
export interface JourneyMemoryCapture {
  captureIterations: number[];
  before: MemoryEvidence;
  after: MemoryEvidence;
}

/** In-memory result of a journey before its artifacts are published. */
export interface JourneyCapture {
  measurements: PlaywrightMeasurements;
  observations?: BrowserObservations;
  trace?: IterationPerformanceTrace;
  memory?: JourneyMemoryCapture;
}

/** Integrity and capture metadata for an immutable Chrome trace artifact. */
export interface WrittenTraceArtifact extends WrittenMeasurementArtifact {
  iteration: number;
  format: 'chrome-trace-json-gzip';
  mediaType: 'application/gzip';
  dataLossOccurred: boolean;
  startedAt: string;
  finishedAt: string;
}

/** Integrity and capture metadata for an immutable heap-snapshot artifact. */
export interface WrittenHeapSnapshotArtifact extends WrittenMeasurementArtifact {
  capturedAt: string;
  format: 'chrome-heap-snapshot-json-gzip';
  mediaType: 'application/gzip';
  uncompressedSizeBytes: number;
  census: MemoryCensus;
}

/** Published before-and-after memory artifacts and the iterations they enclose. */
export interface WrittenMemoryArtifacts {
  captureIterations: number[];
  before: WrittenHeapSnapshotArtifact;
  after: WrittenHeapSnapshotArtifact;
}

/** Integrity metadata for every artifact written by one journey execution. */
export interface WrittenJourneyArtifacts {
  measurements: WrittenMeasurementArtifact;
  observations?: WrittenMeasurementArtifact;
  trace?: WrittenTraceArtifact;
  memory?: WrittenMemoryArtifacts;
}

/** Provenance receipt binding a runner checkout to the artifacts it produced. */
export interface PlaywrightRunnerReceipt {
  schema: 'playwright-runner-receipt/v2';
  runId: string;
  testId: string;
  producer: {
    name: 'playwright';
    version: string;
    artifact: SourceCheckoutArtifact;
  };
  artifacts: WrittenJourneyArtifacts;
}
