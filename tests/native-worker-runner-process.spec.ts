import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  NativeRunnerProcessFailure,
  runNativeRunnerProcess,
} from '../src/native-worker/runner-process.js';

function request(script: string, signal = new AbortController().signal) {
  return {
    executable: process.execPath,
    arguments: ['-e', script],
    workingDirectory: process.cwd(),
    environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    signal,
    timeoutMilliseconds: 5_000,
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

test('runs without a shell or inherited worker credentials', async ({}, testInfo) => {
  const output = testInfo.outputPath('environment.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({value:process.env.RUNNER_VALUE,token:process.env.PERFENG_NATIVE_WORKER_TOKEN}));`;
  await runNativeRunnerProcess({
    ...request(script),
    environment: { RUNNER_VALUE: 'reviewed value' },
  });

  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
    value: 'reviewed value',
  });
});

test('classifies launch and nonzero exit without leaking child output', async () => {
  const missing = request('');
  await expect(
    runNativeRunnerProcess({
      ...missing,
      executable: 'perfeng-missing-executable',
    }),
  ).rejects.toMatchObject({ kind: 'launch' });
  const secret = 'private-child-output';
  const error = await runNativeRunnerProcess(
    request(`process.stderr.write(${JSON.stringify(secret)});process.exit(17)`),
  ).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(NativeRunnerProcessFailure);
  expect(error).toMatchObject({ kind: 'exit' });
  expect(String(error)).not.toContain(secret);
});

test('rejects invalid bounds and does not launch after prior cancellation', async ({}, testInfo) => {
  const marker = testInfo.outputPath('not-launched');
  const controller = new AbortController();
  controller.abort();
  await expect(
    runNativeRunnerProcess(
      request(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`,
        controller.signal,
      ),
    ),
  ).rejects.toMatchObject({ kind: 'cancelled' });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(
    runNativeRunnerProcess({ ...request(''), timeoutMilliseconds: 0 }),
  ).rejects.toThrow('outside supported bounds');
});

test('bounds execution time and stops the owned child', async ({}, testInfo) => {
  const marker = testInfo.outputPath('child-pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000);`;
  await expect(
    runNativeRunnerProcess({ ...request(script), timeoutMilliseconds: 500 }),
  ).rejects.toMatchObject({ kind: 'timeout' });
  const pid = Number(await readFile(marker, 'utf8'));
  await expect.poll(() => isRunning(pid)).toBe(false);
});

test('cancellation stops the parent and its descendant before settling', async ({}, testInfo) => {
  const marker = testInfo.outputPath('process-tree.json');
  const descendant = `setInterval(()=>{},1000)`;
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const running = runNativeRunnerProcess(request(script, controller.signal));
  try {
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(marker, 'utf8')) as unknown;
        } catch {
          return undefined;
        }
      })
      .toMatchObject({ parent: expect.any(Number), child: expect.any(Number) });
    const { parent, child } = JSON.parse(await readFile(marker, 'utf8')) as {
      parent: number;
      child: number;
    };
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: 'cancelled' });
    await expect.poll(() => isRunning(parent)).toBe(false);
    await expect.poll(() => isRunning(child)).toBe(false);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
  }
});
