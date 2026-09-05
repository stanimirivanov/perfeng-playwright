import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { assertMetricName } from './metric-name.js';

const defaultTimeoutMs = 5_000;

/** One browser-clock duration ready for the Playwright measurement artifact. */
export interface InteractionMeasurement {
  name: string;
  durationMs: number;
}

interface InteractionBase {
  metricName: string;
  action: () => Promise<void>;
  timeoutMs?: number;
}

/** Uses a PerformanceMeasure emitted by application-owned semantic marks. */
export interface InstrumentedInteraction extends InteractionBase {
  mode: 'instrumented';
  measureName: string;
}

/** Measures a DOM event through visible completion using the browser clock. */
export interface BlackBoxInteraction extends InteractionBase {
  mode: 'black-box';
  startSelector: string;
  completionSelector: string;
  startEvent?: 'click' | 'submit';
  renderFrames?: number;
}

/** Supported semantic interaction measurement strategies. */
export type InteractionOptions = InstrumentedInteraction | BlackBoxInteraction;

interface BrowserRecord {
  state: 'pending' | 'completed' | 'failed';
  durationMs?: number;
  error?: string;
  cleanup: () => void;
}

type BrowserScope = typeof globalThis & {
  __perfengInteractions?: Map<string, BrowserRecord>;
};

function validateOptions(options: InteractionOptions): number {
  assertMetricName(options.metricName);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('timeoutMs must be an integer from 1 through 60000');
  }
  if (options.mode === 'instrumented') {
    if (options.measureName.trim() === '') {
      throw new Error('measureName is required');
    }
  } else {
    if (
      options.startSelector.trim() === '' ||
      options.completionSelector.trim() === ''
    ) {
      throw new Error('Black-box selectors are required');
    }
    const renderFrames = options.renderFrames ?? 2;
    if (
      !Number.isInteger(renderFrames) ||
      renderFrames < 1 ||
      renderFrames > 10
    ) {
      throw new Error('renderFrames must be an integer from 1 through 10');
    }
  }

  return timeoutMs;
}

function measurement(name: string, durationMs: number): InteractionMeasurement {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Browser returned an invalid interaction duration');
  }

  return { name, durationMs };
}

async function measureInstrumented(
  page: Page,
  options: InstrumentedInteraction,
  timeoutMs: number,
): Promise<InteractionMeasurement> {
  await page.evaluate((name) => {
    performance.clearMeasures(name);
  }, options.measureName);
  await options.action();
  const handle = await page.waitForFunction(
    (name) => {
      const entries = performance.getEntriesByName(name, 'measure');
      return entries.length === 0 ? null : entries.at(-1)?.duration;
    },
    options.measureName,
    { timeout: timeoutMs },
  );
  try {
    const durationMs = await handle.jsonValue();
    if (durationMs === null || durationMs === undefined) {
      throw new Error(
        `Performance measure was not recorded: ${options.measureName}`,
      );
    }

    return measurement(options.metricName, durationMs);
  } finally {
    await handle.dispose();
  }
}

async function installBlackBoxObserver(
  page: Page,
  options: BlackBoxInteraction,
  token: string,
  timeoutMs: number,
): Promise<void> {
  await page.evaluate(
    ({
      completionSelector,
      renderFrames,
      startEvent,
      startSelector,
      timeout,
      id,
    }) => {
      const scope = globalThis as BrowserScope;
      const records = (scope.__perfengInteractions ??= new Map());
      const eventName = startEvent ?? 'click';
      const framesRequired = renderFrames ?? 2;
      let observer: MutationObserver | undefined;
      let startTime: number | undefined;
      let confirming = false;

      const visible = (): boolean => {
        const element = document.querySelector(completionSelector);
        if (!(element instanceof HTMLElement)) {
          return false;
        }
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return (
          !element.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          bounds.width > 0 &&
          bounds.height > 0
        );
      };
      const completionWasVisible = visible();
      const cleanup = (): void => {
        document.removeEventListener(eventName, onStart, true);
        observer?.disconnect();
        clearTimeout(timer);
      };
      const fail = (error: string): void => {
        const record = records.get(id);
        if (record?.state !== 'pending') {
          return;
        }
        record.state = 'failed';
        record.error = error;
        cleanup();
      };
      const complete = (): void => {
        const record = records.get(id);
        if (record?.state !== 'pending' || startTime === undefined) {
          return;
        }
        record.state = 'completed';
        record.durationMs = performance.now() - startTime;
        cleanup();
      };
      const confirmRendered = (): void => {
        confirming = true;
        let renderedFrames = 0;
        const confirm = (): void => {
          if (!visible()) {
            confirming = false;
            return;
          }
          renderedFrames += 1;
          if (renderedFrames >= framesRequired) {
            complete();
            return;
          }
          requestAnimationFrame(confirm);
        };
        requestAnimationFrame(confirm);
      };
      const checkCompletion = (): void => {
        if (!confirming && visible()) {
          confirmRendered();
        }
      };
      function onStart(event: Event): void {
        const target = event.target;
        if (
          !(target instanceof Element) ||
          target.closest(startSelector) === null
        ) {
          return;
        }
        document.removeEventListener(eventName, onStart, true);
        if (completionWasVisible) {
          fail('Completion element was visible before the interaction started');
          return;
        }
        startTime = performance.now();
        observer = new MutationObserver(checkCompletion);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        checkCompletion();
      }

      records.set(id, { state: 'pending', cleanup });
      document.addEventListener(eventName, onStart, true);
      const timer = window.setTimeout(() => {
        fail('Interaction measurement timed out');
      }, timeout);
    },
    {
      completionSelector: options.completionSelector,
      renderFrames: options.renderFrames,
      startEvent: options.startEvent,
      startSelector: options.startSelector,
      timeout: timeoutMs,
      id: token,
    },
  );
}

async function discardBlackBoxObserver(
  page: Page,
  token: string,
): Promise<void> {
  await page
    .evaluate((id) => {
      const scope = globalThis as BrowserScope;
      scope.__perfengInteractions?.get(id)?.cleanup();
      scope.__perfengInteractions?.delete(id);
    }, token)
    .catch(() => undefined);
}

async function measureBlackBox(
  page: Page,
  options: BlackBoxInteraction,
  timeoutMs: number,
): Promise<InteractionMeasurement> {
  const token = randomUUID();
  await installBlackBoxObserver(page, options, token, timeoutMs);
  try {
    await options.action();
    const readiness = await page.waitForFunction(
      (id) => {
        const scope = globalThis as BrowserScope;
        return scope.__perfengInteractions?.get(id)?.state !== 'pending';
      },
      token,
      { timeout: timeoutMs + 1_000 },
    );
    await readiness.dispose();
    const result = await page.evaluate((id) => {
      const scope = globalThis as BrowserScope;
      const record = scope.__perfengInteractions?.get(id);
      scope.__perfengInteractions?.delete(id);
      return record === undefined
        ? { error: 'Interaction observer was lost' }
        : { durationMs: record.durationMs, error: record.error };
    }, token);
    if (result.error !== undefined) {
      throw new Error(result.error);
    }
    if (result.durationMs === undefined) {
      throw new Error('Interaction observer returned no duration');
    }

    return measurement(options.metricName, result.durationMs);
  } catch (error) {
    await discardBlackBoxObserver(page, token);
    throw error;
  }
}

/** Measures one semantic interaction entirely on the browser performance clock. */
export async function measureInteraction(
  page: Page,
  options: InteractionOptions,
): Promise<InteractionMeasurement> {
  const timeoutMs = validateOptions(options);
  return options.mode === 'instrumented'
    ? measureInstrumented(page, options, timeoutMs)
    : measureBlackBox(page, options, timeoutMs);
}
