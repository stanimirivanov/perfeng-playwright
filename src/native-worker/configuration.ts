import { readFile } from 'node:fs/promises';

import {
  exactKeys,
  record,
  requiredString,
} from '../configuration/primitives.js';
import type { WorkerPresenceConfiguration } from './types.js';

const maximumConfigurationBytes = 64 * 1024;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function parseWorkerPresenceConfiguration(
  text: string,
): WorkerPresenceConfiguration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Worker presence configuration must be valid JSON');
  }

  const source = record(decoded, 'worker presence configuration');
  exactKeys(source, 'worker presence configuration', [
    'schemaVersion',
    'controlPlaneOrigin',
    'browsers',
    'environment',
  ]);
  if (source.schemaVersion !== 2) {
    throw new Error('Unsupported worker presence configuration schemaVersion');
  }

  const environment = record(source.environment, 'environment');
  exactKeys(environment, 'environment', ['id', 'sha256']);
  const environmentId = requiredString(environment.id, 'environment.id');
  const environmentSha256 = requiredString(
    environment.sha256,
    'environment.sha256',
  );
  if (!identifierPattern.test(environmentId)) {
    throw new Error('environment.id must be a contract identifier');
  }
  if (!sha256Pattern.test(environmentSha256)) {
    throw new Error('environment.sha256 must be a lowercase SHA-256 digest');
  }

  const controlPlaneOrigin = normalizeControlPlaneOrigin(
    source.controlPlaneOrigin,
  );
  if (
    !Array.isArray(source.browsers) ||
    source.browsers.length !== 1 ||
    source.browsers[0] !== 'chromium'
  ) {
    throw new Error('Native Worker presence requires only chromium');
  }
  return {
    schemaVersion: 2,
    controlPlaneOrigin,
    browsers: ['chromium'],
    environment: { id: environmentId, sha256: environmentSha256 },
  };
}

export async function readWorkerPresenceConfiguration(
  path: string,
): Promise<WorkerPresenceConfiguration> {
  const bytes = await readFile(path);
  if (bytes.length > maximumConfigurationBytes) {
    throw new Error('Worker presence configuration exceeds 64 KiB');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Worker presence configuration must be UTF-8');
  }

  return parseWorkerPresenceConfiguration(text);
}

export function normalizeControlPlaneOrigin(value: unknown): string {
  const configured = requiredString(value, 'controlPlaneOrigin');
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('controlPlaneOrigin must be an absolute HTTPS origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== configured.replace(/\/$/, '')
  ) {
    throw new Error('controlPlaneOrigin must be an absolute HTTPS origin');
  }

  return parsed.origin;
}
