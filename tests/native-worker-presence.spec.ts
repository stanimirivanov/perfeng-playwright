import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  PresenceRequestFailure,
  parsePresenceStatus,
  reportWorkerPresence,
} from '../src/native-worker/client.js';
import { parseWorkerPresenceConfiguration } from '../src/native-worker/configuration.js';
import { createWorkerPresence } from '../src/native-worker/presence.js';
import type {
  WorkerPresence,
  WorkerPresenceConfiguration,
} from '../src/native-worker/types.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { parseWorkerCommand, workerMain } from '../src/worker-cli.js';

const configuration: WorkerPresenceConfiguration = {
  schemaVersion: 2,
  controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
  browsers: ['chromium'],
  environment: {
    id: 'linux-mainstream',
    sha256: 'a'.repeat(64),
  },
};

const source: SourceCheckoutArtifact = {
  kind: 'source-checkout',
  repository: 'https://github.com/stanimirivanov/perfeng-playwright',
  gitSha: 'b'.repeat(40),
  dependencyLock: {
    path: 'pnpm-lock.yaml',
    sha256: 'c'.repeat(64),
  },
};

function presence(): WorkerPresence {
  return createWorkerPresence({
    configuration,
    source,
    agentVersion: '0.13.0',
    platform: 'linux',
    architecture: 'x64',
  });
}

test('parses a closed worker presence configuration', () => {
  expect(
    parseWorkerPresenceConfiguration(JSON.stringify(configuration)),
  ).toEqual(configuration);
  expect(() =>
    parseWorkerPresenceConfiguration(
      JSON.stringify({ ...configuration, schemaVersion: 1 }),
    ),
  ).toThrow('Unsupported worker presence configuration schemaVersion');
});

test('refuses Windows presence instead of relabeling the host as Linux', () => {
  expect(() =>
    createWorkerPresence({
      configuration,
      source,
      agentVersion: '0.13.0',
      platform: 'win32',
      architecture: 'x64',
    }),
  ).toThrow('requires Linux');
});

test('keeps the distributed v2 example valid and unavailable by construction', async () => {
  const example = await readFile(
    'examples/native-worker-presence.json',
    'utf8',
  );
  const parsed = parseWorkerPresenceConfiguration(example);
  expect(parsed).toEqual(configuration);
  expect(
    createWorkerPresence({
      configuration: parsed,
      source,
      agentVersion: '0.13.0',
      platform: 'linux',
      architecture: 'x64',
    }).availability,
  ).toBe('UNAVAILABLE');
});

test('rejects v1-only browsers from a v2 presence configuration', () => {
  for (const browsers of [['edge'], ['chromium', 'edge'], ['chrome']]) {
    expect(() =>
      parseWorkerPresenceConfiguration(
        JSON.stringify({ ...configuration, browsers }),
      ),
    ).toThrow('requires only chromium');
  }
  expect(() =>
    parseWorkerPresenceConfiguration(
      JSON.stringify({ ...configuration, schemaVersion: 3 }),
    ),
  ).toThrow('Unsupported worker presence configuration schemaVersion');
});

test('rejects unsafe origins and invalid qualification identifiers', () => {
  for (const controlPlaneOrigin of [
    'http://control-plane.perfeng.invalid',
    'https://user:secret@control-plane.perfeng.invalid',
    'https://control-plane.perfeng.invalid/api',
    'https://control-plane.perfeng.invalid?token=secret',
  ]) {
    expect(() =>
      parseWorkerPresenceConfiguration(
        JSON.stringify({ ...configuration, controlPlaneOrigin }),
      ),
    ).toThrow('absolute HTTPS origin');
  }
  expect(() =>
    parseWorkerPresenceConfiguration(
      JSON.stringify({
        ...configuration,
        environment: { ...configuration.environment, id: 'Windows Mainstream' },
      }),
    ),
  ).toThrow('contract identifier');
  expect(() =>
    parseWorkerPresenceConfiguration(
      JSON.stringify({ ...configuration, browsers: ['edge', 'edge'] }),
    ),
  ).toThrow('requires only chromium');
});

test('reports only the reviewed v2 baseline Chromium capabilities', async () => {
  const reviewed = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const actual = createWorkerPresence({
    configuration: configuration,
    source,
    agentVersion: '0.13.0',
    platform: 'linux',
    architecture: 'x64',
  });
  expect(actual).toEqual({
    ...reviewed,
    agentVersion: '0.13.0',
    availability: 'UNAVAILABLE',
    qualificationEvidence: {
      environmentId: 'linux-mainstream',
      environmentSha256: 'a'.repeat(64),
      runner: {
        kind: 'source-checkout',
        repository: source.repository,
        revision: source.gitSha,
        lockfile: 'pnpm-lock.yaml',
        lockfileSha256: 'c'.repeat(64),
      },
    },
  });
});

test('posts v2 presence to the isolated endpoint and parses its acknowledgement', async () => {
  const responseDocument = await readFile(
    'vendor/contracts/native-worker/v2/examples/presence-status.json',
    'utf8',
  );
  const v2Presence = createWorkerPresence({
    configuration: configuration,
    source,
    agentVersion: '0.13.0',
    platform: 'linux',
    architecture: 'x64',
  });
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v2/presence',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer worker-secret',
    );
    expect(JSON.parse(init?.body as string)).toEqual(v2Presence);
    return Promise.resolve(new Response(responseDocument, { status: 200 }));
  }) as typeof fetch;

  const status = await reportWorkerPresence(
    {
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token: 'worker-secret',
      presence: v2Presence,
    },
    send,
  );
  expect(status.workerId).toBe('linux-workstation-01');
  expect(status.nextHeartbeatSeconds).toBe(30);
});

test('rejects an unsupported presence protocol before network access', async () => {
  let sent = false;
  const send = (() => {
    sent = true;
    return Promise.reject(new Error('unexpected network request'));
  }) as typeof fetch;
  await expect(
    reportWorkerPresence(
      {
        controlPlaneOrigin: configuration.controlPlaneOrigin,
        token: 'worker-secret',
        presence: {
          ...presence(),
          protocolVersion: 3,
        } as unknown as WorkerPresence,
      },
      send,
    ),
  ).rejects.toThrow('Unsupported Native Worker presence protocolVersion');
  expect(sent).toBe(false);
});

test('keeps credentials and server bodies out of request failures', async () => {
  const token = 'worker-secret';
  const send = (() =>
    Promise.resolve(
      new Response(`rejected ${token}`, { status: 401 }),
    )) as typeof fetch;

  await expect(
    reportWorkerPresence(
      {
        controlPlaneOrigin: configuration.controlPlaneOrigin,
        token,
        presence: presence(),
      },
      send,
    ),
  ).rejects.toThrow('rejected with status 401');
  const error = await reportWorkerPresence(
    {
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token,
      presence: presence(),
    },
    send,
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(String(error)).not.toContain(token);
  expect(String(error)).not.toContain('rejected worker-secret');
});

test('classifies transient presence failures without exposing response bodies', async () => {
  const send = (() =>
    Promise.resolve(
      new Response('temporarily unavailable', {
        status: 503,
        headers: { 'retry-after': '17' },
      }),
    )) as typeof fetch;

  const failure = await reportWorkerPresence(
    {
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token: 'worker-secret',
      presence: presence(),
    },
    send,
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(failure).toBeInstanceOf(PresenceRequestFailure);
  expect(failure).toMatchObject({
    retryable: true,
    retryAfterSeconds: 17,
  });
  expect(String(failure)).not.toContain('temporarily unavailable');
});

test('rejects invalid Retry-After values from transient responses', async () => {
  const send = (() =>
    Promise.resolve(
      new Response(null, {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    )) as typeof fetch;

  await expect(
    reportWorkerPresence(
      {
        controlPlaneOrigin: configuration.controlPlaneOrigin,
        token: 'worker-secret',
        presence: presence(),
      },
      send,
    ),
  ).rejects.toThrow('invalid Retry-After');
});

test('rejects oversized and structurally invalid presence responses', async () => {
  const oversized = (() =>
    Promise.resolve(
      new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    )) as typeof fetch;
  await expect(
    reportWorkerPresence(
      {
        controlPlaneOrigin: configuration.controlPlaneOrigin,
        token: 'worker-secret',
        presence: presence(),
      },
      oversized,
    ),
  ).rejects.toThrow('exceeds 64 KiB');

  const valid = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v2/examples/presence-status.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  expect(() =>
    parsePresenceStatus(
      JSON.stringify({ ...valid, nextHeartbeatSeconds: 301 }),
    ),
  ).toThrow('must not exceed 300');
  expect(() =>
    parsePresenceStatus(
      JSON.stringify({
        ...valid,
        qualification: { status: 'STALE', reasons: [] },
      }),
    ),
  ).toThrow('requires a reason');
});

test('pins byte-identical Native Worker presence fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as {
    v2SourceRevision: string;
    v2BundleVersion: string;
    nativeWorkerApiV2Version: string;
    files: Record<string, string>;
  };
  expect(lock).toMatchObject({
    v2SourceRevision: '55d28f4f432825c1dc504ca0f03ee308e66fb62c',
    v2BundleVersion: '0.27.0',
    nativeWorkerApiV2Version: '2.3.0',
  });
  for (const [path, expected] of Object.entries(lock.files)) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
  }
});

test('parses the isolated worker presence command and requires a credential', async () => {
  expect(
    parseWorkerCommand(['presence', '--config', 'worker-presence.json']),
  ).toEqual({
    action: 'presence',
    configurationPath: 'worker-presence.json',
  });
  expect(
    parseWorkerCommand(['heartbeat', '--config', 'worker-presence.json']),
  ).toEqual({
    action: 'heartbeat',
    configurationPath: 'worker-presence.json',
  });
  expect(() => parseWorkerCommand(['run'])).toThrow('Usage:');
  await expect(
    workerMain(['presence', '--config', 'missing.json'], {}),
  ).rejects.toThrow('PERFENG_NATIVE_WORKER_TOKEN is required');
});
