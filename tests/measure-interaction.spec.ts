import { expect, test } from '@playwright/test';

import { measureInteraction } from '../src/index.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('reads application-assisted semantic timing', async ({ page }) => {
  const result = await measureInteraction(page, {
    mode: 'instrumented',
    metricName: 'ui.search.action_to_visible_ms',
    measureName: 'search.action-to-visible',
    action: () => page.locator('#search').click(),
  });

  expect(result.name).toBe('ui.search.action_to_visible_ms');
  expect(result.durationMs).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(1_000);
});

test('measures black-box action through rendered completion', async ({
  page,
}) => {
  const result = await measureInteraction(page, {
    mode: 'black-box',
    metricName: 'ui.search.action_to_visible_ms',
    startSelector: '#search',
    completionSelector: '#results',
    renderFrames: 2,
    action: () => page.locator('#search').click(),
  });

  expect(result.name).toBe('ui.search.action_to_visible_ms');
  expect(result.durationMs).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(1_000);
});

test('rejects a completion element visible before the action', async ({
  page,
}) => {
  await expect(
    measureInteraction(page, {
      mode: 'black-box',
      metricName: 'ui.search.action_to_visible_ms',
      startSelector: '#search',
      completionSelector: 'h1',
      action: () => page.locator('#search').click(),
    }),
  ).rejects.toThrow(
    'Completion element was visible before the interaction started',
  );
});

test('rejects metric names outside the normalized namespace', async ({
  page,
}) => {
  await expect(
    measureInteraction(page, {
      mode: 'instrumented',
      metricName: 'search.duration',
      measureName: 'search.action-to-visible',
      action: () => page.locator('#search').click(),
    }),
  ).rejects.toThrow('Invalid interaction metric name');
});
