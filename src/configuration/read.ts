import { readFile } from 'node:fs/promises';

import { parseRunnerConfiguration } from './parse.js';
import type { RunnerConfiguration } from './types.js';

const maximumConfigurationBytes = 64 * 1024;

export async function readRunnerConfiguration(
  path: string,
): Promise<RunnerConfiguration> {
  const bytes = await readFile(path);
  if (bytes.length > maximumConfigurationBytes) {
    throw new Error('Runner configuration exceeds 64 KiB');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Runner configuration must be UTF-8');
  }
  return parseRunnerConfiguration(text);
}
