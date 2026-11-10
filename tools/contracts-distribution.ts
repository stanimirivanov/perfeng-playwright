import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendorRoot = 'vendor/contracts';
const openapi = 'api/native-worker/v2/openapi.json';
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;

interface NativeLock {
  v2SourceRevision: string;
  v2BundleVersion: string;
  reviewedV2OpenApiSha256: string;
  files: Record<string, string>;
}

type ReadBytes = (path: string) => Buffer | undefined;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function nativeSelection(lock: Omit<NativeLock, 'v2BundleVersion'>) {
  if (
    !revision.test(lock.v2SourceRevision) ||
    !digest.test(lock.reviewedV2OpenApiSha256)
  ) {
    throw new Error('Invalid Native Worker source revision or API digest');
  }
  const files = Object.entries(lock.files);
  if (files.length === 0) throw new Error('No Native Worker fixtures in lock');
  const members: Record<string, { destination: string; sha256: string }> = {
    [openapi]: { destination: openapi, sha256: lock.reviewedV2OpenApiSha256 },
  };
  for (const [path, sha256] of files) {
    if (
      !/^native-worker\/v2\/examples\/[a-z0-9-]+\.json$/.test(path) ||
      !digest.test(sha256)
    ) {
      throw new Error(`Invalid Native Worker fixture path or digest: ${path}`);
    }
    const source = `api/${path}`;
    members[source] = { destination: source, sha256 };
  }
  return { sourceRevision: lock.v2SourceRevision, members };
}

export function signedSelection(
  lock: Omit<NativeLock, 'v2BundleVersion'>,
  pins: { historyRelease: string; version: string; manifestSha256: string },
  bytes: Buffer,
) {
  if (sha256(bytes) !== pins.manifestSha256) {
    throw new Error('Pinned historical manifest digest differs');
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as {
    releaseId: string;
    source: { revision: string; version: string };
    members: Record<string, string>;
  };
  if (
    manifest.releaseId !== pins.historyRelease ||
    manifest.source.revision !== lock.v2SourceRevision ||
    manifest.source.version !== pins.version
  ) {
    throw new Error('Pinned historical profile differs');
  }
  const selection = nativeSelection(lock);
  for (const [path, member] of Object.entries(selection.members)) {
    if (manifest.members[path] !== member.sha256) {
      throw new Error(`Pinned historical fixture differs for ${path}`);
    }
  }
  return {
    sourceRevision: selection.sourceRevision,
    members: Object.fromEntries(
      Object.entries(manifest.members).map(([path, sha256]) => [
        path,
        { destination: path, sha256 },
      ]),
    ),
  };
}

export function verifyProjection(
  lock: Omit<NativeLock, 'v2BundleVersion'>,
  projected: ReadBytes,
  vendored: ReadBytes,
  vendoredPaths: readonly string[],
): number {
  if (
    new Set(vendoredPaths).size !== Object.keys(lock.files).length ||
    vendoredPaths.some((path) => !Object.hasOwn(lock.files, path))
  ) {
    throw new Error(
      'Vendored fixture inventory differs from the Native Worker lock',
    );
  }
  for (const [path, member] of Object.entries(nativeSelection(lock).members)) {
    const actual = projected(path);
    if (actual === undefined || sha256(actual) !== member.sha256) {
      throw new Error(`Projected digest differs for ${path}`);
    }
    if (path !== openapi) {
      const current = vendored(path.slice('api/'.length));
      if (current === undefined || !actual.equals(current)) {
        throw new Error(`Vendored fixture differs for ${path}`);
      }
    }
  }
  return Object.keys(lock.files).length;
}

export function stageNativeFixtures(
  target: string,
  ledger: Buffer,
  projected: ReadBytes,
): void {
  const lock = JSON.parse(ledger.toString('utf8')) as NativeLock;
  const selection = nativeSelection(lock);
  const files = Object.entries(selection.members)
    .filter(([path]) => path !== openapi)
    .map(([path, member]) => {
      const bytes = projected(path);
      if (!bytes || sha256(bytes) !== member.sha256)
        throw new Error(`Projected digest differs for ${path}`);
      return [path.slice('api/'.length), bytes] as const;
    });
  mkdirSync(target, { mode: 0o700 });
  try {
    for (const [path, bytes] of files) {
      const output = join(target, path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, bytes, { flag: 'wx' });
    }
    writeFileSync(join(target, 'lock.json'), ledger, { flag: 'wx' });
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

interface DistributionLock {
  toolRelease: string;
  historyRelease: string;
  tool: {
    sourceDigest: string;
    signerDigest: string;
    platform: string;
    archiveSha256: string;
  };
  nativeWorker: {
    revision: string;
    bundleVersion: string;
    policy: { manifestSha256: string } & Record<string, string>;
  };
}

function requiredPath(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`Set ${variable} for the offline shadow check`);
  return resolve(value);
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
}

function shadow(target?: string) {
  const distribution = JSON.parse(
    readFileSync('contracts-distribution.lock.json', 'utf8'),
  ) as DistributionLock;
  const ledger = readFileSync(join(vendorRoot, 'lock.json'));
  const lock = JSON.parse(ledger.toString('utf8')) as NativeLock;
  if (
    distribution.nativeWorker.revision !== lock.v2SourceRevision ||
    distribution.nativeWorker.bundleVersion !== lock.v2BundleVersion
  ) {
    throw new Error('Distribution and vendored Native Worker pins differ');
  }
  const assets = requiredPath('CONTRACTS_SHADOW_ASSETS');
  const source = join(assets, 'history', lock.v2SourceRevision);
  const manifestPath = `${source}.manifest.json`;
  const selection = signedSelection(
    lock,
    {
      historyRelease: distribution.historyRelease,
      version: distribution.nativeWorker.bundleVersion,
      manifestSha256: distribution.nativeWorker.policy.manifestSha256,
    },
    readFileSync(manifestPath),
  );
  const bootstrap = requiredPath('CONTRACTS_BOOTSTRAP_ROOT');
  const verifier = requiredPath('CONTRACTS_VERIFIER');
  const scratch = mkdtempSync(join(tmpdir(), 'perfeng-playwright-contracts-'));
  try {
    const tool = join(scratch, 'tool');
    const store = join(scratch, 'store');
    const toolPins = join(scratch, 'tool-pins.json');
    const policy = join(scratch, 'policy.json');
    const selectionPath = join(scratch, 'selection.json');
    writeJson(toolPins, distribution.tool);
    writeJson(policy, distribution.nativeWorker.policy);
    writeJson(selectionPath, selection);
    execFileSync(
      join(bootstrap, '.venv/bin/python'),
      [
        '-B',
        '-m',
        'scripts.contracts_tool_release',
        'restore',
        '--archive',
        join(assets, 'tool/materializer.tar.gz'),
        '--bundle',
        join(assets, 'tool/materializer.sigstore.jsonl'),
        '--verifier',
        verifier,
        '--pins',
        toolPins,
        '--target',
        tool,
      ],
      {
        cwd: bootstrap,
        env: {},
        timeout: 120_000,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    mkdirSync(store, { mode: 0o700 });
    execFileSync(
      join(tool, 'runtime/bin/python3.12'),
      [
        '-IB',
        join(tool, 'materialize.py'),
        '--manifest',
        manifestPath,
        '--archive',
        `${source}.tar.gz`,
        '--bundle',
        join(assets, 'history/manifest.sigstore.jsonl'),
        '--policy',
        policy,
        '--selection',
        selectionPath,
        '--target',
        store,
        '--execute',
      ],
      {
        cwd: scratch,
        env: {},
        timeout: 120_000,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    const pointer = readFileSync(join(store, 'current'), 'ascii');
    if (!/^[a-f0-9]{64}\n$/.test(pointer))
      throw new Error('Invalid projection pointer');
    const projection = join(store, pointer.trim());
    const fixtureCount = verifyProjection(
      lock,
      (path) => readFileSync(join(projection, path)),
      (path) => readFileSync(join(vendorRoot, path)),
      readdirSync(join(vendorRoot, 'native-worker/v2/examples')).map(
        (name) => `native-worker/v2/examples/${name}`,
      ),
    );
    if (target)
      stageNativeFixtures(target, ledger, (path) =>
        readFileSync(join(projection, path)),
      );
    return {
      status: target ? 'prepared' : 'passed',
      toolRelease: distribution.toolRelease,
      historyRelease: distribution.historyRelease,
      manifestSha256: distribution.nativeWorker.policy.manifestSha256,
      sourceRevision: selection.sourceRevision,
      fixtureCount,
      nativeWorkerBundleVersion: lock.v2BundleVersion,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, target, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      (mode !== undefined && (mode !== '--target' || !target))
    ) {
      throw new Error('Use --target with a fresh staging directory');
    }
    console.log(JSON.stringify(shadow(target), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
