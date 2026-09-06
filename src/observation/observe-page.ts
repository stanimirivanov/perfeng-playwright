import type { Page } from '@playwright/test';

import { installPageObserver } from './install-page-observer.js';
import { snapshotPageObserver } from './snapshot-page-observer.js';
import type { PageObservation } from './types.js';

const preparedPages = new WeakSet<Page>();

/** Starts an opt-in, page-local observation without changing measured completion. */
export async function startPageObservation(page: Page): Promise<void> {
  if (!preparedPages.has(page)) {
    await page.addInitScript(installPageObserver);
    preparedPages.add(page);
  }
  await page.evaluate(installPageObserver);
}

/** Stops the active observation and returns raw browser evidence. */
export function finishPageObservation(page: Page): Promise<PageObservation> {
  return page.evaluate(snapshotPageObserver);
}
