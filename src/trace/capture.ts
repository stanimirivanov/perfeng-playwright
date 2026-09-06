import type { CDPSession, Page } from '@playwright/test';

import { chromiumSession } from '../cdp/session.js';
import { traceCaptureOptions } from './configuration.js';
import { readTraceStream } from './stream.js';
import type {
  PerformanceTrace,
  TraceCapture,
  TraceCaptureOptions,
} from './types.js';

interface TraceCompletion {
  dataLossOccurred: boolean;
  stream?: string;
}

interface TraceCompletionWaiter {
  promise: Promise<TraceCompletion>;
  cancel: () => void;
}

const traceCategories = [
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'latencyInfo',
  'loading',
  'renderer.scheduler',
  'toplevel',
  'v8',
  'v8.execute',
];

function waitForTraceCompletion(
  session: CDPSession,
  timeoutMs: number,
): TraceCompletionWaiter {
  let cancel = (): void => undefined;
  const promise = new Promise<TraceCompletion>((resolve, reject) => {
    const complete = (completion: TraceCompletion): void => {
      cancel();
      resolve(completion);
    };
    const close = (): void => {
      cancel();
      reject(new Error('CDP session closed before trace completion'));
    };
    const timeout = setTimeout(() => {
      cancel();
      reject(
        new Error(
          `Chrome performance trace did not complete within ${String(timeoutMs)} ms`,
        ),
      );
    }, timeoutMs);
    cancel = () => {
      clearTimeout(timeout);
      session.off('Tracing.tracingComplete', complete);
      session.off('close', close);
    };
    session.once('Tracing.tracingComplete', complete);
    session.once('close', close);
  });
  return { promise, cancel };
}

async function stopTrace(
  session: CDPSession,
  maxBytes: number,
  timeoutMs: number,
  startedAt: string,
): Promise<PerformanceTrace> {
  const completion = waitForTraceCompletion(session, timeoutMs);
  let finished: TraceCompletion;
  try {
    await session.send('Tracing.end');
    finished = await completion.promise;
  } catch (error) {
    completion.cancel();
    throw error;
  }
  const finishedAt = new Date().toISOString();
  if (finished.stream === undefined) {
    throw new Error('Chrome performance trace returned no stream');
  }
  const bytes = await readTraceStream(session, finished.stream, maxBytes);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error('Chrome performance trace is not gzip data');
  }
  return {
    format: 'chrome-trace-json-gzip',
    mediaType: 'application/gzip',
    dataLossOccurred: finished.dataLossOccurred,
    startedAt,
    finishedAt,
    bytes,
  };
}

/** Captures Chrome DevTools performance evidence around one owned action. */
export async function capturePerformanceTrace<T>(
  page: Page,
  action: () => Promise<T>,
  options: TraceCaptureOptions = {},
): Promise<TraceCapture<T>> {
  const effective = traceCaptureOptions(options);
  const session = await chromiumSession(page, 'CDP performance tracing');
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      streamCompression: 'gzip',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        traceBufferSizeInKb: 64 * 1024,
        enableSampling: true,
        includedCategories: traceCategories,
      },
    });
    const startedAt = new Date().toISOString();
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await stopTrace(
        session,
        effective.maxBytes,
        effective.completionTimeoutMs,
        startedAt,
      ).catch(() => undefined);
      throw error;
    }
    const trace = await stopTrace(
      session,
      effective.maxBytes,
      effective.completionTimeoutMs,
      startedAt,
    );
    return { result, trace };
  } finally {
    await session.detach().catch(() => undefined);
  }
}
