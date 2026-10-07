import { inspect } from 'node:util';

import { integer } from '../configuration/primitives.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  parseNativeExecutionRecipe,
  type NativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from './execution-recipe.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateLeaseCapability,
  validateWorkerCredential,
} from './transport.js';

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

export interface LeaseAcquisitionRequest {
  controlPlaneOrigin: string;
  token: string;
  maxWaitSeconds: number;
  signal?: AbortSignal;
}

/** V2 acquisition inputs, including the worker's current qualification evidence. */
export interface NativeV2LeaseAcquisitionRequest extends LeaseAcquisitionRequest {
  currentEvidence: NativeWorkerQualificationEvidence;
}

/** A validated v2 execution recipe paired with a non-serializable lease capability. */
export class AcquiredNativeV2Lease {
  readonly recipe: NativeExecutionRecipe;
  readonly #capability: string;

  constructor(recipe: NativeExecutionRecipe, capability: string) {
    this.recipe = recipe;
    this.#capability = capability;
  }

  useCapability<T>(operation: (capability: string) => T): T {
    return operation(this.#capability);
  }

  toJSON(): NativeExecutionRecipe {
    return this.recipe;
  }

  toString(): string {
    return `native v2 lease ${this.recipe.leaseId} for run ${this.recipe.runId}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Idle result or one lease validated against the worker's current evidence. */
export type NativeV2LeaseAcquisition =
  | { kind: 'idle'; retryAfterSeconds: number }
  | { kind: 'acquired'; authority: AcquiredNativeV2Lease };

/** Acquires a v2 lease without making the presence-only CLI runnable. */
export async function acquireNativeV2Lease(
  request: NativeV2LeaseAcquisitionRequest,
  send: typeof fetch = fetch,
): Promise<NativeV2LeaseAcquisition> {
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
    body: JSON.stringify({ protocolVersion: 2, maxWaitSeconds }),
    signal: requestSignal,
  };

  let response: Response;
  try {
    response = await send(new URL('/native-worker/v2/leases', origin), options);
  } catch {
    throw new LeaseAcquisitionFailure(
      'Native worker v2 lease acquisition request failed',
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
      `Native worker v2 lease acquisition was rejected with status ${String(response.status)}`,
      response.status === 429 ||
        response.status === 500 ||
        response.status === 503,
      retryAfterSeconds,
    );
  }

  const capability = validateLeaseCapability(
    response.headers.get('x-perfeng-lease'),
  );
  const recipe = parseNativeExecutionRecipe(
    await readBoundedResponse(response),
    request.currentEvidence,
  );

  return {
    kind: 'acquired',
    authority: new AcquiredNativeV2Lease(recipe, capability),
  };
}
