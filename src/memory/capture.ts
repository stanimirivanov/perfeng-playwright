import type { CDPSession, Page } from '@playwright/test';

import { chromiumSession } from '../cdp/session.js';
import { captureMemoryCensus } from './census.js';
import { memoryCaptureOptions } from './configuration.js';
import { takeHeapSnapshot } from './snapshot.js';
import type {
  MemoryCapture,
  MemoryCaptureOptions,
  MemoryEvidence,
} from './types.js';

async function captureEvidence(
  session: CDPSession,
  maxSnapshotBytes: number,
  snapshotTimeoutMs: number,
): Promise<MemoryEvidence> {
  const census = await captureMemoryCensus(session);
  const snapshot = await takeHeapSnapshot(
    session,
    maxSnapshotBytes,
    snapshotTimeoutMs,
  );
  return { census, snapshot };
}

/** Captures garbage-collected heap evidence before and after one owned action. */
export async function captureMemoryComparison<T>(
  page: Page,
  action: () => Promise<T>,
  options: MemoryCaptureOptions = {},
): Promise<MemoryCapture<T>> {
  const effective = memoryCaptureOptions(options);
  const session = await chromiumSession(page, 'CDP memory capture');
  try {
    await session.send('HeapProfiler.enable');
    const before = await captureEvidence(
      session,
      effective.maxSnapshotBytes,
      effective.snapshotTimeoutMs,
    );
    const result = await action();
    const after = await captureEvidence(
      session,
      effective.maxSnapshotBytes,
      effective.snapshotTimeoutMs,
    );
    return { result, before, after };
  } finally {
    await session.send('HeapProfiler.disable').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}
