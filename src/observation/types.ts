export interface PageObservation {
  schema: 'browser-page-observation/v1';
  startedAt: string;
  finishedAt: string;
  supportedEntryTypes: string[];
  navigation: NavigationObservation | null;
  paints: { name: string; startTimeMs: number }[];
  largestContentfulPaint: { startTimeMs: number; size: number } | null;
  layoutShifts: { count: number; cumulativeScore: number };
  longTasks: DurationSummary;
  events: {
    count: number;
    maximumDurationMs: number;
    maximumInteractionDurationMs: number | null;
  };
  resources: ResourceSummary;
  animationFrames: {
    count: number;
    maximumIntervalMs: number | null;
    p95IntervalMs: number | null;
    intervalsOver50Ms: number;
  };
  javascriptHeap: JavaScriptHeapObservation | null;
}

export interface NavigationObservation {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  requestToFirstByteMs: number;
  responseMs: number;
  domInteractiveMs: number;
  domContentLoadedMs: number;
  loadMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

export interface DurationSummary {
  count: number;
  totalDurationMs: number;
  maximumDurationMs: number;
}

export interface ResourceSummary {
  count: number;
  totalDurationMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

export interface JavaScriptHeapObservation {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
}
