import { gunzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { captureMemoryComparison } from '../src/index.js';

interface ChromeHeapSnapshot {
  snapshot: {
    meta: object;
  };
  nodes: number[];
}

test.describe.configure({ timeout: 60_000 });

test('captures garbage-collected memory evidence around one action', async ({
  page,
}) => {
  await page.goto('/');

  const capture = await captureMemoryComparison(page, async () => {
    await page.evaluate(() => {
      const target = window as Window & {
        __perfengRetained?: HTMLElement[];
      };
      target.__perfengRetained = Array.from({ length: 200 }, (_, index) => {
        const element = document.createElement('button');
        element.textContent = `Retained element ${String(index)}`;
        element.addEventListener('click', () => String(index));
        document.body.append(element);
        return element;
      });
    });
    return 'completed';
  });
  const before = JSON.parse(
    gunzipSync(capture.before.snapshot.bytes).toString('utf8'),
  ) as ChromeHeapSnapshot;
  const after = JSON.parse(
    gunzipSync(capture.after.snapshot.bytes).toString('utf8'),
  ) as ChromeHeapSnapshot;

  expect(capture.result).toBe('completed');
  expect(capture.before.snapshot.format).toBe('chrome-heap-snapshot-json-gzip');
  expect(capture.after.snapshot.mediaType).toBe('application/gzip');
  expect(capture.before.snapshot.uncompressedSizeBytes).toBeGreaterThan(0);
  expect(capture.after.snapshot.uncompressedSizeBytes).toBeGreaterThan(0);
  expect(before.snapshot.meta).toBeDefined();
  expect(after.nodes.length).toBeGreaterThan(before.nodes.length);
  expect(capture.after.census.dom.nodes).toBeGreaterThan(
    capture.before.census.dom.nodes,
  );
  expect(capture.after.census.dom.eventListeners).toBeGreaterThan(
    capture.before.census.dom.eventListeners,
  );
});

test('validates memory bounds before invoking the action', async ({ page }) => {
  let invoked = false;

  await expect(
    captureMemoryComparison(
      page,
      () => {
        invoked = true;
        return Promise.resolve();
      },
      { maxSnapshotBytes: 0 },
    ),
  ).rejects.toThrow('maxSnapshotBytes must be an integer between');
  expect(invoked).toBe(false);
});

test('preserves action errors and releases the CDP memory collector', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    captureMemoryComparison(page, () =>
      Promise.reject(new Error('owned action failed')),
    ),
  ).rejects.toThrow('owned action failed');

  const retry = await captureMemoryComparison(page, () =>
    Promise.resolve('retried'),
  );
  expect(retry.result).toBe('retried');
});

test('rejects a heap snapshot that exceeds its output bound', async ({
  page,
}) => {
  await page.goto('/');
  let invoked = false;

  await expect(
    captureMemoryComparison(
      page,
      () => {
        invoked = true;
        return Promise.resolve();
      },
      { maxSnapshotBytes: 1 },
    ),
  ).rejects.toThrow('Chrome heap snapshot exceeds');
  expect(invoked).toBe(false);
});
