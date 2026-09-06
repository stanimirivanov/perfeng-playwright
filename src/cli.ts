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
  receiptOutputPath: string;
  observationsOutputPath?: string;
  traceOutputPath?: string;
  heapSnapshotBeforeOutputPath?: string;
  heapSnapshotAfterOutputPath?: string;
}

const usage =
  'Usage: perfeng-playwright run --config FILE --output FILE --receipt-output FILE [--observations-output FILE | --trace-output FILE | --heap-snapshot-before-output FILE --heap-snapshot-after-output FILE]';

export function parseCommand(args: string[]): Command {
  const configurationPath = args[2];
  const outputPath = args[4];
  if (
    args.length < 5 ||
    (args.length - 5) % 2 !== 0 ||
    args[0] !== 'run' ||
    args[1] !== '--config' ||
    args[3] !== '--output' ||
    configurationPath === undefined ||
    configurationPath === '' ||
    outputPath === undefined ||
    outputPath === ''
  ) {
    throw new Error(usage);
  }
  const command: Partial<Command> = { configurationPath, outputPath };
  const assigned = new Set<string>();
  for (let index = 5; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || value === '') {
      throw new Error(usage);
    }
    if (assigned.has(flag)) {
      throw new Error(`Duplicate command-line option: ${flag}`);
    }
    assigned.add(flag);
    if (flag === '--receipt-output') {
      command.receiptOutputPath = value;
    } else if (flag === '--observations-output') {
      command.observationsOutputPath = value;
    } else if (flag === '--trace-output') {
      command.traceOutputPath = value;
    } else if (flag === '--heap-snapshot-before-output') {
      command.heapSnapshotBeforeOutputPath = value;
    } else if (flag === '--heap-snapshot-after-output') {
      command.heapSnapshotAfterOutputPath = value;
    } else {
      throw new Error(usage);
    }
  }
  if (command.receiptOutputPath === undefined) {
    throw new Error(usage);
  }
  return command as Command;
}

function artifactPaths(
  command: Command,
  mode: DiagnosticMode,
): JourneyArtifactPaths {
  if (mode === 'lightweight') {
    if (
      command.observationsOutputPath === undefined ||
      command.traceOutputPath !== undefined ||
      command.heapSnapshotBeforeOutputPath !== undefined ||
      command.heapSnapshotAfterOutputPath !== undefined
    ) {
      throw new Error(
        'Lightweight diagnostics require --observations-output FILE',
      );
    }
    return {
      measurements: command.outputPath,
      receipt: command.receiptOutputPath,
      observations: command.observationsOutputPath,
    };
  }
  if (mode === 'trace' || mode === 'smoothness') {
    if (
      command.traceOutputPath === undefined ||
      command.observationsOutputPath !== undefined ||
      command.heapSnapshotBeforeOutputPath !== undefined ||
      command.heapSnapshotAfterOutputPath !== undefined
    ) {
      throw new Error(
        `${mode === 'trace' ? 'Trace' : 'Smoothness'} diagnostics require --trace-output FILE`,
      );
    }
    return {
      measurements: command.outputPath,
      receipt: command.receiptOutputPath,
      trace: command.traceOutputPath,
    };
  }
  if (mode === 'memory') {
    if (
      command.heapSnapshotBeforeOutputPath === undefined ||
      command.heapSnapshotAfterOutputPath === undefined ||
      command.observationsOutputPath !== undefined ||
      command.traceOutputPath !== undefined
    ) {
      throw new Error(
        'Memory diagnostics require --heap-snapshot-before-output FILE and --heap-snapshot-after-output FILE',
      );
    }
    return {
      measurements: command.outputPath,
      receipt: command.receiptOutputPath,
      memory: {
        before: command.heapSnapshotBeforeOutputPath,
        after: command.heapSnapshotAfterOutputPath,
      },
    };
  }
  if (
    command.observationsOutputPath !== undefined ||
    command.traceOutputPath !== undefined ||
    command.heapSnapshotBeforeOutputPath !== undefined ||
    command.heapSnapshotAfterOutputPath !== undefined
  ) {
    throw new Error('Diagnostic output requires a diagnostic mode');
  }
  return {
    measurements: command.outputPath,
    receipt: command.receiptOutputPath,
  };
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
