import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  discoverNativeAttempt,
  parseNativeAttemptDiscovery,
  timestampNanoseconds,
} from '../src/native-worker/attempt-discovery.js';

const root = 'vendor/contracts/native-worker/v2/examples';
const token = 'private-worker-token';
const request = {
  controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
  token,
};
const headers = { 'cache-control': 'no-store' };
const fixture = (name: string): Promise<string> =>
  readFile(`${root}/${name}.json`, 'utf8');

test('validates every reviewed discovery variant and every vendored checksum', async () => {
  for (const name of [
    'discovery-active',
    'discovery-terminal',
    'discovery-none',
    'discovery-available',
    'discovery-unreported',
  ]) {
    const text = await fixture(name);
    expect(JSON.stringify(parseNativeAttemptDiscovery(text))).not.toContain(
      token,
    );
  }
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  expect(Object.keys(lock.files)).toHaveLength(26);
  for (const [path, checksum] of Object.entries(lock.files)) {
    expect(
      createHash('sha256')
        .update(await readFile(`vendor/contracts/${path}`))
        .digest('hex'),
    ).toBe(checksum);
  }
});

test('sends one bounded principal-only request without capability or selectors', async () => {
  const body = await fixture('discovery-none');
  const inputBody = await fixture('discover-attempt');
  let calls = 0;
  expect(
    await discoverNativeAttempt(request, (input, init) => {
      calls++;
      expect((input as URL).href).toBe(
        `${request.controlPlaneOrigin}/native-worker/v2/attempts/discover`,
      );
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify(JSON.parse(inputBody)),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(new Headers(init?.headers).has('x-perfeng-lease')).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response(body, { headers }));
    }),
  ).toMatchObject({ state: 'NONE', availability: 'UNAVAILABLE' });
  expect(calls).toBe(1);
});

test('rejects expanded unions and inconsistent or expired clocks', async () => {
  const active = JSON.parse(await fixture('discovery-active')) as {
    serverTime: string;
    slotExpiresAt: string;
    attempt: Record<string, unknown>;
    availability: string;
  };
  const invalid = [
    { ...active, workerId: 'other' },
    { ...active, leaseCapability: token },
    { ...active, state: 'NONE' },
    { ...active, availability: 'UNREPORTED' },
    { ...active, slotExpiresAt: active.serverTime },
    { ...active, attempt: { ...active.attempt, state: 'INACTIVE' } },
    { ...active, attempt: { ...active.attempt, leaseCapability: token } },
    {
      ...active,
      attempt: { ...active.attempt, serverTime: active.slotExpiresAt },
    },
    {
      ...active,
      attempt: { ...active.attempt, expiresAt: '2026-09-18T12:03:00Z' },
    },
    { ...active, attempts: [active.attempt] },
    { ...active, slotExpiresAt: undefined },
  ];
  for (const value of invalid)
    expect(() => parseNativeAttemptDiscovery(JSON.stringify(value))).toThrow();
  const terminal = JSON.parse(await fixture('discovery-terminal')) as {
    attempt: Record<string, unknown>;
  };
  expect(() =>
    parseNativeAttemptDiscovery(
      JSON.stringify({
        ...terminal,
        attempt: { ...terminal.attempt, acceptedAt: '2026-09-18T13:00:00Z' },
      }),
    ),
  ).toThrow();
});

test('preserves nanosecond-exclusive expiry and timezone-equivalent clocks', async () => {
  expect(() => timestampNanoseconds('2026-02-30T12:00:00Z')).toThrow();
  expect(() => timestampNanoseconds('2026-09-18T24:00:00Z')).toThrow();
  const active = JSON.parse(await fixture('discovery-active')) as {
    attempt: Record<string, unknown>;
  };
  const exact = {
    ...active,
    serverTime: '2026-09-18T12:01:00.000000001Z',
    slotExpiresAt: '2026-09-18T12:01:00.000000002Z',
    attempt: {
      ...active.attempt,
      serverTime: '2026-09-18T14:01:00.000000001+02:00',
      expiresAt: '2026-09-18T12:01:00.000000002Z',
    },
  };
  expect(parseNativeAttemptDiscovery(JSON.stringify(exact)).state).toBe(
    'FOUND',
  );
  expect(
    timestampNanoseconds(exact.slotExpiresAt) -
      timestampNanoseconds(exact.serverTime),
  ).toBe(1n);
});

test('fails closed on unsupported routes, redirects, authority headers and caching', async () => {
  for (const status of [301, 401, 403, 404, 429, 500, 503]) {
    await expect(
      discoverNativeAttempt(request, () =>
        Promise.resolve(new Response(token, { status })),
      ),
    ).rejects.toThrow(`status ${String(status)}`);
  }
  for (const unsafeHeaders of [
    {},
    { 'cache-control': 'public' },
    { ...headers, 'x-perfeng-lease': token },
  ]) {
    await expect(
      discoverNativeAttempt(request, () =>
        Promise.resolve(new Response('{}', { headers: unsafeHeaders })),
      ),
    ).rejects.toThrow('unsafe response headers');
  }
});

test('rejects cancelled or unsafe inputs before sending and redacts failed body streams', async () => {
  let calls = 0;
  const send: typeof fetch = () => {
    calls++;
    return Promise.reject(new Error(token));
  };
  await expect(
    discoverNativeAttempt({ ...request, token: 'unsafe token' }, send),
  ).rejects.toThrow('credential');
  await expect(
    discoverNativeAttempt(
      { ...request, controlPlaneOrigin: 'http://localhost' },
      send,
    ),
  ).rejects.toThrow('HTTPS');
  await expect(
    discoverNativeAttempt({ ...request, signal: AbortSignal.abort() }, send),
  ).rejects.toThrow('cancelled');
  expect(calls).toBe(0);
  await expect(discoverNativeAttempt(request, send)).rejects.toThrow(
    'discovery request failed',
  );
  for (const response of [
    new Response('x'.repeat(65_537), { headers }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(token));
        },
      }),
      { headers },
    ),
  ]) {
    await expect(
      discoverNativeAttempt(request, () => Promise.resolve(response)),
    ).rejects.toThrow('could not be read safely');
  }
});
