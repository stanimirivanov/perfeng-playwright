import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition-v2.js';
import {
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';
import {
  LeaseReleaseFailure,
  releaseNativeLease,
} from '../src/native-worker/release.js';
import {
  LeaseRenewalFailure,
  renewNativeLease,
} from '../src/native-worker/renewal.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';
const leasePath = 'vendor/contracts/native-worker/v2/examples/lease.json';

async function acquiredV2Lease(): Promise<AcquiredNativeV2Lease> {
  const [lease, presenceText] = await Promise.all([
    readFile(leasePath, 'utf8'),
    readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  return new AcquiredNativeV2Lease(
    parseNativeExecutionRecipe(lease, presence.qualificationEvidence),
    capability,
  );
}

test('renews the v2 attempt at its own endpoint and observes cancellation', async () => {
  const [authority, requestText, responseText] = await Promise.all([
    acquiredV2Lease(),
    readFile('vendor/contracts/native-worker/v2/examples/renew.json', 'utf8'),
    readFile('vendor/contracts/native-worker/v2/examples/renewal.json', 'utf8'),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v2/leases/11111111-1111-4111-8111-111111111111/renew',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(requestText));
    expect(init?.body).not.toContain(capability);
    return Promise.resolve(new Response(responseText, { status: 200 }));
  }) as typeof fetch;

  const renewal = await renewNativeLease(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 4,
      phase: 'RUNNING',
    },
    send,
  );
  expect(renewal).toEqual(JSON.parse(responseText));
  expect(renewal.cancellationRequested).toBe(true);
});

test('rejects a v2 renewal that changes the acquired attempt fence', async () => {
  const [authority, responseText] = await Promise.all([
    acquiredV2Lease(),
    readFile('vendor/contracts/native-worker/v2/examples/renewal.json', 'utf8'),
  ]);
  const response = JSON.parse(responseText) as Record<string, unknown>;
  const send = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...response,
          attemptId: '33333333-3333-4333-8333-333333333333',
        }),
        { status: 200 },
      ),
    )) as typeof fetch;

  await expect(
    renewNativeLease(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 4,
        phase: 'RUNNING',
      },
      send,
    ),
  ).rejects.toThrow('changed its attempt fence');
});

test('releases the v2 attempt with an idempotent, lease-fenced request', async () => {
  const [authority, requestText] = await Promise.all([
    acquiredV2Lease(),
    readFile('vendor/contracts/native-worker/v2/examples/release.json', 'utf8'),
  ]);
  const bodies: unknown[] = [];
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v2/leases/11111111-1111-4111-8111-111111111111/release',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    bodies.push(JSON.parse(init?.body as string) as unknown);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const request = {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 5,
    reason: 'CANCELLATION_REQUESTED' as const,
  };

  await releaseNativeLease(request, send);
  await releaseNativeLease(request, send);
  expect(bodies).toEqual([JSON.parse(requestText), JSON.parse(requestText)]);
});

test('keeps v2 renewal and release errors classified without leaking the response', async () => {
  const authority = await acquiredV2Lease();
  const failures = [
    { status: 409, kind: 'conflict' },
    { status: 410, kind: 'lost' },
    { status: 503, kind: 'retryable' },
  ] as const;
  for (const { status, kind } of failures) {
    const send = (() =>
      Promise.resolve(
        new Response(`secret ${token}`, {
          status,
          ...(status === 503 ? { headers: { 'retry-after': '12' } } : {}),
        }),
      )) as typeof fetch;
    const renewal = await renewNativeLease(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 4,
        phase: 'RUNNING',
      },
      send,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const release = await releaseNativeLease(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 5,
        reason: 'WORKER_SHUTDOWN',
      },
      send,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(renewal).toBeInstanceOf(LeaseRenewalFailure);
    expect(release).toBeInstanceOf(LeaseReleaseFailure);
    expect(renewal).toMatchObject({ kind });
    expect(release).toMatchObject({ kind });
    expect(String(renewal)).not.toContain(token);
    expect(String(release)).not.toContain(token);
  }
});

test('pins byte-identical Native Worker v2 renewal and release fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v2/examples/renew.json',
    'native-worker/v2/examples/renewal.json',
    'native-worker/v2/examples/release.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
