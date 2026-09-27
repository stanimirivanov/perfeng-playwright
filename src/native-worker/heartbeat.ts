import { PresenceRequestFailure } from './client.js';
import type { WorkerPresence, WorkerPresenceStatus } from './types.js';

const minimumRetryMilliseconds = 5_000;
const maximumRetryMilliseconds = 60_000;

export type PresenceFactory = () => Promise<WorkerPresence>;
export type PresenceReporter = (
  presence: WorkerPresence,
  signal: AbortSignal,
) => Promise<WorkerPresenceStatus>;
export type HeartbeatWait = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface PresenceHeartbeatOptions {
  signal: AbortSignal;
  createPresence: PresenceFactory;
  reportPresence: PresenceReporter;
  onStatus: (status: WorkerPresenceStatus) => void;
  onRetry: (delayMilliseconds: number) => void;
  wait?: HeartbeatWait;
  random?: () => number;
}

export async function runPresenceHeartbeat(
  options: PresenceHeartbeatOptions,
): Promise<void> {
  const wait = options.wait ?? waitForHeartbeat;
  const random = options.random ?? Math.random;
  let consecutiveFailures = 0;

  while (!isAborted(options.signal)) {
    try {
      const presence = await options.createPresence();
      if (isAborted(options.signal)) {
        return;
      }
      const status = await options.reportPresence(presence, options.signal);
      consecutiveFailures = 0;
      options.onStatus(status);
      await wait(
        jitteredDelay(status.nextHeartbeatSeconds * 1_000, random),
        options.signal,
      );
    } catch (error) {
      if (isAborted(options.signal)) {
        return;
      }
      if (!(error instanceof PresenceRequestFailure) || !error.retryable) {
        throw error;
      }
      consecutiveFailures++;
      const delay =
        error.retryAfterSeconds === undefined
          ? jitteredDelay(retryDelay(consecutiveFailures), random)
          : error.retryAfterSeconds * 1_000;
      options.onRetry(delay);
      try {
        await wait(delay, options.signal);
      } catch (waitError) {
        if (isAborted(options.signal)) {
          return;
        }
        throw waitError;
      }
    }
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function waitForHeartbeat(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('Native worker heartbeat cancelled'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    const cancel = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      reject(new Error('Native worker heartbeat cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function retryDelay(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 4);
  return Math.min(
    minimumRetryMilliseconds * 2 ** exponent,
    maximumRetryMilliseconds,
  );
}

function jitteredDelay(milliseconds: number, random: () => number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error('Native worker heartbeat random source is invalid');
  }

  return Math.max(1, Math.floor(milliseconds * (0.9 + sample * 0.1)));
}
