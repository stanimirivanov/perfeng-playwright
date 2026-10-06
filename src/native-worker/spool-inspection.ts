import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const attemptNamePattern =
  /^(perf-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const maximumEntries = 1_024;

export interface NativeSpoolEntry {
  name: string;
  kind: 'attempt' | 'unexpected';
  files?: readonly string[];
}

export interface NativeSpoolInspection {
  schema: 'native-spool-inspection/v1';
  hasRetainedState: boolean;
  entries: readonly NativeSpoolEntry[];
}

/**
 * Inventories retained attempt paths without following links, reading evidence,
 * deleting files or inferring lease authority. This is an operator snapshot,
 * not proof that the spool is safe for a concurrent acquisition.
 */
export async function inspectNativeAttemptSpool(
  spoolRoot: string,
): Promise<NativeSpoolInspection> {
  if (!isAbsolute(spoolRoot)) {
    throw new Error('Native attempt spool root must be absolute');
  }
  const metadata = await lstat(spoolRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Native attempt spool root must be a real directory');
  }
  const root = await realpath(spoolRoot);
  const children = await readdir(root, { withFileTypes: true });
  if (children.length > maximumEntries) {
    throw new Error('Native attempt spool has too many entries to inspect');
  }
  const entries: NativeSpoolEntry[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!attemptNamePattern.test(child.name) || !child.isDirectory()) {
      entries.push({ name: child.name, kind: 'unexpected' });
      continue;
    }
    const directory = join(root, child.name);
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      entries.push({ name: child.name, kind: 'unexpected' });
      continue;
    }
    const files = await readdir(directory);
    if (files.length > maximumEntries) {
      throw new Error(
        'Native attempt directory has too many entries to inspect',
      );
    }
    entries.push({ name: child.name, kind: 'attempt', files: files.sort() });
  }
  return {
    schema: 'native-spool-inspection/v1',
    hasRetainedState: entries.length > 0,
    entries,
  };
}
