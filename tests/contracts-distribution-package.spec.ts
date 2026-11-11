import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { stageNativeFixtures } from '../tools/contracts-distribution.js';

test('stages only exact reviewed fixture bytes and preserves the ledger', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'perfeng-playwright-staging-'));
  const target = join(scratch, 'snapshot');
  const fixture = 'native-worker/v2/examples/lease.json';
  const bytes = readFileSync(join('vendor/contracts', fixture));
  const reviewed = JSON.parse(
    readFileSync('vendor/contracts/lock.json', 'utf8'),
  ) as { files: Record<string, string> };
  const ledger = Buffer.from(
    JSON.stringify({
      ...reviewed,
      files: { [fixture]: reviewed.files[fixture] },
    }),
  );
  try {
    expect(() => {
      stageNativeFixtures(target, ledger, () => Buffer.from('{}'));
    }).toThrow(/Projected digest/);
    stageNativeFixtures(target, ledger, () => bytes);
    expect(readFileSync(join(target, fixture))).toEqual(bytes);
    expect(readFileSync(join(target, 'lock.json'))).toEqual(ledger);
    expect(() => {
      stageNativeFixtures(target, ledger, () => bytes);
    }).toThrow(/EEXIST/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
