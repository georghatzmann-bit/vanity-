import type { InlineConfig } from 'vitest/node';

/**
 * Zeitlimit je Test und Hook. Der Standard (5 s) reicht auf ausgelasteten CI-Runnern nicht:
 * Auf `windows-latest` brauchte der erste (kalte) Test einer Datei mit 27 jsdom-Umgebungen
 * 5,4 s und ließ CI scheitern – lokal sind es ≈ 0,3 s. Hängt ein Test wirklich, meldet er
 * sich trotzdem nach 30 s.
 */
export const TEST_TIMEOUT_MS = 30_000;

/** `CI` gesetzt und nicht ausdrücklich „aus“ (GitHub Actions setzt `CI=true`). */
export function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI?.trim().toLowerCase();
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * Vitest-Einstellungen des Design-Systems – ohne Vite-Plugins, damit sie selbst testbar sind
 * (`src/vitest-settings.test.ts`). In CI läuft immer die Abdeckung mit, damit die
 * Untergrenzen (Freigabe-Dialog ≥ 95 %) nicht nur beim manuellen `test:coverage` gelten.
 */
export function testSettings(env: Readonly<Record<string, string | undefined>>): InlineConfig {
  return {
    root: '.',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: TEST_TIMEOUT_MS,
    // Showcase-Tests prüfen die Referenz-Einbindung (z. B. inert während der Start-Animation);
    // die Abdeckungsschwelle gilt weiterhin nur für das Paket selbst (src/).
    include: ['src/**/*.test.{ts,tsx}', 'showcase/**/*.test.{ts,tsx}'],
    coverage: {
      enabled: isCi(env),
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.*', 'src/test/**'],
      // Untergrenzen: Paket ≥ 80 % (Projektziel), Komponenten ≥ 85 %, der Freigabe-Dialog
      // (Oberfläche der Goldenen Regel) ≥ 95 %.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        'src/components/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
        'src/components/ConsentDialog/**': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
      },
    },
  };
}
