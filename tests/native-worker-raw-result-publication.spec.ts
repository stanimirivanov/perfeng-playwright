import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import type { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import type { NativeArtifactPublicationTransport } from '../src/native-worker/artifact-publication.js';
import {
  publishNativeRawResultManifest,
  type NativeRawResultPublicationRequest,
} from '../src/native-worker/raw-result-publication.js';
import { serializeNativeRawResultManifest } from '../src/native-worker/raw-result.js';
import { nativeRawResultRequest } from './native-worker-raw-result-fixture.js';

type V1PublicationRequest = NativeRawResultPublicationRequest & {
  authority: AcquiredNativeLease;
};

async function withManifestPath<T>(
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-native-manifest-'));
  try {
    return await operation(join(directory, 'results', 'raw-result.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function publicationRequest(path: string): Promise<V1PublicationRequest> {
  return {
    ...(await nativeRawResultRequest()),
    controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
    token: 'worker-secret',
    expectedRunRevision: 5,
    path,
  };
}

async function successfulTransport(
  request: V1PublicationRequest,
  bytes: Buffer,
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
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const objectKey = `runs/${request.authority.lease.runId}/attempts/${request.authority.lease.attemptId}/manifest`;
  const uploadUrl = String(grantFixture.uploadUrl).replace(
    /\/measurements\?/,
    '/manifest?',
  );
  const grant = {
    ...grantFixture,
    slot: 'manifest',
    objectKey,
    uploadUrl,
    sha256,
    uploadHeaders: {
      'content-type': 'application/json',
      'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    },
  };
  const artifact = {
    ...artifactFixture,
    artifactId: '55555555-5555-4555-8555-555555555555',
    slot: 'manifest',
    kind: 'manifest',
    uri: `s3://perfeng/${objectKey}`,
    size: bytes.length,
    sha256,
    registeredAt: '2026-09-18T12:01:30Z',
  };

  return {
    controlPlane: async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input).toBeInstanceOf(URL);
      const url = input as URL;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(await readFile(request.path)).toEqual(bytes);
      if (url.pathname.endsWith('/upload-grants')) {
        stages.push('grant');
        expect(body).toMatchObject({
          slot: 'manifest',
          size: bytes.length,
          sha256,
        });
        return new Response(JSON.stringify(grant), { status: 201 });
      }

      stages.push('register');
      expect(body).toMatchObject({
        grantId: '44444444-4444-4444-8444-444444444444',
        slot: 'manifest',
        size: bytes.length,
        sha256,
      });
      return new Response(JSON.stringify(artifact), { status: 201 });
    },
    objectStore: async (_input: URL | RequestInfo, init?: RequestInit) => {
      stages.push('upload');
      expect(init?.body).toBeInstanceOf(Blob);
      const uploaded = Buffer.from(await (init?.body as Blob).arrayBuffer());
      expect(uploaded).toEqual(bytes);
      return new Response(null, { status: 200 });
    },
  };
}

test('persists then publishes and registers the manifest last', async () => {
  await withManifestPath(async (path) => {
    const request = await publicationRequest(path);
    const bytes = serializeNativeRawResultManifest(request);
    const stages: string[] = [];
    const transport = await successfulTransport(request, bytes, stages);

    const published = await publishNativeRawResultManifest(request, transport);

    expect(stages).toEqual(['grant', 'upload', 'register']);
    expect(await readFile(path)).toEqual(bytes);
    expect(published).toEqual({
      reference: {
        artifactId: '55555555-5555-4555-8555-555555555555',
        runId: request.authority.lease.runId,
        attemptId: request.authority.lease.attemptId,
        slot: 'manifest',
        kind: 'manifest',
        uri: `s3://perfeng/runs/${request.authority.lease.runId}/attempts/${request.authority.lease.attemptId}/manifest`,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'application/json',
        registeredAt: '2026-09-18T12:01:30Z',
      },
      localArtifact: {
        path,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
  });
});

test('never replaces an existing manifest or starts publication', async () => {
  await withManifestPath(async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'existing manifest', {
      encoding: 'utf8',
      flag: 'wx',
    });
    const request = await publicationRequest(path);
    const transport: NativeArtifactPublicationTransport = {
      controlPlane: () => Promise.reject(new Error('request must not be sent')),
      objectStore: () => Promise.reject(new Error('request must not be sent')),
    };

    await expect(
      publishNativeRawResultManifest(request, transport),
    ).rejects.toThrow('Existing native raw-result manifest does not match');
    expect(await readFile(path, 'utf8')).toBe('existing manifest');
  });
});

test('retains exact local bytes when remote publication fails', async () => {
  await withManifestPath(async (path) => {
    const request = await publicationRequest(path);
    const bytes = serializeNativeRawResultManifest(request);
    const stages: string[] = [];
    const transport = await successfulTransport(request, bytes, stages);
    transport.objectStore = () => {
      stages.push('upload');
      return Promise.resolve(new Response(null, { status: 503 }));
    };

    await expect(
      publishNativeRawResultManifest(request, transport),
    ).rejects.toMatchObject({ kind: 'retryable' });
    expect(stages).toEqual(['grant', 'upload']);
    expect(await readFile(path)).toEqual(bytes);

    const retryStages: string[] = [];
    const retryTransport = await successfulTransport(
      request,
      bytes,
      retryStages,
    );
    await expect(
      publishNativeRawResultManifest(request, retryTransport),
    ).resolves.toMatchObject({ reference: { slot: 'manifest' } });
    expect(retryStages).toEqual(['grant', 'upload', 'register']);
    expect(await readFile(path)).toEqual(bytes);
  });
});
