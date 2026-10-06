import type { PlaywrightMeasurements } from '../journey/types.js';
import type { NativeExecutionRecipe } from './execution-recipe.js';

/** Checks the measurement identity projected from an acquired v2 recipe. */
export function validateV2MeasurementIdentity(
  recipe: NativeExecutionRecipe,
  measurements: PlaywrightMeasurements,
): void {
  const configuration = recipe.configuration;
  const identityMatches =
    measurements.runId === recipe.runId &&
    measurements.testId === configuration.testId;
  const workloadMatches =
    measurements.workload.id === configuration.workload.id &&
    measurements.workload.version === configuration.workload.version &&
    measurements.workload.profile === configuration.workload.profile &&
    measurements.workload.sha256 === configuration.workload.sha256;
  const scenarioMatches =
    measurements.scenario.cacheProfile ===
      configuration.scenario.cacheProfile &&
    measurements.scenario.contextReuse ===
      (configuration.scenario.cacheProfile === 'warm'
        ? 'per-run'
        : 'per-iteration') &&
    measurements.scenario.pageReuse === configuration.scenario.pageReuse &&
    measurements.scenario.warmupIterations ===
      configuration.scenario.warmupIterations &&
    measurements.scenario.measurementIterations ===
      configuration.scenario.measurementIterations &&
    measurements.diagnosticMode === configuration.diagnosticMode;
  const environmentMatches =
    measurements.environment.profile.id ===
      configuration.environment.profile.id &&
    measurements.environment.profile.version ===
      configuration.environment.profile.version &&
    measurements.environment.fingerprint ===
      configuration.environment.fingerprint &&
    measurements.runtime.platform === 'win32';
  const browserMatches =
    measurements.browser.name === 'chromium' &&
    measurements.browser.headless === configuration.browser.headless &&
    measurements.browser.viewport.width ===
      configuration.browser.viewport.width &&
    measurements.browser.viewport.height ===
      configuration.browser.viewport.height &&
    measurements.browser.deviceScaleFactor ===
      configuration.browser.deviceScaleFactor;
  if (
    !identityMatches ||
    !workloadMatches ||
    !scenarioMatches ||
    !environmentMatches ||
    !browserMatches
  ) {
    throw new Error('Measurements do not match the native v2 execution recipe');
  }
}
