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

test('accepts lightweight and explicitly selected trace capture', () => {
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
});

test('rejects unsupported and invalid diagnostic selections', () => {
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'memory' }),
    ),
  ).toThrow('Unsupported diagnostic mode');
  expect(() =>
    parseRunnerConfiguration(
      JSON.stringify({ ...valid, diagnosticMode: 'trace' }),
    ),
  ).toThrow('requires diagnostics.captureIterations');
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
  ).toThrow('only supported for trace mode');
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
