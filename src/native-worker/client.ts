import {
  exactKeys,
  integer,
  record,
  requiredString,
} from '../configuration/primitives.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';
import type {
  QualificationDecision,
  QualificationStatus,
  WorkerAvailability,
  WorkerPresence,
  WorkerPresenceStatus,
} from './types.js';

const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
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
  validateWorkerCredential(request.token);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const version: unknown = request.presence.protocolVersion;
  if (version !== 2) {
    throw new Error('Unsupported Native Worker presence protocolVersion');
  }
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
      new URL('/native-worker/v2/presence', origin),
      options,
    );
  } catch {
    throw new PresenceRequestFailure(
      'Native worker presence request failed',
      request.signal?.aborted !== true,
    );
  }
  if (response.status !== 200) {
    await discardResponse(response);
    const retryAfterSeconds = retryAfter(response);
    throw new PresenceRequestFailure(
      `Native worker presence request was rejected with status ${String(response.status)}`,
      response.status === 429 ||
        response.status === 500 ||
        response.status === 503,
      retryAfterSeconds,
    );
  }

  return parsePresenceStatus(await readBoundedResponse(response));
}

function retryAfter(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) {
    return undefined;
  }
  return parseRetryAfter(response, false);
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
