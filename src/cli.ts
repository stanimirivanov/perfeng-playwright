#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { readRunnerConfiguration } from './configuration/read.js';
import {
  writeJourneyArtifacts,
  type JourneyArtifactPaths,
} from './journey/artifact.js';
import type {
  DiagnosticMode,
  WrittenJourneyArtifacts,
} from './journey/types.js';
import { captureSearchJourney } from './journeys/search.js';

interface Command {
  configurationPath: string;
  outputPath: string;
  observationsOutputPath?: string;
  traceOutputPath?: string;
}

export function parseCommand(args: string[]): Command {
  const configurationPath = args[2];
  const outputPath = args[4];
  const hasDiagnosticOutput = args.length === 7;
  const diagnosticFlag = hasDiagnosticOutput ? args[5] : undefined;
  const diagnosticOutputPath = hasDiagnosticOutput ? args[6] : undefined;
  if (
    (args.length !== 5 && !hasDiagnosticOutput) ||
    args[0] !== 'run' ||
    args[1] !== '--config' ||
    args[3] !== '--output' ||
    (hasDiagnosticOutput &&
      diagnosticFlag !== '--observations-output' &&
      diagnosticFlag !== '--trace-output') ||
    configurationPath === undefined ||
    configurationPath === '' ||
    outputPath === undefined ||
    outputPath === '' ||
    (hasDiagnosticOutput &&
      (diagnosticOutputPath === undefined || diagnosticOutputPath === ''))
  ) {
    throw new Error(
      'Usage: perfeng-playwright run --config FILE --output FILE [--observations-output FILE | --trace-output FILE]',
    );
  }
  if (diagnosticOutputPath === undefined) {
    return { configurationPath, outputPath };
  }
  if (diagnosticFlag === '--observations-output') {
    return {
      configurationPath,
      outputPath,
      observationsOutputPath: diagnosticOutputPath,
    };
  }
  if (diagnosticFlag === '--trace-output') {
    return {
      configurationPath,
      outputPath,
      traceOutputPath: diagnosticOutputPath,
    };
  }
  return { configurationPath, outputPath };
}

function artifactPaths(
  command: Command,
  mode: DiagnosticMode,
): JourneyArtifactPaths {
  if (mode === 'lightweight') {
    if (command.observationsOutputPath === undefined) {
      throw new Error(
        'Lightweight diagnostics require --observations-output FILE',
      );
    }
    return {
      measurements: command.outputPath,
      observations: command.observationsOutputPath,
    };
  }
  if (mode === 'trace') {
    if (command.traceOutputPath === undefined) {
      throw new Error('Trace diagnostics require --trace-output FILE');
    }
    return {
      measurements: command.outputPath,
      trace: command.traceOutputPath,
    };
  }
  if (
    command.observationsOutputPath !== undefined ||
    command.traceOutputPath !== undefined
  ) {
    throw new Error('Diagnostic output requires a diagnostic mode');
  }
  return { measurements: command.outputPath };
}

export async function main(args: string[]): Promise<WrittenJourneyArtifacts> {
  const command = parseCommand(args);
  const configuration = await readRunnerConfiguration(
    command.configurationPath,
  );
  const paths = artifactPaths(command, configuration.diagnosticMode);
  const capture = await captureSearchJourney(configuration);
  return writeJourneyArtifacts(paths, capture);
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
