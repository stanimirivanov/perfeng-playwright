import type {
  PresenceInputs,
  WorkerArchitecture,
  WorkerPresence,
} from './types.js';

const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function createWorkerPresence(inputs: PresenceInputs): WorkerPresence {
  if (!semanticVersionPattern.test(inputs.agentVersion)) {
    throw new Error('Native worker agent version is invalid');
  }
  if (inputs.platform !== 'win32') {
    throw new Error('Native worker presence requires Windows');
  }
  const architecture = workerArchitecture(inputs.architecture);
  const { configuration, source } = inputs;

  return {
    protocolVersion: 1,
    agentVersion: inputs.agentVersion,
    availability: 'UNAVAILABLE',
    capabilities: {
      capacity: 1,
      tool: 'playwright',
      operatingSystem: 'windows',
      architecture,
      browsers: [...configuration.browsers],
      runnerContract: 1,
      executionArtifacts: ['source-checkout'],
      artifactKinds: ['measurements', 'diagnostics'],
      diagnosticModes: ['lightweight', 'trace', 'heap'],
    },
    qualificationEvidence: {
      environmentId: configuration.environment.id,
      environmentSha256: configuration.environment.sha256,
      runner: {
        kind: 'source-checkout',
        repository: source.repository,
        revision: source.gitSha,
        lockfile: source.dependencyLock.path,
        lockfileSha256: source.dependencyLock.sha256,
      },
    },
  };
}

function workerArchitecture(value: string): WorkerArchitecture {
  if (value === 'x64' || value === 'arm64') {
    return value;
  }

  throw new Error('Native worker architecture is unsupported');
}
