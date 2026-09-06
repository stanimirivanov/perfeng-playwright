export interface MemoryCensus {
  capturedAt: string;
  javascriptHeap: {
    usedBytes: number;
    totalBytes: number;
    embedderUsedBytes: number;
    backingStorageBytes: number;
  };
  dom: {
    documents: number;
    nodes: number;
    eventListeners: number;
  };
}

export interface HeapSnapshot {
  capturedAt: string;
  format: 'chrome-heap-snapshot-json-gzip';
  mediaType: 'application/gzip';
  uncompressedSizeBytes: number;
  bytes: Buffer;
}

export interface MemoryEvidence {
  census: MemoryCensus;
  snapshot: HeapSnapshot;
}

export interface MemoryCapture<T> {
  result: T;
  before: MemoryEvidence;
  after: MemoryEvidence;
}

export interface MemoryCaptureOptions {
  maxSnapshotBytes?: number;
  snapshotTimeoutMs?: number;
}
