#!/usr/bin/env node
/**
 * Baut NOVA komplett:  npm run build:all
 *
 *  1. Übernimmt die Versionsnummer aus nova.config.json in alle Projektdateien
 *  2. Baut die App      -> release/NovaLauncher.exe
 *  3. Baut den Installer -> release/NovaLauncher-Setup.exe
 *  4. Schreibt release/latest.json (Version, Download-Links, SHA-256-Prüfsummen)
 *
 * Unter Windows wird direkt gebaut. Unter Linux/macOS wird für Windows
 * cross-kompiliert (benötigt: rustup target x86_64-pc-windows-msvc + cargo-xwin).
 *
 * Optionen:  --app-only   --setup-only   --skip-version-sync
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const config = JSON.parse(readFileSync(join(root, "nova.config.json"), "utf8"));
const version = String(config.version);
const releaseDir = join(root, "release");

const c = { cyan: (s) => `\x1b[36m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.cyan("▶")} ${c.bold(s)}`);
const fail = (msg, hint) => {
  console.error(`\n${c.red("✖ " + msg)}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

function run(cmd, cmdArgs, cwd) {
  console.log(c.dim(`  $ ${cmd} ${cmdArgs.join(" ")}  (in ${cwd.replace(root, ".") || "."})`));
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: isWin, env: { ...process.env, CI: process.env.CI ?? "" } });
  if (r.error) fail(`Konnte "${cmd}" nicht starten: ${r.error.message}`, "Ist das Programm installiert? Tipp: npm run doctor");
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(" ")}" ist fehlgeschlagen (Exit-Code ${r.status}).`, "Die Fehlermeldung steht weiter oben.");
}

function has(cmd, testArgs = ["--version"]) {
  const r = spawnSync(cmd, testArgs, { stdio: "ignore", shell: isWin });
  return r.status === 0;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Versionsnummer überall eintragen (eine Quelle: nova.config.json) */
function syncVersion() {
  step(`Version ${version} in alle Projektdateien übernehmen`);
  const jsonFiles = ["package.json", "app/package.json", "installer/package.json", "app/src-tauri/tauri.conf.json", "installer/src-tauri/tauri.conf.json"];
  for (const f of jsonFiles) {
    const p = join(root, f);
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.version !== version) {
      j.version = version;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
      console.log(c.dim(`  ${f} -> ${version}`));
    }
  }
  for (const f of ["app/src-tauri/Cargo.toml", "installer/src-tauri/Cargo.toml"]) {
    const p = join(root, f);
    const txt = readFileSync(p, "utf8");
    const next = txt.replace(/^(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
    if (next !== txt) {
      writeFileSync(p, next);
      console.log(c.dim(`  ${f} -> ${version}`));
    }
  }
}

function checkTools() {
  step("Werkzeuge prüfen");
  if (!has("cargo")) fail("Rust (cargo) wurde nicht gefunden.", "Installieren: https://rustup.rs  – danach ein neues Terminal öffnen.");
  if (!isWin) {
    const targets = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" }).stdout ?? "";
    if (!targets.includes("x86_64-pc-windows-msvc")) fail("Das Windows-Ziel für Rust fehlt.", "Einmalig ausführen:  rustup target add x86_64-pc-windows-msvc");
    if (!has("cargo", ["xwin", "--version"])) fail("cargo-xwin fehlt (wird zum Bauen für Windows unter Linux gebraucht).", "Einmalig ausführen:  cargo install --locked cargo-xwin");
  }
  if (!existsSync(join(root, "node_modules"))) {
    step("Abhängigkeiten installieren (npm install)");
    run("npm", ["install"], root);
  }
  console.log(c.green("  ✓ alles da"));
}

/** Eine Tauri-App bauen und den Pfad der fertigen Exe liefern */
function buildTauri(project, exeName) {
  const dir = join(root, project);
  const tauriArgs = ["tauri", "build", "--no-bundle", "--ci"];
  if (!isWin) tauriArgs.push("--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc");
  run("npx", tauriArgs, dir);
  const targetDir = join(dir, "src-tauri", "target");
  const candidates = isWin
    ? [join(targetDir, "release", exeName), join(targetDir, "x86_64-pc-windows-msvc", "release", exeName)]
    : [join(targetDir, "x86_64-pc-windows-msvc", "release", exeName)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) fail(`Die fertige Datei ${exeName} wurde nicht gefunden.`, `Gesucht in:\n   ${candidates.join("\n   ")}`);
  return found;
}

function fileEntry(file, name) {
  return { url: `${String(config.downloadBaseUrl).replace(/\/?$/, "/")}${name}`, sha256: sha256(file), size: statSync(file).size };
}

// ---------------------------------------------------------------------------
const started = Date.now();
console.log(c.bold(`\n✦ NOVA Build ${version}  ${c.dim(isWin ? "(Windows)" : `(${process.platform} → Windows-Cross-Compile)`)}`));
if (!args.has("--skip-version-sync")) syncVersion();
checkTools();
mkdirSync(releaseDir, { recursive: true });

const appOut = join(releaseDir, config.appExeName);
const setupOut = join(releaseDir, config.setupExeName);

if (!args.has("--setup-only")) {
  step("App bauen (Nova Launcher)");
  copyFileSync(buildTauri("app", config.appExeName), appOut);
}
if (!args.has("--app-only")) {
  step("Installer bauen (Nova Setup)");
  copyFileSync(buildTauri("installer", config.setupExeName), setupOut);
}

step("latest.json schreiben");
const manifest = {
  name: config.appName,
  version,
  notes: process.env.NOVA_RELEASE_NOTES ?? `NOVA ${version}`,
  pubDate: new Date().toISOString(),
};
if (existsSync(appOut)) manifest.app = fileEntry(appOut, config.appExeName);
if (existsSync(setupOut)) manifest.setup = fileEntry(setupOut, config.setupExeName);
if (!manifest.app) fail("release/NovaLauncher.exe fehlt – ohne App kann keine latest.json erzeugt werden.", "Ohne --setup-only bauen.");
writeFileSync(join(releaseDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(
  join(releaseDir, "SHA256SUMS.txt"),
  [manifest.app, manifest.setup]
    .filter(Boolean)
    .map((e) => `${e.sha256}  ${e.url.split("/").pop()}`)
    .join("\n") + "\n",
);

const mb = (p) => (existsSync(p) ? `${(statSync(p).size / 1048576).toFixed(1)} MB` : "–");
console.log(`\n${c.green("✔ Fertig")} in ${Math.round((Date.now() - started) / 1000)} s\n`);
console.log(`  App:        ${appOut}  ${c.dim(mb(appOut))}`);
console.log(`  Setup:      ${setupOut}  ${c.dim(mb(setupOut))}`);
console.log(`  Manifest:   ${join(releaseDir, "latest.json")}`);
console.log(`\n  ${c.dim("Hochladen: alle drei Dateien in ein GitHub-Release (siehe docs/ANLEITUNG.md).")}\n`);
