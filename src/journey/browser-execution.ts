import type { Browser, BrowserContext, Page } from '@playwright/test';

import { captureMemoryComparison } from '../memory/capture.js';
import { executeIteration } from './iteration-execution.js';
import { validateMeasurementSet } from './measurement-set.js';
import type {
  IterationPageObservation,
  IterationPerformanceTrace,
  JourneyMemoryCapture,
  PlaywrightMeasurement,
  RunJourneyOptions,
  Viewport,
} from './types.js';

export interface JourneyExecution {
  measurements: PlaywrightMeasurement[];
  observations: IterationPageObservation[];
  trace?: IterationPerformanceTrace;
  memory?: JourneyMemoryCapture;
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
  const observations: IterationPageObservation[] = [];
  let trace: IterationPerformanceTrace | undefined;
  let memory: JourneyMemoryCapture | undefined;
  const execute = async (page: Page, iteration?: number): Promise<void> => {
    const execution = await executeIteration(page, options, iteration);
    const result = validateMeasurementSet(
      execution.measurements,
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
      if (execution.observation !== undefined) {
        observations.push({ iteration, observation: execution.observation });
      }
      if (execution.trace !== undefined) {
        if (trace !== undefined) {
          throw new Error('Journey produced more than one performance trace');
        }
        trace = execution.trace;
      }
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
        if (options.diagnosticMode === 'memory') {
          if (page === undefined || options.captureIterations === undefined) {
            throw new Error('Memory diagnostic lifecycle was not initialized');
          }
          const first = options.captureIterations[0];
          const last = options.captureIterations.at(-1);
          if (first === undefined || last === undefined) {
            throw new Error('Memory capture iterations were not initialized');
          }
          for (let iteration = 1; iteration < first; iteration += 1) {
            await run(iteration);
          }
          const captured = await captureMemoryComparison(page, async () => {
            for (let iteration = first; iteration <= last; iteration += 1) {
              await run(iteration);
            }
          });
          memory = {
            captureIterations: [...options.captureIterations],
            before: captured.before,
            after: captured.after,
          };
          for (
            let iteration = last + 1;
            iteration <= options.measurementIterations;
            iteration += 1
          ) {
            await run(iteration);
          }
        } else {
          for (
            let iteration = 1;
            iteration <= options.measurementIterations;
            iteration += 1
          ) {
            await run(iteration);
          }
        }
        const execution: JourneyExecution = {
          measurements: collected,
          observations,
          start,
          end: new Date(),
        };
        if (trace !== undefined) {
          execution.trace = trace;
        }
        if (memory !== undefined) {
          execution.memory = memory;
        }
        return execution;
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
  const execution: JourneyExecution = {
    measurements: collected,
    observations,
    start,
    end: new Date(),
  };
  if (trace !== undefined) {
    execution.trace = trace;
  }
  return execution;
}
