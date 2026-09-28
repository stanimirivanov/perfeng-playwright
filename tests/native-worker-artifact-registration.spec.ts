import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import {
  ArtifactRegistrationFailure,
  registerNativeArtifact,
} from '../src/native-worker/artifact-registration.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  AcquiredNativeUploadGrant,
  createNativeUploadGrant,
} from '../src/native-worker/upload-grant.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';
const sha256 = 'f'.repeat(64);

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

async function acquiredGrant(
  authority: AcquiredNativeLease,
): Promise<AcquiredNativeUploadGrant> {
  const document = await readFile(
    'vendor/contracts/native-worker/v1/examples/upload-grant.json',
    'utf8',
  );
  return createNativeUploadGrant(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 5,
      slot: 'measurements',
      size: 4096,
      sha256,
      mediaType: 'application/json',
    },
    () => Promise.resolve(new Response(document, { status: 201 })),
  );
}

async function registrationRequest() {
  const authority = await acquiredLease();
  return {
    controlPlaneOrigin,
    token,
    authority,
    grant: await acquiredGrant(authority),
    expectedRunRevision: 5,
    size: 4096,
    sha256,
  };
}

test('registers exact uploaded evidence under the active lease fence', async () => {
  const [request, requestDocument, artifactDocument] = await Promise.all([
    registrationRequest(),
    readFile(
      'vendor/contracts/native-worker/v1/examples/register-artifact.json',
      'utf8',
    ),
    readFile(
      'vendor/contracts/native-worker/v1/examples/artifact.json',
      'utf8',
    ),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases/11111111-1111-4111-8111-111111111111/artifacts',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    expect(JSON.parse(init?.body as string)).toEqual(
      JSON.parse(requestDocument),
    );
    return Promise.resolve(new Response(artifactDocument, { status: 201 }));
  }) as typeof fetch;

  await expect(registerNativeArtifact(request, send)).resolves.toEqual({
    artifactId: '33333333-3333-4333-8333-333333333333',
    runId: 'perf-20260918-120000-a1b2c3d4',
    attemptId: '22222222-2222-4222-8222-222222222222',
    slot: 'measurements',
    kind: 'measurements',
    uri: 's3://perfeng/runs/perf-20260918-120000-a1b2c3d4/attempts/22222222-2222-4222-8222-222222222222/measurements',
    size: 4096,
    sha256,
    mediaType: 'application/json',
    registeredAt: '2026-09-18T12:01:15Z',
  });
});

test('rejects declarations and grants outside the active artifact fence', async () => {
  const request = await registrationRequest();
  const send = () => Promise.reject(new Error('request must not be sent'));
  await expect(
    registerNativeArtifact({ ...request, size: 1048577 }, send),
  ).rejects.toThrow('does not match');
  await expect(
    registerNativeArtifact({ ...request, sha256: 'a'.repeat(64) }, send),
  ).rejects.toThrow('does not match');

  const authorization = request.grant.useAuthorization((value) => value);
  const foreignGrant = new AcquiredNativeUploadGrant(
    { ...request.grant.grant, runId: 'perf-20260918-120000-deadbeef' },
    authorization,
  );
  await expect(
    registerNativeArtifact({ ...request, grant: foreignGrant }, send),
  ).rejects.toThrow('does not match');
});

test('rejects server references that change artifact identity or evidence', async () => {
  const request = await registrationRequest();
  const document = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/artifact.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const cases: Record<string, unknown>[] = [
    { ...document, runId: 'perf-20260918-120000-deadbeef' },
    { ...document, attemptId: '99999999-9999-4999-8999-999999999999' },
    { ...document, slot: 'diagnostics' },
    { ...document, kind: 'diagnostics' },
    {
      ...document,
      uri: 's3://perfeng/runs/perf-20260918-120000-a1b2c3d4/attempts/22222222-2222-4222-8222-222222222222/diagnostics',
    },
    { ...document, size: 4095 },
    { ...document, sha256: 'a'.repeat(64) },
    { ...document, mediaType: 'application/octet-stream' },
    { ...document, registeredAt: '2026-09-18T12:02:01Z' },
  ];

  for (const candidate of cases) {
    await expect(
      registerNativeArtifact(request, () =>
        Promise.resolve(
          new Response(JSON.stringify(candidate), { status: 201 }),
        ),
      ),
    ).rejects.toThrow('artifact fence');
  }
});

test('classifies registration conflicts, lost authority, retries, and cancellation', async () => {
  const request = await registrationRequest();
  const cases = [
    { responseStatus: 409, expected: { kind: 'conflict' } },
    { responseStatus: 410, expected: { kind: 'lost' } },
    {
      responseStatus: 503,
      expected: { kind: 'retryable', retryAfterSeconds: 12 },
    },
  ] as const;
  for (const failureCase of cases) {
    const failure = await registerNativeArtifact(request, () =>
      Promise.resolve(
        new Response(`sensitive ${capability}`, {
          status: failureCase.responseStatus,
          headers: { 'retry-after': '12' },
        }),
      ),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(ArtifactRegistrationFailure);
    expect(failure).toMatchObject(failureCase.expected);
    expect(String(failure)).not.toContain(capability);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    registerNativeArtifact({ ...request, signal: cancelled.signal }, () =>
      Promise.reject(new Error(capability)),
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});

test('pins byte-identical Native Worker artifact-registration fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v1/examples/register-artifact.json',
    'native-worker/v1/examples/artifact.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
