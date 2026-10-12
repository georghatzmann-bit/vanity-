import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Tauri erwartet einen festen Port; im Browser läuft die App mit Demo-Daten.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@shared": resolve(import.meta.dirname, "../shared"),
    },
  },
  // Tauri-Pakete vorab bündeln, damit der Browser im Entwicklungsmodus nicht neu lädt
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/api/webview",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-autostart",
      "@tauri-apps/plugin-notification",
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "..")] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        overlay: resolve(import.meta.dirname, "overlay.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
} as never);
