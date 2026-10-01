import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const repositoryRoot = resolve('.');
const repoCheck = join(repositoryRoot, 'tools/repo-check.mjs');
const architectureCheck = join(repositoryRoot, 'tools/architecture-check.mjs');

function run(tool: string, root: string) {
  return spawnSync(process.execPath, [tool, root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

test('current repository satisfies harness policy and architecture', () => {
  const policy = run(repoCheck, repositoryRoot);
  expect(policy.status, policy.stderr).toBe(0);
  const architecture = run(architectureCheck, repositoryRoot);
  expect(architecture.status, architecture.stderr).toBe(0);
});

test('repository policy reports broken links and hashed action refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perfeng-playwright-policy-'));
  try {
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      join(root, 'docs/guide.md'),
      '# Guide\n\n[missing](absent.md)\n',
      'utf8',
    );
    await writeFile(
      join(root, '.github/workflows/validate.yml'),
      'jobs:\n  check:\n    steps:\n      - uses: owner/tool@0123456789abcdef\n',
      'utf8',
    );
    const result = run(repoCheck, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[docs.link]');
    expect(result.stderr).toContain('[workflow.action-version]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('action policy accepts quotes and ignores scripts but checks composites', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perfeng-playwright-actions-'));
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await mkdir(join(root, '.github/actions/example'), { recursive: true });
    await writeFile(
      join(root, '.github/workflows/validate.yml'),
      [
        'jobs:',
        '  check:',
        '    steps:',
        '      - uses: "actions/checkout@v7"',
        '      - uses: owner/unversioned',
        '      - run: |',
        "          echo 'uses: owner/fake@0123456789abcdef'",
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, '.github/actions/example/action.yml'),
      "runs:\n  using: composite\n  steps:\n    - uses: 'owner/tool@0123456789abcdef'\n",
      'utf8',
    );
    const result = run(repoCheck, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.github/actions/example/action.yml:4: [workflow.action-version]',
    );
    expect(result.stderr).toContain('owner/unversioned has no action revision');
    expect(result.stderr).not.toContain('owner/fake');
    expect(result.stderr).not.toContain('actions/checkout');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('architecture policy reports facade dependencies and cycles', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'perfeng-playwright-architecture-'),
  );
  try {
    await mkdir(join(root, 'src/feature'), { recursive: true });
    await writeFile(
      join(root, 'src/index.ts'),
      "export { value } from './feature/a.js';\n",
      'utf8',
    );
    await writeFile(
      join(root, 'src/feature/a.ts'),
      "import '../index.js';\nimport './b.js';\nexport const value = 1;\n",
      'utf8',
    );
    await writeFile(
      join(root, 'src/feature/b.ts'),
      "import './a.js';\nexport const other = 2;\n",
      'utf8',
    );
    const result = run(architectureCheck, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[architecture.inward-dependency]');
    expect(result.stderr).toContain('[architecture.cycle]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('architecture policy reports feature cycles and dynamic boundary imports', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'perfeng-playwright-feature-architecture-'),
  );
  try {
    await mkdir(join(root, 'src/alpha'), { recursive: true });
    await mkdir(join(root, 'src/beta'), { recursive: true });
    await writeFile(
      join(root, 'src/alpha/a.ts'),
      "export async function load() { return import('../beta/b.js'); }\n",
      'utf8',
    );
    await writeFile(
      join(root, 'src/beta/b.ts'),
      "import '../alpha/a.js';\nexport const value = 1;\n",
      'utf8',
    );
    const result = run(architectureCheck, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[architecture.feature-cycle]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('architecture policy parses TypeScript rather than comments', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'perfeng-playwright-comment-architecture-'),
  );
  try {
    await mkdir(join(root, 'src/alpha'), { recursive: true });
    await writeFile(
      join(root, 'src/alpha/a.ts'),
      "// import '../missing.js';\nexport const value = 1;\n",
      'utf8',
    );
    const result = run(architectureCheck, root);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('architecture policy rejects a stale cycle exception', async () => {
  const root = await mkdtemp(
    join(tmpdir(), 'perfeng-playwright-stale-architecture-'),
  );
  try {
    await mkdir(join(root, 'src/journey'), { recursive: true });
    await mkdir(join(root, 'src/observation'), { recursive: true });
    await writeFile(
      join(root, 'src/journey/run.ts'),
      "import '../observation/evidence.js';\nexport const run = 1;\n",
      'utf8',
    );
    await writeFile(
      join(root, 'src/observation/evidence.ts'),
      'export const evidence = 1;\n',
      'utf8',
    );
    const result = run(architectureCheck, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[architecture.stale-cycle-exception]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
