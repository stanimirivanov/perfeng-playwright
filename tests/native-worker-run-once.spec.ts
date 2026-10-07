import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition.js';
import { parseNativeExecutionRecipe } from '../src/native-worker/execution-recipe.js';
import {
  runNativeWorkerOnce,
  type NativeRunOncePorts,
  type NativeRunOnceRequest,
} from '../src/native-worker/run-once.js';
import type {
  WorkerPresence,
  WorkerPresenceStatus,
} from '../src/native-worker/types.js';
import { parseWorkerCommand } from '../src/worker-cli.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const token = 'worker-secret-must-not-be-printed';
const ownerFile = '.native-worker-owner';

async function fixture(spoolRoot: string): Promise<{
  request: NativeRunOnceRequest;
  authority: AcquiredNativeV2Lease;
}> {
  const [presenceText, leaseText] = await Promise.all([
    readFile(`${fixtureRoot}/presence.json`, 'utf8'),
    readFile(`${fixtureRoot}/lease.json`, 'utf8'),
  ]);
  const presence = {
    ...(JSON.parse(presenceText) as WorkerPresence),
    availability: 'UNAVAILABLE' as const,
  };
  const authority = new AcquiredNativeV2Lease(
    parseNativeExecutionRecipe(leaseText, presence.qualificationEvidence),
    'example-not-a-real-lease-capability-0001',
  );
  return {
    request: {
      presence,
      controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
      token,
      checkoutRoot: 'C:\\reviewed-checkout',
      spoolRoot,
      runnerEnvironment: { PATH: 'reviewed-bin' },
      timeoutMilliseconds: 60_000,
      signal: new AbortController().signal,
    },
    authority,
  };
}

function status(
  availability: 'AVAILABLE' | 'UNAVAILABLE',
  qualified = true,
): WorkerPresenceStatus {
  return {
    workerId: 'windows-laptop-01',
    serverTime: '2026-10-07T12:00:00Z',
    nextHeartbeatSeconds: 30,
    availability,
    qualification: qualified
      ? {
          status: 'QUALIFIED',
          reasons: [],
          validUntil: '2026-10-07T12:02:00Z',
        }
      : { status: 'UNQUALIFIED', reasons: ['Host is not approved'] },
    authorizedToAcquire: qualified,
  };
}

function ports(
  authority: AcquiredNativeV2Lease,
  reports: ('AVAILABLE' | 'UNAVAILABLE')[],
): NativeRunOncePorts {
  return {
    reportPresence: ({ presence, token: credential }) => {
      expect(credential).toBe(token);
      reports.push(presence.availability);
      return Promise.resolve(status(presence.availability));
    },
    acquireLease: (request) => {
      expect(request.maxWaitSeconds).toBe(0);
      expect(request.currentEvidence).toEqual({
        environmentId: 'windows-mainstream',
        environmentSha256: 'a'.repeat(64),
        runner: authority.recipe.executionArtifact,
      });
      return Promise.resolve({ kind: 'idle', retryAfterSeconds: 5 });
    },
    coordinateAttempt: () =>
      Promise.reject(new Error('Idle worker must not execute')),
  };
}

function rejectWithdrawalAfterOffer(
  reports: ('AVAILABLE' | 'UNAVAILABLE')[],
): NativeRunOncePorts['reportPresence'] {
  return ({ presence }) => {
    reports.push(presence.availability);
    return presence.availability === 'UNAVAILABLE' && reports.length > 1
      ? Promise.reject(new Error('withdrawal unavailable'))
      : Promise.resolve(status(presence.availability));
  };
}

function misreportWithdrawalAfterOffer(
  reports: ('AVAILABLE' | 'UNAVAILABLE')[],
): NativeRunOncePorts['reportPresence'] {
  return ({ presence }) => {
    reports.push(presence.availability);
    return Promise.resolve(
      status(reports.length > 2 ? 'AVAILABLE' : presence.availability),
    );
  };
}

test('parses an explicit one-shot command without accepting partial arguments', () => {
  expect(
    parseWorkerCommand([
      'run-once',
      '--config',
      'worker.json',
      '--spool-root',
      'C:\\spool',
      '--timeout-ms',
      '60000',
    ]),
  ).toEqual({
    action: 'run-once',
    configurationPath: 'worker.json',
    spoolRoot: 'C:\\spool',
    timeoutMilliseconds: 60_000,
  });
  expect(() =>
    parseWorkerCommand(['run-once', '--config', 'worker.json']),
  ).toThrow('Usage:');
});

test('offers one acquisition window and withdraws availability after an idle reply', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  expect(await runNativeWorkerOnce(request, ports(authority, reports))).toEqual(
    {
      kind: 'IDLE',
    },
  );
  expect(reports).toEqual(['UNAVAILABLE', 'AVAILABLE', 'UNAVAILABLE']);
  expect(await readdir(root)).toEqual([]);
});

test('coordinates exactly one acquired attempt and retains its evidence', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  let attempts = 0;
  const controlled = ports(authority, reports);
  controlled.acquireLease = () =>
    Promise.resolve({ kind: 'acquired', authority });
  controlled.coordinateAttempt = async (attempt) => {
    attempts++;
    expect(reports).toEqual(['UNAVAILABLE', 'AVAILABLE', 'UNAVAILABLE']);
    expect(attempt.authority).toBe(authority);
    expect(attempt.runnerEnvironment).not.toHaveProperty(
      'PERFENG_NATIVE_WORKER_TOKEN',
    );
    await mkdir(join(root, 'retained-attempt'));
    return {
      kind: 'FAILED',
      failure: {
        code: 'PREPARATION_FAILED',
        message: 'Native worker preparing failed',
        retryable: false,
      },
      acknowledgement: {
        attemptId: authority.recipe.attemptId,
        runRevision: 6,
        disposition: 'ACCEPTED',
      },
    };
  };
  expect(await runNativeWorkerOnce(request, controlled)).toEqual({
    kind: 'FAILED',
    runId: authority.recipe.runId,
    attemptId: authority.recipe.attemptId,
    runRevision: 6,
  });
  expect(attempts).toBe(1);
  expect(await readdir(root)).toEqual(['retained-attempt']);
});

test('refuses retained state and an existing owner before any network call', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  await writeFile(join(root, 'retained.txt'), 'keep me');
  await expect(
    runNativeWorkerOnce(request, ports(authority, reports)),
  ).rejects.toThrow('retained state');
  expect(await readdir(root)).toEqual(['retained.txt']);
  expect(await readFile(join(root, 'retained.txt'), 'utf8')).toBe('keep me');
  await writeFile(join(root, ownerFile), 'another owner');
  await expect(
    runNativeWorkerOnce(request, ports(authority, reports)),
  ).rejects.toThrow('already has an owner marker');
  expect(reports).toEqual([]);
  expect(await readFile(join(root, ownerFile), 'utf8')).toBe('another owner');
});

test('retains the owner marker after uncertain acquisition', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  const controlled = ports(authority, reports);
  controlled.acquireLease = () =>
    Promise.reject(new Error('uncertain acquisition'));
  await expect(runNativeWorkerOnce(request, controlled)).rejects.toThrow(
    'uncertain acquisition',
  );
  expect(reports).toEqual(['UNAVAILABLE', 'AVAILABLE', 'UNAVAILABLE']);
  expect(await readdir(root)).toEqual([ownerFile]);
});

test('does not acquire when qualification fails or startup is cancelled', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  const controlled = ports(authority, reports);
  controlled.reportPresence = ({ presence }) => {
    reports.push(presence.availability);
    return Promise.resolve(status(presence.availability, false));
  };
  await expect(runNativeWorkerOnce(request, controlled)).rejects.toThrow(
    'not qualified and authorized',
  );
  expect(reports).toEqual(['UNAVAILABLE']);
  expect(await readdir(root)).toEqual([]);

  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    runNativeWorkerOnce({ ...request, signal: cancelled.signal }, controlled),
  ).rejects.toThrow('cancelled before startup');
  expect(reports).toEqual(['UNAVAILABLE']);
  expect(await readdir(root)).toEqual([]);
});

test('rejects a child environment containing the worker credential before network access', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  await expect(
    runNativeWorkerOnce(
      {
        ...request,
        runnerEnvironment: { perfeng_native_worker_token: token },
      },
      ports(authority, reports),
    ),
  ).rejects.toThrow('must not include the worker token');
  expect(reports).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

test('keeps the owner marker and refuses execution if availability withdrawal fails', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  const controlled = ports(authority, reports);
  controlled.acquireLease = () =>
    Promise.resolve({ kind: 'acquired', authority });
  controlled.reportPresence = rejectWithdrawalAfterOffer(reports);
  await expect(runNativeWorkerOnce(request, controlled)).rejects.toThrow(
    'availability withdrawal failed',
  );
  expect(reports).toEqual([
    'UNAVAILABLE',
    'AVAILABLE',
    'UNAVAILABLE',
    'UNAVAILABLE',
  ]);
  expect(await readdir(root)).toEqual([ownerFile]);
});

test('does not treat a mismatched withdrawal acknowledgement as unavailable', async ({}, testInfo) => {
  const root = testInfo.outputPath('spool');
  await mkdir(root);
  const { request, authority } = await fixture(root);
  const reports: ('AVAILABLE' | 'UNAVAILABLE')[] = [];
  const controlled = ports(authority, reports);
  controlled.reportPresence = misreportWithdrawalAfterOffer(reports);
  await expect(runNativeWorkerOnce(request, controlled)).rejects.toThrow(
    'availability withdrawal failed',
  );
  expect(reports).toEqual([
    'UNAVAILABLE',
    'AVAILABLE',
    'UNAVAILABLE',
    'UNAVAILABLE',
  ]);
  expect(await readdir(root)).toEqual([ownerFile]);
});
