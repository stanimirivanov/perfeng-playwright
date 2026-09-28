import {
  boolean,
  exactKeys,
  integer,
  record,
} from '../configuration/primitives.js';
import {
  absoluteHttpsUrl,
  boundedInteger,
  contractArtifactFormat,
  contractIdentifier,
  contractSha256,
  contractTimestamp,
  enumMember,
  leaseUuid,
  patternString,
} from './contract-values.js';
import type {
  BrowserFamily,
  NativeArtifactPlanItem,
  NativeExecutionArtifact,
  NativeExecutionAssignment,
  NativeLease,
  WorkerDiagnosticMode,
} from './types.js';

const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;
const lockfilePattern = /^[A-Za-z0-9._/-]+$/;
const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const canonicalArtifactFormats = new Map([
  ['measurements', 'playwright-measurements/v2'],
  ['manifest', 'raw-result/v2'],
]);
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
  const issuedAt = contractTimestamp(source.issuedAt, 'issuedAt');
  const expiresAt = contractTimestamp(source.expiresAt, 'expiresAt');
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
    leaseId: leaseUuid(source.leaseId, 'leaseId'),
    attemptId: leaseUuid(source.attemptId, 'attemptId'),
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
    catalogueTestId: contractIdentifier(
      source.catalogueTestId,
      'assignment.catalogueTestId',
    ),
    workloadId: contractIdentifier(source.workloadId, 'assignment.workloadId'),
    profile: contractIdentifier(source.profile, 'assignment.profile'),
    target: {
      environmentId: contractIdentifier(
        target.environmentId,
        'assignment.target.environmentId',
      ),
      baseUrl: targetUrl(target.baseUrl),
    },
    browser: enumMember(source.browser, 'assignment.browser', browsers),
    diagnosticMode: enumMember(
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
      repository: absoluteHttpsUrl(
        source.repository,
        'executionArtifact.repository',
      ),
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
      lockfileSha256: contractSha256(
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
      url: absoluteHttpsUrl(source.url, 'executionArtifact.url', true),
      archiveSha256: contractSha256(
        source.archiveSha256,
        'executionArtifact.archiveSha256',
      ),
      executableSha256: contractSha256(
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
    const slot = contractIdentifier(source.slot, `${name}.slot`);
    if (slots.has(slot)) {
      throw new Error('artifactPlan contains a duplicate slot');
    }
    slots.add(slot);

    const format = contractArtifactFormat(source.format, `${name}.format`);
    if (canonicalArtifactFormats.get(slot) !== format) {
      throw new Error(`${name}.format is not supported for slot ${slot}`);
    }

    return {
      slot,
      kind: contractIdentifier(source.kind, `${name}.kind`),
      mediaType: patternString(
        source.mediaType,
        `${name}.mediaType`,
        mediaTypePattern,
      ),
      format,
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

function targetUrl(value: unknown): string {
  const result = absoluteHttpsUrl(value, 'assignment.target.baseUrl');
  const parsed = new URL(result);
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('assignment.target.baseUrl is invalid');
  }
  return result;
}
