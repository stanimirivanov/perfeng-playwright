import { createRequire } from 'node:module';

import type { Browser } from '@playwright/test';

const playwrightPackage = createRequire(import.meta.url)(
  '@playwright/test/package.json',
) as { version: string };

export function runtimePlatform(): 'linux' | 'darwin' | 'win32' {
  if (
    process.platform === 'linux' ||
    process.platform === 'darwin' ||
    process.platform === 'win32'
  ) {
    return process.platform;
  }
  throw new Error(`Unsupported runtime platform: ${process.platform}`);
}

export function runtimeArchitecture(): 'x64' | 'arm64' {
  if (process.arch === 'x64' || process.arch === 'arm64') {
    return process.arch;
  }
  throw new Error(`Unsupported runtime architecture: ${process.arch}`);
}

export function browserName(
  browser: Browser,
): 'chromium' | 'firefox' | 'webkit' {
  const name = browser.browserType().name();
  if (name === 'chromium' || name === 'firefox' || name === 'webkit') {
    return name;
  }
  throw new Error(`Unsupported browser: ${name}`);
}

export function playwrightVersion(): string {
  return playwrightPackage.version;
}
