import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { expect, test, type TestInfo } from '@playwright/test';

import { writeJourneyArtifacts } from '../src/journey/artifact.js';
import type { PlaywrightMeasurements } from '../src/journey/types.js';
import type { NativeArtifactPublicationTransport } from '../src/native-worker/artifact-publication.js';
import { currentNativeRevision } from '../src/native-worker/artifact-publication.js';
import { prepareNativeAttempt } from '../src/native-worker/attempt-preparation.js';
import {
  publishNativeV2Evidence,
  type NativeV2EvidencePublicationRequest,
} from '../src/native-worker/evidence-publication.js';
import type { SourceCheckoutArtifact } from '../src/source-checkout.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const createdAt = '2026-09-18T12:01:30Z';

async function fixture(testInfo: TestInfo) {
  const source = await nativeV2RawResultRequest();
  const first = source.measurements.measurements[0];
  assert.ok(first);
  const measurements: PlaywrightMeasurements = {
    ...source.measurements,
    measurements: Array.from({ length: 5 }, (_, index) => ({
      ...first,
      iteration: index + 1,
    })),
  };
  const runner = source.authority.recipe.executionArtifact;
  const checkout: SourceCheckoutArtifact = {
    kind: 'source-checkout',
    repository: runner.repository,
    gitSha: runner.revision,
    dependencyLock: { path: 'pnpm-lock.yaml', sha256: runner.lockfileSha256 },
  };
  const spoolRoot = testInfo.outputPath('spool');
  await mkdir(spoolRoot);
  const prepared = await prepareNativeAttempt(
    { authority: source.authority, spoolRoot },
    () => Promise.resolve(checkout),
  );
  await writeJourneyArtifacts(
    { measurements: prepared.measurementsPath, receipt: prepared.receiptPath },
    { measurements },
    checkout,
  );
  const request: NativeV2EvidencePublicationRequest = {
    controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
    token: 'worker-secret',
    authority: source.authority,
    expectedRunRevision: 5,
    prepared,
    createdAt,
    signal: new AbortController().signal,
  };
  return { request, measurements };
}

async function transportFor(
  request: NativeV2EvidencePublicationRequest,
  events: string[],
  fail: (stage: string) => boolean = () => false,
  seenRevisions?: number[],
): Promise<NativeArtifactPublicationTransport> {
  const [grantText, artifactText] = await Promise.all([
    readFile(`${fixtureRoot}/upload-grant.json`, 'utf8'),
    readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
  ]);
  const grantFixture = JSON.parse(grantText) as Record<string, unknown>;
  const artifactFixture = JSON.parse(artifactText) as Record<string, unknown>;
  const { runId, attemptId, leaseId } = request.authority.recipe;
  return {
    controlPlane: (input: URL | RequestInfo, init?: RequestInit) => {
      const path = (input as URL).pathname;
      expect(path).toMatch(
        new RegExp(
          `^/native-worker/v2/leases/${leaseId}/(upload-grants|artifacts)$`,
        ),
      );
      const body = JSON.parse(init?.body as string) as {
        expectedRunRevision: number;
        slot: 'measurements' | 'manifest';
        size: number;
        sha256: string;
      };
      seenRevisions?.push(body.expectedRunRevision);
      expect(body.expectedRunRevision).toBe(
        currentNativeRevision(request.expectedRunRevision),
      );
      const slot = body.slot;
      const action = path.endsWith('/upload-grants') ? 'grant' : 'register';
      const stage = `${action}:${slot}`;
      events.push(stage);
      if (fail(stage)) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      const objectKey = `runs/${runId}/attempts/${attemptId}/${slot}`;
      if (action === 'grant') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...grantFixture,
              grantId:
                slot === 'measurements'
                  ? grantFixture.grantId
                  : '55555555-5555-4555-8555-555555555555',
              slot,
              objectKey,
              uploadUrl: String(grantFixture.uploadUrl).replace(
                '/measurements?',
                `/${slot}?`,
              ),
              maximumBytes: request.authority.recipe.artifactPlan.find(
                (item) => item.slot === slot,
              )?.maximumBytes,
              sha256: body.sha256,
              uploadHeaders: {
                'content-type': 'application/json',
                'x-amz-checksum-sha256': Buffer.from(
                  body.sha256,
                  'hex',
                ).toString('base64'),
              },
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...artifactFixture,
            artifactId:
              slot === 'measurements'
                ? artifactFixture.artifactId
                : '66666666-6666-4666-8666-666666666666',
            slot,
            kind: slot,
            uri: `s3://perfeng/${objectKey}`,
            size: body.size,
            sha256: body.sha256,
            registeredAt:
              slot === 'measurements'
                ? '2026-09-18T12:01:15Z'
                : '2026-09-18T12:01:35Z',
          }),
          { status: 201 },
        ),
      );
    },
    objectStore: async (input: URL | RequestInfo, init?: RequestInit) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(input);
      const slot = url.pathname.endsWith('/manifest')
        ? 'manifest'
        : 'measurements';
      const stage = `upload:${slot}`;
      events.push(stage);
      const path =
        slot === 'manifest'
          ? request.prepared.manifestPath
          : request.prepared.measurementsPath;
      expect(init?.body).toBeInstanceOf(Blob);
      expect(Buffer.from(await (init?.body as Blob).arrayBuffer())).toEqual(
        await readFile(path),
      );
      return fail(stage)
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 200 });
    },
  };
}

function abortAfterMeasurementRegistration(
  controller: AbortController,
): (stage: string) => boolean {
  return (stage) => {
    if (stage === 'register:measurements') {
      controller.abort();
    }
    return false;
  };
}

test('registers measurements before publishing the manifest that names them', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const events: string[] = [];
  const requestWithoutTimestamp: NativeV2EvidencePublicationRequest = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    authority: request.authority,
    expectedRunRevision: request.expectedRunRevision,
    prepared: request.prepared,
    signal: request.signal,
  };

  const result = await publishNativeV2Evidence(
    requestWithoutTimestamp,
    await transportFor(request, events),
    () => {
      events.push('manifest-clock');
      return createdAt;
    },
  );

  expect(events).toEqual([
    'grant:measurements',
    'upload:measurements',
    'register:measurements',
    'manifest-clock',
    'grant:manifest',
    'upload:manifest',
    'register:manifest',
  ]);
  expect(result.measurements.slot).toBe('measurements');
  expect(result.manifest.reference.slot).toBe('manifest');
  const manifest = JSON.parse(
    await readFile(request.prepared.manifestPath, 'utf8'),
  ) as {
    createdAt: string;
    artifacts: { id: string; sha256: string }[];
  };
  expect(manifest.createdAt).toBe(createdAt);
  expect(manifest.artifacts).toMatchObject([
    { id: result.measurements.artifactId, sha256: result.measurements.sha256 },
  ]);
});

test('reads the current lease revision for each grant and registration after upload', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const events: string[] = [];
  const seenRevisions: number[] = [];
  let currentRevision = 5;
  const liveRequest: NativeV2EvidencePublicationRequest = {
    ...request,
    expectedRunRevision: () => currentRevision,
  };
  const base = await transportFor(
    liveRequest,
    events,
    () => false,
    seenRevisions,
  );

  await publishNativeV2Evidence(liveRequest, {
    controlPlane: base.controlPlane,
    objectStore: async (input, init) => {
      const response = await base.objectStore(input, init);
      currentRevision++;
      return response;
    },
  });

  expect(seenRevisions).toEqual([5, 6, 6, 7]);
  expect(events).toEqual([
    'grant:measurements',
    'upload:measurements',
    'register:measurements',
    'grant:manifest',
    'upload:manifest',
    'register:manifest',
  ]);
});

test('does not contact storage for invalid local measurements or cancellation', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const events: string[] = [];
  const transport = await transportFor(request, events);
  await writeFile(request.prepared.measurementsPath, '{}');

  await expect(publishNativeV2Evidence(request, transport)).rejects.toThrow(
    'differ from the runner receipt',
  );
  expect(events).toEqual([]);

  const controller = new AbortController();
  controller.abort();
  await expect(
    publishNativeV2Evidence(
      { ...request, signal: controller.signal },
      transport,
    ),
  ).rejects.toThrow('cancelled');
  expect(events).toEqual([]);
});

test('stops before manifest publication if measurement transfer fails', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const events: string[] = [];

  await expect(
    publishNativeV2Evidence(
      request,
      await transportFor(
        request,
        events,
        (stage) => stage === 'upload:measurements',
      ),
    ),
  ).rejects.toThrow();
  expect(events).toEqual(['grant:measurements', 'upload:measurements']);
  await expect(readFile(request.prepared.manifestPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('does not create a manifest after cancellation at the measurement boundary', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const controller = new AbortController();
  const events: string[] = [];

  await expect(
    publishNativeV2Evidence(
      { ...request, signal: controller.signal },
      await transportFor(
        request,
        events,
        abortAfterMeasurementRegistration(controller),
      ),
    ),
  ).rejects.toThrow('cancelled');
  expect(events).toEqual([
    'grant:measurements',
    'upload:measurements',
    'register:measurements',
  ]);
  await expect(readFile(request.prepared.manifestPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('retains exact manifest bytes for an explicit retry after registration failure', async ({}, testInfo) => {
  const { request } = await fixture(testInfo);
  const events: string[] = [];
  let failManifestRegistration = true;
  const transport = await transportFor(
    request,
    events,
    (stage) => stage === 'register:manifest' && failManifestRegistration,
  );

  await expect(publishNativeV2Evidence(request, transport)).rejects.toThrow();
  const bytes = await readFile(request.prepared.manifestPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  failManifestRegistration = false;

  const result = await publishNativeV2Evidence(request, transport);
  expect(result.manifest.localArtifact.sha256).toBe(digest);
  expect(await readFile(request.prepared.manifestPath)).toEqual(bytes);
  expect(events.filter((stage) => stage === 'register:manifest')).toHaveLength(
    2,
  );
});
