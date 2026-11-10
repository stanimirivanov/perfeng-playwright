import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function inventory(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => {
        if (!entry.isFile())
          throw new Error('Package inventory contains a non-regular entry');
        const path = join(entry.parentPath, entry.name);
        return [relative(root, path), hash(path)] as const;
      }),
  );
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function checkInstalled(root: string): Promise<void> {
  assert.deepEqual(
    inventory(join(root, 'dist')),
    inventory('dist'),
    'Packaged runtime differs',
  );
  assert.deepEqual(
    inventory(join(root, 'vendor/contracts')),
    inventory('vendor/contracts'),
    'Packaged contract fixtures differ',
  );
  const fixtures = join(root, 'vendor/contracts/native-worker/v2/examples');
  const { parseNativeExecutionRecipe } = (await import(
    pathToFileURL(join(root, 'dist/native-worker/execution-recipe.js')).href
  )) as typeof import('../src/native-worker/execution-recipe.js');
  const lease = readFileSync(join(fixtures, 'lease.json'), 'utf8');
  const presence = JSON.parse(
    readFileSync(join(fixtures, 'presence.json'), 'utf8'),
  ) as {
    qualificationEvidence: Parameters<typeof parseNativeExecutionRecipe>[1];
  };
  assert.ok(parseNativeExecutionRecipe(lease, presence.qualificationEvidence));
  assert.throws(() =>
    parseNativeExecutionRecipe('{}', presence.qualificationEvidence),
  );
}

async function main() {
  const [candidate, rollback, rollbackPin, ...extra] = process.argv.slice(2);
  if (
    !candidate ||
    !rollback ||
    !rollbackPin ||
    extra.length ||
    !/^[a-f0-9]{64}$/.test(rollbackPin)
  ) {
    throw new Error(
      'Provide the candidate package, retained package, and reviewed rollback SHA-256',
    );
  }
  const currentSha = hash(candidate);
  if (hash(rollback) !== rollbackPin || currentSha === rollbackPin) {
    throw new Error(
      'Retained package digest differs or candidate and rollback are identical',
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), 'perfeng-playwright-package-'));
  try {
    for (const [name, archive] of [
      ['current', candidate],
      ['rollback', rollback],
    ] as const) {
      const directory = join(scratch, name);
      mkdirSync(directory);
      writeFileSync(join(directory, 'package.json'), '{"private":true}', {
        flag: 'wx',
      });
      execFileSync(
        'pnpm',
        [
          'add',
          '--offline',
          '--ignore-scripts',
          '--ignore-workspace',
          resolve(archive),
        ],
        {
          cwd: directory,
          timeout: 60_000,
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      );
      await checkInstalled(join(directory, 'node_modules/@perfeng/playwright'));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      currentPackageSha256: currentSha,
      rollbackPackageSha256: rollbackPin,
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
