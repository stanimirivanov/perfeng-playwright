import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  inspectNativeAttempt,
  parseNativeAttemptInspection,
} from '../src/native-worker/attempt-inspection.js';
import { parseWorkerCommand, workerMain } from '../src/worker-cli.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const origin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret-must-not-be-printed';
const runId = 'perf-20260918-120000-a1b2c3d4';
const attemptId = '22222222-2222-4222-8222-222222222222';

async function fixture(name: string): Promise<string> {
  return readFile(`${fixtureRoot}/${name}.json`, 'utf8');
}

test('accepts the three closed server snapshots and pins the reviewed examples', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const [name, state] of [
    ['attempt-active', 'ACTIVE'],
    ['attempt-inactive', 'INACTIVE'],
    ['attempt-terminal', 'TERMINAL'],
  ] as const) {
    const path = `native-worker/v2/examples/${name}.json`;
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
    expect(
      parseNativeAttemptInspection(bytes.toString('utf8'), runId, attemptId)
        .state,
    ).toBe(state);
  }
  for (const name of ['inspect-attempt', 'attempt-not-found-error']) {
    const path = `native-worker/v2/examples/${name}.json`;
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});

test('sends a bounded read-only request without a lease capability', async () => {
  const response = await fixture('attempt-active');
  let requests = 0;
  const result = await inspectNativeAttempt(
    { controlPlaneOrigin: origin, token, runId, attemptId },
    (input, init) => {
      requests += 1;
      expect(input).toBeInstanceOf(URL);
      expect((input as URL).href).toBe(
        `${origin}/native-worker/v2/attempts/inspect`,
      );
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      });
      expect(init?.body).toBe(
        JSON.stringify({ protocolVersion: 2, runId, attemptId }),
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(response, { status: 200 }));
    },
  );
  expect(requests).toBe(1);
  expect(result).toMatchObject({
    kind: 'found',
    inspection: { state: 'ACTIVE', runId, attemptId },
  });
  expect(JSON.stringify(result)).not.toContain(token);
});

test("does not distinguish missing from another worker's attempt", async () => {
  const body = await fixture('attempt-not-found-error');
  const result = await inspectNativeAttempt(
    { controlPlaneOrigin: origin, token, runId, attemptId },
    () => Promise.resolve(new Response(body, { status: 404 })),
  );
  expect(result).toEqual({ kind: 'not-found', runId, attemptId });
  expect(JSON.stringify(result)).not.toContain('not available to this worker');
});

test('does not mistake an unsupported inspection route for a missing attempt', async () => {
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId, attemptId },
      () => Promise.resolve(new Response('route not found', { status: 404 })),
    ),
  ).rejects.toThrow('invalid 404 response');
});

test('rejects invalid inputs before transport and rejects mismatched or expanded snapshots', async () => {
  let requests = 0;
  const send: typeof fetch = () => {
    requests += 1;
    return Promise.resolve(new Response('{}'));
  };
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId: 'invalid', attemptId },
      send,
    ),
  ).rejects.toThrow('runId');
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId, attemptId: 'invalid' },
      send,
    ),
  ).rejects.toThrow('attemptId');
  expect(requests).toBe(0);

  const active = JSON.parse(await fixture('attempt-active')) as Record<
    string,
    unknown
  >;
  expect(() =>
    parseNativeAttemptInspection(
      JSON.stringify({ ...active, runId: 'perf-20260918-120000-ffffffff' }),
      runId,
      attemptId,
    ),
  ).toThrow('changed its requested identity');
  expect(() =>
    parseNativeAttemptInspection(
      JSON.stringify({ ...active, leaseCapability: 'secret' }),
      runId,
      attemptId,
    ),
  ).toThrow();
  expect(() =>
    parseNativeAttemptInspection(
      JSON.stringify({ ...active, state: 'INACTIVE' }),
      runId,
      attemptId,
    ),
  ).toThrow();
  expect(() =>
    parseNativeAttemptInspection(
      JSON.stringify({ ...active, runRevision: 0 }),
      runId,
      attemptId,
    ),
  ).toThrow();
});

test('bounds responses and redacts transport or server details', async () => {
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId, attemptId },
      () => Promise.reject(new Error(`private ${token}`)),
    ),
  ).rejects.toThrow('Native attempt inspection request failed');
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId, attemptId },
      () => Promise.resolve(new Response(`private ${token}`, { status: 503 })),
    ),
  ).rejects.toThrow('status 503');
  await expect(
    inspectNativeAttempt(
      { controlPlaneOrigin: origin, token, runId, attemptId },
      () => Promise.resolve(new Response('x'.repeat(65_537))),
    ),
  ).rejects.toThrow('exceeds 64 KiB');
});

test('exposes explicit operator command without checkout or local spool access', async () => {
  const args = [
    'attempt-status',
    '--config',
    'examples/native-worker-presence.json',
    '--run-id',
    runId,
    '--attempt-id',
    attemptId,
  ];
  expect(parseWorkerCommand(args)).toEqual({
    action: 'attempt-status',
    configurationPath: 'examples/native-worker-presence.json',
    runId,
    attemptId,
  });
  await expect(workerMain(args, {})).rejects.toThrow(
    'PERFENG_NATIVE_WORKER_TOKEN is required',
  );

  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ code: 'ATTEMPT_NOT_FOUND', message: 'private error' }),
        { status: 404 },
      ),
    );
  };
  try {
    expect(
      await workerMain(args, { PERFENG_NATIVE_WORKER_TOKEN: token }),
    ).toEqual({
      kind: 'not-found',
      runId,
      attemptId,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(requests).toBe(1);
});
