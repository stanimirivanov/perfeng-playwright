import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  LeaseRenewalFailure,
  parseNativeLeaseRenewal,
  renewNativeLease,
} from '../src/native-worker/renewal.js';

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

test('renews the current attempt fence and observes cancellation', async () => {
  const [authority, requestDocument, responseDocument] = await Promise.all([
    acquiredLease(),
    readFile('vendor/contracts/native-worker/v1/examples/renew.json', 'utf8'),
    readFile('vendor/contracts/native-worker/v1/examples/renewal.json', 'utf8'),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases/11111111-1111-4111-8111-111111111111/renew',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(JSON.parse(init?.body as string)).toEqual(
      JSON.parse(requestDocument),
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Promise.resolve(
      new Response(responseDocument, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
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

  expect(renewal).toEqual({
    leaseId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    runRevision: 5,
    serverTime: '2026-09-18T12:01:00Z',
    expiresAt: '2026-09-18T12:03:00Z',
    renewAfterSeconds: 40,
    cancellationRequested: true,
    stopBy: '2026-09-18T12:01:30Z',
  });
});

test('represents a renewal without cancellation as a distinct state', async () => {
  const document = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/renewal.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  delete document.stopBy;
  document.cancellationRequested = false;

  expect(parseNativeLeaseRenewal(JSON.stringify(document))).toEqual({
    leaseId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    runRevision: 5,
    serverTime: '2026-09-18T12:01:00Z',
    expiresAt: '2026-09-18T12:03:00Z',
    renewAfterSeconds: 40,
    cancellationRequested: false,
  });
});

test('rejects invalid cancellation and renewal windows', async () => {
  const valid = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/renewal.json',
      'utf8',
    ),
  ) as Record<string, unknown>;

  expect(() =>
    parseNativeLeaseRenewal(
      JSON.stringify({ ...valid, cancellationRequested: false }),
    ),
  ).toThrow('missing or unknown fields');
  const withoutStopBy = { ...valid };
  delete withoutStopBy.stopBy;
  expect(() => parseNativeLeaseRenewal(JSON.stringify(withoutStopBy))).toThrow(
    'missing or unknown fields',
  );
  expect(() =>
    parseNativeLeaseRenewal(
      JSON.stringify({ ...valid, stopBy: valid.expiresAt }),
    ),
  ).not.toThrow();
  expect(() =>
    parseNativeLeaseRenewal(
      JSON.stringify({ ...valid, stopBy: '2026-09-18T12:03:01Z' }),
    ),
  ).toThrow('outside the lease');
  expect(() =>
    parseNativeLeaseRenewal(
      JSON.stringify({
        ...valid,
        expiresAt: '2026-09-18T12:01:40Z',
      }),
    ),
  ).toThrow('viable renewal window');
});

test('rejects a renewal that changes the acquired attempt fence', async () => {
  const [authority, renewal] = await Promise.all([
    acquiredLease(),
    readFile('vendor/contracts/native-worker/v1/examples/renewal.json', 'utf8'),
  ]);
  const changed = {
    ...(JSON.parse(renewal) as Record<string, unknown>),
    attemptId: '33333333-3333-4333-8333-333333333333',
  };
  const send = (() =>
    Promise.resolve(
      new Response(JSON.stringify(changed), { status: 200 }),
    )) as typeof fetch;

  await expect(
    renewNativeLease(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 4,
        phase: 'PREPARING',
      },
      send,
    ),
  ).rejects.toThrow('changed its attempt fence');
});

test('classifies conflict, lost authority, retryable, and cancelled failures', async () => {
  const authority = await acquiredLease();
  const cases = [
    { status: 409, kind: 'conflict' },
    { status: 410, kind: 'lost' },
    { status: 500, kind: 'retryable' },
  ] as const;
  for (const failureCase of cases) {
    const send = (() =>
      Promise.resolve(
        new Response(`sensitive ${capability}`, {
          status: failureCase.status,
        }),
      )) as typeof fetch;
    const failure = await renewNativeLease(
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
    expect(failure).toBeInstanceOf(LeaseRenewalFailure);
    expect(failure).toMatchObject({ kind: failureCase.kind });
    expect(String(failure)).not.toContain(capability);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  const failure = await renewNativeLease(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 4,
      phase: 'RUNNING',
      signal: cancelled.signal,
    },
    () => Promise.reject(new Error('aborted')),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(failure).toMatchObject({ kind: 'cancelled' });
});

test('pins byte-identical Native Worker renewal fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v1/examples/renew.json',
    'native-worker/v1/examples/renewal.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
