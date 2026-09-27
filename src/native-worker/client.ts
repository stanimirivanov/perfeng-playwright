import {
  exactKeys,
  integer,
  record,
  requiredString,
} from '../configuration/primitives.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import type {
  QualificationDecision,
  QualificationStatus,
  WorkerAvailability,
  WorkerPresence,
  WorkerPresenceStatus,
} from './types.js';

const maximumTokenBytes = 4096;
const maximumResponseBytes = 64 * 1024;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const availabilityValues = new Set<WorkerAvailability>([
  'AVAILABLE',
  'DRAINING',
  'UNAVAILABLE',
]);
const qualificationValues = new Set<QualificationStatus>([
  'QUALIFIED',
  'UNQUALIFIED',
  'STALE',
]);

export class PresenceRequestFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryable: boolean, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PresenceRequestFailure';
    this.retryable = retryable;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export interface PresenceRequest {
  controlPlaneOrigin: string;
  token: string;
  presence: WorkerPresence;
  signal?: AbortSignal;
}

export async function reportWorkerPresence(
  request: PresenceRequest,
  send: typeof fetch = fetch,
): Promise<WorkerPresenceStatus> {
  validateToken(request.token);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const options: RequestInit = {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${request.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request.presence),
  };
  if (request.signal !== undefined) {
    options.signal = request.signal;
  }
  let response: Response;
  try {
    response = await send(
      new URL('/native-worker/v1/presence', origin),
      options,
    );
  } catch {
    throw new PresenceRequestFailure(
      'Native worker presence request failed',
      request.signal?.aborted !== true,
    );
  }
  if (response.status !== 200) {
    await discardBody(response);
    const retryAfterSeconds = retryAfter(response);
    throw new PresenceRequestFailure(
      `Native worker presence request was rejected with status ${String(response.status)}`,
      response.status === 429 ||
        response.status === 500 ||
        response.status === 503,
      retryAfterSeconds,
    );
  }

  return parsePresenceStatus(await readBoundedBody(response));
}

function retryAfter(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) {
    return undefined;
  }
  const value = response.headers.get('retry-after');
  if (value === null) {
    return undefined;
  }
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(value)) {
    throw new Error('Native worker presence response has invalid Retry-After');
  }

  return Number(value);
}

function validateToken(token: string): void {
  if (
    token.length < 1 ||
    Buffer.byteLength(token, 'utf8') > maximumTokenBytes ||
    /[\s,]/u.test(token)
  ) {
    throw new Error('Native worker credential is missing or invalid');
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) {
    throw new Error('Native worker presence response is empty');
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
        throw new Error('Native worker presence response exceeds 64 KiB');
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
    throw new Error('Native worker presence response must be UTF-8');
  }
}

async function discardBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(() => undefined);
  }
}

export function parsePresenceStatus(text: string): WorkerPresenceStatus {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker presence response must be valid JSON');
  }
  const source = record(decoded, 'native worker presence response');
  exactKeys(source, 'native worker presence response', [
    'workerId',
    'serverTime',
    'nextHeartbeatSeconds',
    'availability',
    'qualification',
    'authorizedToAcquire',
  ]);
  const workerId = requiredString(source.workerId, 'workerId');
  if (!identifierPattern.test(workerId)) {
    throw new Error('workerId must be a contract identifier');
  }
  const serverTime = parseTimestamp(source.serverTime, 'serverTime');
  const nextHeartbeatSeconds = integer(
    source.nextHeartbeatSeconds,
    'nextHeartbeatSeconds',
    5,
  );
  if (nextHeartbeatSeconds > 300) {
    throw new Error('nextHeartbeatSeconds must not exceed 300');
  }
  if (
    typeof source.availability !== 'string' ||
    !availabilityValues.has(source.availability as WorkerAvailability)
  ) {
    throw new Error('availability is invalid');
  }
  if (typeof source.authorizedToAcquire !== 'boolean') {
    throw new Error('authorizedToAcquire must be a boolean');
  }

  return {
    workerId,
    serverTime,
    nextHeartbeatSeconds,
    availability: source.availability as WorkerAvailability,
    qualification: parseQualification(source.qualification),
    authorizedToAcquire: source.authorizedToAcquire,
  };
}

function parseQualification(value: unknown): QualificationDecision {
  const source = record(value, 'qualification');
  const expected = ['status', 'reasons'];
  if (source.validUntil !== undefined) {
    expected.push('validUntil');
  }
  exactKeys(source, 'qualification', expected);
  if (
    typeof source.status !== 'string' ||
    !qualificationValues.has(source.status as QualificationStatus)
  ) {
    throw new Error('qualification.status is invalid');
  }
  if (!Array.isArray(source.reasons) || source.reasons.length > 16) {
    throw new Error('qualification.reasons is invalid');
  }
  const reasons = source.reasons.map((reason) => {
    if (
      typeof reason !== 'string' ||
      reason.length < 1 ||
      reason.length > 256
    ) {
      throw new Error('qualification.reasons is invalid');
    }
    return reason;
  });
  const status = source.status as QualificationStatus;
  if (status !== 'QUALIFIED' && reasons.length === 0) {
    throw new Error('Non-qualified presence requires a reason');
  }
  if (status === 'QUALIFIED' && source.validUntil === undefined) {
    throw new Error('Qualified presence requires validUntil');
  }
  const result: QualificationDecision = { status, reasons };
  if (source.validUntil !== undefined) {
    result.validUntil = parseTimestamp(
      source.validUntil,
      'qualification.validUntil',
    );
  }

  return result;
}

function parseTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name);
  if (
    !timestampPattern.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw new Error(`${name} must be an RFC 3339 timestamp`);
  }

  return timestamp;
}
