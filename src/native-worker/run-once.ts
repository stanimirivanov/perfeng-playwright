import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  acquireNativeV2Lease,
  type NativeV2LeaseAcquisitionRequest,
} from './acquisition.js';
import { reportWorkerPresence, type PresenceRequest } from './client.js';
import {
  coordinateNativeV2Attempt,
  type NativeV2AttemptRequest,
  type NativeV2AttemptOutcome,
} from './attempt-coordination.js';
import { validateNativeRunnerTimeout } from './runner-process.js';
import type { WorkerPresence, WorkerPresenceStatus } from './types.js';

const ownerFileName = '.native-worker-owner';
const presenceTimeoutMilliseconds = 15_000;

export interface NativeRunOnceRequest {
  presence: WorkerPresence;
  controlPlaneOrigin: string;
  token: string;
  checkoutRoot: string;
  spoolRoot: string;
  runnerEnvironment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
  signal: AbortSignal;
}

export interface NativeRunOncePorts {
  reportPresence: (request: PresenceRequest) => Promise<WorkerPresenceStatus>;
  acquireLease: (
    request: NativeV2LeaseAcquisitionRequest,
  ) => ReturnType<typeof acquireNativeV2Lease>;
  coordinateAttempt: (
    request: NativeV2AttemptRequest,
  ) => Promise<NativeV2AttemptOutcome>;
}

/** The single acquisition window's idle or acknowledged terminal outcome. */
export type NativeRunOnceResult =
  | { kind: 'IDLE' }
  | {
      kind: 'COMPLETED' | 'FAILED';
      runId: string;
      attemptId: string;
      runRevision: number;
    };

const defaultPorts: NativeRunOncePorts = {
  reportPresence: reportWorkerPresence,
  acquireLease: acquireNativeV2Lease,
  coordinateAttempt: coordinateNativeV2Attempt,
};

/**
 * Offers one qualified v2 acquisition window, then coordinates at most one
 * attempt. Uncertain authority or terminal state leaves the local owner marker
 * for explicit operator reconciliation; no retained evidence is removed.
 */
export async function runNativeWorkerOnce(
  request: NativeRunOnceRequest,
  ports: NativeRunOncePorts = defaultPorts,
): Promise<NativeRunOnceResult> {
  validateNativeRunnerTimeout(request.timeoutMilliseconds);
  if (request.presence.availability !== 'UNAVAILABLE') {
    throw new Error('Native run-once requires unavailable initial presence');
  }
  if (
    Object.keys(request.runnerEnvironment).some(
      (name) => name.toUpperCase() === 'PERFENG_NATIVE_WORKER_TOKEN',
    )
  ) {
    throw new Error('Runner environment must not include the worker token');
  }
  assertNotCancelled(request.signal, 'startup');
  const owner = await claimEmptySpool(request.spoolRoot);
  let offered = false;
  let withdrawn = false;
  let acquisitionAttempted = false;
  let safeToRelease: boolean;
  let result: NativeRunOnceResult | undefined;
  let failure: unknown;
  const report = (
    availability: 'AVAILABLE' | 'UNAVAILABLE',
    signal: AbortSignal,
  ): Promise<WorkerPresenceStatus> =>
    ports.reportPresence({
      controlPlaneOrigin: request.controlPlaneOrigin,
      token: request.token,
      presence: { ...request.presence, availability },
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(presenceTimeoutMilliseconds),
      ]),
    });
  const withdraw = async (): Promise<void> => {
    const status = await report(
      'UNAVAILABLE',
      AbortSignal.timeout(presenceTimeoutMilliseconds),
    );
    if (status.availability !== 'UNAVAILABLE') {
      throw new Error('Native worker availability withdrawal was not accepted');
    }
  };

  try {
    const initial = await report('UNAVAILABLE', request.signal);
    if (!qualified(initial, 'UNAVAILABLE')) {
      throw new Error(
        'Native worker is not qualified and authorized to acquire',
      );
    }
    assertNotCancelled(request.signal, 'acquisition');

    offered = true;
    const ready = await report('AVAILABLE', request.signal);
    if (!qualified(ready, 'AVAILABLE')) {
      throw new Error('Native worker availability was not accepted');
    }
    assertNotCancelled(request.signal, 'acquisition');

    acquisitionAttempted = true;
    const acquisition = await ports.acquireLease({
      controlPlaneOrigin: request.controlPlaneOrigin,
      token: request.token,
      maxWaitSeconds: 0,
      currentEvidence: request.presence.qualificationEvidence,
      signal: request.signal,
    });
    await withdraw();
    withdrawn = true;

    if (acquisition.kind === 'idle') {
      acquisitionAttempted = false;
      result = { kind: 'IDLE' };
    } else {
      assertNotCancelled(request.signal, 'execution');
      const outcome = await ports.coordinateAttempt({
        controlPlaneOrigin: request.controlPlaneOrigin,
        token: request.token,
        authority: acquisition.authority,
        checkoutRoot: request.checkoutRoot,
        spoolRoot: request.spoolRoot,
        runnerEnvironment: request.runnerEnvironment,
        timeoutMilliseconds: request.timeoutMilliseconds,
        signal: request.signal,
      });
      result = {
        kind: outcome.kind,
        runId: acquisition.authority.recipe.runId,
        attemptId: acquisition.authority.recipe.attemptId,
        runRevision: outcome.acknowledgement.runRevision,
      };
    }
    safeToRelease = true;
  } catch (error) {
    failure = error;
    safeToRelease = !acquisitionAttempted;
  }

  if (offered && !withdrawn) {
    try {
      await withdraw();
      withdrawn = true;
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              'Native run-once failed and availability withdrawal failed',
            );
    }
  }
  if (safeToRelease && (!offered || withdrawn)) {
    try {
      await owner.release();
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              'Native run-once failed and local ownership release failed',
            );
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error('Native run-once failed with an unknown error', {
          cause: failure,
        });
  }
  if (result === undefined) {
    throw new Error('Native run-once produced no outcome');
  }
  return result;
}

function qualified(
  status: WorkerPresenceStatus,
  availability: 'AVAILABLE' | 'UNAVAILABLE',
): boolean {
  return (
    status.availability === availability &&
    status.qualification.status === 'QUALIFIED' &&
    status.authorizedToAcquire
  );
}

function assertNotCancelled(signal: AbortSignal, stage: string): void {
  if (signal.aborted) {
    throw new Error(`Native run-once was cancelled before ${stage}`);
  }
}

interface SpoolOwner {
  release: () => Promise<void>;
}

async function claimEmptySpool(spoolRoot: string): Promise<SpoolOwner> {
  if (!isAbsolute(spoolRoot)) {
    throw new Error('Native attempt spool root must be absolute');
  }
  const metadata = await lstat(spoolRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Native attempt spool root must be a real directory');
  }
  const root = await realpath(spoolRoot);
  const path = join(root, ownerFileName);
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      throw new Error('Native attempt spool already has an owner marker', {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await handle.writeFile(nonce);
  } finally {
    await handle.close();
  }
  const owner: SpoolOwner = {
    release: async () => {
      const current = await lstat(path);
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error('Native attempt spool owner marker changed');
      }
      if ((await readFile(path, 'utf8')) !== nonce) {
        throw new Error('Native attempt spool owner marker changed');
      }
      await unlink(path);
    },
  };
  try {
    const entries = await readdir(root);
    if (entries.length !== 1 || entries[0] !== ownerFileName) {
      throw new Error(
        'Native attempt spool has retained state; inspect it before acquisition',
      );
    }
  } catch (error) {
    await owner.release();
    throw error;
  }
  return owner;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
