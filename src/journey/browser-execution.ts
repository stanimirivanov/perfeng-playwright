import type { Browser, BrowserContext, Page } from '@playwright/test';

import { validateMeasurementSet } from './measurement-set.js';
import type {
  PlaywrightMeasurement,
  RunJourneyOptions,
  Viewport,
} from './types.js';

export interface JourneyExecution {
  measurements: PlaywrightMeasurement[];
  start: Date;
  end: Date;
}

interface BrowserContextOptions {
  viewport: Viewport;
  deviceScaleFactor: number;
}

async function withNewContext<T>(
  browser: Browser,
  options: BrowserContextOptions,
  action: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext(options);
  try {
    return await action(context);
  } finally {
    await context.close();
  }
}

async function withNewPage<T>(
  context: BrowserContext,
  action: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await context.newPage();
  try {
    return await action(page);
  } finally {
    await page.close();
  }
}

export async function executeJourney(
  browser: Browser,
  options: RunJourneyOptions,
  contextOptions: BrowserContextOptions,
): Promise<JourneyExecution> {
  let expectedNames: string[] | undefined;
  const collected: PlaywrightMeasurement[] = [];
  const execute = async (page: Page, iteration?: number): Promise<void> => {
    const result = validateMeasurementSet(
      await options.journey(page),
      expectedNames,
    );
    expectedNames = result.names;
    if (iteration !== undefined) {
      collected.push(
        ...result.measurements.map((measurement) => ({
          ...measurement,
          iteration,
        })),
      );
    }
  };
  const executeInContext = (
    context: BrowserContext,
    iteration?: number,
  ): Promise<void> => withNewPage(context, (page) => execute(page, iteration));

  if (options.cacheProfile === 'warm') {
    return withNewContext(browser, contextOptions, async (context) => {
      const page =
        options.pageReuse === 'per-run' ? await context.newPage() : undefined;
      const run = (iteration?: number): Promise<void> =>
        page ? execute(page, iteration) : executeInContext(context, iteration);
      try {
        for (let index = 0; index < options.warmupIterations; index += 1) {
          await run();
        }
        const start = new Date();
        for (
          let iteration = 1;
          iteration <= options.measurementIterations;
          iteration += 1
        ) {
          await run(iteration);
        }
        return { measurements: collected, start, end: new Date() };
      } finally {
        await page?.close();
      }
    });
  }

  for (let index = 0; index < options.warmupIterations; index += 1) {
    await withNewContext(browser, contextOptions, (context) =>
      executeInContext(context),
    );
  }
  const start = new Date();
  for (
    let iteration = 1;
    iteration <= options.measurementIterations;
    iteration += 1
  ) {
    await withNewContext(browser, contextOptions, (context) =>
      executeInContext(context, iteration),
    );
  }
  return { measurements: collected, start, end: new Date() };
}
