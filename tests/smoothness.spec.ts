import { gunzipSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { captureSmoothnessTrace } from '../src/index.js';

interface ChromeTraceEvent {
  cat?: string;
  name?: string;
}

interface ChromeTrace {
  traceEvents: ChromeTraceEvent[];
}

test('captures rendering-focused Chrome trace evidence around one action', async ({
  page,
}) => {
  await page.goto('/');

  const capture = await captureSmoothnessTrace(page, async () => {
    await page.evaluate(async () => {
      performance.mark('perfeng.smoothness.started');
      const element = document.createElement('div');
      element.style.width = '100px';
      element.style.height = '100px';
      element.style.background = 'blue';
      document.body.append(element);
      const animation = element.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }],
        { duration: 250 },
      );
      await animation.finished;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      performance.mark('perfeng.smoothness.finished');
      performance.measure(
        'perfeng.smoothness.action',
        'perfeng.smoothness.started',
        'perfeng.smoothness.finished',
      );
    });
    return 'completed';
  });
  const trace = JSON.parse(
    gunzipSync(capture.trace.bytes).toString('utf8'),
  ) as ChromeTrace;
  const renderingCategories = new Set([
    'cc',
    'devtools.timeline',
    'gpu',
    'renderer.scheduler',
    'viz',
  ]);

  expect(capture.result).toBe('completed');
  expect(capture.trace.format).toBe('chrome-trace-json-gzip');
  expect(typeof capture.trace.dataLossOccurred).toBe('boolean');
  expect(
    trace.traceEvents.some(({ cat }) =>
      cat?.split(',').some((category) => renderingCategories.has(category)),
    ),
  ).toBe(true);
  expect(trace.traceEvents.some(({ name }) => name === 'Screenshot')).toBe(
    false,
  );
});

test('validates smoothness trace bounds before invoking the action', async ({
  page,
}) => {
  let invoked = false;

  await expect(
    captureSmoothnessTrace(
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
