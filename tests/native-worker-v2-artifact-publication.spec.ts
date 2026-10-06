import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition-v2.js';
import {
  publishNativeArtifact,
  type NativeArtifactPublicationRequest,
} from '../src/native-worker/artifact-publication.js';
import { registerNativeArtifact } from '../src/native-worker/artifact-registration.js';
import {
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import { createNativeUploadGrant } from '../src/native-worker/upload-grant.js';

const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';
const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const sha256 = 'f'.repeat(64);

type RegistrationReply = () => Promise<Response>;

async function publicationWithRegistrationReplies(
  replies: RegistrationReply[],
  expectedRunRevision: NativeArtifactPublicationRequest['expectedRunRevision'] = 5,
  grantReplies?: RegistrationReply[],
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-v2-registration-'));
  const stages: string[] = [];
  const grantBodies: string[] = [];
  const registrationBodies: string[] = [];
  try {
    const content = Buffer.from('{"schema":"playwright-measurements/v2"}\n');
    const path = join(directory, 'measurements.json');
    await writeFile(path, content);
    const digest = createHash('sha256').update(content).digest('hex');
    const authority = await acquiredV2Lease();
    const [grantText, artifactText] = await Promise.all([
      readFile(`${fixtureRoot}/upload-grant.json`, 'utf8'),
      readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
    ]);
    const grant = JSON.parse(grantText) as Record<string, unknown>;
    const artifact = JSON.parse(artifactText) as Record<string, unknown>;
    const request: NativeArtifactPublicationRequest = {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision,
      slot: 'measurements',
      path,
      size: content.byteLength,
      sha256: digest,
      mediaType: 'application/json',
      ...(signal === undefined ? {} : { signal }),
    };
    const pendingReplies = [...replies];
    const pendingGrantReplies =
      grantReplies === undefined ? undefined : [...grantReplies];
    try {
      const result = await publishNativeArtifact(request, {
        controlPlane: (input: URL | RequestInfo, init?: RequestInit) => {
          const pathname = (input as URL).pathname;
          expect(pathname).toMatch(/^\/native-worker\/v2\/leases\/[^/]+\//);
          if (pathname.endsWith('/upload-grants')) {
            stages.push('grant');
            grantBodies.push(init?.body as string);
            const reply = pendingGrantReplies?.shift();
            if (pendingGrantReplies !== undefined && reply === undefined) {
              return Promise.reject(new Error('unexpected grant attempt'));
            }
            return (
              reply?.() ?? Promise.resolve(new Response(null, { status: 201 }))
            ).then((response) =>
              response.status === 201
                ? new Response(
                    JSON.stringify({
                      ...grant,
                      sha256: digest,
                      uploadHeaders: {
                        'content-type': 'application/json',
                        'x-amz-checksum-sha256': Buffer.from(
                          digest,
                          'hex',
                        ).toString('base64'),
                      },
                    }),
                    { status: 201 },
                  )
                : response,
            );
          }
          stages.push('register');
          registrationBodies.push(init?.body as string);
          const reply = pendingReplies.shift();
          if (reply === undefined) {
            return Promise.reject(new Error('unexpected registration attempt'));
          }
          return reply().then((response) =>
            response.status === 201
              ? new Response(
                  JSON.stringify({
                    ...artifact,
                    size: content.byteLength,
                    sha256: digest,
                  }),
                  { status: 201 },
                )
              : response,
          );
        },
        objectStore: (_input: URL | RequestInfo, init?: RequestInit) => {
          stages.push('upload');
          expect(init?.method).toBe('PUT');
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      });
      return { result, stages, grantBodies, registrationBodies };
    } catch (error) {
      return { error, stages, grantBodies, registrationBodies };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function acquiredV2Lease(): Promise<AcquiredNativeV2Lease> {
  const [lease, presenceText] = await Promise.all([
    readFile(`${fixtureRoot}/lease.json`, 'utf8'),
    readFile(`${fixtureRoot}/presence.json`, 'utf8'),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  return new AcquiredNativeV2Lease(
    parseNativeExecutionRecipe(lease, presence.qualificationEvidence),
    capability,
  );
}

test('uses v2 grant and registration endpoints with the same lease authority', async () => {
  const authority = await acquiredV2Lease();
  const [grantText, requestText, artifactText] = await Promise.all([
    readFile(`${fixtureRoot}/upload-grant.json`, 'utf8'),
    readFile(`${fixtureRoot}/register-artifact.json`, 'utf8'),
    readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
  ]);
  const paths: string[] = [];
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    const path = (input as URL).pathname;
    paths.push(path);
    expect(path).toMatch(/^\/native-worker\/v2\/leases\/[^/]+\//);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    if (path.endsWith('/upload-grants')) {
      return Promise.resolve(new Response(grantText, { status: 201 }));
    }
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(requestText));
    return Promise.resolve(new Response(artifactText, { status: 201 }));
  }) as typeof fetch;

  const grant = await createNativeUploadGrant(
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
    send,
  );
  expect(grant.protocolVersion).toBe(2);
  expect(JSON.stringify(grant)).not.toContain(capability);
  const artifact = await registerNativeArtifact(
    {
      controlPlaneOrigin,
      token,
      authority,
      grant,
      expectedRunRevision: 5,
      size: 4096,
      sha256,
    },
    send,
  );
  expect(artifact).toEqual(JSON.parse(artifactText));
  expect(paths).toEqual([
    `/native-worker/v2/leases/${authority.recipe.leaseId}/upload-grants`,
    `/native-worker/v2/leases/${authority.recipe.leaseId}/artifacts`,
  ]);
});

test('rejects a v1 grant under v2 authority before registration', async () => {
  const v1Lease = new AcquiredNativeLease(
    parseNativeLease(
      await readFile(
        'vendor/contracts/native-worker/v1/examples/lease.json',
        'utf8',
      ),
    ),
    capability,
  );
  const grantText = await readFile(
    'vendor/contracts/native-worker/v1/examples/upload-grant.json',
    'utf8',
  );
  const grant = await createNativeUploadGrant(
    {
      controlPlaneOrigin,
      token,
      authority: v1Lease,
      expectedRunRevision: 5,
      slot: 'measurements',
      size: 4096,
      sha256,
      mediaType: 'application/json',
    },
    () => Promise.resolve(new Response(grantText, { status: 201 })),
  );
  expect(grant.protocolVersion).toBe(1);
  await expect(
    registerNativeArtifact(
      {
        controlPlaneOrigin,
        token,
        authority: await acquiredV2Lease(),
        grant,
        expectedRunRevision: 5,
        size: 4096,
        sha256,
      },
      () => Promise.reject(new Error('registration must not be sent')),
    ),
  ).rejects.toThrow('does not match its lease and grant');
});

test('publishes a v2 artifact through grant, exact upload and registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-v2-publication-'));
  try {
    const content = Buffer.from('{"schema":"playwright-measurements/v2"}\n');
    const path = join(directory, 'measurements.json');
    await writeFile(path, content);
    const digest = createHash('sha256').update(content).digest('hex');
    const authority = await acquiredV2Lease();
    const [grantText, artifactText] = await Promise.all([
      readFile(`${fixtureRoot}/upload-grant.json`, 'utf8'),
      readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
    ]);
    const grant = JSON.parse(grantText) as Record<string, unknown>;
    const artifact = JSON.parse(artifactText) as Record<string, unknown>;
    const stages: string[] = [];
    const result = await publishNativeArtifact(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 5,
        slot: 'measurements',
        path,
        size: content.byteLength,
        sha256: digest,
        mediaType: 'application/json',
      },
      {
        controlPlane: (input: URL | RequestInfo) => {
          const pathname = (input as URL).pathname;
          expect(pathname).toMatch(/^\/native-worker\/v2\/leases\/[^/]+\//);
          if (pathname.endsWith('/upload-grants')) {
            stages.push('grant');
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  ...grant,
                  sha256: digest,
                  uploadHeaders: {
                    'content-type': 'application/json',
                    'x-amz-checksum-sha256': Buffer.from(
                      digest,
                      'hex',
                    ).toString('base64'),
                  },
                }),
                { status: 201 },
              ),
            );
          }
          stages.push('register');
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...artifact,
                size: content.byteLength,
                sha256: digest,
              }),
              {
                status: 201,
              },
            ),
          );
        },
        objectStore: (_input: URL | RequestInfo, init?: RequestInit) => {
          stages.push('upload');
          expect(init?.method).toBe('PUT');
          expect(init?.body).toBeInstanceOf(Blob);
          return Promise.resolve(new Response(null, { status: 200 }));
        },
      },
    );
    expect(result).toMatchObject({ size: content.byteLength, sha256: digest });
    expect(stages).toEqual(['grant', 'upload', 'register']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('retries only the exact v2 registration after a lost response', async () => {
  let revisionReads = 0;
  const attempt = await publicationWithRegistrationReplies(
    [
      () => Promise.reject(new Error('sensitive transport failure')),
      () => Promise.resolve(new Response(null, { status: 201 })),
    ],
    () => {
      revisionReads += 1;
      return revisionReads === 1 ? 5 : 6;
    },
  );
  expect(attempt.error).toBeUndefined();
  expect(attempt.result).toMatchObject({ slot: 'measurements' });
  expect(attempt.stages).toEqual(['grant', 'upload', 'register', 'register']);
  expect(attempt.registrationBodies).toHaveLength(2);
  expect(attempt.registrationBodies[1]).toBe(attempt.registrationBodies[0]);
  expect(JSON.parse(attempt.registrationBodies[0] ?? '')).toMatchObject({
    expectedRunRevision: 6,
  });
  expect(revisionReads).toBe(2);
});

test('does not immediately retry v2 registration when the server sets Retry-After', async () => {
  const attempt = await publicationWithRegistrationReplies([
    () =>
      Promise.resolve(
        new Response('sensitive server detail', {
          status: 503,
          headers: { 'retry-after': '12' },
        }),
      ),
  ]);
  expect(attempt.error).toMatchObject({
    kind: 'retryable',
    retryAfterSeconds: 12,
  });
  expect(String(attempt.error)).not.toContain('sensitive server detail');
  expect(attempt.stages).toEqual(['grant', 'upload', 'register']);
});

test('does not retry a v2 registration conflict', async () => {
  const attempt = await publicationWithRegistrationReplies([
    () => Promise.resolve(new Response(null, { status: 409 })),
  ]);
  expect(attempt.error).toMatchObject({ kind: 'conflict' });
  expect(attempt.stages).toEqual(['grant', 'upload', 'register']);
});

test('stops after a second uncertain v2 registration response without re-uploading', async () => {
  const attempt = await publicationWithRegistrationReplies([
    () => Promise.resolve(new Response(null, { status: 500 })),
    () => Promise.resolve(new Response(null, { status: 500 })),
  ]);
  expect(attempt.error).toMatchObject({ kind: 'retryable' });
  expect(attempt.stages).toEqual(['grant', 'upload', 'register', 'register']);
  expect(attempt.registrationBodies[1]).toBe(attempt.registrationBodies[0]);
});

test('retries the unchanged v2 grant declaration after a lost response before uploading', async () => {
  let revisionReads = 0;
  const attempt = await publicationWithRegistrationReplies(
    [() => Promise.resolve(new Response(null, { status: 201 }))],
    () => {
      revisionReads += 1;
      return revisionReads === 1 ? 5 : 6;
    },
    [
      () => Promise.reject(new Error('sensitive transport failure')),
      () => Promise.resolve(new Response(null, { status: 201 })),
    ],
  );
  expect(attempt.error).toBeUndefined();
  expect(attempt.result).toMatchObject({ slot: 'measurements' });
  expect(attempt.stages).toEqual(['grant', 'grant', 'upload', 'register']);
  expect(attempt.grantBodies).toHaveLength(2);
  expect(attempt.grantBodies[1]).toBe(attempt.grantBodies[0]);
  expect(JSON.parse(attempt.grantBodies[0] ?? '')).toMatchObject({
    expectedRunRevision: 5,
  });
  expect(JSON.parse(attempt.registrationBodies[0] ?? '')).toMatchObject({
    expectedRunRevision: 6,
  });
  expect(revisionReads).toBe(2);
});

test('does not retry a server-paced v2 grant or transfer bytes', async () => {
  const attempt = await publicationWithRegistrationReplies([], 5, [
    () =>
      Promise.resolve(
        new Response('sensitive server detail', {
          status: 503,
          headers: { 'retry-after': '12' },
        }),
      ),
  ]);
  expect(attempt.error).toMatchObject({
    kind: 'retryable',
    retryAfterSeconds: 12,
  });
  expect(String(attempt.error)).not.toContain('sensitive server detail');
  expect(attempt.stages).toEqual(['grant']);
});

test('does not retry a conflicting v2 grant or transfer bytes', async () => {
  const attempt = await publicationWithRegistrationReplies([], 5, [
    () => Promise.resolve(new Response(null, { status: 409 })),
  ]);
  expect(attempt.error).toMatchObject({ kind: 'conflict' });
  expect(attempt.stages).toEqual(['grant']);
});

test('does not retry a v2 grant after caller cancellation', async () => {
  const controller = new AbortController();
  const attempt = await publicationWithRegistrationReplies(
    [],
    5,
    [
      () => {
        controller.abort();
        return Promise.resolve(new Response(null, { status: 500 }));
      },
    ],
    controller.signal,
  );
  expect(attempt.error).toMatchObject({ kind: 'cancelled' });
  expect(attempt.stages).toEqual(['grant']);
});

test('stops after two uncertain v2 grant responses without uploading', async () => {
  const attempt = await publicationWithRegistrationReplies([], 5, [
    () => Promise.resolve(new Response(null, { status: 500 })),
    () => Promise.resolve(new Response(null, { status: 500 })),
  ]);
  expect(attempt.error).toMatchObject({ kind: 'retryable' });
  expect(attempt.stages).toEqual(['grant', 'grant']);
  expect(attempt.grantBodies[1]).toBe(attempt.grantBodies[0]);
});

test('pins byte-identical v2 artifact-publication fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as {
    files: Record<string, string>;
  };
  for (const name of [
    'upload-request',
    'upload-grant',
    'register-artifact',
    'artifact',
  ]) {
    const relative = `native-worker/v2/examples/${name}.json`;
    const bytes = await readFile(`vendor/contracts/${relative}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[relative],
    );
  }
});
