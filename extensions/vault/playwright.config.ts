import { defineConfig } from '@playwright/test';

/**
 * E2E-Tests der Tresor-Erweiterung in echtem Chromium (eigener Profilordner je Test, siehe
 * e2e/fixtures.ts). Alle Hostnamen zeigen auf 127.0.0.1; statt AEGIS antwortet ein harmloser
 * Test-Host mit erfundenen Zugangsdaten.
 */
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: isCI,
  reporter: isCI ? [['github']] : [['list']],
  use: { trace: 'retain-on-failure' },
});
