import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  createNativeUploadGrant,
  UploadGrantFailure,
} from '../src/native-worker/upload-grant.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';
const sha256 = 'f'.repeat(64);
const signedChecksum = '//////////////////////////////////////////8=';

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

function request(authority: AcquiredNativeLease) {
  return {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 5,
    slot: 'measurements',
    size: 4096,
    sha256,
    mediaType: 'application/json',
  };
}

test('acquires an idempotent fenced upload grant without exposing delivery secrets', async () => {
  const [authority, requestDocument, grantDocument] = await Promise.all([
    acquiredLease(),
    readFile(
      'vendor/contracts/native-worker/v1/examples/upload-request.json',
      'utf8',
    ),
    readFile(
      'vendor/contracts/native-worker/v1/examples/upload-grant.json',
      'utf8',
    ),
  ]);
  const bodies: unknown[] = [];
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases/11111111-1111-4111-8111-111111111111/upload-grants',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    bodies.push(JSON.parse(init?.body as string));

    return Promise.resolve(new Response(grantDocument, { status: 201 }));
  }) as typeof fetch;

  const first = await createNativeUploadGrant(request(authority), send);
  const second = await createNativeUploadGrant(request(authority), send);

  expect(bodies).toEqual([
    JSON.parse(requestDocument),
    JSON.parse(requestDocument),
  ]);
  expect(first.grant).toEqual(second.grant);
  expect(first.grant).toMatchObject({
    grantId: '44444444-4444-4444-8444-444444444444',
    runId: 'perf-20260918-120000-a1b2c3d4',
    slot: 'measurements',
    maximumBytes: 1048576,
    sha256,
  });
  const authorization = first.useAuthorization((value) => value);
  expect(authorization).toMatchObject({
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-amz-checksum-sha256': signedChecksum,
    },
  });
  expect(authorization.url).toContain('X-Amz-Signature=');
  expect(JSON.stringify(first)).not.toContain('X-Amz-');
  expect(JSON.stringify(first)).not.toContain(signedChecksum);
  expect(inspect(first)).not.toContain('X-Amz-');
  expect(inspect(first)).not.toContain(signedChecksum);
});

test('rejects declarations outside the assigned artifact plan before sending', async () => {
  const authority = await acquiredLease();
  const send = () => Promise.reject(new Error('request must not be sent'));
  const valid = request(authority);
  const invalid = [
    { ...valid, slot: 'diagnostics' },
    { ...valid, size: 1048577 },
    { ...valid, sha256: 'invalid' },
    { ...valid, mediaType: 'application/octet-stream' },
  ];

  for (const candidate of invalid) {
    await expect(createNativeUploadGrant(candidate, send)).rejects.toThrow();
  }
});

test('rejects grants that change artifact or lease authority', async () => {
  const authority = await acquiredLease();
  const document = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/upload-grant.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const headers = document.uploadHeaders as Record<string, unknown>;
  const cases: Record<string, unknown>[] = [
    { ...document, leaseId: '99999999-9999-4999-8999-999999999999' },
    {
      ...document,
      objectKey:
        'runs/perf-20260918-120000-a1b2c3d4/attempts/22222222-2222-4222-8222-222222222222/manifest',
    },
    { ...document, maximumBytes: 1048575 },
    { ...document, expiresAt: '2026-09-18T12:02:01Z' },
    {
      ...document,
      uploadUrl:
        'https://objects.perfeng.invalid/perfeng-artifacts/runs/perf-20260918-120000-a1b2c3d4/attempts/22222222-2222-4222-8222-222222222222/measurements',
    },
    {
      ...document,
      uploadHeaders: {
        ...headers,
        'content-type': 'application/octet-stream',
      },
    },
    {
      ...document,
      uploadHeaders: {
        ...headers,
        'x-amz-checksum-sha256': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    },
  ];

  for (const candidate of cases) {
    const send = (() =>
      Promise.resolve(
        new Response(JSON.stringify(candidate), { status: 201 }),
      )) as typeof fetch;
    const failure = await createNativeUploadGrant(
      request(authority),
      send,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('X-Amz-Signature');
    expect(String(failure)).not.toContain(signedChecksum);
  }
});

test('classifies grant conflicts, lost authority, retries, and cancellation', async () => {
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
    const failure = await createNativeUploadGrant(
      request(authority),
      send,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(UploadGrantFailure);
    expect(failure).toMatchObject(failureCase.expected);
    expect(String(failure)).not.toContain(capability);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  const failure = await createNativeUploadGrant(
    { ...request(authority), signal: cancelled.signal },
    () => Promise.reject(new Error('aborted')),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(failure).toMatchObject({ kind: 'cancelled' });
});

test('pins byte-identical Native Worker upload-grant fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v1/examples/upload-request.json',
    'native-worker/v1/examples/upload-grant.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
