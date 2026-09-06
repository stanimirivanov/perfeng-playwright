import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(
  fileURLToPath(new URL('../package.json', import.meta.url)),
);

export interface SourceCheckoutArtifact {
  kind: 'source-checkout';
  repository: string;
  gitSha: string;
  dependencyLock: {
    path: 'pnpm-lock.yaml';
    sha256: string;
  };
}

export type GitCommand = (arguments_: string[]) => Promise<string>;

async function executeGit(root: string, arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function repositoryUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Source repository must be a credential-free HTTPS URL');
  }
  parsed.pathname = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '');
  return parsed.href.replace(/\/$/, '');
}

/** Verifies and identifies the clean source checkout used by the native runner. */
export async function inspectSourceCheckout(
  root = projectRoot,
  runGit: GitCommand = (arguments_) => executeGit(root, arguments_),
): Promise<SourceCheckoutArtifact> {
  const status = await runGit([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status.trim() !== '') {
    throw new Error('Native runner source checkout must be clean');
  }
  const gitSha = (await runGit(['rev-parse', 'HEAD'])).trim();
  if (!/^[a-f0-9]{40}$/.test(gitSha)) {
    throw new Error('Native runner Git revision is invalid');
  }
  const repository = repositoryUrl(
    await runGit(['remote', 'get-url', 'origin']),
  );
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  const metadata = await lstat(lockPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Native runner dependency lock must be a regular file');
  }
  const lockBytes = await readFile(lockPath);
  if (lockBytes.length === 0) {
    throw new Error('Native runner dependency lock must not be empty');
  }
  return {
    kind: 'source-checkout',
    repository,
    gitSha,
    dependencyLock: {
      path: 'pnpm-lock.yaml',
      sha256: createHash('sha256').update(lockBytes).digest('hex'),
    },
  };
}
