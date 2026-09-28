import { readFile } from 'node:fs/promises';

import { AcquiredNativeLease } from '../src/native-worker/acquisition.js';
import { parseNativeLease } from '../src/native-worker/lease.js';
import type { NativeRawResultRequest } from '../src/native-worker/raw-result.js';
import type { NativeArtifactReference } from '../src/native-worker/types.js';
import type { PlaywrightMeasurements } from '../src/journey/types.js';

const capability = 'example-not-a-real-lease-capability-0001';

export async function nativeRawResultRequest(): Promise<NativeRawResultRequest> {
  const authority = new AcquiredNativeLease(
    parseNativeLease(
      await readFile(
        'vendor/contracts/native-worker/v1/examples/lease.json',
        'utf8',
      ),
    ),
    capability,
  );
  authority.lease.assignment.profile = 'smoke';
  const measurements: PlaywrightMeasurements = {
    schemaVersion: 2,
    kind: 'PlaywrightMeasurements',
    runId: authority.lease.runId,
    testId: authority.lease.assignment.catalogueTestId,
    workload: {
      id: authority.lease.assignment.workloadId,
      version: '1.0.0',
      profile: 'smoke',
      sha256: 'a'.repeat(64),
    },
    scenario: {
      cacheProfile: 'warm',
      contextReuse: 'per-run',
      pageReuse: 'per-iteration',
      warmupIterations: 1,
      measurementIterations: 3,
    },
    diagnosticMode: 'trace',
    environment: {
      profile: {
        id: 'windows-mainstream',
        version: '1.0.0',
      },
      fingerprint: 'b'.repeat(64),
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
      headless: false,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
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
  const registeredArtifacts: NativeArtifactReference[] = [
    {
      artifactId: '33333333-3333-4333-8333-333333333333',
      runId: authority.lease.runId,
      attemptId: authority.lease.attemptId,
      slot: 'measurements',
      kind: 'measurements',
      uri: `s3://perfeng/runs/${authority.lease.runId}/attempts/${authority.lease.attemptId}/measurements`,
      size: 2048,
      sha256: 'c'.repeat(64),
      mediaType: 'application/json',
      registeredAt: '2026-09-18T12:01:15Z',
    },
  ];
  return {
    authority,
    measurements,
    registeredArtifacts,
    createdAt: '2026-09-18T12:01:20Z',
  };
}
