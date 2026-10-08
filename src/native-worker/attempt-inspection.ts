import { exactKeys, integer, record } from '../configuration/primitives.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  contractTimestamp,
  enumMember,
  leaseUuid,
  patternString,
} from './contract-values.js';
import {
  discardResponse,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';

const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const inspectionTimeoutMilliseconds = 5_000;
const terminalKinds = new Set(['COMPLETED', 'FAILED'] as const);

/** A point-in-time server observation, never a lease or recovery authority. */
export type NativeAttemptInspection =
  | {
      runId: string;
      attemptId: string;
      state: 'ACTIVE';
      serverTime: string;
      leaseId: string;
      expiresAt: string;
      runRevision: number;
    }
  | {
      runId: string;
      attemptId: string;
      state: 'INACTIVE';
      serverTime: string;
    }
  | {
      runId: string;
      attemptId: string;
      state: 'TERMINAL';
      serverTime: string;
      terminalKind: 'COMPLETED' | 'FAILED';
      runRevision: number;
      acceptedAt: string;
    };

/** A missing or foreign attempt is deliberately indistinguishable. */
export type NativeAttemptInspectionResult =
  | { kind: 'found'; inspection: NativeAttemptInspection }
  | { kind: 'not-found'; runId: string; attemptId: string };

/** Inputs for one bounded, authenticated, read-only server inspection. */
export interface NativeAttemptInspectionRequest {
  controlPlaneOrigin: string;
  token: string;
  runId: string;
  attemptId: string;
  signal?: AbortSignal;
}

/** Inspects one known attempt without supplying or recovering lease authority. */
export async function inspectNativeAttempt(
  request: NativeAttemptInspectionRequest,
  send: typeof fetch = fetch,
): Promise<NativeAttemptInspectionResult> {
  validateWorkerCredential(request.token);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const runId = patternString(request.runId, 'runId', runIdPattern);
  const attemptId = leaseUuid(request.attemptId, 'attemptId');
  const timeout = AbortSignal.timeout(inspectionTimeoutMilliseconds);
  const signal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  let response: Response;
  try {
    response = await send(
      new URL('/native-worker/v2/attempts/inspect', origin),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${request.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocolVersion: 2, runId, attemptId }),
        signal,
      },
    );
  } catch {
    throw new Error('Native attempt inspection request failed');
  }
  if (response.status === 404) {
    parseAttemptNotFound(await readBoundedResponse(response));
    return { kind: 'not-found', runId, attemptId };
  }
  if (response.status !== 200) {
    await discardResponse(response);
    throw new Error(
      `Native attempt inspection was rejected with status ${String(response.status)}`,
    );
  }
  return {
    kind: 'found',
    inspection: parseNativeAttemptInspection(
      await readBoundedResponse(response),
      runId,
      attemptId,
    ),
  };
}

function parseAttemptNotFound(text: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error(
      'Native attempt inspection returned an invalid 404 response',
    );
  }
  const source = record(decoded, 'native attempt inspection 404 response');
  const expected = ['code', 'message'];
  if (source.requestId !== undefined) {
    expected.push('requestId');
    patternString(source.requestId, 'requestId', uuidPattern);
  }
  exactKeys(source, 'native attempt inspection 404 response', expected);
  if (
    source.code !== 'ATTEMPT_NOT_FOUND' ||
    typeof source.message !== 'string' ||
    source.message.length < 1 ||
    source.message.length > 512
  ) {
    throw new Error(
      'Native attempt inspection returned an invalid 404 response',
    );
  }
}

/** Validates the closed v2 response and its requested Run/attempt identity. */
export function parseNativeAttemptInspection(
  text: string,
  runId: string,
  attemptId: string,
): NativeAttemptInspection {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native attempt inspection must be valid JSON');
  }
  const source = record(decoded, 'native attempt inspection');
  const common = ['runId', 'attemptId', 'state', 'serverTime'];
  if (source.state === 'ACTIVE') {
    exactKeys(source, 'native attempt inspection', [
      ...common,
      'leaseId',
      'expiresAt',
      'runRevision',
    ]);
    return {
      ...parseCommon(source, runId, attemptId),
      state: 'ACTIVE',
      leaseId: leaseUuid(source.leaseId, 'leaseId'),
      expiresAt: contractTimestamp(source.expiresAt, 'expiresAt'),
      runRevision: integer(source.runRevision, 'runRevision', 1),
    };
  }
  if (source.state === 'INACTIVE') {
    exactKeys(source, 'native attempt inspection', common);
    return { ...parseCommon(source, runId, attemptId), state: 'INACTIVE' };
  }
  if (source.state === 'TERMINAL') {
    exactKeys(source, 'native attempt inspection', [
      ...common,
      'terminalKind',
      'runRevision',
      'acceptedAt',
    ]);
    return {
      ...parseCommon(source, runId, attemptId),
      state: 'TERMINAL',
      terminalKind: enumMember(
        source.terminalKind,
        'terminalKind',
        terminalKinds,
      ),
      runRevision: integer(source.runRevision, 'runRevision', 1),
      acceptedAt: contractTimestamp(source.acceptedAt, 'acceptedAt'),
    };
  }
  throw new Error('Native attempt inspection state is invalid');
}

function parseCommon(
  source: Record<string, unknown>,
  runId: string,
  attemptId: string,
): { runId: string; attemptId: string; serverTime: string } {
  const actualRunId = patternString(source.runId, 'runId', runIdPattern);
  const actualAttemptId = leaseUuid(source.attemptId, 'attemptId');
  if (actualRunId !== runId || actualAttemptId !== attemptId) {
    throw new Error('Native attempt inspection changed its requested identity');
  }
  return {
    runId: actualRunId,
    attemptId: actualAttemptId,
    serverTime: contractTimestamp(source.serverTime, 'serverTime'),
  };
}
