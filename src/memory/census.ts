import type { CDPSession } from '@playwright/test';

import type { MemoryCensus } from './types.js';

export async function captureMemoryCensus(
  session: CDPSession,
): Promise<MemoryCensus> {
  await session.send('HeapProfiler.collectGarbage');
  const [heap, dom] = await Promise.all([
    session.send('Runtime.getHeapUsage'),
    session.send('Memory.getDOMCounters'),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    javascriptHeap: {
      usedBytes: heap.usedSize,
      totalBytes: heap.totalSize,
      embedderUsedBytes: heap.embedderHeapUsedSize,
      backingStorageBytes: heap.backingStorageSize,
    },
    dom: {
      documents: dom.documents,
      nodes: dom.nodes,
      eventListeners: dom.jsEventListeners,
    },
  };
}
