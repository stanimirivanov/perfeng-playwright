/** Bounded, gzip-compressed Chrome trace bytes and completeness metadata. */
export interface PerformanceTrace {
  format: 'chrome-trace-json-gzip';
  mediaType: 'application/gzip';
  dataLossOccurred: boolean;
  startedAt: string;
  finishedAt: string;
  bytes: Buffer;
}

/** Result of an owned action captured within one Chrome tracing interval. */
export interface TraceCapture<T> {
  result: T;
  trace: PerformanceTrace;
}

/** Resource and completion bounds applied to Chrome trace collection. */
export interface TraceCaptureOptions {
  maxBytes?: number;
  completionTimeoutMs?: number;
}
