export interface PageObservationState {
  active: boolean;
  startedAt: string;
  startedPerformanceMs: number;
  observers: PageEntryObserver[];
  largestContentfulPaint: { startTimeMs: number; size: number } | null;
  layoutShiftCount: number;
  cumulativeLayoutShift: number;
  longTaskDurations: number[];
  eventDurations: number[];
  interactionDurations: number[];
  frameIntervals: number[];
  lastFrameTime: number | null;
  frameRequest: number;
}

export interface PageEntryObserver {
  observer: PerformanceObserver;
  receive: (entry: PerformanceEntry & Record<string, unknown>) => void;
}

export type ObservationWindow = Window &
  typeof globalThis & {
    __perfengPageObservation?: PageObservationState;
  };
