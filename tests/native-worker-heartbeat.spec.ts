import { expect, test } from '@playwright/test';

import { PresenceRequestFailure } from '../src/native-worker/client.js';
import {
  runPresenceHeartbeat,
  type HeartbeatWait,
} from '../src/native-worker/heartbeat.js';
import type {
  WorkerPresence,
  WorkerPresenceStatus,
} from '../src/native-worker/types.js';

const workerPresence: WorkerPresence = {
  protocolVersion: 1,
  agentVersion: '0.13.0',
  availability: 'UNAVAILABLE',
  capabilities: {
    capacity: 1,
    tool: 'playwright',
    operatingSystem: 'windows',
    architecture: 'x64',
    browsers: ['edge'],
    runnerContract: 1,
    executionArtifacts: ['source-checkout'],
    artifactKinds: ['measurements', 'diagnostics'],
    diagnosticModes: ['lightweight', 'trace', 'heap'],
  },
  qualificationEvidence: {
    environmentId: 'windows-mainstream',
    environmentSha256: 'a'.repeat(64),
    runner: {
      kind: 'source-checkout',
      repository: 'https://github.com/stanimirivanov/perfeng-playwright',
      revision: 'b'.repeat(40),
      lockfile: 'pnpm-lock.yaml',
      lockfileSha256: 'c'.repeat(64),
    },
  },
};

const presenceStatus: WorkerPresenceStatus = {
  workerId: 'windows-laptop-01',
  serverTime: '2026-09-27T12:00:00Z',
  nextHeartbeatSeconds: 30,
  availability: 'UNAVAILABLE',
  qualification: {
    status: 'STALE',
    reasons: ['Worker execution is not enabled'],
  },
  authorizedToAcquire: false,
};

function unexpectedCallback(): never {
  throw new Error('Unexpected callback');
}

test('refreshes presence and follows the jittered server heartbeat pace', async () => {
  const shutdown = new AbortController();
  const created: WorkerPresence[] = [];
  const reported: WorkerPresence[] = [];
  const statuses: WorkerPresenceStatus[] = [];
  const delays: number[] = [];
  const waits = [
    () => Promise.resolve(),
    () => {
      shutdown.abort();
      return Promise.reject(new Error('cancelled'));
    },
  ];
  const wait: HeartbeatWait = (milliseconds) => {
    delays.push(milliseconds);
    return (
      waits[delays.length - 1]?.() ?? Promise.reject(new Error('wait overflow'))
    );
  };

  await runPresenceHeartbeat({
    signal: shutdown.signal,
    createPresence: () => {
      const current = structuredClone(workerPresence);
      created.push(current);
      return Promise.resolve(current);
    },
    reportPresence: (current) => {
      reported.push(current);
      return Promise.resolve(presenceStatus);
    },
    onStatus: (status) => statuses.push(status),
    onRetry: unexpectedCallback,
    wait,
    random: () => 0.5,
  });

  expect(created).toHaveLength(2);
  expect(reported).toEqual(created);
  expect(statuses).toEqual([presenceStatus, presenceStatus]);
  expect(delays).toEqual([28_500, 28_500]);
});

test('honors Retry-After before resuming server-paced heartbeats', async () => {
  const shutdown = new AbortController();
  const delays: number[] = [];
  const retries: number[] = [];
  let requests = 0;
  const waits = [
    () => Promise.resolve(),
    () => {
      shutdown.abort();
      return Promise.reject(new Error('cancelled'));
    },
  ];
  const reports = [
    () =>
      Promise.reject(
        new PresenceRequestFailure('temporarily unavailable', true, 17),
      ),
    () => Promise.resolve(presenceStatus),
  ];
  const wait: HeartbeatWait = (milliseconds) => {
    delays.push(milliseconds);
    return (
      waits[delays.length - 1]?.() ?? Promise.reject(new Error('wait overflow'))
    );
  };

  await runPresenceHeartbeat({
    signal: shutdown.signal,
    createPresence: () => Promise.resolve(workerPresence),
    reportPresence: () => {
      requests++;
      return (
        reports[requests - 1]?.() ??
        Promise.reject(new Error('request overflow'))
      );
    },
    onStatus: () => undefined,
    onRetry: (delay) => retries.push(delay),
    wait,
    random: () => 0,
  });

  expect(requests).toBe(2);
  expect(retries).toEqual([17_000]);
  expect(delays).toEqual([17_000, 27_000]);
});

test('uses bounded exponential backoff for retryable request failures', async () => {
  const shutdown = new AbortController();
  const delays: number[] = [];
  let requests = 0;
  const waits = [
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => Promise.resolve(),
    () => {
      shutdown.abort();
      return Promise.reject(new Error('cancelled'));
    },
  ];

  await runPresenceHeartbeat({
    signal: shutdown.signal,
    createPresence: () => Promise.resolve(workerPresence),
    reportPresence: () => {
      requests++;
      return Promise.reject(
        new PresenceRequestFailure('transport failed', true),
      );
    },
    onStatus: unexpectedCallback,
    onRetry: () => undefined,
    wait: (milliseconds) => {
      delays.push(milliseconds);
      return (
        waits[delays.length - 1]?.() ??
        Promise.reject(new Error('wait overflow'))
      );
    },
    random: () => 0,
  });

  expect(requests).toBe(6);
  expect(delays).toEqual([4_500, 9_000, 18_000, 36_000, 54_000, 54_000]);
});

test('stops before a request when cancelled and propagates permanent failures', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let requests = 0;
  await runPresenceHeartbeat({
    signal: cancelled.signal,
    createPresence: () => {
      requests++;
      return Promise.resolve(workerPresence);
    },
    reportPresence: () => Promise.resolve(presenceStatus),
    onStatus: () => undefined,
    onRetry: () => undefined,
  });
  expect(requests).toBe(0);

  await expect(
    runPresenceHeartbeat({
      signal: new AbortController().signal,
      createPresence: () => Promise.resolve(workerPresence),
      reportPresence: () =>
        Promise.reject(new PresenceRequestFailure('unauthorized', false)),
      onStatus: () => undefined,
      onRetry: unexpectedCallback,
      wait: () => Promise.resolve(),
    }),
  ).rejects.toThrow('unauthorized');
});
