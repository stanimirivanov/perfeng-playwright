import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import {
  NativeArtifactUploadFailure,
  uploadNativeArtifact,
} from '../src/native-worker/artifact-upload.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import {
  AcquiredNativeUploadGrant,
  createNativeUploadGrant,
} from '../src/native-worker/upload-grant.js';

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

async function acquiredGrant(
  content: Uint8Array,
): Promise<AcquiredNativeUploadGrant> {
  const [authority, document] = await Promise.all([
    acquiredLease(),
    readFile(
      'vendor/contracts/native-worker/v1/examples/upload-grant.json',
      'utf8',
    ).then((value) => JSON.parse(value) as Record<string, unknown>),
  ]);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const uploadHeaders = document.uploadHeaders as Record<string, unknown>;
  const response = JSON.stringify({
    ...document,
    sha256,
    uploadHeaders: {
      ...uploadHeaders,
      'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    },
  });

  return createNativeUploadGrant(
    {
      controlPlaneOrigin,
      token,
      authority,
      expectedRunRevision: 5,
      slot: 'measurements',
      size: content.byteLength,
      sha256,
      mediaType: 'application/json',
    },
    () => Promise.resolve(new Response(response, { status: 201 })),
  );
}

async function withArtifact(
  content: Uint8Array,
  operation: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'perfeng-native-upload-'));
  const path = join(directory, 'measurements.json');
  try {
    await writeFile(path, content);
    await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('uploads exact verified bytes with only the signed request headers', async () => {
  const content = Buffer.from('{"schema":"playwright-measurements/v2"}\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const grant = await acquiredGrant(content);

  await withArtifact(content, async (path) => {
    const send = (async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(typeof input).toBe('string');
      const url = input as string;
      expect(url).toContain(
        'https://objects.perfeng.invalid/perfeng-artifacts/',
      );
      expect(url).toContain('X-Amz-Signature=');
      expect(init?.method).toBe('PUT');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ['content-type', 'application/json'],
        [
          'x-amz-checksum-sha256',
          Buffer.from(sha256, 'hex').toString('base64'),
        ],
      ]);
      expect(init?.body).toBeInstanceOf(Blob);
      const body = init?.body as Blob;
      expect(body.size).toBe(content.byteLength);
      expect(body.type).toBe('application/json');
      expect(Buffer.from(await body.arrayBuffer())).toEqual(content);

      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await uploadNativeArtifact(
      {
        grant,
        path,
        size: content.byteLength,
        sha256,
        mediaType: 'application/json',
      },
      send,
    );
  });
});

test('rejects missing, changed, and inconsistent local artifacts before transfer', async () => {
  const content = Buffer.from('{"value":"expected"}\n');
  const changed = Buffer.from('{"value":"modified"}\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const grant = await acquiredGrant(content);
  const send = () => Promise.reject(new Error('request must not be sent'));

  await expect(
    uploadNativeArtifact(
      {
        grant,
        path: join(tmpdir(), 'perfeng-missing-artifact'),
        size: content.byteLength,
        sha256,
        mediaType: 'application/json',
      },
      send,
    ),
  ).rejects.toMatchObject({ kind: 'local-artifact' });

  await withArtifact(changed, async (path) => {
    await expect(
      uploadNativeArtifact(
        {
          grant,
          path,
          size: changed.byteLength,
          sha256,
          mediaType: 'application/json',
        },
        send,
      ),
    ).rejects.toMatchObject({ kind: 'local-artifact' });
  });

  await withArtifact(content, async (path) => {
    await expect(
      uploadNativeArtifact(
        {
          grant,
          path,
          size: content.byteLength,
          sha256,
          mediaType: 'application/octet-stream',
        },
        send,
      ),
    ).rejects.toThrow('does not match the artifact');
  });
});

test('rejects a backing file changed after preflight verification', async () => {
  const content = Buffer.from('{"value":"stable"}\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const grant = await acquiredGrant(content);

  await withArtifact(content, async (path) => {
    const send = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      await writeFile(path, Buffer.from('{"value":"changed-after-hash"}\n'));
      await (init?.body as Blob).arrayBuffer();
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await expect(
      uploadNativeArtifact(
        {
          grant,
          path,
          size: content.byteLength,
          sha256,
          mediaType: 'application/json',
        },
        send,
      ),
    ).rejects.toMatchObject({ kind: 'local-artifact' });
  });
});

test('classifies provider rejection, retry, transport failure, and cancellation safely', async () => {
  const content = Buffer.from('{"value":"classification"}\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const grant = await acquiredGrant(content);

  await withArtifact(content, async (path) => {
    const request = {
      grant,
      path,
      size: content.byteLength,
      sha256,
      mediaType: 'application/json',
    };
    for (const failureCase of [
      { status: 403, kind: 'rejected' },
      { status: 503, kind: 'retryable' },
    ] as const) {
      const failure = await uploadNativeArtifact(request, () =>
        Promise.resolve(
          new Response('sensitive provider response', {
            status: failureCase.status,
          }),
        ),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(failure).toBeInstanceOf(NativeArtifactUploadFailure);
      expect(failure).toMatchObject({ kind: failureCase.kind });
      expect(String(failure)).not.toContain('sensitive provider response');
      expect(String(failure)).not.toContain('X-Amz-');
    }

    const transportFailure = await uploadNativeArtifact(request, () =>
      Promise.reject(new Error('X-Amz-Signature=secret')),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(transportFailure).toMatchObject({ kind: 'retryable' });
    expect(String(transportFailure)).not.toContain('X-Amz-');

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      uploadNativeArtifact({ ...request, signal: cancelled.signal }, () =>
        Promise.reject(new Error('request must not be sent')),
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

test('rejects inconsistent delivery material before transfer', async () => {
  const content = Buffer.from('{"value":"authorization"}\n');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const grant = await acquiredGrant(content);
  const inconsistent = new AcquiredNativeUploadGrant(grant.grant, {
    url: 'https://objects.perfeng.invalid/wrong?X-Amz-Signature=secret',
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
    },
  });

  await withArtifact(content, async (path) => {
    await expect(
      uploadNativeArtifact(
        {
          grant: inconsistent,
          path,
          size: content.byteLength,
          sha256,
          mediaType: 'application/json',
        },
        () => Promise.reject(new Error('request must not be sent')),
      ),
    ).rejects.toThrow('authorization does not match');
  });
});
