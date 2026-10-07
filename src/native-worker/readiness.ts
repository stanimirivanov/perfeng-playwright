import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import {
  inspectSourceCheckout,
  type SourceCheckoutArtifact,
} from '../source-checkout.js';
import { validateRunnerEntrypoint } from './local-execution.js';
import type { WorkerPresence } from './types.js';

export interface NativeRunnerReadinessRequest {
  checkoutRoot: string;
  spoolRoot: string;
  presence: WorkerPresence;
}

/**
 * Checks local execution inputs before the worker advertises availability.
 * Execution still rechecks checkout and artifact state under the acquired lease.
 */
export async function validateNativeRunnerReadiness(
  request: NativeRunnerReadinessRequest,
  inspectCheckout: (
    root: string,
  ) => Promise<SourceCheckoutArtifact> = inspectSourceCheckout,
): Promise<void> {
  if (!isAbsolute(request.checkoutRoot) || !isAbsolute(request.spoolRoot)) {
    throw new Error('Native runner checkout and spool roots must be absolute');
  }
  await validateRunnerEntrypoint(request.checkoutRoot);
  const [checkout, spool] = await Promise.all([
    realpath(request.checkoutRoot),
    realpath(request.spoolRoot),
  ]);
  const pathWithinCheckout = relative(checkout, spool);
  if (
    pathWithinCheckout === '' ||
    (pathWithinCheckout !== '..' &&
      !pathWithinCheckout.startsWith(`..${sep}`) &&
      !isAbsolute(pathWithinCheckout))
  ) {
    throw new Error('Native attempt spool must be outside the runner checkout');
  }
  const source = await inspectCheckout(checkout);
  const runner = request.presence.qualificationEvidence.runner;
  if (
    runner.repository !== source.repository ||
    runner.revision !== source.gitSha ||
    runner.lockfileSha256 !== source.dependencyLock.sha256
  ) {
    throw new Error(
      'Native runner checkout no longer matches advertised evidence',
    );
  }
}
