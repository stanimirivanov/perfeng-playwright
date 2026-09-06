export interface TracePreset {
  capability: string;
  description: string;
  categories: string[];
  enableSampling: boolean;
}

export const performanceTracePreset: TracePreset = {
  capability: 'CDP performance tracing',
  description: 'Chrome performance trace',
  enableSampling: true,
  categories: [
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'latencyInfo',
    'loading',
    'renderer.scheduler',
    'toplevel',
    'v8',
    'v8.execute',
  ],
};

export const smoothnessTracePreset: TracePreset = {
  capability: 'CDP smoothness tracing',
  description: 'Chrome smoothness trace',
  enableSampling: false,
  categories: [
    'benchmark',
    'blink.animations',
    'blink.console',
    'blink.user_timing',
    'cc',
    'devtools.timeline',
    'disabled-by-default-cc.debug',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'disabled-by-default-devtools.timeline.layers',
    'disabled-by-default-devtools.timeline.picture',
    'disabled-by-default-gpu.debug',
    'gpu',
    'input',
    'latencyInfo',
    'renderer.scheduler',
    'toplevel',
    'viz',
  ],
};
