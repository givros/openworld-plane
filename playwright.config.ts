import { defineConfig } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function installedChromium(): string | undefined {
  if (process.env.BROWSER_EXECUTABLE) return process.env.BROWSER_EXECUTABLE;
  const directory = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : '');
  if (!directory || !existsSync(directory)) return undefined;
  const candidates = readdirSync(directory).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const candidate of candidates) {
    for (const suffix of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const executable = join(directory, candidate, suffix);
      if (existsSync(executable)) return executable;
    }
  }
  return undefined;
}

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The full-detail exports are 1.89 GB; some cases also open a fresh DPR-2 page.
  // Loading has a separate allowance from the unchanged interaction assertions.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  outputDir: 'artifacts/test-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    actionTimeout: 20_000,
    navigationTimeout: 180_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: installedChromium(),
      args: ['--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    },
  },
  webServer: process.env.BASE_URL ? undefined : {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
