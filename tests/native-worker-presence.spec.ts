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
  schemaVersion: 1,
  controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
  browsers: ['edge', 'chromium'],
  environment: {
    id: 'windows-mainstream',
    sha256: 'a'.repeat(64),
  },
};

const v2Configuration: WorkerPresenceConfiguration = {
  ...configuration,
  schemaVersion: 2,
  browsers: ['chromium'],
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
    platform: 'win32',
    architecture: 'x64',
  });
}

test('parses a closed worker presence configuration', () => {
  expect(
    parseWorkerPresenceConfiguration(JSON.stringify(configuration)),
  ).toEqual(configuration);
  expect(
    parseWorkerPresenceConfiguration(JSON.stringify(v2Configuration)),
  ).toEqual(v2Configuration);
});

test('keeps the distributed v2 example valid and unavailable by construction', async () => {
  const example = await readFile(
    'examples/native-worker-v2-presence.json',
    'utf8',
  );
  const parsed = parseWorkerPresenceConfiguration(example);
  expect(parsed).toEqual(v2Configuration);
  expect(
    createWorkerPresence({
      configuration: parsed,
      source,
      agentVersion: '0.13.0',
      platform: 'win32',
      architecture: 'x64',
    }).availability,
  ).toBe('UNAVAILABLE');
});

test('rejects v1-only browsers from a v2 presence configuration', () => {
  for (const browsers of [['edge'], ['chromium', 'edge'], ['chrome']]) {
    expect(() =>
      parseWorkerPresenceConfiguration(
        JSON.stringify({ ...v2Configuration, browsers }),
      ),
    ).toThrow('requires only chromium');
  }
  expect(() =>
    parseWorkerPresenceConfiguration(
      JSON.stringify({ ...v2Configuration, schemaVersion: 3 }),
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
  ).toThrow('duplicate');
});

test('reports only verified Windows capabilities and remains unavailable', () => {
  expect(presence()).toEqual({
    protocolVersion: 1,
    agentVersion: '0.13.0',
    availability: 'UNAVAILABLE',
    capabilities: {
      capacity: 1,
      tool: 'playwright',
      operatingSystem: 'windows',
      architecture: 'x64',
      browsers: ['edge', 'chromium'],
      runnerContract: 1,
      executionArtifacts: ['source-checkout'],
      artifactKinds: ['measurements', 'diagnostics'],
      diagnosticModes: ['lightweight', 'trace', 'heap'],
    },
    qualificationEvidence: {
      environmentId: 'windows-mainstream',
      environmentSha256: 'a'.repeat(64),
      runner: {
        kind: 'source-checkout',
        repository: source.repository,
        revision: 'b'.repeat(40),
        lockfile: 'pnpm-lock.yaml',
        lockfileSha256: 'c'.repeat(64),
      },
    },
  });
  expect(() =>
    createWorkerPresence({
      configuration,
      source,
      agentVersion: '0.13.0',
      platform: 'linux',
      architecture: 'x64',
    }),
  ).toThrow('requires Windows');
});

test('reports only the reviewed v2 baseline Chromium capabilities', async () => {
  const reviewed = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v2/examples/presence.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const actual = createWorkerPresence({
    configuration: v2Configuration,
    source,
    agentVersion: '0.13.0',
    platform: 'win32',
    architecture: 'x64',
  });
  expect(actual).toEqual({
    ...reviewed,
    agentVersion: '0.13.0',
    availability: 'UNAVAILABLE',
    qualificationEvidence: {
      environmentId: 'windows-mainstream',
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

test('posts presence to the fixed endpoint with bearer authentication', async () => {
  const responseDocument = await readFile(
    'vendor/contracts/native-worker/v1/examples/presence-status.json',
    'utf8',
  );
  const token = 'worker-secret';
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/presence',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual(presence());
    return Promise.resolve(
      new Response(responseDocument, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  const status = await reportWorkerPresence(
    {
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token,
      presence: presence(),
    },
    send,
  );

  expect(status.workerId).toBe('windows-laptop-01');
  expect(status.qualification.status).toBe('QUALIFIED');
  expect(status.authorizedToAcquire).toBe(true);
});

test('posts v2 presence to the isolated endpoint and parses its acknowledgement', async () => {
  const responseDocument = await readFile(
    'vendor/contracts/native-worker/v2/examples/presence-status.json',
    'utf8',
  );
  const v2Presence = createWorkerPresence({
    configuration: v2Configuration,
    source,
    agentVersion: '0.13.0',
    platform: 'win32',
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
      controlPlaneOrigin: v2Configuration.controlPlaneOrigin,
      token: 'worker-secret',
      presence: v2Presence,
    },
    send,
  );
  expect(status.workerId).toBe('windows-laptop-01');
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
      'vendor/contracts/native-worker/v1/examples/presence-status.json',
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
    sourceRevision: string;
    bundleVersion: string;
    nativeWorkerApiVersion: string;
    reviewedOpenApiSha256: string;
    files: Record<string, string>;
  };
  expect(lock).toMatchObject({
    sourceRevision: 'be847a4c7c0ad22c799389410a8c234d5492abc3',
    bundleVersion: '0.17.0',
    nativeWorkerApiVersion: '1.0.0',
    reviewedOpenApiSha256:
      '46c2dea401c086b9ba748d1214fea5795a245f56eb8226e38ed03922a98ca51d',
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
