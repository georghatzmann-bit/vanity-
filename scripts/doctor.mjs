#!/usr/bin/env node
/**
 * npm run doctor  –  prüft, ob alles zum Bauen von NOVA installiert ist,
 * und sagt in einfachen Worten, was fehlt.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
let problems = 0;

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s, fix) => {
  problems++;
  console.log(`  \x1b[31m✖\x1b[0m ${s}\n      → ${fix}`);
};
const out = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin });
  return r.status === 0 ? (r.stdout || r.stderr).trim() : null;
};

console.log("\n✦ NOVA – Werkzeug-Check\n");

const node = process.versions.node.split(".").map(Number);
if (node[0] >= 20) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js ${process.versions.node} ist zu alt`, "Node.js 20 oder neuer installieren: https://nodejs.org");

const cargo = out("cargo", ["--version"]);
if (cargo) ok(cargo);
else bad("Rust fehlt", "Rust installieren: https://rustup.rs (Standard-Optionen), danach neues Fenster öffnen");

if (isWin) {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  const vs = existsSync(vswhere) ? out(`"${vswhere}"`, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "displayName"]) : null;
  if (vs) ok(`C++-Build-Tools: ${vs}`);
  else bad("Microsoft C++ Build Tools fehlen", "„Build Tools für Visual Studio“ installieren und „Desktopentwicklung mit C++“ anhaken: https://visualstudio.microsoft.com/de/visual-cpp-build-tools/");
} else {
  const targets = out("rustup", ["target", "list", "--installed"]) ?? "";
  if (targets.includes("x86_64-pc-windows-msvc")) ok("Rust-Ziel x86_64-pc-windows-msvc");
  else bad("Rust-Ziel für Windows fehlt", "rustup target add x86_64-pc-windows-msvc");
  const xwin = out("cargo", ["xwin", "--version"]);
  if (xwin) ok(xwin);
  else bad("cargo-xwin fehlt", "cargo install --locked cargo-xwin");
  if (out("clang", ["--version"])) ok("clang");
  else bad("clang fehlt", "z. B. sudo apt install clang lld llvm");
}

if (existsSync(join(root, "node_modules"))) ok("npm-Pakete installiert");
else bad("npm-Pakete fehlen", "Im Projektordner ausführen: npm install");

console.log(problems ? `\n${problems} Punkt(e) offen. Danach: npm run build:all\n` : "\nAlles bereit! Jetzt: npm run build:all\n");
process.exit(problems ? 1 : 0);
