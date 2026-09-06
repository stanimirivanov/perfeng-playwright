import { createGzip } from 'node:zlib';

import type { CDPSession } from '@playwright/test';

import type { HeapSnapshot } from './types.js';

class SnapshotCompressor {
  readonly #gzip = createGzip();
  readonly #chunks: Buffer[] = [];
  readonly #finished: Promise<void>;
  readonly #maxBytes: number;
  #uncompressedSize = 0;
  #exceeded = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
    this.#finished = new Promise((resolve, reject) => {
      this.#gzip.on('data', (chunk: Buffer) => this.#chunks.push(chunk));
      this.#gzip.once('end', resolve);
      this.#gzip.once('error', reject);
    });
  }

  write(chunk: string): void {
    this.#uncompressedSize += Buffer.byteLength(chunk);
    if (this.#uncompressedSize > this.#maxBytes) {
      this.#exceeded = true;
      return;
    }
    this.#gzip.write(chunk, 'utf8');
  }

  async finish(): Promise<{ bytes: Buffer; uncompressedSizeBytes: number }> {
    this.#gzip.end();
    await this.#finished;
    if (this.#exceeded) {
      throw new Error(
        `Chrome heap snapshot exceeds the ${String(this.#maxBytes)} byte limit`,
      );
    }
    return {
      bytes: Buffer.concat(this.#chunks),
      uncompressedSizeBytes: this.#uncompressedSize,
    };
  }

  abort(): void {
    this.#gzip.destroy();
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Chrome heap snapshot did not complete within ${String(timeoutMs)} ms`,
        ),
      );
    }, timeoutMs);
    operation.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function takeHeapSnapshot(
  session: CDPSession,
  maxBytes: number,
  timeoutMs: number,
): Promise<HeapSnapshot> {
  const compressor = new SnapshotCompressor(maxBytes);
  const receive = ({ chunk }: { chunk: string }): void => {
    compressor.write(chunk);
  };
  session.on('HeapProfiler.addHeapSnapshotChunk', receive);
  try {
    await withTimeout(
      session.send('HeapProfiler.takeHeapSnapshot', {
        reportProgress: false,
        captureNumericValue: true,
        exposeInternals: false,
      }),
      timeoutMs,
    );
    const compressed = await compressor.finish();
    return {
      capturedAt: new Date().toISOString(),
      format: 'chrome-heap-snapshot-json-gzip',
      mediaType: 'application/gzip',
      ...compressed,
    };
  } catch (error) {
    compressor.abort();
    throw error;
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk', receive);
  }
}
