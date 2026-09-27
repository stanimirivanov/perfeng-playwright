const maximumTokenBytes = 4096;
const maximumResponseBytes = 64 * 1024;

export function validateWorkerCredential(token: string): void {
  if (
    token.length < 1 ||
    Buffer.byteLength(token, 'utf8') > maximumTokenBytes ||
    /[\s,]/u.test(token)
  ) {
    throw new Error('Native worker credential is missing or invalid');
  }
}

export function validateLeaseCapability(value: string | null): string {
  if (
    value === null ||
    value.length < 32 ||
    value.length > maximumTokenBytes ||
    !/^[\x21-\x2b\x2d-\x7e]+$/.test(value)
  ) {
    throw new Error('Native worker lease capability is missing or invalid');
  }

  return value;
}

export async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) {
    throw new Error('Native worker response is empty');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      const { value } = result;
      size += value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Native worker response exceeds 64 KiB');
      }
      chunks.push(value);
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Native worker response must be UTF-8');
  }
}

export async function discardResponse(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(() => undefined);
  }
}

export function parseRetryAfter(response: Response, required: true): number;
export function parseRetryAfter(
  response: Response,
  required: false,
): number | undefined;
export function parseRetryAfter(
  response: Response,
  required: boolean,
): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null && !required) {
    return undefined;
  }
  if (value === null || !/^(?:[1-9]|[1-5][0-9]|60)$/.test(value)) {
    throw new Error('Native worker response has invalid Retry-After');
  }

  return Number(value);
}
