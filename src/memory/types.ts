/** Point-in-time JavaScript and DOM memory counters surrounding a heap snapshot. */
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

/** Bounded, gzip-compressed Chrome heap-snapshot bytes and capture metadata. */
export interface HeapSnapshot {
  capturedAt: string;
  format: 'chrome-heap-snapshot-json-gzip';
  mediaType: 'application/gzip';
  uncompressedSizeBytes: number;
  bytes: Buffer;
}

/** One memory census and the heap snapshot captured at the same boundary. */
export interface MemoryEvidence {
  census: MemoryCensus;
  snapshot: HeapSnapshot;
}

/** Result of an owned action enclosed by before-and-after memory evidence. */
export interface MemoryCapture<T> {
  result: T;
  before: MemoryEvidence;
  after: MemoryEvidence;
}

/** Resource bounds applied while capturing Chrome heap snapshots. */
export interface MemoryCaptureOptions {
  maxSnapshotBytes?: number;
  snapshotTimeoutMs?: number;
}
