export interface PerformanceTrace {
  format: 'chrome-trace-json-gzip';
  mediaType: 'application/gzip';
  dataLossOccurred: boolean;
  startedAt: string;
  finishedAt: string;
  bytes: Buffer;
}

export interface TraceCapture<T> {
  result: T;
  trace: PerformanceTrace;
}

export interface TraceCaptureOptions {
  maxBytes?: number;
  completionTimeoutMs?: number;
}
