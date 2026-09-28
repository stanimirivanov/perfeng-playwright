import { exactKeys, integer, record } from '../configuration/primitives.js';
import type { AcquiredNativeLease } from './acquisition.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
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
  NativeArtifactReference,
  NativeLeaseMutationFailureKind,
} from './types.js';
import type { AcquiredNativeUploadGrant } from './upload-grant.js';

const registrationTimeoutMilliseconds = 5_000;
const maximumArtifactBytes = 512 * 1024 * 1024;
const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;

export class ArtifactRegistrationFailure extends Error {
  readonly kind: NativeLeaseMutationFailureKind;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: NativeLeaseMutationFailureKind,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ArtifactRegistrationFailure';
    this.kind = kind;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export interface ArtifactRegistrationRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease;
  grant: AcquiredNativeUploadGrant;
  expectedRunRevision: number;
  size: number;
  sha256: string;
  signal?: AbortSignal;
}

interface ArtifactDeclaration {
  expectedRunRevision: number;
  size: number;
  sha256: string;
  kind: string;
  mediaType: string;
}

export async function registerNativeArtifact(
  request: ArtifactRegistrationRequest,
  send: typeof fetch = fetch,
): Promise<NativeArtifactReference> {
  validateWorkerCredential(request.token);
  const declaration = artifactDeclaration(request);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout(registrationTimeoutMilliseconds);
  const requestSignal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const lease = request.authority.lease;
  const grant = request.grant.grant;
  const body = {
    attemptId: lease.attemptId,
    expectedRunRevision: declaration.expectedRunRevision,
    grantId: grant.grantId,
    slot: grant.slot,
    size: declaration.size,
    sha256: declaration.sha256,
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
      new URL(`/native-worker/v1/leases/${lease.leaseId}/artifacts`, origin),
      {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        signal: requestSignal,
      },
    );
  } catch {
    throw new ArtifactRegistrationFailure(
      'Native worker artifact registration request failed',
      request.signal?.aborted === true ? 'cancelled' : 'retryable',
    );
  }
  if (response.status !== 201) {
    await discardResponse(response);
    throw registrationFailure(response);
  }

  return parseArtifactReference(
    await readBoundedResponse(response),
    request,
    declaration,
  );
}

function artifactDeclaration(
  request: ArtifactRegistrationRequest,
): ArtifactDeclaration {
  const expectedRunRevision = integer(
    request.expectedRunRevision,
    'expectedRunRevision',
    1,
  );
  const size = boundedInteger(request.size, 'size', 1, maximumArtifactBytes);
  const sha256 = contractSha256(request.sha256, 'sha256');
  const lease = request.authority.lease;
  const grant = request.grant.grant;
  const plan = lease.artifactPlan.find((item) => item.slot === grant.slot);
  if (plan === undefined) {
    throw new Error('Artifact registration does not match its lease and grant');
  }
  if (
    grant.leaseId !== lease.leaseId ||
    grant.attemptId !== lease.attemptId ||
    grant.runId !== lease.runId ||
    grant.maximumBytes !== plan.maximumBytes ||
    size > grant.maximumBytes ||
    grant.sha256 !== sha256
  ) {
    throw new Error('Artifact registration does not match its lease and grant');
  }

  return {
    expectedRunRevision,
    size,
    sha256,
    kind: plan.kind,
    mediaType: plan.mediaType,
  };
}

function parseArtifactReference(
  text: string,
  request: ArtifactRegistrationRequest,
  declaration: ArtifactDeclaration,
): NativeArtifactReference {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker artifact response must be valid JSON');
  }
  const source = record(decoded, 'native worker artifact response');
  exactKeys(source, 'native worker artifact response', [
    'artifactId',
    'runId',
    'attemptId',
    'slot',
    'kind',
    'uri',
    'size',
    'sha256',
    'mediaType',
    'registeredAt',
  ]);
  const reference: NativeArtifactReference = {
    artifactId: leaseUuid(source.artifactId, 'artifactId'),
    runId: patternString(source.runId, 'runId', runIdPattern),
    attemptId: leaseUuid(source.attemptId, 'attemptId'),
    slot: contractIdentifier(source.slot, 'slot'),
    kind: contractIdentifier(source.kind, 'kind'),
    uri: artifactUri(source.uri),
    size: boundedInteger(source.size, 'size', 1, maximumArtifactBytes),
    sha256: contractSha256(source.sha256, 'sha256'),
    mediaType: patternString(source.mediaType, 'mediaType', mediaTypePattern),
    registeredAt: contractTimestamp(source.registeredAt, 'registeredAt'),
  };
  const lease = request.authority.lease;
  const grant = request.grant.grant;
  const expectedUriPath = `/${grant.objectKey}`;
  const uri = new URL(reference.uri);
  if (
    reference.runId !== lease.runId ||
    reference.attemptId !== lease.attemptId ||
    reference.slot !== grant.slot ||
    reference.kind !== declaration.kind ||
    uri.pathname !== expectedUriPath ||
    reference.size !== declaration.size ||
    reference.sha256 !== declaration.sha256 ||
    reference.mediaType !== declaration.mediaType ||
    Date.parse(reference.registeredAt) < Date.parse(lease.issuedAt) ||
    Date.parse(reference.registeredAt) > Date.parse(lease.expiresAt)
  ) {
    throw new Error(
      'Native worker artifact response changed its artifact fence',
    );
  }

  return reference;
}

function artifactUri(value: unknown): string {
  const result = patternString(value, 'uri', /^s3:\/\/[^/?#]+\/runs\/[^?#]+$/);
  const parsed = new URL(result);
  if (
    parsed.protocol !== 's3:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === ''
  ) {
    throw new Error('uri is invalid');
  }
  return result;
}

function registrationFailure(response: Response): ArtifactRegistrationFailure {
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

  return new ArtifactRegistrationFailure(
    `Native worker artifact registration was rejected with status ${String(response.status)}`,
    kind,
    retryAfterSeconds,
  );
}
