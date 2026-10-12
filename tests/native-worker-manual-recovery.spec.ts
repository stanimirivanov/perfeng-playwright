import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { parseNativeAttemptDiscovery } from '../src/native-worker/attempt-discovery.js';
import { parseNativeExecutionRecipe } from '../src/native-worker/execution-recipe.js';
import {
  recoverNativeWorkerManually,
  type ManualRecoveryPorts,
  type ManualRecoveryRequest,
} from '../src/native-worker/manual-recovery.js';
import { claimRecoverySpool } from '../src/native-worker/recovery-spool.js';
import { runNativeWorkerOnce } from '../src/native-worker/run-once.js';
import type {
  WorkerPresence,
  WorkerPresenceStatus,
} from '../src/native-worker/types.js';
import { parseWorkerCommand, workerMain } from '../src/worker-cli.js';

const fixtureRoot = 'vendor/contracts/native-worker/v2/examples';
const ownerName = '.native-worker-owner';
const recoveryName = '.native-worker-recovery';
const token = 'private-recovery-token';
const attemptId = '22222222-2222-4222-8222-222222222222';
const runId = 'perf-20260918-120000-a1b2c3d4';
const attemptName = `${runId}-${attemptId}`;

async function setup(base: string): Promise<{
  request: ManualRecoveryRequest;
  ports: ManualRecoveryPorts;
  calls: string[];
}> {
  const spoolRoot = join(base, 'spool');
  const archiveRoot = join(base, 'archives');
  const checkoutRoot = join(base, 'checkout');
  await mkdir(base, { recursive: true });
  await Promise.all([
    mkdir(spoolRoot, { recursive: true }),
    mkdir(archiveRoot),
    mkdir(checkoutRoot),
  ]);
  await writeFile(join(spoolRoot, ownerName), 'original-owner-nonce');
  const presence = {
    ...(JSON.parse(
      await readFile(`${fixtureRoot}/presence.json`, 'utf8'),
    ) as WorkerPresence),
    availability: 'UNAVAILABLE' as const,
  };
  const none = parseNativeAttemptDiscovery(
    await readFile(`${fixtureRoot}/discovery-none.json`, 'utf8'),
  );
  const calls: string[] = [];
  const ports: ManualRecoveryPorts = {
    reportPresence: ({ presence: offered, signal }) => {
      calls.push('withdraw');
      expect(offered.availability).toBe('UNAVAILABLE');
      expect(signal).toBeInstanceOf(AbortSignal);
      const status: WorkerPresenceStatus = {
        workerId: 'windows-laptop-01',
        serverTime: '2026-09-18T12:00:00Z',
        nextHeartbeatSeconds: 30,
        availability: 'UNAVAILABLE',
        qualification: {
          status: 'UNQUALIFIED',
          reasons: ['Source was updated'],
        },
        authorizedToAcquire: false,
      };
      return Promise.resolve(status);
    },
    discover: ({ signal }) => {
      calls.push('discover');
      expect(signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(none);
    },
    inspect: ({ runId: id, attemptId: attempt }) => {
      calls.push('inspect');
      return Promise.resolve({
        kind: 'not-found',
        runId: id,
        attemptId: attempt,
      });
    },
  };
  return {
    request: {
      presence,
      controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
      token,
      spoolRoot,
      archiveRoot,
      checkoutRoot,
      processesStopped: true,
      signal: new AbortController().signal,
    },
    ports,
    calls,
  };
}

async function partialAttempt(root: string): Promise<Buffer> {
  await mkdir(join(root, attemptName));
  const bytes = Buffer.from([0, 255, 1, 128, 10]);
  await writeFile(join(root, attemptName, 'partial.bin'), bytes);
  return bytes;
}

test('requires a complete explicit command and confirmation before any side effect', async ({}, testInfo) => {
  const args = [
    'recover',
    '--config',
    'worker.json',
    '--spool-root',
    'C:\\spool',
    '--archive-root',
    'C:\\archives',
    '--confirm-processes-stopped',
  ];
  expect(parseWorkerCommand(args)).toEqual({
    action: 'recover',
    configurationPath: 'worker.json',
    spoolRoot: 'C:\\spool',
    archiveRoot: 'C:\\archives',
    processesStopped: true,
  });
  expect(() => parseWorkerCommand(args.slice(0, -1))).toThrow('Usage:');
  expect(() => parseWorkerCommand([...args, '--force'])).toThrow('Usage:');
  await expect(workerMain(args, {})).rejects.toThrow('TOKEN is required');
  const { request, ports, calls } = await setup(testInfo.outputPath('manual'));
  await expect(
    recoverNativeWorkerManually({ ...request, processesStopped: false }, ports),
  ).rejects.toThrow('confirmation');
  await expect(
    recoverNativeWorkerManually(
      { ...request, signal: AbortSignal.abort() },
      ports,
    ),
  ).rejects.toThrow('cancelled');
  expect(calls).toEqual([]);
  expect(await readdir(request.spoolRoot)).toEqual([ownerName]);
});

test('archives a marker-only uncertain acquisition without treating NONE as history', async ({}, testInfo) => {
  const { request, ports, calls } = await setup(testInfo.outputPath('manual'));
  const result = await recoverNativeWorkerManually(request, ports);
  expect(result.kind).toBe('ARCHIVED');
  if (result.kind !== 'ARCHIVED') throw new Error('Expected archive');
  expect(calls).toEqual(['withdraw', 'discover', 'discover']);
  expect(
    await readFile(join(result.archiveDirectory, 'spool', ownerName), 'utf8'),
  ).toBe('original-owner-nonce');
  expect(await readdir(join(result.archiveDirectory, 'spool'))).toEqual([
    ownerName,
  ]);
  expect(
    JSON.parse(
      await readFile(join(result.archiveDirectory, 'recovery.json'), 'utf8'),
    ),
  ).toMatchObject({
    freshSpoolRequired: true,
    evidenceDisposition: 'preserved-without-resuming',
  });
  await expect(readdir(request.spoolRoot)).rejects.toThrow();
  expect(JSON.stringify(result)).not.toContain(token);
});

test('preserves incomplete and unknown evidence without inventing integrity or server success', async ({}, testInfo) => {
  const { request, ports, calls } = await setup(testInfo.outputPath('manual'));
  const bytes = await partialAttempt(request.spoolRoot);
  const result = await recoverNativeWorkerManually(request, ports);
  if (result.kind !== 'ARCHIVED') throw new Error('Expected archive');
  expect(calls).toEqual(['withdraw', 'discover', 'inspect', 'discover']);
  expect(result.retained).toEqual([
    {
      name: attemptName,
      server: { kind: 'not-found', runId, attemptId },
      measurements: { kind: 'unverified' },
    },
  ]);
  expect(
    await readFile(
      join(result.archiveDirectory, 'spool', attemptName, 'partial.bin'),
    ),
  ).toEqual(bytes);
  expect(
    await readFile(join(result.archiveDirectory, 'spool', ownerName), 'utf8'),
  ).toBe('original-owner-nonce');
});

test('records receipt-bound integrity separately from accepted terminal state', async ({}, testInfo) => {
  const { request, ports } = await setup(testInfo.outputPath('manual'));
  const recipe = parseNativeExecutionRecipe(
    await readFile(`${fixtureRoot}/lease.json`, 'utf8'),
    request.presence.qualificationEvidence,
  );
  const directory = join(request.spoolRoot, attemptName);
  await mkdir(directory);
  const measurements = Buffer.from('retained bytes, not a semantic verdict');
  const receipt = {
    schema: 'playwright-runner-receipt/v2',
    runId,
    testId: recipe.configuration.testId,
    producer: {
      name: 'playwright',
      version: '1.62.1',
      artifact: {
        kind: 'source-checkout',
        repository: recipe.executionArtifact.repository,
        gitSha: recipe.executionArtifact.revision,
        dependencyLock: {
          path: recipe.executionArtifact.lockfile,
          sha256: recipe.executionArtifact.lockfileSha256,
        },
      },
    },
    artifacts: {
      measurements: {
        sizeBytes: measurements.length,
        sha256: createHash('sha256').update(measurements).digest('hex'),
      },
    },
  };
  await writeFile(
    join(directory, 'runner-config.json'),
    JSON.stringify(recipe.configuration),
  );
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt));
  await writeFile(join(directory, 'measurements.json'), measurements);
  const terminal = JSON.parse(
    await readFile(`${fixtureRoot}/attempt-terminal.json`, 'utf8'),
  ) as Extract<
    Awaited<ReturnType<ManualRecoveryPorts['inspect']>>,
    { kind: 'found' }
  >['inspection'];
  ports.inspect = () =>
    Promise.resolve({ kind: 'found', inspection: terminal });
  const result = await recoverNativeWorkerManually(request, ports);
  if (result.kind !== 'ARCHIVED') throw new Error('Expected archive');
  expect(result.retained[0]).toMatchObject({
    measurements: {
      kind: 'verified',
      integrity: { serverStateVerified: false },
    },
    server: { kind: 'found', inspection: { state: 'TERMINAL' } },
  });
  expect(
    await readFile(
      join(result.archiveDirectory, 'spool', attemptName, 'measurements.json'),
    ),
  ).toEqual(measurements);
});

for (const variant of ['discovery-active', 'discovery-terminal']) {
  test(`blocks ${variant} even with no local attempt IDs`, async ({}, testInfo) => {
    const { request, ports, calls } = await setup(
      testInfo.outputPath('manual'),
    );
    const observation = parseNativeAttemptDiscovery(
      await readFile(`${fixtureRoot}/${variant}.json`, 'utf8'),
    );
    ports.discover = () => {
      calls.push('discover');
      return Promise.resolve({ ...observation, availability: 'UNAVAILABLE' });
    };
    expect(await recoverNativeWorkerManually(request, ports)).toMatchObject({
      kind: 'BLOCKED',
      reason: 'CURRENT_SLOT',
    });
    expect(calls).toEqual(['withdraw', 'discover']);
    expect(await readdir(request.archiveRoot)).toEqual([]);
    expect(await readdir(request.spoolRoot)).toEqual([ownerName]);
  });
}

test('blocks an active retained attempt even if current discovery says NONE', async ({}, testInfo) => {
  const { request, ports } = await setup(testInfo.outputPath('manual'));
  await partialAttempt(request.spoolRoot);
  const active = JSON.parse(
    await readFile(`${fixtureRoot}/attempt-active.json`, 'utf8'),
  ) as Extract<
    Awaited<ReturnType<ManualRecoveryPorts['inspect']>>,
    { kind: 'found' }
  >['inspection'];
  ports.inspect = () => Promise.resolve({ kind: 'found', inspection: active });
  expect(await recoverNativeWorkerManually(request, ports)).toMatchObject({
    kind: 'BLOCKED',
    reason: 'ACTIVE_RETAINED_ATTEMPT',
  });
  expect(await readdir(request.archiveRoot)).toEqual([]);
});

test('retains evidence after failed withdrawal, changed intent, stale discovery or remote failure', async ({}, testInfo) => {
  for (const mode of [
    'withdrawal',
    'intent',
    'clock',
    'network',
    'final-network',
  ] as const) {
    const { request, ports } = await setup(testInfo.outputPath(mode));
    const bytes = await partialAttempt(request.spoolRoot);
    const original = ports.reportPresence;
    if (mode === 'withdrawal')
      ports.reportPresence = async (input) => ({
        ...(await original(input)),
        availability: 'AVAILABLE',
      });
    const discover = ports.discover;
    let calls = 0;
    ports.discover = async (input) => {
      calls++;
      if (mode === 'network' || (mode === 'final-network' && calls === 2))
        throw new Error(token);
      const result = await discover(input);
      return mode === 'intent'
        ? {
            state: 'NONE',
            serverTime: result.serverTime,
            availability: 'UNREPORTED',
          }
        : mode === 'clock'
          ? { ...result, serverTime: '2026-09-18T11:59:59Z' }
          : result;
    };
    await expect(recoverNativeWorkerManually(request, ports)).rejects.toThrow(
      'Native manual recovery failed',
    );
    expect(
      await readFile(join(request.spoolRoot, attemptName, 'partial.bin')),
    ).toEqual(bytes);
    expect(await readFile(join(request.spoolRoot, ownerName), 'utf8')).toBe(
      'original-owner-nonce',
    );
    expect(await readdir(request.archiveRoot)).toEqual([]);
    expect(await readdir(request.spoolRoot)).not.toContain(recoveryName);
  }
});

test('checks capacity again and cancellation immediately before archival', async ({}, testInfo) => {
  for (const mode of ['new-slot', 'cancel'] as const) {
    const { request, ports } = await setup(testInfo.outputPath(mode));
    await partialAttempt(request.spoolRoot);
    const cancellation = new AbortController();
    const discover = ports.discover;
    let calls = 0;
    const active = parseNativeAttemptDiscovery(
      await readFile(`${fixtureRoot}/discovery-active.json`, 'utf8'),
    );
    ports.discover = async (input) => {
      calls++;
      const result = await discover(input);
      if (calls === 2) {
        if (mode === 'cancel') cancellation.abort();
        else return { ...active, availability: 'UNAVAILABLE' };
      }
      return result;
    };
    if (mode === 'cancel')
      await expect(
        recoverNativeWorkerManually(
          { ...request, signal: cancellation.signal },
          ports,
        ),
      ).rejects.toThrow('Native manual recovery failed');
    else
      expect(await recoverNativeWorkerManually(request, ports)).toMatchObject({
        kind: 'BLOCKED',
      });
    expect(await readdir(request.archiveRoot)).toEqual([]);
    expect(await readdir(request.spoolRoot)).toContain(ownerName);
  }
});

test('detects changes to retained state while server reconciliation is in flight', async ({}, testInfo) => {
  const { request, ports } = await setup(testInfo.outputPath('manual'));
  await partialAttempt(request.spoolRoot);
  const inspect = ports.inspect;
  ports.inspect = async (input) => {
    await writeFile(
      join(request.spoolRoot, attemptName, 'partial.bin'),
      'changed-by-another-writer',
    );
    return inspect(input);
  };
  await expect(recoverNativeWorkerManually(request, ports)).rejects.toThrow(
    'Native manual recovery failed',
  );
  expect(
    await readFile(join(request.spoolRoot, attemptName, 'partial.bin'), 'utf8'),
  ).toBe('changed-by-another-writer');
  expect(await readdir(request.archiveRoot)).toEqual([]);
});

test('excludes concurrent recovery and run-once without starting another acquisition', async ({}, testInfo) => {
  const { request, ports } = await setup(testInfo.outputPath('manual'));
  const spool = await claimRecoverySpool(
    request.spoolRoot,
    request.archiveRoot,
    request.checkoutRoot,
  );
  try {
    await expect(recoverNativeWorkerManually(request, ports)).rejects.toThrow();
    let networkCalls = 0;
    await expect(
      runNativeWorkerOnce(
        { ...request, runnerEnvironment: {}, timeoutMilliseconds: 60_000 },
        {
          verifyReadiness: () => Promise.resolve(),
          reportPresence: () => {
            networkCalls++;
            return Promise.reject(new Error('Must not send'));
          },
          acquireLease: () => {
            networkCalls++;
            return Promise.reject(new Error('Must not acquire'));
          },
          coordinateAttempt: () =>
            Promise.reject(new Error('Must not execute')),
        },
      ),
    ).rejects.toThrow('owner marker');
    expect(networkCalls).toBe(0);
  } finally {
    await spool.release();
  }
});

test('rejects overlapping roots, unexpected entries and nested junctions before network calls', async ({}, testInfo) => {
  const { request, ports, calls } = await setup(testInfo.outputPath('manual'));
  await expect(
    recoverNativeWorkerManually(
      { ...request, archiveRoot: request.spoolRoot },
      ports,
    ),
  ).rejects.toThrow('separate');
  await expect(
    recoverNativeWorkerManually(
      { ...request, spoolRoot: request.checkoutRoot },
      ports,
    ),
  ).rejects.toThrow('separate');
  await writeFile(join(request.spoolRoot, 'foreign.txt'), 'preserve');
  await expect(recoverNativeWorkerManually(request, ports)).rejects.toThrow(
    'unexpected',
  );
  const other = await setup(testInfo.outputPath('linked'));
  await partialAttempt(other.request.spoolRoot);
  await symlink(
    other.request.checkoutRoot,
    join(other.request.spoolRoot, attemptName, 'linked'),
    'junction',
  );
  await expect(
    recoverNativeWorkerManually(other.request, other.ports),
  ).rejects.toThrow('linked');
  expect(calls).toEqual([]);
  expect(other.calls).toEqual([]);
  expect(await readFile(join(request.spoolRoot, 'foreign.txt'), 'utf8')).toBe(
    'preserve',
  );
});

test('retains a new owner marker when recovery of an ownerless spool fails', async ({}, testInfo) => {
  const { request, ports } = await setup(testInfo.outputPath('manual'));
  const clean = join(testInfo.outputPath('manual'), 'ownerless');
  await mkdir(clean);
  ports.reportPresence = () => Promise.reject(new Error(token));
  await expect(
    recoverNativeWorkerManually({ ...request, spoolRoot: clean }, ports),
  ).rejects.toThrow('Native manual recovery failed');
  expect(await readdir(clean)).toEqual([ownerName]);
});

test('cancels archival without creating an archive and never removes a changed recovery nonce', async ({}, testInfo) => {
  const { request } = await setup(testInfo.outputPath('manual'));
  const spool = await claimRecoverySpool(
    request.spoolRoot,
    request.archiveRoot,
    request.checkoutRoot,
  );
  await expect(spool.archive({}, AbortSignal.abort())).rejects.toThrow(
    'cancelled',
  );
  expect(await readdir(request.archiveRoot)).toEqual([]);
  const archive = await spool.archive(
    { schema: 'test-only' },
    new AbortController().signal,
  );
  const recoveryPath = join(archive, 'spool', recoveryName);
  await writeFile(recoveryPath, 'a-different-invocation');
  await expect(spool.release()).rejects.toThrow('ownership changed');
  expect(await readFile(recoveryPath, 'utf8')).toBe('a-different-invocation');
  expect(await readFile(join(archive, 'spool', ownerName), 'utf8')).toBe(
    'original-owner-nonce',
  );
});

test('bounds retained attempts before any server request', async ({}, testInfo) => {
  const { request, ports, calls } = await setup(testInfo.outputPath('manual'));
  for (let index = 0; index < 33; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
    await mkdir(join(request.spoolRoot, `${runId}-${id}`));
  }
  await expect(recoverNativeWorkerManually(request, ports)).rejects.toThrow(
    'bound',
  );
  expect(calls).toEqual([]);
  expect(await readdir(request.archiveRoot)).toEqual([]);
  expect(await readFile(join(request.spoolRoot, ownerName), 'utf8')).toBe(
    'original-owner-nonce',
  );
});
