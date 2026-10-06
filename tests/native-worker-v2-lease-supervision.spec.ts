import { expect, test } from '@playwright/test';

import type { AcquiredNativeV2Lease } from '../src/native-worker/acquisition-v2.js';
import {
  superviseNativeV2Lease,
  NativeV2SupervisionFailure,
  type NativeV2SupervisionClock,
  type NativeV2LeaseSupervisionRequest,
} from '../src/native-worker/lease-supervision-v2.js';
import {
  LeaseRenewalFailure,
  renewNativeLease,
} from '../src/native-worker/renewal.js';
import { NativeRunnerProcessFailure } from '../src/native-worker/runner-process.js';
import type { NativeLeaseRenewal } from '../src/native-worker/types.js';
import { nativeV2RawResultRequest } from './native-worker-v2-raw-result-fixture.js';

async function fixture() {
  const { authority } = await nativeV2RawResultRequest();
  const request: NativeV2LeaseSupervisionRequest = {
    controlPlaneOrigin: 'https://control-plane.perfeng.invalid',
    token: 'worker-secret',
    authority,
    signal: new AbortController().signal,
  };
  return request;
}

function renewal(
  authority: AcquiredNativeV2Lease,
  runRevision = 5,
): NativeLeaseRenewal {
  return {
    leaseId: authority.recipe.leaseId,
    attemptId: authority.recipe.attemptId,
    runRevision,
    serverTime: '2026-09-18T12:00:10Z',
    expiresAt: '2026-09-18T12:01:10Z',
    renewAfterSeconds: 5,
    cancellationRequested: false,
  };
}

function stoppedClock(): NativeV2SupervisionClock {
  return {
    monotonicNow: () => 0,
    wait: (_milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        }
      }),
  };
}

function gatedFirstTickClock(
  onFirstWait: (release: () => void) => void,
): NativeV2SupervisionClock {
  let waits = 0;
  return {
    monotonicNow: () => 0,
    wait: (_milliseconds, signal) => {
      waits++;
      if (waits === 1) {
        return new Promise<void>((resolve) => {
          onFirstWait(resolve);
        });
      }
      return stoppedClock().wait(0, signal);
    },
  };
}

function immediateFirstTickClock(): NativeV2SupervisionClock {
  let waits = 0;
  return {
    monotonicNow: () => 0,
    wait: (_milliseconds, signal) => {
      waits++;
      return waits === 1 ? Promise.resolve() : stoppedClock().wait(0, signal);
    },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function renewWith(
  values: NativeLeaseRenewal[],
  phases: string[],
): typeof renewNativeLease {
  return (request) => {
    phases.push(request.phase);
    const value = values.shift();
    return value === undefined
      ? Promise.reject(new Error('Unexpected renewal'))
      : Promise.resolve(value);
  };
}

test('renews before work, advances phases and exposes the accepted revision', async () => {
  const request = await fixture();
  const phases: string[] = [];
  let observedSignal: AbortSignal | undefined;

  const value = await superviseNativeV2Lease(
    request,
    (context) => {
      observedSignal = context.signal;
      expect(context.expectedRunRevision()).toBe(5);
      expect(context.signal.aborted).toBe(false);
      context.advancePhase('RUNNING');
      context.advancePhase('UPLOADING');
      context.advancePhase('FINALIZING');
      return Promise.resolve('completed');
    },
    renewWith([renewal(request.authority)], phases),
    stoppedClock(),
  );

  expect(value).toBe('completed');
  expect(phases).toEqual(['PREPARING']);
  expect(observedSignal?.aborted).toBe(true);
});

test('renews the current phase and updates the revision during work', async () => {
  const request = await fixture();
  const phases: string[] = [];
  let tick: (() => void) | undefined;
  const clock = gatedFirstTickClock((release) => {
    tick = release;
  });

  const result = await superviseNativeV2Lease(
    request,
    async (context) => {
      context.advancePhase('RUNNING');
      await expect.poll(() => tick).not.toBeUndefined();
      tick?.();
      await expect.poll(() => context.expectedRunRevision()).toBe(6);
      return context.expectedRunRevision();
    },
    renewWith(
      [renewal(request.authority), renewal(request.authority, 6)],
      phases,
    ),
    clock,
  );

  expect(result).toBe(6);
  expect(phases).toEqual(['PREPARING', 'RUNNING']);
});

test('server cancellation aborts work and preserves the stop deadline', async () => {
  const request = await fixture();
  const phases: string[] = [];
  let cancelledRevision = 0;
  const clock = immediateFirstTickClock();
  const cancelled: NativeLeaseRenewal = {
    ...renewal(request.authority, 6),
    cancellationRequested: true,
    stopBy: '2026-09-18T12:00:30Z',
  };

  await expect(
    superviseNativeV2Lease(
      request,
      async (context) => {
        await waitForAbort(context.signal);
        cancelledRevision = context.expectedRunRevision();
        throw new NativeRunnerProcessFailure('cancelled');
      },
      renewWith([renewal(request.authority), cancelled], phases),
      clock,
    ),
  ).rejects.toMatchObject({
    kind: 'server-cancelled',
    stopBy: '2026-09-18T12:00:30Z',
  });
  expect(cancelledRevision).toBe(6);
});

test('lost authority fails before starting work', async () => {
  const request = await fixture();
  let started = false;
  await expect(
    superviseNativeV2Lease(
      request,
      () => {
        started = true;
        return Promise.resolve();
      },
      () => Promise.reject(new LeaseRenewalFailure('lost', 'lost')),
      stoppedClock(),
    ),
  ).rejects.toMatchObject({ kind: 'lost' });
  expect(started).toBe(false);
});

test('lost authority during renewal aborts active work', async () => {
  const request = await fixture();
  let renewals = 0;
  await expect(
    superviseNativeV2Lease(
      request,
      async (context) => {
        await waitForAbort(context.signal);
        throw new NativeRunnerProcessFailure('cancelled');
      },
      () => {
        renewals++;
        return renewals === 1
          ? Promise.resolve(renewal(request.authority))
          : Promise.reject(new LeaseRenewalFailure('lost', 'lost'));
      },
      immediateFirstTickClock(),
    ),
  ).rejects.toMatchObject({ kind: 'lost' });
  expect(renewals).toBe(2);
});

test('a retryable renewal failure also stops work without an implicit retry', async () => {
  const request = await fixture();
  let renewals = 0;
  await expect(
    superviseNativeV2Lease(
      request,
      async (context) => {
        await waitForAbort(context.signal);
        throw new NativeRunnerProcessFailure('cancelled');
      },
      () => {
        renewals++;
        return renewals === 1
          ? Promise.resolve(renewal(request.authority))
          : Promise.reject(
              new LeaseRenewalFailure('temporarily unavailable', 'retryable'),
            );
      },
      immediateFirstTickClock(),
    ),
  ).rejects.toMatchObject({ kind: 'renewal' });
  expect(renewals).toBe(2);
});

test('preserves a process termination failure alongside lease interruption', async () => {
  const request = await fixture();
  let renewals = 0;
  const failure = await superviseNativeV2Lease(
    request,
    async (context) => {
      await waitForAbort(context.signal);
      throw new NativeRunnerProcessFailure('termination');
    },
    () => {
      renewals++;
      return renewals === 1
        ? Promise.resolve(renewal(request.authority))
        : Promise.reject(new LeaseRenewalFailure('lost', 'lost'));
    },
    immediateFirstTickClock(),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toMatchObject([
    { kind: 'lost' },
    { kind: 'termination' },
  ]);
});

test('a renewal response received after its server lifetime cannot start work', async () => {
  const request = await fixture();
  let elapsed = 0;
  let started = false;
  const clock: NativeV2SupervisionClock = {
    monotonicNow: () => elapsed,
    wait: (milliseconds, signal) => stoppedClock().wait(milliseconds, signal),
  };

  await expect(
    superviseNativeV2Lease(
      request,
      () => {
        started = true;
        return Promise.resolve();
      },
      () => {
        elapsed = 61_000;
        return Promise.resolve(renewal(request.authority));
      },
      clock,
    ),
  ).rejects.toMatchObject({ kind: 'expired' });
  expect(started).toBe(false);
});

test('expiry after a delayed wake aborts work without another renewal', async () => {
  const request = await fixture();
  let elapsed = 0;
  let renewals = 0;
  const clock: NativeV2SupervisionClock = {
    monotonicNow: () => elapsed,
    wait: () => {
      elapsed = 61_000;
      return Promise.resolve();
    },
  };

  await expect(
    superviseNativeV2Lease(
      request,
      async (context) => {
        await waitForAbort(context.signal);
        throw new NativeRunnerProcessFailure('cancelled');
      },
      () => {
        renewals++;
        return Promise.resolve(renewal(request.authority));
      },
      clock,
    ),
  ).rejects.toMatchObject({ kind: 'expired' });
  expect(renewals).toBe(1);
});

test('rejects skipped phases and propagates an operation failure', async () => {
  const request = await fixture();
  const failure = new Error('local evidence was invalid');

  await expect(
    superviseNativeV2Lease(
      request,
      (context) => {
        expect(() => {
          context.advancePhase('UPLOADING');
        }).toThrow('phase transition is invalid');
        return Promise.reject(failure);
      },
      renewWith([renewal(request.authority)], []),
      stoppedClock(),
    ),
  ).rejects.toBe(failure);
});

test('does not renew or run work after prior shutdown', async () => {
  const request = await fixture();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(
    superviseNativeV2Lease(
      { ...request, signal: controller.signal },
      () => {
        calls++;
        return Promise.resolve();
      },
      () => {
        calls++;
        return Promise.resolve(renewal(request.authority));
      },
      stoppedClock(),
    ),
  ).rejects.toBeInstanceOf(NativeV2SupervisionFailure);
  expect(calls).toBe(0);
});

test('does not start work if shutdown arrives during initial renewal', async () => {
  const request = await fixture();
  const controller = new AbortController();
  let started = false;
  await expect(
    superviseNativeV2Lease(
      { ...request, signal: controller.signal },
      () => {
        started = true;
        return Promise.resolve();
      },
      () => {
        controller.abort();
        return Promise.resolve(renewal(request.authority));
      },
      stoppedClock(),
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  expect(started).toBe(false);
});

test('shutdown during work aborts the callback before returning', async () => {
  const request = await fixture();
  const controller = new AbortController();
  await expect(
    superviseNativeV2Lease(
      { ...request, signal: controller.signal },
      async (context) => {
        controller.abort();
        await waitForAbort(context.signal);
        throw new NativeRunnerProcessFailure('cancelled');
      },
      renewWith([renewal(request.authority)], []),
      stoppedClock(),
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
});
