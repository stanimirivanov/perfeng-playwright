import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  reportNativeTerminal,
  TerminalReportFailure,
  type TerminalReportRequest,
} from '../src/native-worker/terminal.js';
import type {
  NativeArtifactReference,
  NativeTerminalFailure,
} from '../src/native-worker/types.js';

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

function manifestReference(
  authority: AcquiredNativeLease,
): NativeArtifactReference {
  return {
    artifactId: '33333333-3333-4333-8333-333333333333',
    runId: authority.lease.runId,
    attemptId: authority.lease.attemptId,
    slot: 'manifest',
    kind: 'manifest',
    uri: `s3://perfeng/runs/${authority.lease.runId}/attempts/${authority.lease.attemptId}/manifest`,
    size: 2048,
    sha256: 'e'.repeat(64),
    mediaType: 'application/json',
    registeredAt: '2026-09-18T12:01:30Z',
  };
}

function completedRequest(
  authority: AcquiredNativeLease,
): Extract<TerminalReportRequest, { kind: 'COMPLETED' }> {
  return {
    controlPlaneOrigin,
    token,
    authority,
    expectedRunRevision: 6,
    kind: 'COMPLETED',
    manifest: manifestReference(authority),
  };
}

test('reports completed execution with the registered manifest fence', async () => {
  const [authority, requestDocument, acknowledgementDocument] =
    await Promise.all([
      acquiredLease(),
      readFile(
        'vendor/contracts/native-worker/v1/examples/terminal-completed.json',
        'utf8',
      ),
      readFile(
        'vendor/contracts/native-worker/v1/examples/terminal-ack.json',
        'utf8',
      ),
    ]);
  const send = ((input: URL | RequestInfo, init?: RequestInit) => {
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(
      'https://control-plane.perfeng.invalid/native-worker/v1/leases/11111111-1111-4111-8111-111111111111/terminal',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('x-perfeng-lease')).toBe(capability);
    expect(init?.body).not.toContain(capability);
    expect(JSON.parse(init?.body as string)).toEqual(
      JSON.parse(requestDocument),
    );
    return Promise.resolve(
      new Response(acknowledgementDocument, { status: 200 }),
    );
  }) as typeof fetch;

  await expect(
    reportNativeTerminal(completedRequest(authority), send),
  ).resolves.toEqual({
    attemptId: '22222222-2222-4222-8222-222222222222',
    runRevision: 7,
    disposition: 'ACCEPTED',
  });
});

test('reports a classified failure and accepts an identical-retry acknowledgement', async () => {
  const [authority, requestDocument, acknowledgementDocument] =
    await Promise.all([
      acquiredLease(),
      readFile(
        'vendor/contracts/native-worker/v1/examples/terminal-failed.json',
        'utf8',
      ),
      readFile(
        'vendor/contracts/native-worker/v1/examples/terminal-ack-duplicate.json',
        'utf8',
      ),
    ]);
  const request: TerminalReportRequest = {
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
  };
  const send = ((_input: URL | RequestInfo, init?: RequestInit) => {
    expect(JSON.parse(init?.body as string)).toEqual(
      JSON.parse(requestDocument),
    );
    return Promise.resolve(
      new Response(acknowledgementDocument, { status: 200 }),
    );
  }) as typeof fetch;

  await expect(reportNativeTerminal(request, send)).resolves.toMatchObject({
    runRevision: 7,
    disposition: 'ALREADY_ACCEPTED',
  });
});

test('rejects invalid completion and failure claims before sending', async () => {
  const authority = await acquiredLease();
  const send = () => Promise.reject(new Error('request must not be sent'));
  const completed = completedRequest(authority);
  await expect(
    reportNativeTerminal(
      {
        ...completed,
        manifest: { ...completed.manifest, slot: 'measurements' },
      },
      send,
    ),
  ).rejects.toThrow('does not identify its manifest');

  const invalidFailures: NativeTerminalFailure[] = [
    {
      code: 'UNKNOWN' as NativeTerminalFailure['code'],
      message: 'invalid code',
      retryable: false,
    },
    { code: 'TOOL_FAILED', message: '', retryable: false },
    { code: 'TOOL_FAILED', message: 'x'.repeat(1025), retryable: false },
    { code: 'TOOL_FAILED', message: '\ud800', retryable: false },
  ];
  for (const failure of invalidFailures) {
    await expect(
      reportNativeTerminal(
        {
          controlPlaneOrigin,
          token,
          authority,
          expectedRunRevision: 5,
          kind: 'FAILED',
          failure,
        },
        send,
      ),
    ).rejects.toThrow();
  }
});

test('rejects terminal acknowledgements outside the attempt fence', async () => {
  const authority = await acquiredLease();
  const request = completedRequest(authority);
  const valid = JSON.parse(
    await readFile(
      'vendor/contracts/native-worker/v1/examples/terminal-ack.json',
      'utf8',
    ),
  ) as Record<string, unknown>;
  const cases: Record<string, unknown>[] = [
    { ...valid, attemptId: '99999999-9999-4999-8999-999999999999' },
    { ...valid, runRevision: 5 },
    { ...valid, disposition: 'UNKNOWN' },
    { ...valid, extra: true },
  ];

  for (const candidate of cases) {
    await expect(
      reportNativeTerminal(request, () =>
        Promise.resolve(
          new Response(JSON.stringify(candidate), { status: 200 }),
        ),
      ),
    ).rejects.toThrow();
  }
});

test('classifies terminal conflicts, lost authority, retries, and cancellation', async () => {
  const authority = await acquiredLease();
  const request = completedRequest(authority);
  const cases = [
    { responseStatus: 409, expected: { kind: 'conflict' } },
    { responseStatus: 410, expected: { kind: 'lost' } },
    {
      responseStatus: 503,
      expected: { kind: 'retryable', retryAfterSeconds: 12 },
    },
  ] as const;
  for (const failureCase of cases) {
    const failure = await reportNativeTerminal(request, () =>
      Promise.resolve(
        new Response(`sensitive ${capability}`, {
          status: failureCase.responseStatus,
          headers: { 'retry-after': '12' },
        }),
      ),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(failure).toBeInstanceOf(TerminalReportFailure);
    expect(failure).toMatchObject(failureCase.expected);
    expect(String(failure)).not.toContain(capability);
  }

  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    reportNativeTerminal({ ...request, signal: cancelled.signal }, () =>
      Promise.reject(new Error(capability)),
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});

test('pins byte-identical Native Worker terminal-reporting fixtures', async () => {
  const lock = JSON.parse(
    await readFile('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  for (const path of [
    'native-worker/v1/examples/terminal-completed.json',
    'native-worker/v1/examples/terminal-failed.json',
    'native-worker/v1/examples/terminal-ack.json',
    'native-worker/v1/examples/terminal-ack-duplicate.json',
  ]) {
    const bytes = await readFile(`vendor/contracts/${path}`);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      lock.files[path],
    );
  }
});
