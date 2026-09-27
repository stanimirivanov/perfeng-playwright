import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  LeaseReleaseFailure,
  releaseNativeLease,
} from '../src/native-worker/release.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';

async function acquiredLease(): Promise<AcquiredNativeLease> {
  return new AcquiredNativeLease(
    parseNativeLease(
      await readFile(
        'vendor/contracts/native-worker/v1/examples/lease.json',
        'utf8',
      ),
    ),
    capability,
  );
}

test('releases the current attempt with an idempotent fenced request', async () => {
  const [authority, requestDocument] = await Promise.all([
    acquiredLease(),
    readFile('vendor/contracts/native-worker/v1/examples/release.json', 'utf8'),
  ]);
  const requests: unknown[] = [];
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases/11111111-1111-4111-8111-111111111111/release',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    requests.push(JSON.parse(init?.body as string));
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

  expect(requests).toEqual([
    JSON.parse(requestDocument),
    JSON.parse(requestDocument),
  ]);
});

test('accepts a bounded Unicode message and omits absent messages', async () => {
  const authority = await acquiredLease();
  const bodies: Record<string, unknown>[] = [];
  const send = ((_input: URL | RequestInfo, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  await releaseNativeLease(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 5,
      reason: 'PREPARATION_FAILED',
      message: '🙂'.repeat(512),
    },
    send,
  );
  await releaseNativeLease(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 5,
      reason: 'WORKER_SHUTDOWN',
    },
    send,
  );

  expect(bodies[0]?.message).toBe('🙂'.repeat(512));
  expect(bodies[1]).not.toHaveProperty('message');
});

test('rejects unsafe release input before sending a request', async () => {
  const authority = await acquiredLease();
  const send = () => Promise.reject(new Error('request must not be sent'));
  const request = {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 5,
    reason: 'PREPARATION_FAILED' as const,
  };

  await expect(
    releaseNativeLease({ ...request, message: '' }, send),
  ).rejects.toThrow('non-empty');
  await expect(
    releaseNativeLease({ ...request, message: '🙂'.repeat(513) }, send),
  ).rejects.toThrow('at most 512');
  await expect(
    releaseNativeLease({ ...request, message: '\ud800' }, send),
  ).rejects.toThrow('at most 512');
  await expect(
    releaseNativeLease(
      { ...request, reason: 'UNKNOWN' as 'PREPARATION_FAILED' },
      send,
    ),
  ).rejects.toThrow('reason is invalid');
});

test('classifies conflict, lost authority, retryable, and cancelled failures', async () => {
  const authority = await acquiredLease();
  const cases = [
    { responseStatus: 409, expected: { kind: 'conflict' } },
    { responseStatus: 410, expected: { kind: 'lost' } },
    {
      responseStatus: 503,
      expected: { kind: 'retryable', retryAfterSeconds: 12 },
    },
  ] as const;
  for (const failureCase of cases) {
    const send = (() =>
      Promise.resolve(
        new Response(`sensitive ${capability}`, {
          status: failureCase.responseStatus,
          headers: { 'retry-after': '12' },
        }),
      )) as typeof fetch;
    const failure = await releaseNativeLease(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 5,
        reason: 'LEASE_LOST',
      },
      send,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(LeaseReleaseFailure);
    expect(failure).toMatchObject(failureCase.expected);
    expect(String(failure)).not.toContain(capability);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  const failure = await releaseNativeLease(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 5,
      reason: 'WORKER_SHUTDOWN',
      signal: cancelled.signal,
    },
    () => Promise.reject(new Error('aborted')),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(failure).toMatchObject({ kind: 'cancelled' });
});

test('pins the byte-identical Native Worker release fixture', async () => {
  const path = 'native-worker/v1/examples/release.json';
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  const bytes = await readFile(`vendor/contracts/${path}`);

  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    lock.files[path],
  );
});
