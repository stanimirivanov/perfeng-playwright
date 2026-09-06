import type { CDPSession, Page } from '@playwright/test';

import { chromiumSession } from '../cdp/session.js';
import { readTraceStream } from './stream.js';
import type { TracePreset } from './presets.js';
import type { PerformanceTrace, TraceCapture } from './types.js';

interface TraceCompletion {
  dataLossOccurred: boolean;
  stream?: string;
}

interface TraceCompletionWaiter {
  promise: Promise<TraceCompletion>;
  cancel: () => void;
}

export interface ChromeTraceOptions {
  maxBytes: number;
  completionTimeoutMs: number;
}

function waitForTraceCompletion(
  session: CDPSession,
  timeoutMs: number,
  description: string,
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
          `${description} did not complete within ${String(timeoutMs)} ms`,
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
  preset: TracePreset,
  options: ChromeTraceOptions,
  startedAt: string,
): Promise<PerformanceTrace> {
  const completion = waitForTraceCompletion(
    session,
    options.completionTimeoutMs,
    preset.description,
  );
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
    throw new Error(`${preset.description} returned no stream`);
  }
  const bytes = await readTraceStream(
    session,
    finished.stream,
    options.maxBytes,
    preset.description,
  );
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`${preset.description} is not gzip data`);
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

export async function captureChromeTrace<T>(
  page: Page,
  action: () => Promise<T>,
  preset: TracePreset,
  options: ChromeTraceOptions,
): Promise<TraceCapture<T>> {
  const session = await chromiumSession(page, preset.capability);
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      streamCompression: 'gzip',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        traceBufferSizeInKb: 64 * 1024,
        enableSampling: preset.enableSampling,
        includedCategories: preset.categories,
      },
    });
    const startedAt = new Date().toISOString();
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await stopTrace(session, preset, options, startedAt).catch(
        () => undefined,
      );
      throw error;
    }
    const trace = await stopTrace(session, preset, options, startedAt);
    return { result, trace };
  } finally {
    await session.detach().catch(() => undefined);
  }
}
