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

const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)(?:$|\?)/i;

/**
 * Schriften nie als data:-URI einbetten: Die CSP erlaubt Schriften nur aus 'self'
 * (font-src). Für alle anderen Dateien gilt Vites Standard-Grenze.
 */
function inlineAsset(filePath: string): boolean | undefined {
  return FONT_FILE.test(filePath) ? false : undefined;
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
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
