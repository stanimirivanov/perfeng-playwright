import { inspect } from 'node:util';

import { exactKeys, integer, record } from '../configuration/primitives.js';
import type { AcquiredNativeLease } from './acquisition.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  absoluteHttpsUrl,
  boundedInteger,
  contractIdentifier,
  contractSha256,
  contractTimestamp,
  leaseUuid,
  patternString,
} from './contract-values.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';
import type {
  NativeLeaseMutationFailureKind,
  NativeUploadAuthorization,
  NativeUploadGrantDetails,
} from './types.js';

const uploadGrantTimeoutMilliseconds = 5_000;
const maximumArtifactBytes = 512 * 1024 * 1024;
const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const checksumBase64Pattern = /^[A-Za-z0-9+/]{43}=$/;

export class UploadGrantFailure extends Error {
  readonly kind: NativeLeaseMutationFailureKind;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: NativeLeaseMutationFailureKind,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'UploadGrantFailure';
    this.kind = kind;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export class AcquiredNativeUploadGrant {
  readonly grant: NativeUploadGrantDetails;
  readonly protocolVersion: 1 | 2;
  readonly #url: string;
  readonly #contentType: string;
  readonly #checksumSha256: string;

  constructor(
    grant: NativeUploadGrantDetails,
    authorization: NativeUploadAuthorization,
    protocolVersion: 1 | 2 = 1,
  ) {
    this.grant = grant;
    this.protocolVersion = protocolVersion;
    this.#url = authorization.url;
    this.#contentType = authorization.headers['content-type'];
    this.#checksumSha256 = authorization.headers['x-amz-checksum-sha256'];
  }

  useAuthorization<T>(
    operation: (authorization: NativeUploadAuthorization) => T,
  ): T {
    return operation({
      url: this.#url,
      method: 'PUT',
      headers: {
        'content-type': this.#contentType,
        'x-amz-checksum-sha256': this.#checksumSha256,
      },
    });
  }

  toJSON(): NativeUploadGrantDetails {
    return this.grant;
  }

  toString(): string {
    return `native upload grant ${this.grant.grantId} for run ${this.grant.runId} slot ${this.grant.slot}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export interface UploadGrantRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: number;
  slot: string;
  size: number;
  sha256: string;
  mediaType: string;
  signal?: AbortSignal;
}

interface UploadDeclaration {
  expectedRunRevision: number;
  slot: string;
  size: number;
  sha256: string;
  mediaType: string;
  maximumBytes: number;
}

export async function createNativeUploadGrant(
  request: UploadGrantRequest,
  send: typeof fetch = fetch,
): Promise<AcquiredNativeUploadGrant> {
  validateWorkerCredential(request.token);
  const declaration = uploadDeclaration(request);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout(uploadGrantTimeoutMilliseconds);
  const requestSignal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const body = {
    attemptId:
      request.authority instanceof AcquiredNativeV2Lease
        ? request.authority.recipe.attemptId
        : request.authority.lease.attemptId,
    expectedRunRevision: declaration.expectedRunRevision,
    slot: declaration.slot,
    size: declaration.size,
    sha256: declaration.sha256,
    mediaType: declaration.mediaType,
  };
  const headers = request.authority.useCapability((capability) => ({
    accept: 'application/json',
    authorization: `Bearer ${request.token}`,
    'content-type': 'application/json',
    'x-perfeng-lease': capability,
  }));

  let response: Response;
  try {
    const v2 = request.authority instanceof AcquiredNativeV2Lease;
    const leaseId =
      request.authority instanceof AcquiredNativeV2Lease
        ? request.authority.recipe.leaseId
        : request.authority.lease.leaseId;
    response = await send(
      new URL(
        `/native-worker/v${v2 ? '2' : '1'}/leases/${leaseId}/upload-grants`,
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
    throw new UploadGrantFailure(
      'Native worker upload grant request failed',
      request.signal?.aborted === true ? 'cancelled' : 'retryable',
    );
  }
  if (response.status !== 201) {
    await discardResponse(response);
    throw uploadGrantFailure(response);
  }

  return parseUploadGrant(
    await readBoundedResponse(response),
    request.authority,
    declaration,
  );
}

function uploadDeclaration(request: UploadGrantRequest): UploadDeclaration {
  const expectedRunRevision = integer(
    request.expectedRunRevision,
    'expectedRunRevision',
    1,
  );
  const slot = contractIdentifier(request.slot, 'slot');
  const size = boundedInteger(request.size, 'size', 1, maximumArtifactBytes);
  const sha256 = contractSha256(request.sha256, 'sha256');
  const mediaType = patternString(
    request.mediaType,
    'mediaType',
    mediaTypePattern,
  );
  const lease =
    request.authority instanceof AcquiredNativeV2Lease
      ? request.authority.recipe
      : request.authority.lease;
  const plan = lease.artifactPlan.find((item) => item.slot === slot);
  if (plan?.mediaType !== mediaType || size > plan.maximumBytes) {
    throw new Error('Upload declaration does not match the artifact plan');
  }

  return {
    expectedRunRevision,
    slot,
    size,
    sha256,
    mediaType,
    maximumBytes: plan.maximumBytes,
  };
}

function parseUploadGrant(
  text: string,
  authority: AcquiredNativeLease | AcquiredNativeV2Lease,
  declaration: UploadDeclaration,
): AcquiredNativeUploadGrant {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker upload grant response must be valid JSON');
  }
  const source = record(decoded, 'native worker upload grant response');
  exactKeys(source, 'native worker upload grant response', [
    'grantId',
    'leaseId',
    'attemptId',
    'runId',
    'slot',
    'objectKey',
    'uploadUrl',
    'uploadHeaders',
    'method',
    'expiresAt',
    'maximumBytes',
    'sha256',
  ]);
  const headers = uploadHeaders(source.uploadHeaders, declaration);
  const v2 = authority instanceof AcquiredNativeV2Lease;
  const lease = v2 ? authority.recipe : authority.lease;
  const grant: NativeUploadGrantDetails = {
    grantId: leaseUuid(source.grantId, 'grantId'),
    leaseId: leaseUuid(source.leaseId, 'leaseId'),
    attemptId: leaseUuid(source.attemptId, 'attemptId'),
    runId: patternString(
      source.runId,
      'runId',
      /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/,
    ),
    slot: contractIdentifier(source.slot, 'slot'),
    objectKey: patternString(
      source.objectKey,
      'objectKey',
      /^runs\/perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}\/attempts\/[0-9a-f-]{36}\/[a-z][a-z0-9-]{1,62}$/,
    ),
    method: uploadMethod(source.method),
    expiresAt: contractTimestamp(source.expiresAt, 'expiresAt'),
    maximumBytes: boundedInteger(
      source.maximumBytes,
      'maximumBytes',
      1,
      maximumArtifactBytes,
    ),
    sha256: contractSha256(source.sha256, 'sha256'),
  };
  const expectedKey = `runs/${lease.runId}/attempts/${lease.attemptId}/${declaration.slot}`;
  if (
    grant.leaseId !== lease.leaseId ||
    grant.attemptId !== lease.attemptId ||
    grant.runId !== lease.runId ||
    grant.slot !== declaration.slot ||
    grant.objectKey !== expectedKey ||
    grant.maximumBytes !== declaration.maximumBytes ||
    grant.sha256 !== declaration.sha256 ||
    Date.parse(grant.expiresAt) <= Date.parse(lease.issuedAt) ||
    Date.parse(grant.expiresAt) > Date.parse(lease.expiresAt)
  ) {
    throw new Error('Native worker upload grant changed its artifact fence');
  }
  const url = presignedUploadUrl(source.uploadUrl, expectedKey);

  return new AcquiredNativeUploadGrant(
    grant,
    { url, method: 'PUT', headers },
    v2 ? 2 : 1,
  );
}

function uploadHeaders(
  value: unknown,
  declaration: UploadDeclaration,
): NativeUploadAuthorization['headers'] {
  const source = record(value, 'uploadHeaders');
  exactKeys(source, 'uploadHeaders', ['content-type', 'x-amz-checksum-sha256']);
  const contentType = patternString(
    source['content-type'],
    'uploadHeaders.content-type',
    mediaTypePattern,
  );
  const checksum = patternString(
    source['x-amz-checksum-sha256'],
    'uploadHeaders.x-amz-checksum-sha256',
    checksumBase64Pattern,
  );
  const expectedChecksum = Buffer.from(declaration.sha256, 'hex').toString(
    'base64',
  );
  if (contentType !== declaration.mediaType || checksum !== expectedChecksum) {
    throw new Error('Native worker upload grant changed its signed headers');
  }

  return {
    'content-type': contentType,
    'x-amz-checksum-sha256': checksum,
  };
}

function uploadMethod(value: unknown): 'PUT' {
  if (value !== 'PUT') {
    throw new Error('method is invalid');
  }
  return value;
}

function presignedUploadUrl(value: unknown, objectKey: string): string {
  const result = absoluteHttpsUrl(value, 'uploadUrl');
  const parsed = new URL(result);
  if (
    parsed.search === '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith(`/${objectKey}`)
  ) {
    throw new Error('uploadUrl is invalid');
  }
  return result;
}

function uploadGrantFailure(response: Response): UploadGrantFailure {
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

  return new UploadGrantFailure(
    `Native worker upload grant was rejected with status ${String(response.status)}`,
    kind,
    retryAfterSeconds,
  );
}
