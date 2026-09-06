import type { Page } from '@playwright/test';

interface BrowserRecord {
  state: 'pending' | 'completed' | 'failed';
  durationMs?: number;
  error?: string;
  cleanup: () => void;
}

type BrowserScope = typeof globalThis & {
  __perfengInteractions?: Map<string, BrowserRecord>;
};

export interface BlackBoxObserverOptions {
  id: string;
  startSelector: string;
  completionSelector: string;
  startEvent: 'click' | 'submit' | undefined;
  renderFrames: number | undefined;
  timeoutMs: number;
}

export interface BlackBoxResult {
  durationMs: number | undefined;
  error: string | undefined;
}

export async function installBlackBoxObserver(
  page: Page,
  options: BlackBoxObserverOptions,
): Promise<void> {
  await page.evaluate(
    ({
      completionSelector,
      renderFrames,
      startEvent,
      startSelector,
      timeoutMs,
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
      }, timeoutMs);
    },
    options,
  );
}

export async function waitForBlackBoxResult(
  page: Page,
  token: string,
  timeoutMs: number,
): Promise<BlackBoxResult> {
  const readiness = await page.waitForFunction(
    (id) => {
      const scope = globalThis as BrowserScope;
      return scope.__perfengInteractions?.get(id)?.state !== 'pending';
    },
    token,
    { timeout: timeoutMs + 1_000 },
  );
  await readiness.dispose();
  return page.evaluate((id) => {
    const scope = globalThis as BrowserScope;
    const record = scope.__perfengInteractions?.get(id);
    scope.__perfengInteractions?.delete(id);
    return record === undefined
      ? {
          durationMs: undefined,
          error: 'Interaction observer was lost',
        }
      : { durationMs: record.durationMs, error: record.error };
  }, token);
}

export async function discardBlackBoxObserver(
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
