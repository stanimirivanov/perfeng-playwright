#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { inspectSourceCheckout } from './source-checkout.js';
import { reportWorkerPresence } from './native-worker/client.js';
import { readWorkerPresenceConfiguration } from './native-worker/configuration.js';
import { createWorkerPresence } from './native-worker/presence.js';
import type { WorkerPresenceStatus } from './native-worker/types.js';

const credentialVariable = 'PERFENG_NATIVE_WORKER_TOKEN';
const usage = 'Usage: perfeng-playwright-worker presence --config FILE';

export interface WorkerCommand {
  configurationPath: string;
}

export function parseWorkerCommand(args: string[]): WorkerCommand {
  if (
    args.length !== 3 ||
    args[0] !== 'presence' ||
    args[1] !== '--config' ||
    args[2] === undefined ||
    args[2] === ''
  ) {
    throw new Error(usage);
  }

  return { configurationPath: args[2] };
}

export async function workerMain(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerPresenceStatus> {
  const command = parseWorkerCommand(args);
  const token = environment[credentialVariable];
  if (token === undefined || token === '') {
    throw new Error(`${credentialVariable} is required`);
  }
  const [configuration, source, agentVersion] = await Promise.all([
    readWorkerPresenceConfiguration(command.configurationPath),
    inspectSourceCheckout(),
    readAgentVersion(),
  ]);
  const presence = createWorkerPresence({
    configuration,
    source,
    agentVersion,
    platform: process.platform,
    architecture: process.arch,
  });

  return reportWorkerPresence({
    controlPlaneOrigin: configuration.controlPlaneOrigin,
    token,
    presence,
    signal: AbortSignal.timeout(15_000),
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
  workerMain(process.argv.slice(2))
    .then((status) => {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown native worker failure';
      process.stderr.write(`Native worker failed: ${message}\n`);
      process.exitCode = 1;
    });
}
