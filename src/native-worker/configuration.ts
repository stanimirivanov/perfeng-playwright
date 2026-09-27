import { readFile } from 'node:fs/promises';

import {
  exactKeys,
  record,
  requiredString,
} from '../configuration/primitives.js';
import type { BrowserFamily, WorkerPresenceConfiguration } from './types.js';

const maximumConfigurationBytes = 64 * 1024;
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const supportedBrowsers = new Set<BrowserFamily>([
  'chromium',
  'chrome',
  'edge',
]);

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
  if (source.schemaVersion !== 1) {
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

  return {
    schemaVersion: 1,
    controlPlaneOrigin: normalizeControlPlaneOrigin(source.controlPlaneOrigin),
    browsers: parseBrowsers(source.browsers),
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

function parseBrowsers(value: unknown): BrowserFamily[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error('browsers must contain one through four browser families');
  }
  const browsers: BrowserFamily[] = [];
  const seen = new Set<string>();
  for (const browser of value) {
    if (
      typeof browser !== 'string' ||
      !supportedBrowsers.has(browser as BrowserFamily) ||
      seen.has(browser)
    ) {
      throw new Error('browsers contains an unsupported or duplicate family');
    }
    seen.add(browser);
    browsers.push(browser as BrowserFamily);
  }

  return browsers;
}
