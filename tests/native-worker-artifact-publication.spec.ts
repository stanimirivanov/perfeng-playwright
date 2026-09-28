import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { ArtifactRegistrationFailure } from '../src/native-worker/artifact-registration.js';
import {
  publishNativeArtifact,
  type NativeArtifactPublicationRequest,
  type NativeArtifactPublicationTransport,
} from '../src/native-worker/artifact-publication.js';
import { NativeArtifactUploadFailure } from '../src/native-worker/artifact-upload.js';
import { parseNativeLease } from '../src/native-worker/lease.js';

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

async function withArtifact<T>(
  content: Uint8Array,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(
    join(tmpdir(), 'perfeng-native-publication-'),
  );
  const path = join(directory, 'measurements.json');
  try {
    await writeFile(path, content);
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function publicationRequest(
  path: string,
  content: Uint8Array,
): Promise<NativeArtifactPublicationRequest> {
  return {
    controlPlaneOrigin,
    token,
    authority: await acquiredLease(),
    expectedRunRevision: 5,
    slot: 'measurements',
    path,
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    mediaType: 'application/json',
  };
}

async function successfulTransport(
  request: NativeArtifactPublicationRequest,
  stages: string[],
): Promise<NativeArtifactPublicationTransport> {
  const [grantFixture, artifactFixture] = await Promise.all([
    readFile(
      'vendor/contracts/native-worker/v1/examples/upload-grant.json',
      'utf8',
    ).then((value) => JSON.parse(value) as Record<string, unknown>),
    readFile(
      'vendor/contracts/native-worker/v1/examples/artifact.json',
      'utf8',
    ).then((value) => JSON.parse(value) as Record<string, unknown>),
  ]);
  const uploadHeaders = grantFixture.uploadHeaders as Record<string, unknown>;
  const grant = {
    ...grantFixture,
    sha256: request.sha256,
    uploadHeaders: {
      ...uploadHeaders,
      'x-amz-checksum-sha256': Buffer.from(request.sha256, 'hex').toString(
        'base64',
      ),
    },
  };
  const artifact = {
    ...artifactFixture,
    size: request.size,
    sha256: request.sha256,
  };

  return {
    controlPlane: (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      const url = input as URL;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (url.pathname.endsWith('/upload-grants')) {
        stages.push('grant');
        expect(body).toMatchObject({
          slot: request.slot,
          size: request.size,
          sha256: request.sha256,
        });
        return Promise.resolve(
          new Response(JSON.stringify(grant), { status: 201 }),
        );
      }

      stages.push('register');
      expect(url.pathname).toMatch(/\/artifacts$/);
      expect(body).toMatchObject({
        grantId: '44444444-4444-4444-8444-444444444444',
        slot: request.slot,
        size: request.size,
        sha256: request.sha256,
      });
      return Promise.resolve(
        new Response(JSON.stringify(artifact), { status: 201 }),
      );
    },
    objectStore: (input: URL | RequestInfo, init?: RequestInit) => {
      stages.push('upload');
      expect(typeof input).toBe('string');
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBeInstanceOf(Blob);
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

test('publishes one artifact through grant, transfer, and registration in order', async () => {
  const content = Buffer.from('{"schema":"playwright-measurements/v2"}\n');
  await withArtifact(content, async (path) => {
    const stages: string[] = [];
    const request = await publicationRequest(path, content);
    const transport = await successfulTransport(request, stages);

    await expect(publishNativeArtifact(request, transport)).resolves.toEqual({
      artifactId: '33333333-3333-4333-8333-333333333333',
      runId: 'perf-20260918-120000-a1b2c3d4',
      attemptId: '22222222-2222-4222-8222-222222222222',
      slot: 'measurements',
      kind: 'measurements',
      uri: 's3://perfeng/runs/perf-20260918-120000-a1b2c3d4/attempts/22222222-2222-4222-8222-222222222222/measurements',
      size: content.byteLength,
      sha256: request.sha256,
      mediaType: 'application/json',
      registeredAt: '2026-09-18T12:01:15Z',
    });
    expect(stages).toEqual(['grant', 'upload', 'register']);
  });
});

test('rejects an unassigned artifact before any network request', async () => {
  const content = Buffer.from('{"value":"unassigned"}\n');
  await withArtifact(content, async (path) => {
    const request = {
      ...(await publicationRequest(path, content)),
      slot: 'unknown',
    };
    const transport: NativeArtifactPublicationTransport = {
      controlPlane: () => Promise.reject(new Error('request must not be sent')),
      objectStore: () => Promise.reject(new Error('request must not be sent')),
    };

    await expect(publishNativeArtifact(request, transport)).rejects.toThrow(
      'does not match the artifact plan',
    );
  });
});

test('stops after grant when local bytes do not match the declaration', async () => {
  const declared = Buffer.from('{"value":"expected"}\n');
  const actual = Buffer.from('{"value":"modified"}\n');
  await withArtifact(actual, async (path) => {
    const stages: string[] = [];
    const request = await publicationRequest(path, declared);
    const transport = await successfulTransport(request, stages);

    await expect(
      publishNativeArtifact(request, transport),
    ).rejects.toMatchObject({ kind: 'local-artifact' });
    expect(stages).toEqual(['grant']);
  });
});

test('does not register an artifact rejected by object storage', async () => {
  const content = Buffer.from('{"value":"upload-rejected"}\n');
  await withArtifact(content, async (path) => {
    const stages: string[] = [];
    const request = await publicationRequest(path, content);
    const transport = await successfulTransport(request, stages);
    transport.objectStore = () => {
      stages.push('upload');
      return Promise.resolve(
        new Response('sensitive provider response', { status: 503 }),
      );
    };

    const failure = await publishNativeArtifact(request, transport).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(NativeArtifactUploadFailure);
    expect(failure).toMatchObject({ kind: 'retryable' });
    expect(String(failure)).not.toContain('sensitive provider response');
    expect(stages).toEqual(['grant', 'upload']);
  });
});

test('preserves a registration failure after successful transfer', async () => {
  const content = Buffer.from('{"value":"registration-retry"}\n');
  await withArtifact(content, async (path) => {
    const stages: string[] = [];
    const request = await publicationRequest(path, content);
    const transport = await successfulTransport(request, stages);
    const successfulControlPlane = transport.controlPlane;
    transport.controlPlane = (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input as URL;
      if (url.pathname.endsWith('/artifacts')) {
        stages.push('register');
        return Promise.resolve(
          new Response('sensitive control-plane response', {
            status: 503,
            headers: { 'retry-after': '12' },
          }),
        );
      }
      return successfulControlPlane(input, init);
    };

    const failure = await publishNativeArtifact(request, transport).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(ArtifactRegistrationFailure);
    expect(failure).toMatchObject({
      kind: 'retryable',
      retryAfterSeconds: 12,
    });
    expect(String(failure)).not.toContain('sensitive control-plane response');
    expect(stages).toEqual(['grant', 'upload', 'register']);
  });
});
