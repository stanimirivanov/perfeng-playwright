#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectSourceCheckout } from './source-checkout.js';
import {
  PresenceRequestFailure,
  reportWorkerPresence,
} from './native-worker/client.js';
import { readWorkerPresenceConfiguration } from './native-worker/configuration.js';
import { runPresenceHeartbeat } from './native-worker/heartbeat.js';
import { createWorkerPresence } from './native-worker/presence.js';
import {
  runNativeWorkerOnce,
  type NativeRunOnceResult,
} from './native-worker/run-once.js';
import {
  inspectNativeAttemptSpool,
  type NativeSpoolInspection,
} from './native-worker/spool-inspection.js';
import type {
  WorkerPresence,
  WorkerPresenceConfiguration,
  WorkerPresenceStatus,
} from './native-worker/types.js';

export type { NativeRunOnceResult } from './native-worker/run-once.js';

const credentialVariable = 'PERFENG_NATIVE_WORKER_TOKEN';
const runnerCheckoutRoot = dirname(
  fileURLToPath(new URL('../package.json', import.meta.url)),
);
const usage =
  'Usage: perfeng-playwright-worker <presence|heartbeat> --config FILE | spool-status --spool-root DIRECTORY | run-once --config FILE --spool-root DIRECTORY --timeout-ms INTEGER';

/** Parsed action and configuration path accepted by the Native Worker executable. */
export type WorkerCommand =
  | { action: 'presence' | 'heartbeat'; configurationPath: string }
  | { action: 'spool-status'; spoolRoot: string }
  | {
      action: 'run-once';
      configurationPath: string;
      spoolRoot: string;
      timeoutMilliseconds: number;
    };

/** Parses the Native Worker executable's presence, heartbeat or local spool inspection. */
export function parseWorkerCommand(args: string[]): WorkerCommand {
  if (
    args.length === 7 &&
    args[0] === 'run-once' &&
    args[1] === '--config' &&
    args[2] !== undefined &&
    args[2] !== '' &&
    args[3] === '--spool-root' &&
    args[4] !== undefined &&
    args[4] !== '' &&
    args[5] === '--timeout-ms' &&
    args[6] !== undefined &&
    args[6] !== ''
  ) {
    return {
      action: 'run-once',
      configurationPath: args[2],
      spoolRoot: args[4],
      timeoutMilliseconds: Number(args[6]),
    };
  }
  if (
    args.length === 3 &&
    args[0] === 'spool-status' &&
    args[1] === '--spool-root' &&
    args[2] !== undefined &&
    args[2] !== ''
  ) {
    return { action: 'spool-status', spoolRoot: args[2] };
  }
  if (
    args.length !== 3 ||
    (args[0] !== 'presence' && args[0] !== 'heartbeat') ||
    args[1] !== '--config' ||
    args[2] === undefined ||
    args[2] === ''
  ) {
    throw new Error(usage);
  }

  return { action: args[0], configurationPath: args[2] };
}

/** Reports presence, runs its heartbeat or inventories local retained attempt paths. */
export async function workerMain(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal = new AbortController().signal,
): Promise<
  WorkerPresenceStatus | NativeSpoolInspection | NativeRunOnceResult | undefined
> {
  const command = parseWorkerCommand(args);
  if (command.action === 'spool-status') {
    return inspectNativeAttemptSpool(command.spoolRoot);
  }
  const token = environment[credentialVariable];
  if (token === undefined || token === '') {
    throw new Error(`${credentialVariable} is required`);
  }
  const [configuration, agentVersion] = await Promise.all([
    readWorkerPresenceConfiguration(command.configurationPath),
    readAgentVersion(),
  ]);
  if (command.action === 'run-once') {
    return runNativeWorkerOnce({
      presence: await createWorkerPresenceFromCheckout(
        configuration,
        agentVersion,
      ),
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token,
      checkoutRoot: runnerCheckoutRoot,
      spoolRoot: command.spoolRoot,
      runnerEnvironment: Object.fromEntries(
        Object.entries(environment).filter(
          ([name]) => name.toUpperCase() !== credentialVariable,
        ),
      ),
      timeoutMilliseconds: command.timeoutMilliseconds,
      signal,
    });
  }
  const createPresence = (): Promise<WorkerPresence> =>
    createWorkerPresenceFromCheckout(configuration, agentVersion);
  const reportPresence = (
    presence: WorkerPresence,
    lifetime: AbortSignal,
  ): Promise<WorkerPresenceStatus> => {
    const requestSignal = AbortSignal.any([
      lifetime,
      AbortSignal.timeout(15_000),
    ]);

    return reportWorkerPresence({
      controlPlaneOrigin: configuration.controlPlaneOrigin,
      token,
      presence,
      signal: requestSignal,
    }).catch((error: unknown) => {
      if (
        !lifetime.aborted &&
        requestSignal.aborted &&
        error instanceof PresenceRequestFailure &&
        !error.retryable
      ) {
        throw new PresenceRequestFailure(error.message, true);
      }
      throw error;
    });
  };

  if (command.action === 'heartbeat') {
    await runPresenceHeartbeat({
      signal,
      createPresence,
      reportPresence,
      onStatus: (status) => {
        process.stdout.write(`${JSON.stringify(status)}\n`);
      },
      onRetry: (delayMilliseconds) => {
        process.stderr.write(
          `Native worker presence retry scheduled in ${String(delayMilliseconds)} ms.\n`,
        );
      },
    });

    return undefined;
  }

  return reportPresence(await createPresence(), signal);
}

async function createWorkerPresenceFromCheckout(
  configuration: WorkerPresenceConfiguration,
  agentVersion: string,
): Promise<ReturnType<typeof createWorkerPresence>> {
  const source = await inspectSourceCheckout();

  return createWorkerPresence({
    configuration,
    source,
    agentVersion,
    platform: process.platform,
    architecture: process.arch,
  });
}

async function readAgentVersion(): Promise<string> {
  const document = await readFile(new URL('../package.json', import.meta.url), {
    encoding: 'utf8',
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(document);
  } catch {
    throw new Error('Native worker package metadata is invalid');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('version' in decoded) ||
    typeof decoded.version !== 'string'
  ) {
    throw new Error('Native worker package metadata is invalid');
  }

  return decoded.version;
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const shutdown = new AbortController();
  const stop = (): void => {
    shutdown.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  workerMain(process.argv.slice(2), process.env, shutdown.signal)
    .then((status) => {
      if (status !== undefined) {
        process.stdout.write(`${JSON.stringify(status)}\n`);
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown native worker failure';
      process.stderr.write(`Native worker failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    });
}
