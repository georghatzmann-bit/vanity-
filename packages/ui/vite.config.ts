import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { testSettings } from './vitest.settings.ts';

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
  test: testSettings(process.env),
});
