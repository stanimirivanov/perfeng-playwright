#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readRunnerConfiguration } from './configuration/read.js';
import { writeMeasurementArtifact } from './journey/artifact.js';
import type { WrittenMeasurementArtifact } from './journey/types.js';
import { runSearchJourney } from './journeys/search.js';

interface Command {
  configurationPath: string;
  outputPath: string;
}

export function parseCommand(args: string[]): Command {
  const configurationPath = args[2];
  const outputPath = args[4];
  if (
    args.length !== 5 ||
    args[0] !== 'run' ||
    args[1] !== '--config' ||
    args[3] !== '--output' ||
    configurationPath === undefined ||
    configurationPath === '' ||
    outputPath === undefined ||
    outputPath === ''
  ) {
    throw new Error(
      'Usage: perfeng-playwright run --config FILE --output FILE',
    );
  }
  return { configurationPath, outputPath };
}

export async function main(
  args: string[],
): Promise<WrittenMeasurementArtifact> {
  const command = parseCommand(args);
  const configuration = await readRunnerConfiguration(
    command.configurationPath,
  );
  const payload = await runSearchJourney(configuration);
  return writeMeasurementArtifact(command.outputPath, payload);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main(process.argv.slice(2))
    .then((integrity) => {
      process.stdout.write(`${JSON.stringify(integrity)}\n`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unknown runner failure';
      process.stderr.write(`Playwright runner failed: ${message}\n`);
      process.exitCode = 1;
    });
}
