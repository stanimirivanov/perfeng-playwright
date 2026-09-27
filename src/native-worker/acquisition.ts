import { inspect } from 'node:util';

import { integer } from '../configuration/primitives.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import { parseNativeLease } from './lease.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateLeaseCapability,
  validateWorkerCredential,
} from './transport.js';
import type { NativeLease } from './types.js';

export class LeaseAcquisitionFailure extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryable: boolean, retryAfterSeconds?: number) {
    super(message);
    this.name = 'LeaseAcquisitionFailure';
    this.retryable = retryable;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export class AcquiredNativeLease {
  readonly lease: NativeLease;
  readonly #capability: string;

  constructor(lease: NativeLease, capability: string) {
    this.lease = lease;
    this.#capability = capability;
  }

  useCapability<T>(operation: (capability: string) => T): T {
    return operation(this.#capability);
  }

  toJSON(): NativeLease {
    return this.lease;
  }

  toString(): string {
    return `native lease ${this.lease.leaseId} for run ${this.lease.runId}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export type LeaseAcquisition =
  | { kind: 'idle'; retryAfterSeconds: number }
  | { kind: 'acquired'; authority: AcquiredNativeLease };

export interface LeaseAcquisitionRequest {
  controlPlaneOrigin: string;
  token: string;
  maxWaitSeconds: number;
  signal?: AbortSignal;
}

export async function acquireNativeLease(
  request: LeaseAcquisitionRequest,
  send: typeof fetch = fetch,
): Promise<LeaseAcquisition> {
  validateWorkerCredential(request.token);
  const maxWaitSeconds = integer(request.maxWaitSeconds, 'maxWaitSeconds', 0);
  if (maxWaitSeconds > 30) {
    throw new Error('maxWaitSeconds must not exceed 30');
  }
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout((maxWaitSeconds + 5) * 1_000);
  const requestSignal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const options: RequestInit = {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${request.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocolVersion: 1, maxWaitSeconds }),
    signal: requestSignal,
  };

  let response: Response;
  try {
    response = await send(new URL('/native-worker/v1/leases', origin), options);
  } catch {
    throw new LeaseAcquisitionFailure(
      'Native worker lease acquisition request failed',
      request.signal?.aborted !== true,
    );
  }
  if (response.status === 204) {
    await discardResponse(response);
    return {
      kind: 'idle',
      retryAfterSeconds: parseRetryAfter(response, true),
    };
  }
  if (response.status !== 200) {
    await discardResponse(response);
    const retryAfterSeconds =
      response.status === 429 || response.status === 503
        ? parseRetryAfter(response, false)
        : undefined;
    throw new LeaseAcquisitionFailure(
      `Native worker lease acquisition was rejected with status ${String(response.status)}`,
      response.status === 429 ||
        response.status === 500 ||
        response.status === 503,
      retryAfterSeconds,
    );
  }

  const capability = validateLeaseCapability(
    response.headers.get('x-perfeng-lease'),
  );
  const lease = parseNativeLease(await readBoundedResponse(response));

  return {
    kind: 'acquired',
    authority: new AcquiredNativeLease(lease, capability),
  };
}
