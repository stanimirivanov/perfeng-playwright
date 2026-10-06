import { expect, test } from '@playwright/test';

import { currentNativeRevision } from '../src/native-worker/artifact-publication.js';
import { ArtifactRegistrationFailure } from '../src/native-worker/artifact-registration.js';
import {
  coordinateNativeV2Attempt,
  type NativeV2AttemptPorts,
  type NativeV2AttemptRequest,
} from '../src/native-worker/attempt-coordination-v2.js';
import type { NativeLocalExecutionResult } from '../src/native-worker/local-execution.js';
import type { NativeV2SupervisionClock } from '../src/native-worker/lease-supervision-v2.js';
import { NativeRunnerProcessFailure } from '../src/native-worker/runner-process.js';
import { LeaseRenewalFailure } from '../src/native-worker/renewal.js';
import { TerminalReportFailure } from '../src/native-worker/terminal.js';
import type { NativeLeaseRenewal } from '../src/native-worker/types.js';
import { UploadGrantFailure } from '../src/native-worker/upload-grant.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

async function fixture() {
  const raw = await nativeV2RawResultRequest();
  const request: NativeV2AttemptRequest = {
    authority: raw.authority,
    controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
    token: 'worker-secret',
    checkoutRoot: 'C:\\reviewed-checkout',
    spoolRoot: 'C:\\attempt-spool',
    runnerEnvironment: {},
    signal: new AbortController().signal,
    timeoutMilliseconds: 60_000,
  };
  const local: NativeLocalExecutionResult = {
    prepared: {
      directory: 'C:\\attempt-spool\\attempt',
      configurationPath: 'C:\\attempt-spool\\attempt\\config.json',
      measurementsPath: 'C:\\attempt-spool\\attempt\\measurements.json',
      receiptPath: 'C:\\attempt-spool\\attempt\\receipt.json',
      manifestPath: 'C:\\attempt-spool\\attempt\\manifest.json',
      runnerArguments: [],
    },
    artifact: {
      path: 'C:\\attempt-spool\\attempt\\measurements.json',
      size: 10,
      sha256: 'a'.repeat(64),
      mediaType: 'application/json',
    },
    measurements: raw.measurements,
  };
  const measurements = raw.registeredArtifacts[0];
  if (measurements === undefined) {
    throw new Error('Native v2 fixture has no registered measurements');
  }
  const evidence = {
    measurements,
    manifest: {
      reference: { ...measurements, slot: 'manifest', kind: 'manifest' },
      localArtifact: {
        path: local.prepared.manifestPath,
        size: 10,
        sha256: 'b'.repeat(64),
      },
    },
  };
  const clock: NativeV2SupervisionClock = {
    monotonicNow: () => 0,
    wait: (_milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        }
      }),
  };
  const renewal: NativeLeaseRenewal = {
    leaseId: raw.authority.recipe.leaseId,
    attemptId: raw.authority.recipe.attemptId,
    runRevision: 5,
    serverTime: '2026-09-18T12:00:10Z',
    expiresAt: '2026-09-18T12:01:10Z',
    renewAfterSeconds: 5,
    cancellationRequested: false,
  };
  return { request, local, evidence, clock, renewal };
}

type FailureStage = 'preparing' | 'running' | 'capturing' | 'uploading';

function failingPorts(
  stage: FailureStage,
  data: Awaited<ReturnType<typeof fixture>>,
  reports: string[],
): NativeV2AttemptPorts {
  return {
    renew: () => Promise.resolve(data.renewal),
    execute: (value) => {
      if (stage === 'preparing') {
        return Promise.reject(new Error('private preparation detail'));
      }
      value.onPrepared?.();
      if (stage === 'running') {
        return Promise.reject(new Error('private process detail'));
      }
      value.onRunnerCompleted?.();
      return stage === 'capturing'
        ? Promise.reject(new Error('private measurement detail'))
        : Promise.resolve(data.local);
    },
    publish: () =>
      stage === 'uploading'
        ? Promise.reject(new Error('private upload detail'))
        : Promise.resolve(data.evidence),
    report: (value) => {
      reports.push(value.kind);
      return Promise.resolve({
        attemptId: data.request.authority.recipe.attemptId,
        runRevision: 6,
        disposition: 'ACCEPTED',
      });
    },
  };
}

function gatedClock() {
  const pending: (() => void)[] = [];
  const clock: NativeV2SupervisionClock = {
    monotonicNow: () => 0,
    wait: (_milliseconds, signal) =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      }),
  };
  const tick = async () => {
    await expect.poll(() => pending.length).toBeGreaterThan(0);
    const release = pending.shift();
    if (release === undefined) {
      throw new Error('Expected a pending lease renewal tick');
    }
    release();
  };
  return { clock, tick };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

test('keeps renewal active through ordered publication and completed terminal reporting', async () => {
  const { request, local, evidence, clock, renewal } = await fixture();
  const calls: string[] = [];
  const ports: NativeV2AttemptPorts = {
    renew: (value) => {
      calls.push(`renew:${value.phase}`);
      return Promise.resolve(renewal);
    },
    execute: (value) => {
      calls.push('prepare');
      value.onPrepared?.();
      calls.push('run');
      value.onRunnerCompleted?.();
      calls.push('capture');
      return Promise.resolve(local);
    },
    publish: (value) => {
      calls.push('publish');
      expect(value.prepared).toBe(local.prepared);
      expect(currentNativeRevision(value.expectedRunRevision)).toBe(5);
      return Promise.resolve(evidence);
    },
    report: (value) => {
      calls.push(`terminal:${value.kind}`);
      expect(value.expectedRunRevision).toBe(5);
      expect(value).toMatchObject({
        kind: 'COMPLETED',
        manifest: evidence.manifest.reference,
      });
      return Promise.resolve({
        attemptId: request.authority.recipe.attemptId,
        runRevision: 6,
        disposition: 'ACCEPTED',
      });
    },
  };

  const result = await coordinateNativeV2Attempt(request, ports, clock);

  expect(result.kind).toBe('COMPLETED');
  expect(calls).toEqual([
    'renew:PREPARING',
    'prepare',
    'run',
    'capture',
    'publish',
    'terminal:COMPLETED',
  ]);
});

test('publishes and reports with revisions accepted during the running and uploading phases', async () => {
  const { request, local, evidence, renewal } = await fixture();
  const { clock, tick } = gatedClock();
  const phases: string[] = [];
  let revision = 4;
  const result = await coordinateNativeV2Attempt(
    request,
    {
      renew: (value) => {
        phases.push(value.phase);
        revision++;
        return Promise.resolve({ ...renewal, runRevision: revision });
      },
      execute: async (value) => {
        value.onPrepared?.();
        await tick();
        await expect.poll(() => revision).toBe(6);
        value.onRunnerCompleted?.();
        return local;
      },
      publish: async (value) => {
        expect(currentNativeRevision(value.expectedRunRevision)).toBe(6);
        await tick();
        await expect.poll(() => revision).toBe(7);
        expect(currentNativeRevision(value.expectedRunRevision)).toBe(7);
        return evidence;
      },
      report: (value) => {
        expect(value.expectedRunRevision).toBe(7);
        return Promise.resolve({
          attemptId: request.authority.recipe.attemptId,
          runRevision: 8,
          disposition: 'ACCEPTED',
        });
      },
    },
    clock,
  );
  expect(result.kind).toBe('COMPLETED');
  expect(phases).toEqual(['PREPARING', 'RUNNING', 'UPLOADING']);
});

for (const [stage, expectedCode] of [
  ['preparing', 'PREPARATION_FAILED'],
  ['running', 'TOOL_FAILED'],
  ['capturing', 'CAPTURE_FAILED'],
  ['uploading', 'UPLOAD_FAILED'],
] as const) {
  test(`reports a safe ${stage} failure without publishing success`, async () => {
    const data = await fixture();
    const reports: string[] = [];
    const result = await coordinateNativeV2Attempt(
      data.request,
      failingPorts(stage, data, reports),
      data.clock,
    );
    expect(result).toMatchObject({
      kind: 'FAILED',
      failure: {
        code: expectedCode,
        message: `Native worker ${stage} failed`,
        retryable: false,
      },
    });
    expect(reports).toEqual(['FAILED']);
  });
}

test('preserves both local and terminal-report failures for explicit recovery', async () => {
  const { request, clock, renewal } = await fixture();
  const failure = await coordinateNativeV2Attempt(
    request,
    {
      renew: () => Promise.resolve(renewal),
      execute: () => Promise.reject(new Error('private local failure')),
      publish: () => Promise.reject(new Error('publication must not run')),
      report: () =>
        Promise.reject(
          new TerminalReportFailure('terminal conflict', 'conflict'),
        ),
    },
    clock,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toMatchObject([
    { message: 'private local failure' },
    { kind: 'conflict' },
  ]);
});

test('does not report terminal after cancellation during execution', async () => {
  const { request, clock, renewal } = await fixture();
  const controller = new AbortController();
  let reports = 0;
  await expect(
    coordinateNativeV2Attempt(
      { ...request, signal: controller.signal },
      {
        renew: () => Promise.resolve(renewal),
        execute: (value) => {
          value.onPrepared?.();
          controller.abort();
          return Promise.reject(new NativeRunnerProcessFailure('cancelled'));
        },
        publish: () => Promise.reject(new Error('publication must not run')),
        report: () => {
          reports++;
          return Promise.reject(new Error('terminal must not run'));
        },
      },
      clock,
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  expect(reports).toBe(0);
});

test('does not report terminal after losing the lease during execution', async () => {
  const { request, renewal } = await fixture();
  const { clock, tick } = gatedClock();
  let renewals = 0;
  let reports = 0;
  await expect(
    coordinateNativeV2Attempt(
      request,
      {
        renew: () => {
          renewals++;
          return renewals === 1
            ? Promise.resolve(renewal)
            : Promise.reject(new LeaseRenewalFailure('lost', 'lost'));
        },
        execute: async (value) => {
          value.onPrepared?.();
          await tick();
          await waitForAbort(value.signal);
          throw new NativeRunnerProcessFailure('cancelled');
        },
        publish: () => Promise.reject(new Error('publication must not run')),
        report: () => {
          reports++;
          return Promise.reject(new Error('terminal must not run'));
        },
      },
      clock,
    ),
  ).rejects.toMatchObject({ kind: 'lost' });
  expect(reports).toBe(0);
});

for (const failure of [
  new UploadGrantFailure('grant lost its fence', 'lost'),
  new ArtifactRegistrationFailure('registration conflicted', 'conflict'),
]) {
  test(`does not report terminal after ${failure.name} loses authority`, async () => {
    const { request, local, clock, renewal } = await fixture();
    let reports = 0;
    await expect(
      coordinateNativeV2Attempt(
        request,
        {
          renew: () => Promise.resolve(renewal),
          execute: (value) => {
            value.onPrepared?.();
            value.onRunnerCompleted?.();
            return Promise.resolve(local);
          },
          publish: () => Promise.reject(failure),
          report: () => {
            reports++;
            return Promise.reject(new Error('terminal must not run'));
          },
        },
        clock,
      ),
    ).rejects.toBe(failure);
    expect(reports).toBe(0);
  });
}

test('does not misreport a completed-terminal conflict as a work failure', async () => {
  const { request, local, evidence, clock, renewal } = await fixture();
  let reports = 0;
  await expect(
    coordinateNativeV2Attempt(
      request,
      {
        renew: () => Promise.resolve(renewal),
        execute: (value) => {
          value.onPrepared?.();
          value.onRunnerCompleted?.();
          return Promise.resolve(local);
        },
        publish: () => Promise.resolve(evidence),
        report: () => {
          reports++;
          return Promise.reject(
            new TerminalReportFailure('terminal conflict', 'conflict'),
          );
        },
      },
      clock,
    ),
  ).rejects.toMatchObject({ kind: 'conflict' });
  expect(reports).toBe(1);
});
