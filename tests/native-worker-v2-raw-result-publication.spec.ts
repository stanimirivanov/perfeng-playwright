import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import type { NativeArtifactPublicationTransport } from '../src/native-worker/artifact-publication.js';
import { publishNativeRawResultManifest } from '../src/native-worker/raw-result-publication.js';
import { serializeNativeRawResultManifest } from '../src/native-worker/raw-result.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';

test('publishes the exact v2 manifest last through the v2 lease endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-v2-manifest-'));
  try {
    const path = join(directory, 'results', 'raw-result.json');
    const request = {
      ...(await nativeV2RawResultRequest()),
      controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
      token: 'worker-secret',
      expectedRunRevision: 6,
      path,
    };
    const bytes = serializeNativeRawResultManifest(request);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const [grantText, artifactText] = await Promise.all([
      readFile(`${fixtureRoot}/upload-grant.json`, 'utf8'),
      readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
    ]);
    const grant = JSON.parse(grantText) as Record<string, unknown>;
    const artifact = JSON.parse(artifactText) as Record<string, unknown>;
    const objectKey = `runs/${request.authority.recipe.runId}/attempts/${request.authority.recipe.attemptId}/manifest`;
    const responses = [
      {
        ...grant,
        slot: 'manifest',
        objectKey,
        uploadUrl: String(grant.uploadUrl).replace(
          /\/measurements\?/,
          '/manifest?',
        ),
        sha256,
        uploadHeaders: {
          'content-type': 'application/json',
          'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString(
            'base64',
          ),
        },
      },
      {
        ...artifact,
        artifactId: '55555555-5555-4555-8555-555555555555',
        slot: 'manifest',
        kind: 'manifest',
        uri: `s3://perfeng/${objectKey}`,
        size: bytes.length,
        sha256,
        registeredAt: '2026-09-18T12:01:30Z',
      },
    ];
    const paths = [
      `/native-worker/v2/leases/${request.authority.recipe.leaseId}/upload-grants`,
      `/native-worker/v2/leases/${request.authority.recipe.leaseId}/artifacts`,
    ];
    const stages: string[] = [];
    let controlPlaneCalls = 0;
    const transport: NativeArtifactPublicationTransport = {
      controlPlane: async (input: URL | RequestInfo, init?: RequestInit) => {
        const index = controlPlaneCalls++;
        expect((input as URL).pathname).toBe(paths[index]);
        expect(await readFile(path)).toEqual(bytes);
        expect(JSON.parse(init?.body as string)).toMatchObject({
          slot: 'manifest',
          size: bytes.length,
          sha256,
        });
        stages.push(['grant', 'register'][index] ?? 'unexpected');
        return new Response(JSON.stringify(responses[index]), { status: 201 });
      },
      objectStore: async (_input: URL | RequestInfo, init?: RequestInit) => {
        stages.push('upload');
        expect(init?.body).toBeInstanceOf(Blob);
        expect(Buffer.from(await (init?.body as Blob).arrayBuffer())).toEqual(
          bytes,
        );
        return new Response(null, { status: 200 });
      },
    };

    const published = await publishNativeRawResultManifest(request, transport);
    expect(stages).toEqual(['grant', 'upload', 'register']);
    expect(await readFile(path)).toEqual(bytes);
    expect(published).toMatchObject({
      reference: { slot: 'manifest', size: bytes.length, sha256 },
      localArtifact: { path, size: bytes.length, sha256 },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a mismatched v2 manifest destination before network access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-v2-manifest-'));
  try {
    const path = join(directory, 'results', 'raw-result.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'existing manifest', { flag: 'wx' });
    const transport: NativeArtifactPublicationTransport = {
      controlPlane: () => Promise.reject(new Error('request must not be sent')),
      objectStore: () => Promise.reject(new Error('request must not be sent')),
    };
    await expect(
      publishNativeRawResultManifest(
        {
          ...(await nativeV2RawResultRequest()),
          controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
          token: 'worker-secret',
          expectedRunRevision: 6,
          path,
        },
        transport,
      ),
    ).rejects.toThrow('Existing native raw-result manifest does not match');
    expect(await readFile(path, 'utf8')).toBe('existing manifest');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
