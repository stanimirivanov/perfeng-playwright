import type { JourneyExecution } from '../journey/browser-execution.js';
import type {
  BrowserObservations,
  RunJourneyOptions,
} from '../journey/types.js';

export function browserObservations(
  options: RunJourneyOptions,
  execution: JourneyExecution,
  createdAt: string,
): BrowserObservations | undefined {
  if (options.diagnosticMode !== 'lightweight') {
    return undefined;
  }
  const first = execution.observations[0];
  const last = execution.observations.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Lightweight capture produced no page observations');
  }
  return {
    schemaVersion: 1,
    kind: 'BrowserObservations',
    runId: options.runId,
    testId: options.testId,
    workload: { ...options.workload },
    environment: {
      profile: { ...options.environment.profile },
      fingerprint: options.environment.fingerprint,
    },
    execution: {
      mode: 'lightweight',
      contextReuse:
        options.cacheProfile === 'warm' ? 'per-run' : 'per-iteration',
      pageReuse: options.pageReuse,
      captureIterations: execution.observations.map(
        ({ iteration }) => iteration,
      ),
    },
    captureWindow: {
      start: first.observation.startedAt,
      end: last.observation.finishedAt,
    },
    observations: execution.observations,
    createdAt,
  };
}
