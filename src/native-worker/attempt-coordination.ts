import { AcquiredNativeV2Lease } from './acquisition.js';
import { ArtifactRegistrationFailure } from './artifact-registration.js';
import { NativeArtifactUploadFailure } from './artifact-upload.js';
import {
  publishNativeV2Evidence,
  type PublishedNativeV2Evidence,
} from './evidence-publication.js';
import {
  NativeV2PhaseTransitionFailure,
  NativeV2SupervisionFailure,
  superviseNativeV2Lease,
  type NativeV2SupervisionClock,
} from './lease-supervision.js';
import {
  executeNativeLocalAttempt,
  type NativeLocalExecutionRequest,
} from './local-execution.js';
import { releaseNativeLease } from './release.js';
import { renewNativeLease } from './renewal.js';
import {
  reportNativeTerminal,
  TerminalReportFailure,
  type TerminalReportRequest,
} from './terminal.js';
import type {
  NativeTerminalAcknowledgement,
  NativeTerminalFailure,
  NativeTerminalFailureCode,
} from './types.js';
import { UploadGrantFailure } from './upload-grant.js';

export interface NativeV2AttemptRequest extends Omit<
  NativeLocalExecutionRequest,
  'onPrepared' | 'onRunnerCompleted'
> {
  controlPlaneOrigin: string;
  token: string;
}

export interface NativeV2AttemptPorts {
  execute: typeof executeNativeLocalAttempt;
  publish: typeof publishNativeV2Evidence;
  report: typeof reportNativeTerminal;
  renew: typeof renewNativeLease;
  release: typeof releaseNativeLease;
}

export type NativeV2AttemptOutcome =
  | {
      kind: 'COMPLETED';
      evidence: PublishedNativeV2Evidence;
      acknowledgement: NativeTerminalAcknowledgement;
    }
  | {
      kind: 'FAILED';
      failure: NativeTerminalFailure;
      acknowledgement: NativeTerminalAcknowledgement;
    };

const defaultPorts: NativeV2AttemptPorts = {
  execute: executeNativeLocalAttempt,
  publish: publishNativeV2Evidence,
  report: reportNativeTerminal,
  renew: renewNativeLease,
  release: releaseNativeLease,
};

type AttemptStage = 'preparing' | 'running' | 'capturing' | 'uploading';

/**
 * Owns one acquired v2 attempt through local execution, ordered publication and
 * terminal reporting. Renewal remains active through terminal acknowledgement.
 * It does not acquire, release or recover an interrupted attempt; those require
 * a separate authority decision before the worker can advertise availability.
 */
export async function coordinateNativeV2Attempt(
  request: NativeV2AttemptRequest,
  ports: NativeV2AttemptPorts = defaultPorts,
  clock?: NativeV2SupervisionClock,
): Promise<NativeV2AttemptOutcome> {
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('Native v2 attempt requires acquired v2 authority');
  }
  return superviseNativeV2Lease(
    request,
    async (lease) => {
      let stage: AttemptStage = 'preparing';
      let evidence: PublishedNativeV2Evidence;
      try {
        const local = await ports.execute({
          authority: request.authority,
          checkoutRoot: request.checkoutRoot,
          spoolRoot: request.spoolRoot,
          runnerEnvironment: request.runnerEnvironment,
          signal: lease.signal,
          timeoutMilliseconds: request.timeoutMilliseconds,
          onPrepared: () => {
            lease.advancePhase('RUNNING');
            stage = 'running';
          },
          onRunnerCompleted: () => {
            stage = 'capturing';
          },
        });
        assertActive(lease.signal);
        lease.advancePhase('UPLOADING');
        stage = 'uploading';
        evidence = await ports.publish({
          controlPlaneOrigin: request.controlPlaneOrigin,
          token: request.token,
          authority: request.authority,
          expectedRunRevision: () => lease.expectedRunRevision(),
          prepared: local.prepared,
          signal: lease.signal,
        });
        assertActive(lease.signal);
        lease.advancePhase('FINALIZING');
      } catch (error) {
        if (
          lease.signal.aborted ||
          error instanceof NativeV2PhaseTransitionFailure ||
          error instanceof NativeV2SupervisionFailure ||
          isAuthorityInterruption(error)
        ) {
          throw error;
        }
        const failure = terminalFailure(stage);
        let acknowledgement: NativeTerminalAcknowledgement;
        try {
          acknowledgement = await reportTerminalWithExactRetry(
            {
              controlPlaneOrigin: request.controlPlaneOrigin,
              token: request.token,
              authority: request.authority,
              expectedRunRevision: lease.expectedRunRevision(),
              kind: 'FAILED',
              failure,
              signal: lease.signal,
            },
            ports.report,
          );
        } catch (reportError) {
          throw new AggregateError(
            [error, reportError],
            'Native v2 attempt and terminal failure report both failed',
            { cause: reportError },
          );
        }
        return { kind: 'FAILED', failure, acknowledgement };
      }

      assertActive(lease.signal);
      const acknowledgement = await reportTerminalWithExactRetry(
        {
          controlPlaneOrigin: request.controlPlaneOrigin,
          token: request.token,
          authority: request.authority,
          expectedRunRevision: lease.expectedRunRevision(),
          kind: 'COMPLETED',
          manifest: evidence.manifest.reference,
          signal: lease.signal,
        },
        ports.report,
      );
      return { kind: 'COMPLETED', evidence, acknowledgement };
    },
    ports.renew,
    clock,
    (stopped) =>
      ports.release({
        controlPlaneOrigin: request.controlPlaneOrigin,
        token: request.token,
        authority: request.authority,
        expectedRunRevision: stopped.expectedRunRevision,
        reason: stopped.reason,
        signal: AbortSignal.timeout(
          Math.min(stopped.remainingMilliseconds, 5_000),
        ),
      }),
  );
}

/** Repeats one unchanged terminal claim only when the first response is uncertain. */
async function reportTerminalWithExactRetry(
  request: TerminalReportRequest,
  report: typeof reportNativeTerminal,
): Promise<NativeTerminalAcknowledgement> {
  try {
    return await report(request);
  } catch (error) {
    if (
      !(error instanceof TerminalReportFailure) ||
      error.kind !== 'retryable' ||
      error.retryAfterSeconds !== undefined
    ) {
      throw error;
    }
    if (request.signal?.aborted) {
      throw new NativeV2SupervisionFailure('cancelled', undefined, error);
    }
  }
  return report(request);
}

function terminalFailure(stage: AttemptStage): NativeTerminalFailure {
  const codes: Record<AttemptStage, NativeTerminalFailureCode> = {
    preparing: 'PREPARATION_FAILED',
    running: 'TOOL_FAILED',
    capturing: 'CAPTURE_FAILED',
    uploading: 'UPLOAD_FAILED',
  };
  return {
    code: codes[stage],
    message: `Native worker ${stage} failed`,
    retryable: false,
  };
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Native v2 attempt was interrupted');
  }
}

function isAuthorityInterruption(error: unknown): boolean {
  if (
    error instanceof UploadGrantFailure ||
    error instanceof ArtifactRegistrationFailure
  ) {
    return (
      error.kind === 'cancelled' ||
      error.kind === 'conflict' ||
      error.kind === 'lost'
    );
  }
  return (
    error instanceof NativeArtifactUploadFailure && error.kind === 'cancelled'
  );
}
