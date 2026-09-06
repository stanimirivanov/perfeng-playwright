import { exactKeys, record, requiredString } from './primitives.js';
import { parseDiagnostics } from './diagnostics.js';
import {
  parseBrowser,
  parseDiagnosticMode,
  parseEnvironment,
  parseScenario,
  parseTarget,
  parseWorkload,
} from './sections.js';
import type { RunnerConfiguration } from './types.js';

export function parseRunnerConfiguration(text: string): RunnerConfiguration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Runner configuration must be valid JSON');
  }
  const source = record(decoded, 'configuration');
  const keys = [
    'schemaVersion',
    'runId',
    'testId',
    'workload',
    'scenario',
    'diagnosticMode',
    'environment',
    'target',
    'browser',
  ];
  if (source.diagnostics !== undefined) {
    keys.push('diagnostics');
  }
  exactKeys(source, 'configuration', keys);
  if (source.schemaVersion !== 2) {
    throw new Error('Unsupported runner configuration schemaVersion');
  }
  const scenario = parseScenario(source.scenario);
  const diagnosticMode = parseDiagnosticMode(source.diagnosticMode);
  const diagnostics = parseDiagnostics(
    source.diagnostics,
    diagnosticMode,
    scenario.measurementIterations,
  );
  const configuration: RunnerConfiguration = {
    schemaVersion: 2,
    runId: requiredString(source.runId, 'runId'),
    testId: requiredString(source.testId, 'testId'),
    workload: parseWorkload(source.workload),
    scenario,
    diagnosticMode,
    environment: parseEnvironment(source.environment),
    target: parseTarget(source.target),
    browser: parseBrowser(source.browser),
  };
  if (diagnostics !== undefined) {
    configuration.diagnostics = diagnostics;
  }
  return configuration;
}
