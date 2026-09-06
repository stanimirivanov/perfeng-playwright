import { expect, test } from '@playwright/test';

import { parseCommand } from '../src/cli.js';
import { parseRunnerConfiguration } from '../src/configuration.js';

const valid = {
  schemaVersion: 1,
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
    warmupIterations: 1,
    measurementIterations: 2,
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
  expect(() => parseCommand(['run', '--output', 'results.json'])).toThrow(
    'Usage:',
  );
});
