import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Die Showcase-Seite des Design-Systems (pnpm --filter @aegis/ui dev).
export default defineConfig({
  root: 'showcase',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist-showcase',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Fremdbibliotheken (React, Motion) getrennt vom Design-System – kleinere Pakete,
        // besseres Caching und keine Warnung zur Paketgröße.
        codeSplitting: {
          groups: [{ name: 'vendor', test: /[\\/]node_modules[\\/]/ }],
        },
      },
    },
  },
  test: {
    root: '.',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Showcase-Tests prüfen die Referenz-Einbindung (z. B. inert während der Start-Animation);
    // die Abdeckungsschwelle gilt weiterhin nur für das Paket selbst (src/).
    include: ['src/**/*.test.{ts,tsx}', 'showcase/**/*.test.{ts,tsx}'],
    coverage: {
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
  },
});
