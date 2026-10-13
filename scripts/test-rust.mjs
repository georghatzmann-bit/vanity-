#!/usr/bin/env node
// npm run test:rust – führt die Rust-Tests von App und Installer aus.
// Tauri bettet die fertige Oberfläche beim Kompilieren ein, daher wird sie bei Bedarf zuerst gebaut.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = process.platform === "win32";
let failed = false;
for (const [ws, crate] of [["app", "app/src-tauri"], ["installer", "installer/src-tauri"]]) {
  if (!existsSync(join(root, ws, "dist", "index.html"))) {
    console.log(`\n▶ Oberfläche bauen (${ws}), damit Tauri sie einbetten kann`);
    const b = spawnSync("npm", ["run", "build", "-w", ws], { cwd: root, stdio: "inherit", shell });
    if (b.status !== 0) process.exit(1);
  }
  console.log(`\n▶ cargo test in ${crate}`);
  const r = spawnSync("cargo", ["test", "--quiet"], { cwd: join(root, crate), stdio: "inherit", shell });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
