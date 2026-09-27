import {
  boolean,
  exactKeys,
  integer,
  record,
  requiredString,
} from '../configuration/primitives.js';
import type {
  BrowserFamily,
  NativeArtifactPlanItem,
  NativeExecutionArtifact,
  NativeExecutionAssignment,
  NativeLease,
  WorkerDiagnosticMode,
} from './types.js';

const identifierPattern = /^[a-z][a-z0-9-]{1,62}$/;
const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const lockfilePattern = /^[A-Za-z0-9._/-]+$/;
const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const browsers = new Set<BrowserFamily>(['chromium', 'chrome', 'edge']);
const diagnosticModes = new Set<WorkerDiagnosticMode>([
  'lightweight',
  'trace',
  'heap',
  'cpu-profile',
]);

export function parseNativeLease(text: string): NativeLease {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native worker lease response must be valid JSON');
  }

  const source = record(decoded, 'native worker lease response');
  exactKeys(source, 'native worker lease response', [
    'leaseId',
    'attemptId',
    'runId',
    'runRevision',
    'issuedAt',
    'expiresAt',
    'renewAfterSeconds',
    'assignment',
    'artifactPlan',
  ]);
  const issuedAt = timestamp(source.issuedAt, 'issuedAt');
  const expiresAt = timestamp(source.expiresAt, 'expiresAt');
  const renewAfterSeconds = boundedInteger(
    source.renewAfterSeconds,
    'renewAfterSeconds',
    5,
    300,
  );
  const leaseDuration = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (leaseDuration <= renewAfterSeconds * 1_000) {
    throw new Error(
      'Native worker lease does not provide a viable renewal window',
    );
  }

  return {
    leaseId: uuid(source.leaseId, 'leaseId'),
    attemptId: uuid(source.attemptId, 'attemptId'),
    runId: patternString(source.runId, 'runId', runIdPattern),
    runRevision: integer(source.runRevision, 'runRevision', 1),
    issuedAt,
    expiresAt,
    renewAfterSeconds,
    assignment: assignment(source.assignment),
    artifactPlan: artifactPlan(source.artifactPlan),
  };
}

function assignment(value: unknown): NativeExecutionAssignment {
  const source = record(value, 'assignment');
  exactKeys(source, 'assignment', [
    'catalogueTestId',
    'workloadId',
    'profile',
    'target',
    'browser',
    'diagnosticMode',
    'executionArtifact',
  ]);
  const target = record(source.target, 'assignment.target');
  exactKeys(target, 'assignment.target', ['environmentId', 'baseUrl']);

  return {
    catalogueTestId: identifier(
      source.catalogueTestId,
      'assignment.catalogueTestId',
    ),
    workloadId: identifier(source.workloadId, 'assignment.workloadId'),
    profile: identifier(source.profile, 'assignment.profile'),
    target: {
      environmentId: identifier(
        target.environmentId,
        'assignment.target.environmentId',
      ),
      baseUrl: targetUrl(target.baseUrl),
    },
    browser: member(source.browser, 'assignment.browser', browsers),
    diagnosticMode: member(
      source.diagnosticMode,
      'assignment.diagnosticMode',
      diagnosticModes,
    ),
    executionArtifact: executionArtifact(source.executionArtifact),
  };
}

function executionArtifact(value: unknown): NativeExecutionArtifact {
  const source = record(value, 'assignment.executionArtifact');
  if (source.kind === 'source-checkout') {
    exactKeys(source, 'assignment.executionArtifact', [
      'kind',
      'repository',
      'revision',
      'lockfile',
      'lockfileSha256',
    ]);
    return {
      kind: 'source-checkout',
      repository: httpsUrl(source.repository, 'executionArtifact.repository'),
      revision: patternString(
        source.revision,
        'executionArtifact.revision',
        /^[a-f0-9]{40}$/,
      ),
      lockfile: patternString(
        source.lockfile,
        'executionArtifact.lockfile',
        lockfilePattern,
      ),
      lockfileSha256: sha256(
        source.lockfileSha256,
        'executionArtifact.lockfileSha256',
      ),
    };
  }
  if (source.kind === 'release-archive') {
    exactKeys(source, 'assignment.executionArtifact', [
      'kind',
      'url',
      'archiveSha256',
      'executableSha256',
    ]);
    return {
      kind: 'release-archive',
      url: httpsUrl(source.url, 'executionArtifact.url', true),
      archiveSha256: sha256(
        source.archiveSha256,
        'executionArtifact.archiveSha256',
      ),
      executableSha256: sha256(
        source.executableSha256,
        'executionArtifact.executableSha256',
      ),
    };
  }

  throw new Error('assignment.executionArtifact.kind is invalid');
}

function artifactPlan(value: unknown): NativeArtifactPlanItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error('artifactPlan must contain one through sixteen items');
  }
  const slots = new Set<string>();

  return value.map((item, index) => {
    const name = `artifactPlan[${String(index)}]`;
    const source = record(item, name);
    exactKeys(source, name, [
      'slot',
      'kind',
      'mediaType',
      'format',
      'maximumBytes',
      'required',
    ]);
    const slot = identifier(source.slot, `${name}.slot`);
    if (slots.has(slot)) {
      throw new Error('artifactPlan contains a duplicate slot');
    }
    slots.add(slot);

    return {
      slot,
      kind: identifier(source.kind, `${name}.kind`),
      mediaType: patternString(
        source.mediaType,
        `${name}.mediaType`,
        mediaTypePattern,
      ),
      format: identifier(source.format, `${name}.format`),
      maximumBytes: boundedInteger(
        source.maximumBytes,
        `${name}.maximumBytes`,
        1,
        512 * 1024 * 1024,
      ),
      required: boolean(source.required, `${name}.required`),
    };
  });
}

function identifier(value: unknown, name: string): string {
  return patternString(value, name, identifierPattern);
}

function sha256(value: unknown, name: string): string {
  return patternString(value, name, sha256Pattern);
}

function uuid(value: unknown, name: string): string {
  return patternString(value, name, uuidPattern);
}

function timestamp(value: unknown, name: string): string {
  const result = patternString(value, name, timestampPattern);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be an RFC 3339 timestamp`);
  }
  return result;
}

function patternString(value: unknown, name: string, pattern: RegExp): string {
  const result = requiredString(value, name);
  if (!pattern.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = integer(value, name, minimum);
  if (result > maximum) {
    throw new Error(`${name} must not exceed ${String(maximum)}`);
  }
  return result;
}

function member<T extends string>(
  value: unknown,
  name: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

function targetUrl(value: unknown): string {
  const result = httpsUrl(value, 'assignment.target.baseUrl');
  const parsed = new URL(result);
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('assignment.target.baseUrl is invalid');
  }
  return result;
}

function httpsUrl(value: unknown, name: string, exactPath = false): string {
  const result = requiredString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (exactPath && (parsed.search !== '' || parsed.hash !== ''))
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  return result;
}
