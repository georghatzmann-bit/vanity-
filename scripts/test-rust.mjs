#!/usr/bin/env node
// npm run test:rust – führt die Rust-Tests von App und Installer aus.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
for (const p of ["app/src-tauri", "installer/src-tauri"]) {
  console.log(`\n▶ cargo test in ${p}`);
  const r = spawnSync("cargo", ["test", "--quiet"], { cwd: join(root, p), stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
