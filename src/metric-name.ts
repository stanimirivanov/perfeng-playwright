const metricNamePattern = /^ui\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*_ms$/;

export function assertMetricName(name: string): void {
  if (!metricNamePattern.test(name)) {
    throw new Error(`Invalid interaction metric name: ${name}`);
  }
}
