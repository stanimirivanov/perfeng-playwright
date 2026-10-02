import {
  boolean,
  exactKeys,
  integer,
  record,
} from '../configuration/primitives.js';
import type { AcquiredNativeLease } from './acquisition.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  boundedInteger,
  contractTimestamp,
  enumMember,
  leaseUuid,
} from './contract-values.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';
import type {
  NativeExecutionPhase,
  NativeLeaseMutationFailureKind,
  NativeLeaseRenewal,
} from './types.js';

const renewalTimeoutMilliseconds = 5_000;
const executionPhases = new Set<NativeExecutionPhase>([
  'PREPARING',
  'RUNNING',
  'UPLOADING',
  'FINALIZING',
]);

export class LeaseRenewalFailure extends Error {
  readonly kind: NativeLeaseMutationFailureKind;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: NativeLeaseMutationFailureKind,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LeaseRenewalFailure';
    this.kind = kind;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export interface LeaseRenewalRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: number;
  phase: NativeExecutionPhase;
  signal?: AbortSignal;
}

export async function renewNativeLease(
  request: LeaseRenewalRequest,
  send: typeof fetch = fetch,
): Promise<NativeLeaseRenewal> {
  validateWorkerCredential(request.token);
  const expectedRunRevision = integer(
    request.expectedRunRevision,
    'expectedRunRevision',
    1,
  );
  const phase = enumMember(request.phase, 'phase', executionPhases);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout(renewalTimeoutMilliseconds);
  const requestSignal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const authority = request.authority;
  const v2 = authority instanceof AcquiredNativeV2Lease;
  const lease =
    authority instanceof AcquiredNativeV2Lease
      ? authority.recipe
      : authority.lease;
  const body = {
    attemptId: lease.attemptId,
    expectedRunRevision,
    phase,
  };
  const headers = request.authority.useCapability((capability) => ({
    accept: 'application/json',
    authorization: `Bearer ${request.token}`,
    'content-type': 'application/json',
    'x-perfeng-lease': capability,
  }));

  let response: Response;
  try {
    response = await send(
      new URL(
        `/native-worker/v${v2 ? '2' : '1'}/leases/${lease.leaseId}/renew`,
        origin,
      ),
      {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      },
    );
  } catch {
    throw new LeaseRenewalFailure(
      'Native worker lease renewal request failed',
      request.signal?.aborted === true ? 'cancelled' : 'retryable',
    );
  }
  if (response.status !== 200) {
    await discardResponse(response);
    throw renewalFailure(response);
  }

  const renewal = parseNativeLeaseRenewal(await readBoundedResponse(response));
  if (
    renewal.leaseId !== lease.leaseId ||
    renewal.attemptId !== lease.attemptId ||
    renewal.runRevision < expectedRunRevision
  ) {
    throw new Error('Native worker lease renewal changed its attempt fence');
  }

  return renewal;
}

export function parseNativeLeaseRenewal(text: string): NativeLeaseRenewal {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker lease renewal must be valid JSON');
  }

  const source = record(decoded, 'native worker lease renewal');
  const cancellationRequested = boolean(
    source.cancellationRequested,
    'cancellationRequested',
  );
  const expectedKeys = [
    'leaseId',
    'attemptId',
    'runRevision',
    'serverTime',
    'expiresAt',
    'renewAfterSeconds',
    'cancellationRequested',
  ];
  if (cancellationRequested) {
    expectedKeys.push('stopBy');
  }
  exactKeys(source, 'native worker lease renewal', expectedKeys);
  const serverTime = contractTimestamp(source.serverTime, 'serverTime');
  const expiresAt = contractTimestamp(source.expiresAt, 'expiresAt');
  const renewAfterSeconds = boundedInteger(
    source.renewAfterSeconds,
    'renewAfterSeconds',
    5,
    300,
  );
  const renewalWindow = Date.parse(expiresAt) - Date.parse(serverTime);
  if (renewalWindow <= renewAfterSeconds * 1_000) {
    throw new Error(
      'Native worker lease renewal does not provide a viable renewal window',
    );
  }
  const fields = {
    leaseId: leaseUuid(source.leaseId, 'leaseId'),
    attemptId: leaseUuid(source.attemptId, 'attemptId'),
    runRevision: integer(source.runRevision, 'runRevision', 1),
    serverTime,
    expiresAt,
    renewAfterSeconds,
  };
  if (!cancellationRequested) {
    return { ...fields, cancellationRequested: false };
  }

  const stopBy = contractTimestamp(source.stopBy, 'stopBy');
  if (
    Date.parse(stopBy) <= Date.parse(serverTime) ||
    Date.parse(stopBy) > Date.parse(expiresAt)
  ) {
    throw new Error('Native worker cancellation stopBy is outside the lease');
  }
  return { ...fields, cancellationRequested: true, stopBy };
}

function renewalFailure(response: Response): LeaseRenewalFailure {
  const retryAfterSeconds =
    response.status === 429 || response.status === 503
      ? parseRetryAfter(response, false)
      : undefined;
  let kind: NativeLeaseMutationFailureKind = 'permanent';
  if (response.status === 409) {
    kind = 'conflict';
  } else if (response.status === 410) {
    kind = 'lost';
  } else if (
    response.status === 429 ||
    response.status === 500 ||
    response.status === 503
  ) {
    kind = 'retryable';
  }

  return new LeaseRenewalFailure(
    `Native worker lease renewal was rejected with status ${String(response.status)}`,
    kind,
    retryAfterSeconds,
  );
}
