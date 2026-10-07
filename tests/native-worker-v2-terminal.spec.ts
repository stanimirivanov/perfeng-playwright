import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition.js';
import {
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';
import {
  reportNativeTerminal,
  TerminalReportFailure,
} from '../src/native-worker/terminal.js';
import type { NativeArtifactReference } from '../src/native-worker/types.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const controlPlaneOrigin = 'https://control-plane.perfeng.invalid';
const token = 'worker-secret';
const capability = 'example-not-a-real-lease-capability-0001';

async function acquiredLease(): Promise<AcquiredNativeV2Lease> {
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

function manifestReference(
  authority: AcquiredNativeV2Lease,
): NativeArtifactReference {
  return {
    artifactId: '33333333-3333-4333-8333-333333333333',
    runId: authority.recipe.runId,
    attemptId: authority.recipe.attemptId,
    slot: 'manifest',
    kind: 'manifest',
    uri: `s3://perfeng/runs/${authority.recipe.runId}/attempts/${authority.recipe.attemptId}/manifest`,
    size: 2048,
    sha256: 'e'.repeat(64),
    mediaType: 'application/json',
    registeredAt: '2026-09-18T12:01:30Z',
  };
}

test('reports v2 completion with the manifest and lease capability fences', async () => {
  const authority = await acquiredLease();
  const [requestText, acknowledgementText] = await Promise.all([
    readFile(`${fixtureRoot}/terminal-completed.json`, 'utf8'),
    readFile(`${fixtureRoot}/terminal-ack.json`, 'utf8'),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect((input as URL).href).toBe(
      `${controlPlaneOrigin}/native-worker/v2/leases/${authority.recipe.leaseId}/terminal`,
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${token}`,
    );
    expect(new Headers(init?.headers).get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(requestText));
    return Promise.resolve(new Response(acknowledgementText, { status: 200 }));
  }) as typeof fetch;

  await expect(
    reportNativeTerminal(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 6,
        kind: 'COMPLETED',
        manifest: manifestReference(authority),
      },
      send,
    ),
  ).resolves.toEqual(JSON.parse(acknowledgementText));
});

test('reports a classified v2 failure and accepts an identical retry', async () => {
  const authority = await acquiredLease();
  const [requestText, acknowledgementText] = await Promise.all([
    readFile(`${fixtureRoot}/terminal-failed.json`, 'utf8'),
    readFile(`${fixtureRoot}/terminal-ack-duplicate.json`, 'utf8'),
  ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect((input as URL).pathname).toBe(
      `/native-worker/v2/leases/${authority.recipe.leaseId}/terminal`,
    );
    expect(JSON.parse(init?.body as string)).toEqual(JSON.parse(requestText));
    return Promise.resolve(new Response(acknowledgementText, { status: 200 }));
  }) as typeof fetch;

  await expect(
    reportNativeTerminal(
      {
        controlPlaneOrigin,
        token,
        authority,
        expectedRunRevision: 5,
        kind: 'FAILED',
        failure: {
          code: 'TOOL_FAILED',
          message: 'The reviewed runner exited unsuccessfully.',
          retryable: false,
        },
      },
      send,
    ),
  ).resolves.toEqual(JSON.parse(acknowledgementText));
});

test('rejects foreign v2 manifest claims before sending', async () => {
  const authority = await acquiredLease();
  const manifest = manifestReference(authority);
  const send = () => Promise.reject(new Error('request must not be sent'));
  for (const candidate of [
    { ...manifest, runId: 'perf-20260918-120000-deadbeef' },
    { ...manifest, attemptId: '99999999-9999-4999-8999-999999999999' },
    { ...manifest, slot: 'measurements' },
  ]) {
    await expect(
      reportNativeTerminal(
        {
          controlPlaneOrigin,
          token,
          authority,
          expectedRunRevision: 6,
          kind: 'COMPLETED',
          manifest: candidate,
        },
        send,
      ),
    ).rejects.toThrow('does not identify its manifest');
  }
});

test('rejects a v2 acknowledgement outside the attempt and revision fence', async () => {
  const authority = await acquiredLease();
  const request = {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 6,
    kind: 'COMPLETED' as const,
    manifest: manifestReference(authority),
  };
  const valid = JSON.parse(
    await readFile(`${fixtureRoot}/terminal-ack.json`, 'utf8'),
  ) as Record<string, unknown>;
  for (const candidate of [
    { ...valid, attemptId: '99999999-9999-4999-8999-999999999999' },
    { ...valid, runRevision: 5 },
    { ...valid, disposition: 'UNKNOWN' },
    { ...valid, extra: true },
  ]) {
    await expect(
      reportNativeTerminal(request, () =>
        Promise.resolve(
          new Response(JSON.stringify(candidate), { status: 200 }),
        ),
      ),
    ).rejects.toThrow();
  }
});

test('classifies v2 lost authority and retries without response-body disclosure', async () => {
  const authority = await acquiredLease();
  const request = {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 6,
    kind: 'COMPLETED' as const,
    manifest: manifestReference(authority),
  };
  for (const failureCase of [
    { status: 409, kind: 'conflict' },
    { status: 410, kind: 'lost' },
    { status: 503, kind: 'retryable' },
  ] as const) {
    const failure = await reportNativeTerminal(request, () =>
      Promise.resolve(
        new Response(`sensitive ${capability}`, {
          status: failureCase.status,
          headers: { 'retry-after': '12' },
        }),
      ),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(TerminalReportFailure);
    expect(failure).toMatchObject({ kind: failureCase.kind });
    expect(String(failure)).not.toContain(capability);
  }
});

test('pins byte-identical v2 terminal fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const name of [
    'terminal-completed',
    'terminal-failed',
    'terminal-ack',
    'terminal-ack-duplicate',
  ]) {
    const path = `native-worker/v2/examples/${name}.json`;
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
