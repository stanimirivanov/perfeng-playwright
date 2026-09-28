import { integer, requiredString } from '../configuration/primitives.js';

const identifierPattern = /^[a-z][a-z0-9-]{1,62}$/;
const artifactFormatPattern = /^[a-z0-9][a-z0-9._/-]*$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function contractIdentifier(value: unknown, name: string): string {
  return patternString(value, name, identifierPattern);
}

export function contractArtifactFormat(value: unknown, name: string): string {
  return patternString(value, name, artifactFormatPattern);
}

export function contractSha256(value: unknown, name: string): string {
  return patternString(value, name, sha256Pattern);
}

export function leaseUuid(value: unknown, name: string): string {
  return patternString(value, name, uuidPattern);
}

export function contractTimestamp(value: unknown, name: string): string {
  const result = patternString(value, name, timestampPattern);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${name} must be an RFC 3339 timestamp`);
  }
  return result;
}

export function patternString(
  value: unknown,
  name: string,
  pattern: RegExp,
): string {
  const result = requiredString(value, name);
  if (!pattern.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

export function boundedInteger(
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

export function enumMember<T extends string>(
  value: unknown,
  name: string,
  allowed: ReadonlySet<T>,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

export function absoluteHttpsUrl(
  value: unknown,
  name: string,
  excludeQueryAndFragment = false,
): string {
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
    (excludeQueryAndFragment && (parsed.search !== '' || parsed.hash !== ''))
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  return result;
}
