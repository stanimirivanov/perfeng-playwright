import {
  boolean,
  exactKeys,
  integer,
  record,
  requiredString,
} from '../configuration/primitives.js';
import type { AcquiredNativeLease } from './acquisition.js';
import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import { enumMember, leaseUuid } from './contract-values.js';
import {
  discardResponse,
  parseRetryAfter,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';
import type {
  NativeArtifactReference,
  NativeLeaseMutationFailureKind,
  NativeTerminalAcknowledgement,
  NativeTerminalDisposition,
  NativeTerminalFailure,
  NativeTerminalFailureCode,
} from './types.js';

const terminalTimeoutMilliseconds = 5_000;
const terminalFailureCodes = new Set<NativeTerminalFailureCode>([
  'PREPARATION_FAILED',
  'TOOL_FAILED',
  'CAPTURE_FAILED',
  'UPLOAD_FAILED',
  'HOST_BECAME_UNQUALIFIED',
]);
const terminalDispositions = new Set<NativeTerminalDisposition>([
  'ACCEPTED',
  'ALREADY_ACCEPTED',
]);

export class TerminalReportFailure extends Error {
  readonly kind: NativeLeaseMutationFailureKind;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    kind: NativeLeaseMutationFailureKind,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TerminalReportFailure';
    this.kind = kind;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

interface TerminalReportRequestBase {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeLease | AcquiredNativeV2Lease;
  expectedRunRevision: number;
  signal?: AbortSignal;
}

export type TerminalReportRequest = TerminalReportRequestBase &
  (
    | {
        kind: 'COMPLETED';
        manifest: NativeArtifactReference;
      }
    | {
        kind: 'FAILED';
        failure: NativeTerminalFailure;
      }
  );

interface TerminalRequestBody {
  expectedRunRevision: number;
  value: Record<string, unknown>;
}

export async function reportNativeTerminal(
  request: TerminalReportRequest,
  send: typeof fetch = fetch,
): Promise<NativeTerminalAcknowledgement> {
  validateWorkerCredential(request.token);
  const body = terminalRequestBody(request);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const timeout = AbortSignal.timeout(terminalTimeoutMilliseconds);
  const requestSignal =
    request.signal === undefined
      ? timeout
      : AbortSignal.any([request.signal, timeout]);
  const headers = request.authority.useCapability((capability) => ({
    accept: 'application/json',
    authorization: `Bearer ${request.token}`,
    'content-type': 'application/json',
    'x-perfeng-lease': capability,
  }));
  const v2 = request.authority instanceof AcquiredNativeV2Lease;
  const lease =
    request.authority instanceof AcquiredNativeV2Lease
      ? request.authority.recipe
      : request.authority.lease;

  let response: Response;
  try {
    response = await send(
      new URL(
        `/native-worker/v${v2 ? '2' : '1'}/leases/${lease.leaseId}/terminal`,
        origin,
      ),
      {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body.value),
        signal: requestSignal,
      },
    );
  } catch {
    throw new TerminalReportFailure(
      'Native worker terminal report request failed',
      request.signal?.aborted === true ? 'cancelled' : 'retryable',
    );
  }
  if (response.status !== 200) {
    await discardResponse(response);
    throw terminalReportFailure(response);
  }

  return parseTerminalAcknowledgement(
    await readBoundedResponse(response),
    request.authority,
    body.expectedRunRevision,
  );
}

function terminalRequestBody(
  request: TerminalReportRequest,
): TerminalRequestBody {
  const expectedRunRevision = integer(
    request.expectedRunRevision,
    'expectedRunRevision',
    1,
  );
  const attemptId =
    request.authority instanceof AcquiredNativeV2Lease
      ? request.authority.recipe.attemptId
      : request.authority.lease.attemptId;
  if (request.kind === 'COMPLETED') {
    const manifestArtifactId = validateManifestReference(
      request.authority,
      request.manifest,
    );
    return {
      expectedRunRevision,
      value: {
        kind: 'COMPLETED',
        attemptId,
        expectedRunRevision,
        manifestArtifactId,
      },
    };
  }
  return {
    expectedRunRevision,
    value: {
      kind: 'FAILED',
      attemptId,
      expectedRunRevision,
      failure: terminalFailure(request.failure),
    },
  };
}

function validateManifestReference(
  authority: AcquiredNativeLease | AcquiredNativeV2Lease,
  reference: NativeArtifactReference,
): string {
  const artifactId = leaseUuid(reference.artifactId, 'manifest.artifactId');
  const lease =
    authority instanceof AcquiredNativeV2Lease
      ? authority.recipe
      : authority.lease;
  const plan = lease.artifactPlan.find((item) => item.slot === reference.slot);
  if (
    reference.runId !== lease.runId ||
    reference.attemptId !== lease.attemptId ||
    plan?.kind !== 'manifest' ||
    !plan.required ||
    reference.kind !== plan.kind ||
    reference.mediaType !== plan.mediaType
  ) {
    throw new Error('Completed terminal report does not identify its manifest');
  }

  return artifactId;
}

function terminalFailure(value: NativeTerminalFailure): NativeTerminalFailure {
  const code = enumMember(value.code, 'failure.code', terminalFailureCodes);
  const message = terminalFailureMessage(value.message);
  const retryable = boolean(value.retryable, 'failure.retryable');
  return { code, message, retryable };
}

function terminalFailureMessage(value: unknown): string {
  const message = requiredString(value, 'failure.message');
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
  if (!wellFormed || characters > 1024) {
    throw new Error(
      'failure.message must contain at most 1024 Unicode characters',
    );
  }
  return message;
}

function parseTerminalAcknowledgement(
  text: string,
  authority: AcquiredNativeLease | AcquiredNativeV2Lease,
  expectedRunRevision: number,
): NativeTerminalAcknowledgement {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error(
      'Native worker terminal acknowledgement must be valid JSON',
    );
  }
  const source = record(decoded, 'native worker terminal acknowledgement');
  exactKeys(source, 'native worker terminal acknowledgement', [
    'attemptId',
    'runRevision',
    'disposition',
  ]);
  const acknowledgement: NativeTerminalAcknowledgement = {
    attemptId: leaseUuid(source.attemptId, 'attemptId'),
    runRevision: integer(source.runRevision, 'runRevision', 1),
    disposition: enumMember(
      source.disposition,
      'disposition',
      terminalDispositions,
    ),
  };
  const attemptId =
    authority instanceof AcquiredNativeV2Lease
      ? authority.recipe.attemptId
      : authority.lease.attemptId;
  if (
    acknowledgement.attemptId !== attemptId ||
    acknowledgement.runRevision < expectedRunRevision
  ) {
    throw new Error(
      'Native worker terminal acknowledgement changed its attempt fence',
    );
  }

  return acknowledgement;
}

function terminalReportFailure(response: Response): TerminalReportFailure {
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

  return new TerminalReportFailure(
    `Native worker terminal report was rejected with status ${String(response.status)}`,
    kind,
    retryAfterSeconds,
  );
}
