import type { Page } from '@playwright/test';

import { installPageObserver } from './install-page-observer.js';
import { snapshotPageObserver } from './snapshot-page-observer.js';
import type { PageObservation } from './types.js';

/** Starts an opt-in, page-local observation without changing measured completion. */
export async function startPageObservation(page: Page): Promise<void> {
  await page.addInitScript(installPageObserver);
  await page.evaluate(installPageObserver);
}

/** Stops the active observation and returns raw browser evidence. */
export function finishPageObservation(page: Page): Promise<PageObservation> {
  return page.evaluate(snapshotPageObserver);
}
