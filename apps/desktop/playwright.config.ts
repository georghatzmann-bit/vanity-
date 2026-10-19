import { defineConfig, devices } from '@playwright/test';

/**
 * E2E-Tests gegen den Produktions-Build (`vite preview`), der dieselbe CSP sendet wie das
 * Tauri-Fenster (siehe vite.config.ts). Nur Chromium – WebView2 basiert ebenfalls darauf.
 * Browser: im Container über PLAYWRIGHT_BROWSERS_PATH, in CI per `playwright install`.
 */
const host = '127.0.0.1';
const port = 4173;
const baseURL = `http://${host}:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // Die Tests messen Zeiten (z. B. Überspringen < 600 ms) – nacheinander statt um CPU
  // konkurrierend, damit die Messungen aussagekräftig bleiben.
  fullyParallel: false,
  workers: 1,
  // Keine Wiederholungen: Ein wackliger Test soll auffallen, nicht verdeckt werden.
  retries: 0,
  forbidOnly: isCI,
  reporter: isCI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'de-DE',
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // Gleiche Fenstergröße wie das Tauri-Hauptfenster (tauri.conf.json).
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
