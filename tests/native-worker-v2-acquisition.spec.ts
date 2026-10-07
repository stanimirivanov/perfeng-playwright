import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

import { expect, test } from '@playwright/test';

import { LeaseAcquisitionFailure } from '../src/native-worker/acquisition.js';
import {
  acquireNativeV2Lease,
  type AcquiredNativeV2Lease,
  type NativeV2LeaseAcquisition,
  type NativeV2LeaseAcquisitionRequest,
} from '../src/native-worker/acquisition.js';
import type { NativeWorkerQualificationEvidence } from '../src/native-worker/execution-recipe.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';

function requireAcquired(
  result: NativeV2LeaseAcquisition,
): AcquiredNativeV2Lease {
  if (result.kind !== 'acquired') {
    throw new Error('Expected a v2 lease');
  }
  return result.authority;
}

async function fixtures(): Promise<{
  acquire: unknown;
  lease: string;
  request: NativeV2LeaseAcquisitionRequest;
}> {
  const [acquireText, lease, presenceText] = await Promise.all([
    readFile('vendor/contracts/native-worker/v2/examples/acquire.json', 'utf8'),
    readFile('vendor/contracts/native-worker/v2/examples/lease.json', 'utf8'),
    readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  return {
    acquire: JSON.parse(acquireText) as unknown,
    lease,
    request: {
      controlPlaneOrigin,
      token,
      maxWaitSeconds: 20,
      currentEvidence: presence.qualificationEvidence,
    },
  };
}

test('acquires a reviewed v2 recipe with its capability kept outside JSON and diagnostics', async () => {
  const { acquire, lease, request } = await fixtures();
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v2/leases',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(JSON.parse(init?.body as string)).toEqual(acquire);
    return Promise.resolve(
      new Response(lease, {
        status: 200,
        headers: { 'x-perfeng-lease': capability },
      }),
    );
  }) as typeof fetch;

  const authority = requireAcquired(await acquireNativeV2Lease(request, send));
  expect(authority.recipe).toMatchObject({
    leaseId: '11111111-1111-4111-8111-111111111111',
    runId: 'perf-20260918-120000-a1b2c3d4',
    targetEnvironmentId: 'local-demo',
    configuration: {
      scenario: { cacheProfile: 'cold', measurementIterations: 5 },
      browser: { viewport: { width: 1366, height: 768 } },
    },
  });
  expect(authority.useCapability((value) => value)).toBe(capability);
  expect(JSON.stringify(authority)).not.toContain(capability);
  expect(inspect(authority)).not.toContain(capability);
});

test('returns the server retry interval for idle v2 acquisition', async () => {
  const { request } = await fixtures();
  const send = (() =>
    Promise.resolve(
      new Response(null, {
        status: 204,
        headers: { 'retry-after': '15' },
      }),
    )) as typeof fetch;

  expect(await acquireNativeV2Lease(request, send)).toEqual({
    kind: 'idle',
    retryAfterSeconds: 15,
  });
});

test('rejects invalid bounds and origin before sending a v2 request', async () => {
  const { request } = await fixtures();
  let sent = false;
  const send = (() => {
    sent = true;
    return Promise.reject(new Error('unexpected request'));
  }) as typeof fetch;

  for (const maxWaitSeconds of [-1, 1.5, 31]) {
    await expect(
      acquireNativeV2Lease({ ...request, maxWaitSeconds }, send),
    ).rejects.toThrow('maxWaitSeconds');
  }
  await expect(
    acquireNativeV2Lease(
      {
        ...request,
        controlPlaneOrigin: 'http://control-plane.perfeng.invalid',
      },
      send,
    ),
  ).rejects.toThrow('absolute HTTPS origin');
  expect(sent).toBe(false);
});

test('rejects malformed idle, missing capability and incompatible v2 recipes', async () => {
  const { lease, request } = await fixtures();
  const missingRetryAfter = (() =>
    Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;
  await expect(
    acquireNativeV2Lease(request, missingRetryAfter),
  ).rejects.toThrow('invalid Retry-After');

  const missingCapability = (() =>
    Promise.resolve(new Response(lease, { status: 200 }))) as typeof fetch;
  await expect(
    acquireNativeV2Lease(request, missingCapability),
  ).rejects.toThrow('lease capability is missing or invalid');

  const sendLease = (() =>
    Promise.resolve(
      new Response(lease, {
        status: 200,
        headers: { 'x-perfeng-lease': capability },
      }),
    )) as typeof fetch;
  await expect(
    acquireNativeV2Lease(
      {
        ...request,
        currentEvidence: {
          ...request.currentEvidence,
          environmentSha256: 'd'.repeat(64),
        },
      },
      sendLease,
    ),
  ).rejects.toThrow('Assigned environment differs');

  const decoded = JSON.parse(lease) as Record<string, unknown>;
  const assignment = decoded.assignment as Record<string, unknown>;
  const incomplete = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ...decoded,
          assignment: { ...assignment, recipe: undefined },
        }),
        {
          status: 200,
          headers: { 'x-perfeng-lease': capability },
        },
      ),
    )) as typeof fetch;
  await expect(acquireNativeV2Lease(request, incomplete)).rejects.toThrow();
});

test('classifies v2 HTTP failures without leaking credentials or response bodies', async () => {
  const { request } = await fixtures();
  const transient = (() =>
    Promise.resolve(
      new Response(`unavailable ${token}`, {
        status: 503,
        headers: { 'retry-after': '12' },
      }),
    )) as typeof fetch;
  const failure = await acquireNativeV2Lease(request, transient).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(failure).toBeInstanceOf(LeaseAcquisitionFailure);
  expect(failure).toMatchObject({
    retryable: true,
    retryAfterSeconds: 12,
  });
  expect(String(failure)).not.toContain(token);
  expect(String(failure)).not.toContain('unavailable worker-secret');

  for (const status of [400, 401, 403]) {
    const rejected = (() =>
      Promise.resolve(
        new Response(`secret ${token}`, { status }),
      )) as typeof fetch;
    const outcome = await acquireNativeV2Lease(request, rejected).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(outcome).toBeInstanceOf(LeaseAcquisitionFailure);
    expect(outcome).toMatchObject({ retryable: false });
    expect(String(outcome)).not.toContain(token);
  }
});

test('pins byte-identical Native Worker v2 acquisition fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v2/examples/acquire.json',
    'native-worker/v2/examples/lease.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
