import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = import.meta.dirname;
const mainPage = path.resolve(root, "index.html");
// The splash window (tauri.conf.json, label "splash") always loads splash.html – it must ship in
// dist/ as its own page next to index.html. Without it Tauri would fall back to index.html and load
// the whole app inside the small splash window, so a missing file stops the build.
const splashPage = path.resolve(root, "splash.html");
if (!fs.existsSync(splashPage)) {
  throw new Error("[rift] launcher/splash.html is missing – the splash window in tauri.conf.json needs it.");
}

// Tauri expects a fixed port and should not watch the Rust files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    // The launcher loads from disk, big files are no problem
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: mainPage, splash: splashPage },
    },
  },
});
