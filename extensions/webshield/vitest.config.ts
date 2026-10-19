import { defineConfig } from 'vitest/config';

// Nur Unit-Tests aus src/; e2e/ läuft mit Playwright.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
