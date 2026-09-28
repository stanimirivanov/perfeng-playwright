/** One semantic browser measurement expressed in milliseconds. */
export interface InteractionMeasurement {
  name: string;
  durationMs: number;
}

interface InteractionBase {
  metricName: string;
  /** Performs the application interaction whose semantic completion is measured. */
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

/** Selects application-assisted or DOM-observed semantic interaction timing. */
export type InteractionOptions = InstrumentedInteraction | BlackBoxInteraction;
