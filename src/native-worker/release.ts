import { integer, requiredString } from '../configuration/primitives.js';
import type { AcquiredNativeLease } from './acquisition.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import { enumMember } from './contract-values.js';
import {
  discardResponse,
  parseRetryAfter,
  validateWorkerCredential,
} from './transport.js';
import type {
  NativeLeaseMutationFailureKind,
  NativeLeaseReleaseReason,
} from './types.js';

const releaseTimeoutMilliseconds = 5_000;
const releaseReasons = new Set<NativeLeaseReleaseReason>([
  'CANCELLATION_REQUESTED',
  'LEASE_LOST',
  'WORKER_SHUTDOWN',
  'PREPARATION_FAILED',
]);

export class LeaseReleaseFailure extends Error {
  readonly kind: NativeLeaseMutationFailureKind;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: NativeLeaseMutationFailureKind,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LeaseReleaseFailure';
    this.kind = kind;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export interface LeaseReleaseRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: number;
  reason: NativeLeaseReleaseReason;
  message?: string;
  signal?: AbortSignal;
}

export async function releaseNativeLease(
  request: LeaseReleaseRequest,
  send: typeof fetch = fetch,
): Promise<void> {
  validateWorkerCredential(request.token);
  const expectedRunRevision = integer(
    request.expectedRunRevision,
    'expectedRunRevision',
    1,
  );
  const reason = enumMember(request.reason, 'reason', releaseReasons);
  const message = releaseMessage(request.message);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout(releaseTimeoutMilliseconds);
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
  const body: Record<string, unknown> = {
    attemptId: lease.attemptId,
    expectedRunRevision,
    reason,
  };
  if (message !== undefined) {
    body.message = message;
  }
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
        `/native-worker/v${v2 ? '2' : '1'}/leases/${lease.leaseId}/release`,
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
    throw new LeaseReleaseFailure(
      'Native worker lease release request failed',
      request.signal?.aborted === true ? 'cancelled' : 'retryable',
    );
  }
  await discardResponse(response);
  if (response.status !== 204) {
    throw releaseFailure(response);
  }
}

function releaseMessage(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const message = requiredString(value, 'message');
  let characters = 0;
  let wellFormed = true;
  for (const character of message) {
    characters++;
    if (character.length === 1) {
      const codeUnit = character.charCodeAt(0);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
        wellFormed = false;
      }
    }
  }
  if (!wellFormed || characters > 512) {
    throw new Error('message must contain at most 512 Unicode characters');
  }
  return message;
}

function releaseFailure(response: Response): LeaseReleaseFailure {
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

  return new LeaseReleaseFailure(
    `Native worker lease release was rejected with status ${String(response.status)}`,
    kind,
    retryAfterSeconds,
  );
}
