/** Bounded, raw browser signals observed during one owned page interval. */
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

/** Navigation timing and transfer sizes relative to the document navigation. */
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

/** Count and duration aggregates for a browser performance-entry category. */
export interface DurationSummary {
  count: number;
  totalDurationMs: number;
  maximumDurationMs: number;
}

/** Aggregate timing and transfer sizes for observed resource entries. */
export interface ResourceSummary {
  count: number;
  totalDurationMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

/** Chromium's optional page-level JavaScript heap counters. */
export interface JavaScriptHeapObservation {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
}
