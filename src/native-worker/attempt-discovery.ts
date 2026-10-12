import { exactKeys, record } from '../configuration/primitives.js';
import {
  parseNativeAttemptInspection,
  type NativeAttemptInspection,
} from './attempt-inspection.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import {
  contractTimestamp,
  enumMember,
  leaseUuid,
  patternString,
} from './contract-values.js';
import {
  discardResponse,
  readBoundedResponse,
  validateWorkerCredential,
} from './transport.js';

const availabilityValues = new Set([
  'UNREPORTED',
  'AVAILABLE',
  'DRAINING',
  'UNAVAILABLE',
] as const);
const runIdPattern = /^perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/;

/** Current worker capacity and stored intent, never acquisition history or authority. */
export type NativeAttemptDiscovery =
  | {
      state: 'NONE';
      serverTime: string;
      availability: 'UNREPORTED' | 'AVAILABLE' | 'DRAINING' | 'UNAVAILABLE';
    }
  | {
      state: 'FOUND';
      serverTime: string;
      availability: 'AVAILABLE' | 'DRAINING' | 'UNAVAILABLE';
      slotExpiresAt: string;
      attempt: Exclude<NativeAttemptInspection, { state: 'INACTIVE' }>;
    };

export interface NativeAttemptDiscoveryRequest {
  controlPlaneOrigin: string;
  token: string;
  signal?: AbortSignal;
}

/** Sends one bounded principal-scoped lookup without selectors, retries or lease material. */
export async function discoverNativeAttempt(
  request: NativeAttemptDiscoveryRequest,
  send: typeof fetch = fetch,
): Promise<NativeAttemptDiscovery> {
  validateWorkerCredential(request.token);
  const origin = normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const signal = AbortSignal.any([
    AbortSignal.timeout(5_000),
    ...(request.signal === undefined ? [] : [request.signal]),
  ]);
  assertDiscoveryActive(signal);
  let response: Response;
  try {
    response = await send(
      new URL('/native-worker/v2/attempts/discover', origin),
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${request.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocolVersion: 2 }),
      },
    );
  } catch {
    throw new Error('Native attempt discovery request failed');
  }
  if (response.status !== 200) {
    await discardResponse(response);
    throw new Error(
      `Native attempt discovery was rejected with status ${String(response.status)}`,
    );
  }
  if (
    response.headers.get('cache-control') !== 'no-store' ||
    response.headers.has('x-perfeng-lease')
  ) {
    await discardResponse(response);
    throw new Error(
      'Native attempt discovery returned unsafe response headers',
    );
  }
  let body: string;
  try {
    body = await readBoundedResponse(response);
  } catch {
    throw new Error(
      'Native attempt discovery response could not be read safely',
    );
  }
  assertDiscoveryActive(signal);
  return parseNativeAttemptDiscovery(body);
}

export function parseNativeAttemptDiscovery(
  text: string,
): NativeAttemptDiscovery {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Native attempt discovery must be valid JSON');
  }
  const source = record(decoded, 'native attempt discovery');
  const serverTime = contractTimestamp(source.serverTime, 'serverTime');
  timestampNanoseconds(serverTime);
  const availability = enumMember(
    source.availability,
    'availability',
    availabilityValues,
  );
  const common = ['state', 'serverTime', 'availability'];
  if (source.state === 'NONE') {
    exactKeys(source, 'native attempt discovery', common);
    return { state: 'NONE', serverTime, availability };
  }
  if (source.state !== 'FOUND' || availability === 'UNREPORTED') {
    throw new Error('Native attempt discovery state is invalid');
  }
  exactKeys(source, 'native attempt discovery', [
    ...common,
    'slotExpiresAt',
    'attempt',
  ]);
  const nested = record(source.attempt, 'attempt');
  const attempt = parseNativeAttemptInspection(
    JSON.stringify(nested),
    patternString(nested.runId, 'runId', runIdPattern),
    leaseUuid(nested.attemptId, 'attemptId'),
  );
  const slotExpiresAt = contractTimestamp(
    source.slotExpiresAt,
    'slotExpiresAt',
  );
  if (
    attempt.state === 'INACTIVE' ||
    timestampNanoseconds(attempt.serverTime) !==
      timestampNanoseconds(serverTime) ||
    timestampNanoseconds(slotExpiresAt) <= timestampNanoseconds(serverTime) ||
    (attempt.state === 'ACTIVE' &&
      timestampNanoseconds(attempt.expiresAt) !==
        timestampNanoseconds(slotExpiresAt)) ||
    (attempt.state === 'TERMINAL' &&
      timestampNanoseconds(attempt.acceptedAt) >
        timestampNanoseconds(serverTime))
  ) {
    throw new Error(
      'Native attempt discovery has inconsistent state or clocks',
    );
  }
  return { state: 'FOUND', serverTime, availability, slotExpiresAt, attempt };
}

// Server timestamps retain nanosecond precision; Date alone truncates lease fences.
export function timestampNanoseconds(value: string): bigint {
  const checked = contractTimestamp(value, 'server timestamp');
  const date = checked.slice(0, 10);
  if (
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    Number(checked.slice(11, 13)) > 23 ||
    Number(checked.slice(14, 16)) > 59
  ) {
    throw new Error(
      'Server timestamp contains an invalid calendar date or time',
    );
  }
  const fraction = /\.(\d{1,9})/.exec(checked)?.[1] ?? '';
  const whole = checked.replace(/\.\d{1,9}/, '');
  return (
    BigInt(Date.parse(whole)) * 1_000_000n + BigInt(fraction.padEnd(9, '0'))
  );
}

function assertDiscoveryActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Native attempt discovery was cancelled');
}
