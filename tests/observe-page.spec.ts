import { expect, test } from '@playwright/test';

import { finishPageObservation, startPageObservation } from '../src/index.js';

test('captures bounded browser observations around owned work', async ({
  page,
}) => {
  await page.goto('/');
  await startPageObservation(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          const started = performance.now();
          while (performance.now() - started < 75) {
            // Generate one observable page task.
          }
          resolve();
        }, 0);
      }),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );

  const observation = await finishPageObservation(page);

  expect(observation.schema).toBe('browser-page-observation/v1');
  expect(Date.parse(observation.startedAt)).toBeLessThanOrEqual(
    Date.parse(observation.finishedAt),
  );
  expect(observation.supportedEntryTypes).toContain('navigation');
  expect(observation.navigation?.loadMs).toBeGreaterThanOrEqual(0);
  expect(observation.longTasks.count).toBeGreaterThanOrEqual(1);
  expect(observation.longTasks.maximumDurationMs).toBeGreaterThanOrEqual(50);
  expect(observation.animationFrames.count).toBeGreaterThan(0);
  expect(observation.animationFrames.maximumIntervalMs).toBeGreaterThan(0);
  expect(observation.javascriptHeap?.usedBytes).toBeGreaterThan(0);
});

test('installs before navigation and observes the destination document', async ({
  page,
}) => {
  await startPageObservation(page);
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );

  const observation = await finishPageObservation(page);

  expect(observation.navigation).not.toBeNull();
  expect(observation.paints.map(({ name }) => name)).toContain('first-paint');
});

test('requires one active observation per capture window', async ({ page }) => {
  await page.goto('/');
  await expect(finishPageObservation(page)).rejects.toThrow(
    'Page observation is not active',
  );
  await startPageObservation(page);
  await finishPageObservation(page);
  await expect(finishPageObservation(page)).rejects.toThrow(
    'Page observation is not active',
  );
});
