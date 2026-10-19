import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { cspFromTauriConfig } from './src/csp.ts';
import tauriConfig from './src-tauri/tauri.conf.json' with { type: 'json' };

/**
 * Dieselbe CSP wie im Tauri-Fenster – einzige Quelle ist tauri.conf.json (app.security.csp).
 * Wird beim Laden der Konfiguration gebildet; fehlt die CSP, startet die Vorschau nicht.
 */
const contentSecurityPolicy = cspFromTauriConfig(tauriConfig);

/**
 * Keine Datei als data:-URI einbetten: Die CSP erlaubt Bilder und Schriften nur aus 'self'
 * (img-src/font-src ohne data:). Jede Datei wird deshalb als eigene Datei ausgeliefert.
 */
function inlineAsset(): false {
  return false;
}

// Tauri erwartet einen festen Port und keine Bildschirm-Löschung (siehe Tauri-Doku).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  // Vorschau des Produktions-Builds (Playwright): gleiche CSP wie die App.
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
    headers: { 'Content-Security-Policy': contentSecurityPolicy },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome120',
    sourcemap: false,
    assetsInlineLimit: inlineAsset,
    rolldownOptions: {
      output: {
        // Fremdbibliotheken (React, Motion, Tauri-API) getrennt von App und Design-System –
        // kleinere Pakete, besseres Caching, keine Warnung zur Paketgröße.
        codeSplitting: {
          groups: [{ name: 'vendor', test: /[\\/]node_modules[\\/]/ }],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
  },
});
