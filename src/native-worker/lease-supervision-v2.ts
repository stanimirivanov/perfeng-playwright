import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

import { AcquiredNativeV2Lease } from './acquisition-v2.js';
import { LeaseRenewalFailure, renewNativeLease } from './renewal.js';
import type { NativeExecutionPhase, NativeLeaseRenewal } from './types.js';

const phases: readonly NativeExecutionPhase[] = [
  'PREPARING',
  'RUNNING',
  'UPLOADING',
  'FINALIZING',
];

export type NativeV2SupervisionFailureKind =
  'cancelled' | 'server-cancelled' | 'lost' | 'expired' | 'renewal';

/** A fail-closed lease interruption; no terminal or release claim is implied. */
export class NativeV2SupervisionFailure extends Error {
  readonly kind: NativeV2SupervisionFailureKind;
  readonly stopBy?: string;

  constructor(
    kind: NativeV2SupervisionFailureKind,
    stopBy?: string,
    cause?: unknown,
  ) {
    super(`Native v2 lease supervision ${kind}`, { cause });
    this.name = 'NativeV2SupervisionFailure';
    this.kind = kind;
    if (stopBy !== undefined) {
      this.stopBy = stopBy;
    }
  }
}

/** The attempt callback tried to skip, repeat or reverse an execution phase. */
export class NativeV2PhaseTransitionFailure extends Error {
  constructor() {
    super('Native v2 attempt phase transition is invalid');
    this.name = 'NativeV2PhaseTransitionFailure';
  }
}

export interface NativeV2LeaseSupervisionRequest {
  controlPlaneOrigin: string;
  token: string;
  authority: AcquiredNativeV2Lease;
  signal: AbortSignal;
}

/** Authority access for one active attempt; the callback owns phase transitions. */
export interface NativeV2LeaseContext {
  signal: AbortSignal;
  expectedRunRevision(): number;
  advancePhase(next: NativeExecutionPhase): void;
}

export interface NativeV2SupervisionClock {
  monotonicNow(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

/** A bounded release opportunity after abort-aware work has settled. */
export interface NativeV2StoppedLease {
  reason: 'CANCELLATION_REQUESTED' | 'WORKER_SHUTDOWN';
  expectedRunRevision: number;
  remainingMilliseconds: number;
}

const defaultClock: NativeV2SupervisionClock = {
  monotonicNow: () => performance.now(),
  wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

type Outcome<T> =
  { kind: 'success'; value: T } | { kind: 'failure'; error: unknown };

/**
 * Keeps one acquired v2 lease current for an abort-aware attempt callback.
 * Renewal is immediate and then server-paced. Any failed renewal stops work;
 * release, terminal reporting and recovery remain the caller's responsibility.
 * The callback must settle after its signal aborts, including process-tree stop.
 */
export async function superviseNativeV2Lease<T>(
  request: NativeV2LeaseSupervisionRequest,
  work: (context: NativeV2LeaseContext) => Promise<T>,
  renew: typeof renewNativeLease = renewNativeLease,
  clock: NativeV2SupervisionClock = defaultClock,
  onStopped?: (stopped: NativeV2StoppedLease) => Promise<void>,
): Promise<T> {
  if (!(request.authority instanceof AcquiredNativeV2Lease)) {
    throw new Error('V2 lease supervision requires acquired v2 authority');
  }
  if (request.signal.aborted) {
    throw new NativeV2SupervisionFailure('cancelled');
  }
  const stop = new AbortController();
  const interrupted = new AbortController();
  const workSignal = AbortSignal.any([request.signal, interrupted.signal]);
  const waitSignal = AbortSignal.any([request.signal, stop.signal]);
  let phase: NativeExecutionPhase = 'PREPARING';
  let revision = request.authority.recipe.runRevision;
  let expiryDeadline = 0;
  let cancellationDeadline = 0;
  let renewAfterMilliseconds = 0;

  const accept = (value: NativeLeaseRenewal, sentAt: number): void => {
    if (
      value.leaseId !== request.authority.recipe.leaseId ||
      value.attemptId !== request.authority.recipe.attemptId ||
      value.runRevision < revision
    ) {
      throw new NativeV2SupervisionFailure('lost');
    }
    revision = value.runRevision;
    const lifetime = Date.parse(value.expiresAt) - Date.parse(value.serverTime);
    if (
      !Number.isFinite(lifetime) ||
      lifetime <= value.renewAfterSeconds * 1_000 ||
      !Number.isSafeInteger(value.renewAfterSeconds) ||
      value.renewAfterSeconds < 5 ||
      value.renewAfterSeconds > 300
    ) {
      throw new NativeV2SupervisionFailure('renewal');
    }
    expiryDeadline = sentAt + lifetime;
    renewAfterMilliseconds = Math.max(
      0,
      sentAt + value.renewAfterSeconds * 1_000 - clock.monotonicNow(),
    );
    if (clock.monotonicNow() >= expiryDeadline) {
      throw new NativeV2SupervisionFailure('expired');
    }
    if (value.cancellationRequested) {
      const stopInterval =
        Date.parse(value.stopBy) - Date.parse(value.serverTime);
      if (
        !Number.isFinite(stopInterval) ||
        stopInterval <= 0 ||
        stopInterval > lifetime
      ) {
        throw new NativeV2SupervisionFailure('renewal');
      }
      cancellationDeadline = sentAt + stopInterval;
      throw new NativeV2SupervisionFailure('server-cancelled', value.stopBy);
    }
  };
  const renewOnce = async (): Promise<void> => {
    const sentAt = clock.monotonicNow();
    try {
      accept(
        await renew({
          controlPlaneOrigin: request.controlPlaneOrigin,
          token: request.token,
          authority: request.authority,
          expectedRunRevision: revision,
          phase,
          signal: workSignal,
        }),
        sentAt,
      );
    } catch (error) {
      throw classifyRenewal(error, request.signal);
    }
  };

  const releaseStopped = async (
    interruption: NativeV2SupervisionFailure,
  ): Promise<void> => {
    if (onStopped === undefined) {
      return;
    }
    const reason =
      interruption.kind === 'server-cancelled'
        ? 'CANCELLATION_REQUESTED'
        : interruption.kind === 'cancelled'
          ? 'WORKER_SHUTDOWN'
          : undefined;
    if (reason === undefined) {
      return;
    }
    const deadline =
      reason === 'CANCELLATION_REQUESTED'
        ? Math.min(expiryDeadline, cancellationDeadline)
        : expiryDeadline;
    const remainingMilliseconds = Math.floor(deadline - clock.monotonicNow());
    if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) {
      return;
    }
    try {
      await onStopped({
        reason,
        expectedRunRevision: revision,
        remainingMilliseconds,
      });
    } catch (error) {
      throw new AggregateError(
        [interruption, error],
        'Native v2 interruption and release both failed',
        { cause: error },
      );
    }
  };

  try {
    await renewOnce();
  } catch (error) {
    if (error instanceof NativeV2SupervisionFailure) {
      await releaseStopped(error);
    }
    throw error;
  }
  if (isAborted(request.signal)) {
    const interruption = new NativeV2SupervisionFailure('cancelled');
    await releaseStopped(interruption);
    throw interruption;
  }
  const context: NativeV2LeaseContext = {
    signal: workSignal,
    expectedRunRevision: () => revision,
    advancePhase: (next) => {
      const currentIndex = phases.indexOf(phase);
      if (workSignal.aborted) {
        throw new NativeV2SupervisionFailure('cancelled');
      }
      if (clock.monotonicNow() >= expiryDeadline) {
        throw new NativeV2SupervisionFailure('expired');
      }
      if (phases[currentIndex + 1] !== next) {
        throw new NativeV2PhaseTransitionFailure();
      }
      phase = next;
    },
  };
  const renewal = observe(async () => {
    while (!isAborted(stop.signal)) {
      try {
        await clock.wait(renewAfterMilliseconds, waitSignal);
      } catch (error) {
        if (isAborted(stop.signal)) {
          return;
        }
        if (isAborted(request.signal)) {
          throw new NativeV2SupervisionFailure('cancelled');
        }
        throw error;
      }
      if (isAborted(stop.signal)) {
        return;
      }
      if (isAborted(request.signal)) {
        throw new NativeV2SupervisionFailure('cancelled');
      }
      if (clock.monotonicNow() >= expiryDeadline) {
        throw new NativeV2SupervisionFailure('expired');
      }
      await renewOnce();
    }
  });
  const attempted = observe(() => work(context));
  const winner = await Promise.race([
    attempted.then((outcome) => ({ source: 'work' as const, outcome })),
    renewal.then((outcome) => ({ source: 'renewal' as const, outcome })),
  ]);
  if (winner.source === 'renewal') {
    interrupted.abort();
    const workOutcome = await attempted;
    if (winner.outcome.kind === 'failure') {
      if (
        workOutcome.kind === 'failure' &&
        !isCancellation(workOutcome.error)
      ) {
        throw new AggregateError(
          [winner.outcome.error, workOutcome.error],
          'Native v2 lease interruption and work termination both failed',
        );
      }
      if (winner.outcome.error instanceof NativeV2SupervisionFailure) {
        await releaseStopped(winner.outcome.error);
      }
      throw winner.outcome.error;
    }
    throw new NativeV2SupervisionFailure('cancelled');
  }

  stop.abort();
  const renewalOutcome = await renewal;
  interrupted.abort();
  if (renewalOutcome.kind === 'failure') {
    if (
      winner.outcome.kind === 'failure' &&
      !isCancellation(winner.outcome.error)
    ) {
      throw new AggregateError(
        [renewalOutcome.error, winner.outcome.error],
        'Native v2 renewal and work both failed',
      );
    }
    if (
      renewalOutcome.error instanceof NativeV2SupervisionFailure &&
      winner.outcome.kind === 'failure' &&
      isCancellation(winner.outcome.error)
    ) {
      await releaseStopped(renewalOutcome.error);
    }
    throw renewalOutcome.error;
  }
  if (isAborted(request.signal)) {
    const interruption = new NativeV2SupervisionFailure('cancelled');
    if (
      winner.outcome.kind === 'failure' &&
      isCancellation(winner.outcome.error)
    ) {
      await releaseStopped(interruption);
    }
    throw interruption;
  }
  if (clock.monotonicNow() >= expiryDeadline) {
    throw new NativeV2SupervisionFailure('expired');
  }
  if (winner.outcome.kind === 'failure') {
    throw winner.outcome.error;
  }
  return winner.outcome.value;
}

function observe<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  return Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ kind: 'success' as const, value }),
      (error: unknown) => ({ kind: 'failure' as const, error }),
    );
}

function classifyRenewal(
  error: unknown,
  signal: AbortSignal,
): NativeV2SupervisionFailure {
  if (error instanceof NativeV2SupervisionFailure) {
    return error;
  }
  if (signal.aborted) {
    return new NativeV2SupervisionFailure('cancelled');
  }
  if (
    error instanceof LeaseRenewalFailure &&
    (error.kind === 'lost' || error.kind === 'conflict')
  ) {
    return new NativeV2SupervisionFailure('lost', undefined, error);
  }
  return new NativeV2SupervisionFailure('renewal', undefined, error);
}

function isCancellation(error: unknown): boolean {
  return (
    (error instanceof Error && 'kind' in error && error.kind === 'cancelled') ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
