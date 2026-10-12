import {
  discoverNativeAttempt,
  timestampNanoseconds,
  type NativeAttemptDiscovery,
  type NativeAttemptDiscoveryRequest,
} from './attempt-discovery.js';
import {
  inspectNativeAttempt,
  type NativeAttemptInspectionRequest,
  type NativeAttemptInspectionResult,
} from './attempt-inspection.js';
import { reportWorkerPresence, type PresenceRequest } from './client.js';
import { normalizeControlPlaneOrigin } from './configuration.js';
import { claimRecoverySpool } from './recovery-spool.js';
import {
  verifyRetainedAttemptMeasurements,
  type RetainedAttemptIntegrity,
} from './retained-attempt.js';
import { validateWorkerCredential } from './transport.js';
import type { WorkerPresence, WorkerPresenceStatus } from './types.js';

export interface ManualRecoveryRequest {
  controlPlaneOrigin: string;
  token: string;
  presence: WorkerPresence;
  spoolRoot: string;
  archiveRoot: string;
  checkoutRoot: string;
  processesStopped: boolean;
  signal: AbortSignal;
}

export interface ManualRecoveryPorts {
  reportPresence: (request: PresenceRequest) => Promise<WorkerPresenceStatus>;
  discover: (
    request: NativeAttemptDiscoveryRequest,
  ) => Promise<NativeAttemptDiscovery>;
  inspect: (
    request: NativeAttemptInspectionRequest,
  ) => Promise<NativeAttemptInspectionResult>;
}

/** Local integrity and independent server observations; unknown evidence remains preserved. */
export interface RetainedRecoveryObservation {
  name: string;
  server: NativeAttemptInspectionResult;
  measurements:
    | { kind: 'verified'; integrity: RetainedAttemptIntegrity }
    | { kind: 'unverified' };
}

/** A blocked observation or preserved archive; neither grants execution or deletion authority. */
export type ManualRecoveryResult =
  | {
      kind: 'BLOCKED';
      reason: 'CURRENT_SLOT' | 'ACTIVE_RETAINED_ATTEMPT';
      discovery: NativeAttemptDiscovery;
    }
  | {
      kind: 'ARCHIVED';
      archiveDirectory: string;
      workerId: string;
      discovery: Extract<NativeAttemptDiscovery, { state: 'NONE' }>;
      retained: readonly RetainedRecoveryObservation[];
    };

const defaultPorts: ManualRecoveryPorts = {
  reportPresence: reportWorkerPresence,
  discover: discoverNativeAttempt,
  inspect: inspectNativeAttempt,
};

/**
 * Withdraws availability and reconciles current capacity before moving the complete
 * spool to an exclusive archive. The operator must stop and exclude every process
 * using the identity. No lease is recovered, artifact deleted or work acquired.
 * Failures retain the owner and evidence; retries require another explicit invocation.
 */
export async function recoverNativeWorkerManually(
  request: ManualRecoveryRequest,
  ports: ManualRecoveryPorts = defaultPorts,
): Promise<ManualRecoveryResult> {
  const processesStopped: unknown = request.processesStopped;
  if (processesStopped !== true)
    throw new Error(
      'Manual recovery requires confirmation that all worker/browser processes are stopped',
    );
  validateWorkerCredential(request.token);
  normalizeControlPlaneOrigin(request.controlPlaneOrigin);
  const protocolVersion: unknown = request.presence.protocolVersion;
  if (protocolVersion !== 2 || request.presence.availability !== 'UNAVAILABLE')
    throw new Error('Manual recovery requires unavailable v2 presence');
  assertNotCancelled(request.signal);
  const spool = await claimRecoverySpool(
    request.spoolRoot,
    request.archiveRoot,
    request.checkoutRoot,
  );
  let result: ManualRecoveryResult | undefined;
  let failure: unknown;
  try {
    result = await reconcile(request, ports, spool);
  } catch (error) {
    failure = new Error(
      'Native manual recovery failed; retain the spool and inspect server state before retrying',
      { cause: error },
    );
  }
  try {
    await spool.release();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError(
            [failure, error],
            'Native recovery and ownership cleanup failed',
          );
  }
  if (failure !== undefined)
    throw failure instanceof Error
      ? failure
      : new Error('Native recovery failed with an unknown error', {
          cause: failure,
        });
  if (result === undefined)
    throw new Error('Native recovery produced no result');
  return result;
}

async function reconcile(
  request: ManualRecoveryRequest,
  ports: ManualRecoveryPorts,
  spool: Awaited<ReturnType<typeof claimRecoverySpool>>,
): Promise<ManualRecoveryResult> {
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(120_000),
  ]);
  const connection = {
    controlPlaneOrigin: request.controlPlaneOrigin,
    token: request.token,
    signal,
  };
  const withdrawn = await ports.reportPresence({
    ...connection,
    presence: request.presence,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (withdrawn.availability !== 'UNAVAILABLE')
    throw new Error('Native recovery withdrawal was not acknowledged');
  const discover = async (): Promise<NativeAttemptDiscovery> => {
    assertNotCancelled(signal);
    const discovery = await ports.discover(connection);
    if (
      discovery.availability !== 'UNAVAILABLE' ||
      timestampNanoseconds(discovery.serverTime) <
        timestampNanoseconds(withdrawn.serverTime)
    )
      throw new Error(
        'Native recovery discovery does not confirm the withdrawal fence',
      );
    return discovery;
  };
  let discovery = await discover();
  if (discovery.state === 'FOUND')
    return { kind: 'BLOCKED', reason: 'CURRENT_SLOT', discovery };
  const retained: RetainedRecoveryObservation[] = [];
  for (const attempt of spool.attempts) {
    assertNotCancelled(signal);
    const server = await ports.inspect({
      ...connection,
      runId: attempt.runId,
      attemptId: attempt.attemptId,
    });
    if (server.kind === 'found' && server.inspection.state === 'ACTIVE')
      return { kind: 'BLOCKED', reason: 'ACTIVE_RETAINED_ATTEMPT', discovery };
    let measurements: RetainedRecoveryObservation['measurements'];
    try {
      measurements = {
        kind: 'verified',
        integrity: await verifyRetainedAttemptMeasurements(
          request.spoolRoot,
          attempt.name,
        ),
      };
    } catch {
      measurements = { kind: 'unverified' };
    }
    retained.push({ name: attempt.name, server, measurements });
  }
  discovery = await discover();
  if (discovery.state === 'FOUND')
    return { kind: 'BLOCKED', reason: 'CURRENT_SLOT', discovery };
  assertNotCancelled(signal);
  const record = {
    schema: 'native-manual-recovery/v1',
    workerId: withdrawn.workerId,
    discovery,
    retained,
    evidenceDisposition: 'preserved-without-resuming',
    freshSpoolRequired: true,
  };
  const archiveDirectory = await spool.archive(record, signal);
  // The old owner marker is archived, not cleared; provision a new spool separately.
  return {
    kind: 'ARCHIVED',
    archiveDirectory,
    workerId: withdrawn.workerId,
    discovery,
    retained,
  };
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Native manual recovery was cancelled');
}
