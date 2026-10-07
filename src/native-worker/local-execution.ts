import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  prepareNativeAttempt,
  type PreparedNativeAttempt,
} from './attempt-preparation.js';
import { AcquiredNativeV2Lease } from './acquisition.js';
import {
  loadNativeV2Measurements,
  type ParsedNativeAttemptArtifacts,
} from './local-artifacts.js';
import {
  NativeRunnerProcessFailure,
  runNativeRunnerProcess,
  validateNativeRunnerTimeout,
} from './runner-process.js';
import {
  inspectSourceCheckout,
  type SourceCheckoutArtifact,
} from '../source-checkout.js';

export interface NativeLocalExecutionRequest {
  authority: AcquiredNativeV2Lease;
  checkoutRoot: string;
  spoolRoot: string;
  runnerEnvironment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMilliseconds: number;
  /** Called after preparation, immediately before the runner is launched. */
  onPrepared?: () => void;
  /** Called after a successful runner exit, before artifact validation. */
  onRunnerCompleted?: () => void;
}

export interface NativeLocalExecutionResult extends ParsedNativeAttemptArtifacts {
  prepared: PreparedNativeAttempt;
}

/**
 * Prepares, supervises and validates one local v2 baseline attempt. It does not
 * acquire/renew authority, upload evidence, report a terminal state or clean up
 * retained attempt files. The caller must provide a reviewed runner environment.
 */
export async function executeNativeLocalAttempt(
  request: NativeLocalExecutionRequest,
  inspectCheckout: () => Promise<SourceCheckoutArtifact> = () =>
    inspectSourceCheckout(request.checkoutRoot),
): Promise<NativeLocalExecutionResult> {
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('Local execution requires acquired v2 authority');
  }
  validateNativeRunnerTimeout(request.timeoutMilliseconds);
  rejectWorkerCredential(request.runnerEnvironment);
  assertNotCancelled(request.signal);
  const entrypoint = await validateRunnerEntrypoint(request.checkoutRoot);
  assertNotCancelled(request.signal);

  const prepared = await prepareNativeAttempt(
    { authority: request.authority, spoolRoot: request.spoolRoot },
    inspectCheckout,
  );
  assertNotCancelled(request.signal);
  request.onPrepared?.();
  await runNativeRunnerProcess({
    executable: process.execPath,
    arguments: [entrypoint, ...prepared.runnerArguments],
    workingDirectory: request.checkoutRoot,
    environment: { ...request.runnerEnvironment },
    signal: request.signal,
    timeoutMilliseconds: request.timeoutMilliseconds,
  });
  assertNotCancelled(request.signal);
  request.onRunnerCompleted?.();
  const loaded = await loadNativeV2Measurements(request.authority, prepared);
  assertNotCancelled(request.signal);
  return { prepared, ...loaded };
}

function rejectWorkerCredential(environment: NodeJS.ProcessEnv): void {
  if (
    Object.keys(environment).some(
      (name) => name.toUpperCase() === 'PERFENG_NATIVE_WORKER_TOKEN',
    )
  ) {
    throw new Error('Runner environment must not include the worker token');
  }
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new NativeRunnerProcessFailure('cancelled');
  }
}

/** Requires the built runner entry point to be a regular file in a real checkout. */
export async function validateRunnerEntrypoint(
  checkoutRoot: string,
): Promise<string> {
  if (!isAbsolute(checkoutRoot)) {
    throw new Error('Native runner checkout root must be absolute');
  }
  const dist = join(checkoutRoot, 'dist');
  const entrypoint = join(dist, 'cli.js');
  const [rootMetadata, distMetadata, entrypointMetadata] = await Promise.all([
    lstat(checkoutRoot),
    lstat(dist),
    lstat(entrypoint),
  ]);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    !distMetadata.isDirectory() ||
    distMetadata.isSymbolicLink() ||
    !entrypointMetadata.isFile() ||
    entrypointMetadata.isSymbolicLink()
  ) {
    throw new Error('Native runner entry point must be a regular local file');
  }
  return entrypoint;
}
