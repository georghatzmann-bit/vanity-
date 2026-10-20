import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** Keine Datei als data:-URI einbetten (CSP erlaubt Bilder/Schriften nur aus 'self'). */
function inlineAsset(): false {
  return false;
}

// Tauri erwartet einen festen Port (Desktop-App: 5173, Browser: 5174, Setup: 5175).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5175, strictPort: true, host: '127.0.0.1' },
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
