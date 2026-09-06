import type { ObservationWindow } from './page-state.js';
import type {
  JavaScriptHeapObservation,
  NavigationObservation,
  PageObservation,
  ResourceSummary,
} from './types.js';

export function snapshotPageObserver(): PageObservation {
  const maximum = (values: number[]): number =>
    values.length === 0 ? 0 : Math.max(...values);
  const percentile95 = (values: number[]): number | null => {
    if (values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
  };
  const target = window as ObservationWindow;
  const state = target.__perfengPageObservation;
  if (state?.active !== true) {
    throw new Error('Page observation is not active');
  }
  state.active = false;
  cancelAnimationFrame(state.frameRequest);
  for (const { observer, receive } of state.observers) {
    for (const entry of observer.takeRecords()) {
      receive(entry as PerformanceEntry & Record<string, unknown>);
    }
    observer.disconnect();
  }

  const navigationEntry = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const navigation: NavigationObservation | null = navigationEntry
    ? {
        dnsMs:
          navigationEntry.domainLookupEnd - navigationEntry.domainLookupStart,
        connectMs: navigationEntry.connectEnd - navigationEntry.connectStart,
        tlsMs:
          navigationEntry.secureConnectionStart > 0
            ? navigationEntry.connectEnd - navigationEntry.secureConnectionStart
            : 0,
        requestToFirstByteMs:
          navigationEntry.responseStart - navigationEntry.requestStart,
        responseMs: navigationEntry.responseEnd - navigationEntry.responseStart,
        domInteractiveMs: navigationEntry.domInteractive,
        domContentLoadedMs: navigationEntry.domContentLoadedEventEnd,
        loadMs: navigationEntry.loadEventEnd,
        transferSize: navigationEntry.transferSize,
        encodedBodySize: navigationEntry.encodedBodySize,
        decodedBodySize: navigationEntry.decodedBodySize,
      }
    : null;
  const resources = performance.getEntriesByType(
    'resource',
  ) as PerformanceResourceTiming[];
  const resourceSummary: ResourceSummary = {
    count: resources.length,
    totalDurationMs: resources.reduce(
      (total, entry) => total + entry.duration,
      0,
    ),
    transferSize: resources.reduce(
      (total, entry) => total + entry.transferSize,
      0,
    ),
    encodedBodySize: resources.reduce(
      (total, entry) => total + entry.encodedBodySize,
      0,
    ),
    decodedBodySize: resources.reduce(
      (total, entry) => total + entry.decodedBodySize,
      0,
    ),
  };
  const paints = performance.getEntriesByType('paint').map((entry) => ({
    name: entry.name,
    startTimeMs: entry.startTime,
  }));
  const performanceWithMemory = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };
  const memory = performanceWithMemory.memory;
  const javascriptHeap: JavaScriptHeapObservation | null = memory
    ? {
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      }
    : null;

  return {
    schema: 'browser-page-observation/v1',
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    supportedEntryTypes: [...PerformanceObserver.supportedEntryTypes].sort(),
    navigation,
    paints,
    largestContentfulPaint: state.largestContentfulPaint,
    layoutShifts: {
      count: state.layoutShiftCount,
      cumulativeScore: state.cumulativeLayoutShift,
    },
    longTasks: {
      count: state.longTaskDurations.length,
      totalDurationMs: state.longTaskDurations.reduce(
        (total, value) => total + value,
        0,
      ),
      maximumDurationMs: maximum(state.longTaskDurations),
    },
    events: {
      count: state.eventDurations.length,
      maximumDurationMs: maximum(state.eventDurations),
      maximumInteractionDurationMs:
        state.interactionDurations.length === 0
          ? null
          : maximum(state.interactionDurations),
    },
    resources: resourceSummary,
    animationFrames: {
      count: state.frameIntervals.length,
      maximumIntervalMs:
        state.frameIntervals.length === 0
          ? null
          : maximum(state.frameIntervals),
      p95IntervalMs: percentile95(state.frameIntervals),
      intervalsOver50Ms: state.frameIntervals.filter(
        (duration) => duration > 50,
      ).length,
    },
    javascriptHeap,
  };
}
