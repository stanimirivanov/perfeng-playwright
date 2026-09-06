import { expect, test } from '@playwright/test';

import { parseCommand } from '../src/cli.js';
import { parseRunnerConfiguration } from '../src/configuration.js';

const valid = {
  schemaVersion: 2,
  runId: 'perf-20260902-130000-a1b2c3d5',
  testId: 'search-browser',
  workload: {
    id: 'search-browser-smoke',
    version: '1.0.0',
    profile: 'smoke',
    sha256: 'd'.repeat(64),
  },
  scenario: {
    cacheProfile: 'warm',
    pageReuse: 'per-iteration',
    warmupIterations: 1,
    measurementIterations: 2,
  },
  diagnosticMode: 'baseline',
  environment: {
    profile: { id: 'windows-mainstream', version: '1.0.0' },
    fingerprint: 'f'.repeat(64),
  },
  target: { baseUrl: 'http://127.0.0.1:4173/' },
  browser: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  },
};

test('parses a closed explicit runner configuration', () => {
  expect(parseRunnerConfiguration(JSON.stringify(valid))).toEqual(valid);
});

test('rejects unknown configuration and unsafe target URL fields', () => {
  expect(() =>
    parseRunnerConfiguration(JSON.stringify({ ...valid, extra: true })),
  ).toThrow('missing or unknown fields');
  for (const baseUrl of [
    'file:///tmp/search.html',
    'https://user:secret@example.invalid/',
    'https://example.invalid/?token=secret',
    'https://example.invalid/#section',
  ]) {
    expect(() =>
      parseRunnerConfiguration(
        JSON.stringify({ ...valid, target: { baseUrl } }),
      ),
    ).toThrow('target.baseUrl');
  }
});

test('accepts supported diagnostics with explicit capture selections', () => {
  expect(
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'lightweight' }),
    ).diagnosticMode,
  ).toBe('lightweight');
  expect(
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        diagnosticMode: 'trace',
        diagnostics: { captureIterations: [2] },
      }),
    ).diagnostics,
  ).toEqual({ captureIterations: [2] });
  expect(
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        diagnosticMode: 'smoothness',
        diagnostics: { captureIterations: [1] },
      }),
    ).diagnostics,
  ).toEqual({ captureIterations: [1] });
  expect(
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        scenario: {
          ...valid.scenario,
          pageReuse: 'per-run',
          warmupIterations: 1,
          measurementIterations: 3,
        },
        diagnosticMode: 'memory',
        diagnostics: { captureIterations: [1, 2, 3] },
      }),
    ).diagnostics,
  ).toEqual({ captureIterations: [1, 2, 3] });
});

test('rejects unsupported and invalid diagnostic selections', () => {
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'unsupported' }),
    ),
  ).toThrow('Unsupported diagnostic mode');
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'trace' }),
    ),
  ).toThrow('requires diagnostics.captureIterations');
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'smoothness' }),
    ),
  ).toThrow('requires diagnostics.captureIterations');
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        diagnosticMode: 'smoothness',
        diagnostics: { captureIterations: [1, 2] },
      }),
    ),
  ).toThrow('must contain exactly one iteration');
  for (const captureIterations of [[], [1, 2], [0], [3]]) {
    expect(() =>
      parseRunnerConfiguration(
        JSON.stringify({
          ...valid,
          diagnosticMode: 'trace',
          diagnostics: { captureIterations },
        }),
      ),
    ).toThrow('diagnostics.captureIterations');
  }
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        diagnostics: { captureIterations: [1] },
      }),
    ),
  ).toThrow('only supported for trace, memory, and smoothness modes');
});

test('requires a repeated warm page lifecycle for memory diagnostics', () => {
  const memory = {
    ...valid,
    scenario: {
      ...valid.scenario,
      pageReuse: 'per-run',
      warmupIterations: 1,
      measurementIterations: 3,
    },
    diagnosticMode: 'memory',
    diagnostics: { captureIterations: [1, 2, 3] },
  };
  for (const captureIterations of [[], [1], [1, 3], [2, 1]]) {
    expect(() =>
      parseRunnerConfiguration(
        JSON.stringify({
          ...memory,
          diagnostics: { captureIterations },
        }),
      ),
    ).toThrow(/Memory diagnostics|consecutive/);
  }
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({
        ...memory,
        scenario: { ...memory.scenario, pageReuse: 'per-iteration' },
      }),
    ),
  ).toThrow('requires a warm cache profile and per-run page reuse');
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({
        ...memory,
        scenario: { ...memory.scenario, warmupIterations: 0 },
      }),
    ),
  ).toThrow('requires at least one warm-up iteration');
});

test('rejects an impossible page lifetime', () => {
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({
        ...valid,
        scenario: {
          ...valid.scenario,
          cacheProfile: 'cold',
          pageReuse: 'per-run',
        },
      }),
    ),
  ).toThrow('Cold cache profile requires per-iteration page reuse');
});

test('requires an unambiguous command line', () => {
  expect(
    parseCommand([
      'run',
      '--config',
      'configuration.json',
      '--output',
      'results/measurements.json',
    ]),
  ).toEqual({
    configurationPath: 'configuration.json',
    outputPath: 'results/measurements.json',
  });
  expect(
    parseCommand([
      'run',
      '--config',
      'configuration.json',
      '--output',
      'results/measurements.json',
      '--heap-snapshot-before-output',
      'results/before.heapsnapshot.gz',
      '--heap-snapshot-after-output',
      'results/after.heapsnapshot.gz',
    ]),
  ).toEqual({
    configurationPath: 'configuration.json',
    outputPath: 'results/measurements.json',
    heapSnapshotBeforeOutputPath: 'results/before.heapsnapshot.gz',
    heapSnapshotAfterOutputPath: 'results/after.heapsnapshot.gz',
  });
  expect(() =>
    parseCommand([
      'run',
      '--config',
      'configuration.json',
      '--output',
      'results/measurements.json',
      '--trace-output',
      'results/one.json.gz',
      '--trace-output',
      'results/two.json.gz',
    ]),
  ).toThrow('Duplicate command-line option');
  expect(
    parseCommand([
      'run',
      '--config',
      'configuration.json',
      '--output',
      'results/measurements.json',
      '--trace-output',
      'results/trace.json.gz',
    ]),
  ).toEqual({
    configurationPath: 'configuration.json',
    outputPath: 'results/measurements.json',
    traceOutputPath: 'results/trace.json.gz',
  });
  expect(
    parseCommand([
      'run',
      '--config',
      'configuration.json',
      '--output',
      'results/measurements.json',
      '--observations-output',
      'results/observations.json',
    ]),
  ).toEqual({
    configurationPath: 'configuration.json',
    outputPath: 'results/measurements.json',
    observationsOutputPath: 'results/observations.json',
  });
  expect(() => parseCommand(['run', '--output', 'results.json'])).toThrow(
    'Usage:',
  );
});
