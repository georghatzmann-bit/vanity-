import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Die Showcase-Seite des Design-Systems (pnpm --filter @aegis/ui dev).
export default defineConfig({
  root: 'showcase',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist-showcase', emptyOutDir: true },
  test: {
    root: '.',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/*.test.*'] },
  },
});
