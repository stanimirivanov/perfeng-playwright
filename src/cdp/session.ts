import type { CDPSession, Page } from '@playwright/test';

export async function chromiumSession(
  page: Page,
  capability: string,
): Promise<CDPSession> {
  try {
    return await page.context().newCDPSession(page);
  } catch (error) {
    throw new Error(`${capability} requires Chromium`, { cause: error });
  }
}
