import type { CDPSession } from '@playwright/test';

const chunkSize = 1024 * 1024;

export async function readTraceStream(
  session: CDPSession,
  handle: string,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const response = await session.send('IO.read', {
        handle,
        size: chunkSize,
      });
      const chunk = Buffer.from(
        response.data,
        response.base64Encoded === true ? 'base64' : 'utf8',
      );
      size += chunk.length;
      if (size > maxBytes) {
        throw new Error(
          `Chrome performance trace exceeds the ${String(maxBytes)} byte limit`,
        );
      }
      chunks.push(chunk);
      if (response.eof) {
        return Buffer.concat(chunks, size);
      }
    }
  } finally {
    await session.send('IO.close', { handle }).catch(() => undefined);
  }
}
