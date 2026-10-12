import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { inspectRegularFile } from '../filesystem/inspect-regular-file.js';

const ownerName = '.native-worker-owner';
const lockName = '.native-worker-recovery';
const attemptPattern =
  /^(perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

export interface RecoverySpool {
  attempts: readonly { name: string; runId: string; attemptId: string }[];
  archive: (record: unknown, signal: AbortSignal) => Promise<string>;
  release: () => Promise<void>;
}

/** Owns only a recovery nonce; existing markers and every retained byte are preserved. */
export async function claimRecoverySpool(
  spoolRoot: string,
  archiveRoot: string,
  checkoutRoot: string,
): Promise<RecoverySpool> {
  const [root, archives, checkout] = await Promise.all([
    realDirectory(spoolRoot),
    realDirectory(archiveRoot),
    realDirectory(checkoutRoot),
  ]);
  if (
    overlap(root, archives) ||
    overlap(root, checkout) ||
    overlap(archives, checkout)
  ) {
    throw new Error(
      'Recovery spool, archive and checkout must be separate directories',
    );
  }
  const [spoolDevice, archiveDevice] = await Promise.all([
    lstat(root),
    lstat(archives),
  ]);
  if (spoolDevice.dev !== archiveDevice.dev)
    throw new Error(
      'Native recovery archive must be on the same filesystem as the spool',
    );
  const nonce = randomUUID();
  await writeExclusive(join(root, lockName), nonce);
  let currentRoot = root;
  const release = async (): Promise<void> => {
    const lock = await inspectRegularFile(
      join(currentRoot, lockName),
      64,
      true,
    );
    if (lock.bytes?.toString('utf8') !== nonce)
      throw new Error('Native recovery ownership changed');
    await unlink(join(currentRoot, lockName));
  };
  try {
    // An absent owner is claimed before any server call and remains on failure.
    try {
      await writeExclusive(join(root, ownerName), randomUUID());
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
    await inspectRegularFile(join(root, ownerName), 64, true);
    const names = (await boundedNames(root, 34))
      .filter((name) => name !== ownerName && name !== lockName)
      .sort();
    if (names.length > 32)
      throw new Error('Native recovery supports at most 32 retained attempts');
    const attempts = names.map((name) => {
      const match = attemptPattern.exec(name);
      if (match?.[1] === undefined || match[2] === undefined)
        throw new Error('Native recovery found an unexpected spool entry');
      return { name, runId: match[1], attemptId: match[2] };
    });
    for (const attempt of attempts)
      await realDirectory(join(root, attempt.name));
    const before = await inventory(root);
    return {
      attempts,
      release,
      archive: async (record, signal) => {
        if ((await inventory(root)) !== before)
          throw new Error(
            'Native recovery spool changed during reconciliation',
          );
        const lock = await inspectRegularFile(join(root, lockName), 64, true);
        if (lock.bytes?.toString('utf8') !== nonce)
          throw new Error('Native recovery ownership changed');
        assertArchivalActive(signal);
        const container = join(archives, `native-recovery-${randomUUID()}`);
        await mkdir(container, { mode: 0o700 });
        await writeExclusive(
          join(container, 'recovery.json'),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        const destination = join(container, 'spool');
        assertArchivalActive(signal);
        // The destination is absent inside our exclusive container; never copy/delete or merge.
        await rename(root, destination);
        currentRoot = destination;
        return container;
      },
    };
  } catch (error) {
    try {
      await release();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Native recovery preparation and ownership cleanup failed',
        { cause: cleanup },
      );
    }
    throw error;
  }
}

async function inventory(root: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 16)
      throw new Error('Native recovery directory nesting exceeds its bound');
    for (const name of (
      await boundedNames(directory, 4096 - entries.length)
    ).sort()) {
      if (directory === root && name === lockName) continue;
      if (entries.length >= 4096)
        throw new Error('Native recovery inventory exceeds its bound');
      const path = join(directory, name);
      const stats = await lstat(path, { bigint: true });
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()))
        throw new Error('Native recovery refuses linked or special entries');
      const identity = [
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ]
        .map(String)
        .join(':');
      entries.push(`${relative(root, path)}:${identity}`);
      if (stats.isDirectory()) await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  const stats = await lstat(root, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('Native recovery spool root changed');
  return `${stats.dev.toString()}:${stats.ino.toString()}\n${entries.join('\n')}`;
}

async function realDirectory(path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new Error('Native recovery paths must be absolute');
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('Native recovery paths must be real directories');
  return realpath(path);
}

async function boundedNames(
  directory: string,
  maximum: number,
): Promise<string[]> {
  const names: string[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (names.length >= maximum)
      throw new Error('Native recovery inventory exceeds its bound');
    names.push(entry.name);
  }
  return names;
}

function overlap(left: string, right: string): boolean {
  const inside = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return (
      path === '' ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
    );
  };
  return inside(left, right) || inside(right, left);
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function assertArchivalActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new Error('Native recovery was cancelled before archival');
}
