import { readFile } from 'node:fs/promises';

import { AcquiredNativeV2Lease } from '../src/native-worker/acquisition-v2.js';
import {
  parseNativeExecutionRecipe,
  type NativeWorkerQualificationEvidence,
} from '../src/native-worker/execution-recipe.js';
import type { NativeRawResultRequest } from '../src/native-worker/raw-result.js';
import type { NativeArtifactReference } from '../src/native-worker/types.js';
import type { PlaywrightMeasurements } from '../src/journey/types.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const capability = 'example-not-a-real-lease-capability-0001';

export async function nativeV2RawResultRequest(): Promise<
  NativeRawResultRequest & { authority: AcquiredNativeV2Lease }
> {
  const [lease, presenceText, artifactText] = await Promise.all([
    readFile(`${fixtureRoot}/lease.json`, 'utf8'),
    readFile(`${fixtureRoot}/presence.json`, 'utf8'),
    readFile(`${fixtureRoot}/artifact.json`, 'utf8'),
  ]);
  const presence = JSON.parse(presenceText) as {
    qualificationEvidence: NativeWorkerQualificationEvidence;
  };
  const authority = new AcquiredNativeV2Lease(
    parseNativeExecutionRecipe(lease, presence.qualificationEvidence),
    capability,
  );
  const configuration = authority.recipe.configuration;
  const measurements: PlaywrightMeasurements = {
    schemaVersion: 2,
    kind: 'PlaywrightMeasurements',
    runId: configuration.runId,
    testId: configuration.testId,
    workload: { ...configuration.workload },
    scenario: {
      ...configuration.scenario,
      contextReuse: 'per-iteration',
    },
    diagnosticMode: configuration.diagnosticMode,
    environment: {
      profile: { ...configuration.environment.profile },
      fingerprint: configuration.environment.fingerprint,
    },
    runtime: {
      playwrightVersion: '1.62.1',
      nodeVersion: '24.13.0',
      platform: 'win32',
      architecture: 'x64',
    },
    browser: {
      name: 'chromium',
      version: '140.0.7339.16',
      ...configuration.browser,
      viewport: { ...configuration.browser.viewport },
    },
    measurementWindow: {
      start: '2026-09-18T12:00:20Z',
      end: '2026-09-18T12:01:00Z',
    },
    createdAt: '2026-09-18T12:01:01Z',
    measurements: [
      { iteration: 1, name: 'ui.search.action_to_visible_ms', durationMs: 24 },
    ],
  };
  return {
    authority,
    measurements,
    registeredArtifacts: [JSON.parse(artifactText) as NativeArtifactReference],
    createdAt: '2026-09-18T12:01:20Z',
  };
}
