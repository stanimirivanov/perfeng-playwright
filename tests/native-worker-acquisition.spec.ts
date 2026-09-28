import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

import { expect, test } from '@playwright/test';

import {
  acquireNativeLease,
  type AcquiredNativeLease,
  type LeaseAcquisition,
  LeaseAcquisitionFailure,
} from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';

function requireAcquired(result: LeaseAcquisition): AcquiredNativeLease {
  if (result.kind !== 'acquired') {
    throw new Error('Expected an acquired lease');
  }
  return result.authority;
}

function requireIdle(result: LeaseAcquisition): number {
  if (result.kind !== 'idle') {
    throw new Error('Expected an idle acquisition response');
  }
  return result.retryAfterSeconds;
}

test('acquires and validates one lease without serializing its capability', async () => {
  const [acquireDocument, leaseDocument] = await Promise.all([
    readFile('vendor/contracts/native-worker/v1/examples/acquire.json', 'utf8'),
    readFile('vendor/contracts/native-worker/v1/examples/lease.json', 'utf8'),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual(
      JSON.parse(acquireDocument),
    );
    return Promise.resolve(
      new Response(leaseDocument, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-perfeng-lease': capability,
        },
      }),
    );
  }) as typeof fetch;

  const authority = requireAcquired(
    await acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      send,
    ),
  );

  expect(authority.lease).toMatchObject({
    leaseId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    runId: 'perf-20260918-120000-a1b2c3d4',
    runRevision: 4,
    renewAfterSeconds: 40,
    artifactPlan: [
      { slot: 'measurements', format: 'playwright-measurements/v2' },
      { slot: 'manifest', format: 'raw-result/v2' },
    ],
  });
  expect(authority.useCapability((value) => value)).toBe(capability);
  expect(JSON.stringify(authority)).not.toContain(capability);
  expect(inspect(authority)).not.toContain(capability);
});

test('returns the required server retry interval when no work is available', async () => {
  const send = (() =>
    Promise.resolve(
      new Response(null, {
        status: 204,
        headers: { 'retry-after': '15' },
      }),
    )) as typeof fetch;

  const result = await acquireNativeLease(
    { controlPlaneOrigin, token, maxWaitSeconds: 20 },
    send,
  );

  expect(requireIdle(result)).toBe(15);
});

test('rejects malformed idle and acquired responses', async () => {
  const missingRetryAfter = (() =>
    Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;
  await expect(
    acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      missingRetryAfter,
    ),
  ).rejects.toThrow('invalid Retry-After');

  const lease = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/lease.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const invalidWindow = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...lease,
          expiresAt: lease.issuedAt,
        }),
        {
          status: 200,
          headers: { 'x-perfeng-lease': capability },
        },
      ),
    )) as typeof fetch;
  await expect(
    acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      invalidWindow,
    ),
  ).rejects.toThrow('viable renewal window');

  const missingCapability = (() =>
    Promise.resolve(
      new Response(JSON.stringify(lease), { status: 200 }),
    )) as typeof fetch;
  await expect(
    acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      missingCapability,
    ),
  ).rejects.toThrow('lease capability is missing or invalid');
});

test('accepts server timestamps with nanosecond precision', async () => {
  const lease = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/lease.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const send = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...lease,
          issuedAt: '2026-09-18T12:00:00.123456789Z',
          expiresAt: '2026-09-18T12:02:00.123456789Z',
        }),
        {
          status: 200,
          headers: { 'x-perfeng-lease': capability },
        },
      ),
    )) as typeof fetch;

  const authority = requireAcquired(
    await acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      send,
    ),
  );

  expect(authority.lease.issuedAt).toBe('2026-09-18T12:00:00.123456789Z');
});

test('rejects obsolete and unsafe artifact formats before execution', async () => {
  const lease = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/lease.json',
      'utf8',
    ),
  ) as {
    artifactPlan: [Record<string, unknown>, ...Record<string, unknown>[]];
  };

  for (const format of ['playwright-measurements-v2', '../measurements/v2']) {
    const [firstArtifact, ...remainingArtifacts] = lease.artifactPlan;
    const artifactPlan = [
      { ...firstArtifact, format },
      ...remainingArtifacts.map((item) => ({ ...item })),
    ];
    expect(() =>
      parseNativeLease(JSON.stringify({ ...lease, artifactPlan })),
    ).toThrow('artifactPlan[0].format');
  }
});

test('accepts the source-checkout assignment advertised by this worker', async () => {
  const lease = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/lease.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const assignment = lease.assignment as Record<string, unknown>;
  const send = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...lease,
          assignment: {
            ...assignment,
            executionArtifact: {
              kind: 'source-checkout',
              repository:
                'https://github.com/stanimirivanov/perfeng-playwright',
              revision: 'b'.repeat(40),
              lockfile: 'pnpm-lock.yaml',
              lockfileSha256: 'c'.repeat(64),
            },
          },
        }),
        {
          status: 200,
          headers: { 'x-perfeng-lease': capability },
        },
      ),
    )) as typeof fetch;

  const authority = requireAcquired(
    await acquireNativeLease(
      { controlPlaneOrigin, token, maxWaitSeconds: 20 },
      send,
    ),
  );

  expect(authority.lease.assignment.executionArtifact.kind).toBe(
    'source-checkout',
  );
});

test('rejects invalid long-poll bounds before sending a request', async () => {
  const send = (() =>
    Promise.reject(new Error('request must not be sent'))) as typeof fetch;

  for (const maxWaitSeconds of [-1, 1.5, 31]) {
    await expect(
      acquireNativeLease({ controlPlaneOrigin, token, maxWaitSeconds }, send),
    ).rejects.toThrow('maxWaitSeconds');
  }
});

test('classifies transient failures without exposing response bodies', async () => {
  const send = (() =>
    Promise.resolve(
      new Response(`unavailable ${token}`, {
        status: 503,
        headers: { 'retry-after': '12' },
      }),
    )) as typeof fetch;

  const failure = await acquireNativeLease(
    { controlPlaneOrigin, token, maxWaitSeconds: 20 },
    send,
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(failure).toBeInstanceOf(LeaseAcquisitionFailure);
  expect(failure).toMatchObject({
    retryable: true,
    retryAfterSeconds: 12,
  });
  expect(String(failure)).not.toContain(token);
});

test('pins byte-identical Native Worker acquisition fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v1/examples/acquire.json',
    'native-worker/v1/examples/lease.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
