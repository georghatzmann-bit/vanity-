import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
      "@shared": resolve(import.meta.dirname, "../shared"),
    },
  },
  optimizeDeps: {
    include: ["@tauri-apps/api/core", "@tauri-apps/api/event", "@tauri-apps/api/window", "@tauri-apps/plugin-dialog"],
  },
  server: {
    port: 1421,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "..")] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
