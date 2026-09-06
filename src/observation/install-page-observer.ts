import type {
  ObservationWindow,
  PageEntryObserver,
  PageObservationState,
} from './page-state.js';

export function installPageObserver(): void {
  const target = window as ObservationWindow;
  if (target.__perfengPageObservation?.active === true) {
    return;
  }
  const state: PageObservationState = {
    active: true,
    startedAt: new Date().toISOString(),
    startedPerformanceMs: performance.now(),
    observers: [],
    largestContentfulPaint: null,
    layoutShiftCount: 0,
    cumulativeLayoutShift: 0,
    longTaskDurations: [],
    eventDurations: [],
    interactionDurations: [],
    frameIntervals: [],
    lastFrameTime: null,
    frameRequest: 0,
  };
  target.__perfengPageObservation = state;

  const observe = (
    type: string,
    receive: PageEntryObserver['receive'],
  ): void => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) {
      return;
    }
    const record: PageEntryObserver['receive'] = (entry) => {
      if (entry.startTime >= state.startedPerformanceMs) {
        receive(entry);
      }
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        record(entry as PerformanceEntry & Record<string, unknown>);
      }
    });
    const options: PerformanceObserverInit & { durationThreshold?: number } = {
      type,
      buffered: true,
    };
    if (type === 'event') {
      options.durationThreshold = 16;
    }
    observer.observe(options);
    state.observers.push({ observer, receive: record });
  };

  observe('largest-contentful-paint', (entry) => {
    state.largestContentfulPaint = {
      startTimeMs: entry.startTime,
      size: typeof entry.size === 'number' ? entry.size : 0,
    };
  });
  observe('layout-shift', (entry) => {
    if (entry.hadRecentInput !== true && typeof entry.value === 'number') {
      state.layoutShiftCount += 1;
      state.cumulativeLayoutShift += entry.value;
    }
  });
  observe('longtask', (entry) => state.longTaskDurations.push(entry.duration));
  observe('event', (entry) => {
    state.eventDurations.push(entry.duration);
    if (typeof entry.interactionId === 'number' && entry.interactionId > 0) {
      state.interactionDurations.push(entry.duration);
    }
  });

  const frame = (time: number): void => {
    if (!state.active) {
      return;
    }
    if (state.lastFrameTime !== null) {
      state.frameIntervals.push(time - state.lastFrameTime);
    }
    state.lastFrameTime = time;
    state.frameRequest = requestAnimationFrame(frame);
  };
  state.frameRequest = requestAnimationFrame(frame);
}
