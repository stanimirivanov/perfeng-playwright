import type {
  CacheProfile,
  DiagnosticMode,
  EnvironmentIdentity,
  PageReuse,
  Viewport,
  WorkloadIdentity,
} from '../journey/types.js';

export interface RunnerConfiguration {
  schemaVersion: 2;
  runId: string;
  testId: string;
  workload: WorkloadIdentity;
  scenario: {
    cacheProfile: CacheProfile;
    pageReuse: PageReuse;
    warmupIterations: number;
    measurementIterations: number;
  };
  diagnosticMode: DiagnosticMode;
  diagnostics?: {
    captureIterations: [number];
  };
  environment: EnvironmentIdentity;
  target: {
    baseUrl: string;
  };
  browser: {
    headless: boolean;
    viewport: Viewport;
    deviceScaleFactor: number;
  };
}
