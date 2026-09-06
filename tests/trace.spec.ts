import { gunzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { capturePerformanceTrace } from '../src/index.js';

interface ChromeTrace {
  traceEvents: { name?: string }[];
}

test('captures a gzip Chrome performance trace around one action', async ({
  page,
}) => {
  await page.goto('/');

  const capture = await capturePerformanceTrace(page, async () => {
    await page.evaluate(() => {
      performance.mark('perfeng.trace.started');
      const started = performance.now();
      while (performance.now() - started < 25) {
        Math.sqrt(started);
      }
      performance.mark('perfeng.trace.finished');
      performance.measure(
        'perfeng.trace.action',
        'perfeng.trace.started',
        'perfeng.trace.finished',
      );
    });
    return 'completed';
  });
  const trace = JSON.parse(
    gunzipSync(capture.trace.bytes).toString('utf8'),
  ) as ChromeTrace;

  expect(capture.result).toBe('completed');
  expect(capture.trace.format).toBe('chrome-trace-json-gzip');
  expect(capture.trace.mediaType).toBe('application/gzip');
  expect(typeof capture.trace.dataLossOccurred).toBe('boolean');
  expect(trace.traceEvents.length).toBeGreaterThan(0);
  expect(
    trace.traceEvents.some(({ name }) => name === 'perfeng.trace.action'),
  ).toBe(true);
});

test('validates trace bounds before invoking the action', async ({ page }) => {
  let invoked = false;

  await expect(
    capturePerformanceTrace(
      page,
      () => {
        invoked = true;
        return Promise.resolve();
      },
      { maxBytes: 0 },
    ),
  ).rejects.toThrow('maxBytes must be an integer between');
  expect(invoked).toBe(false);
});

test('releases CDP tracing after action and output failures', async ({
  page,
}) => {
  await page.goto('/');

  await expect(
    capturePerformanceTrace(page, () =>
      Promise.reject(new Error('owned action failed')),
    ),
  ).rejects.toThrow('owned action failed');
  await expect(
    capturePerformanceTrace(page, () => Promise.resolve(), { maxBytes: 1 }),
  ).rejects.toThrow('Chrome performance trace exceeds');

  const retry = await capturePerformanceTrace(page, () => Promise.resolve());
  expect(retry.trace.bytes.length).toBeGreaterThan(0);
});
