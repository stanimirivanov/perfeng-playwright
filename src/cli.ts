#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readRunnerConfiguration } from './configuration/read.js';
import { writeJourneyArtifacts } from './journey/artifact.js';
import type { WrittenJourneyArtifacts } from './journey/types.js';
import { captureSearchJourney } from './journeys/search.js';

interface Command {
  configurationPath: string;
  outputPath: string;
  observationsOutputPath?: string;
}

export function parseCommand(args: string[]): Command {
  const configurationPath = args[2];
  const outputPath = args[4];
  const hasObservationsOutput = args.length === 7;
  const observationsOutputPath = hasObservationsOutput ? args[6] : undefined;
  if (
    (args.length !== 5 && !hasObservationsOutput) ||
    args[0] !== 'run' ||
    args[1] !== '--config' ||
    args[3] !== '--output' ||
    (hasObservationsOutput && args[5] !== '--observations-output') ||
    configurationPath === undefined ||
    configurationPath === '' ||
    outputPath === undefined ||
    outputPath === '' ||
    (hasObservationsOutput &&
      (observationsOutputPath === undefined || observationsOutputPath === ''))
  ) {
    throw new Error(
      'Usage: perfeng-playwright run --config FILE --output FILE [--observations-output FILE]',
    );
  }
  return observationsOutputPath === undefined
    ? { configurationPath, outputPath }
    : { configurationPath, outputPath, observationsOutputPath };
}

export async function main(args: string[]): Promise<WrittenJourneyArtifacts> {
  const command = parseCommand(args);
  const configuration = await readRunnerConfiguration(
    command.configurationPath,
  );
  if (
    configuration.diagnosticMode === 'lightweight' &&
    command.observationsOutputPath === undefined
  ) {
    throw new Error(
      'Lightweight diagnostics require --observations-output FILE',
    );
  }
  if (
    configuration.diagnosticMode === 'baseline' &&
    command.observationsOutputPath !== undefined
  ) {
    throw new Error(
      '--observations-output requires lightweight diagnostic mode',
    );
  }
  const capture = await captureSearchJourney(configuration);
  return writeJourneyArtifacts(
    command.observationsOutputPath === undefined
      ? { measurements: command.outputPath }
      : {
          measurements: command.outputPath,
          observations: command.observationsOutputPath,
        },
    capture,
  );
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
