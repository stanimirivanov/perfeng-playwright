import { spawn } from 'node:child_process';

const maximumExecutionMilliseconds = 4 * 60 * 60 * 1_000;
const terminationWaitMilliseconds = 10_000;

export type NativeRunnerProcessFailureKind =
  'launch' | 'exit' | 'cancelled' | 'timeout' | 'termination';

export class NativeRunnerProcessFailure extends Error {
  readonly kind: NativeRunnerProcessFailureKind;

  constructor(kind: NativeRunnerProcessFailureKind) {
    super(`Native runner process ${kind}`);
    this.name = 'NativeRunnerProcessFailure';
    this.kind = kind;
  }
}

export interface NativeRunnerProcessRequest {
  executable: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMilliseconds: number;
}

/** Rejects an invalid execution bound before attempt state is created. */
export function validateNativeRunnerTimeout(timeoutMilliseconds: number): void {
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > maximumExecutionMilliseconds
  ) {
    throw new Error(
      'Native runner process timeout is outside supported bounds',
    );
  }
}

/**
 * Runs one reviewed runner command without a shell or inherited output streams.
 *
 * The caller owns command and environment validation. Cancellation waits for
 * process-tree termination before it settles. The child leads a dedicated Linux
 * process group.
 */
export async function runNativeRunnerProcess(
  request: NativeRunnerProcessRequest,
): Promise<void> {
  validateNativeRunnerTimeout(request.timeoutMilliseconds);
  if (request.signal.aborted) {
    throw new NativeRunnerProcessFailure('cancelled');
  }

  const timeout = AbortSignal.timeout(request.timeoutMilliseconds);
  const cancellation = AbortSignal.any([request.signal, timeout]);
  let child;
  try {
    child = spawn(request.executable, [...request.arguments], {
      cwd: request.workingDirectory,
      env: request.environment,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
  } catch {
    throw new NativeRunnerProcessFailure('launch');
  }
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => {
      reject(new NativeRunnerProcessFailure('launch'));
    });
    child.once('close', (code) => {
      resolve(code);
    });
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => {
      resolve('aborted');
    };
    if (cancellation.aborted) {
      onAbort();
    } else {
      cancellation.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    const outcome = await Promise.race([
      closed.then((code) => ({ kind: 'closed' as const, code })),
      aborted.then(() => ({ kind: 'aborted' as const })),
    ]);
    if (outcome.kind === 'closed' && !cancellation.aborted) {
      if (outcome.code !== 0) {
        throw new NativeRunnerProcessFailure('exit');
      }
      return;
    }
    const pid = child.pid;
    if (pid === undefined) {
      await closed;
      throw new NativeRunnerProcessFailure('launch');
    }
    const failureKind = cancellationKind(request.signal);
    try {
      terminateProcessTree(pid);
      await waitForClose(closed);
    } catch {
      throw new NativeRunnerProcessFailure('termination');
    }
    throw new NativeRunnerProcessFailure(failureKind);
  } finally {
    if (onAbort !== undefined) {
      cancellation.removeEventListener('abort', onAbort);
    }
  }
}

function terminateProcessTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function waitForClose(closed: Promise<number | null>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new NativeRunnerProcessFailure('termination'));
    }, terminationWaitMilliseconds);
    closed.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        reject(new NativeRunnerProcessFailure('termination'));
      },
    );
  });
}

function cancellationKind(signal: AbortSignal): 'cancelled' | 'timeout' {
  return signal.aborted ? 'cancelled' : 'timeout';
}
