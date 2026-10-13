#!/usr/bin/env node
/**
 * Ende-zu-Ende-Test der ECHTEN App (Rust-Backend + Oberfläche) unter Linux.
 * Startet die App über tauri-driver (WebDriver), bedient sie per Skript und macht Screenshots.
 *
 * Voraussetzungen: Linux-Build der App (npx tauri build --no-bundle in app/), tauri-driver,
 * WebKitWebDriver und ein X-Server (z. B. xvfb-run).
 *
 * Aufruf: xvfb-run -a node scripts/e2e-linux.mjs <app-binary> <ausgabe-ordner>
 *
 * Geprüft wird: Start + Intro, Datenbank, Steam-Scan (mit nachgebauter Steam-Bibliothek),
 * Hinzufügen, Starten eines Programms, Spielzeit-Erkennung, Sitzung gespeichert, Beenden,
 * Statistik, Export/Import, Seitenwechsel, Themes.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , appArg, outArg = "e2e-shots"] = process.argv;
if (!appArg || !existsSync(appArg)) {
  console.error("Bitte den Pfad zur Linux-App angeben, z. B. app/src-tauri/target/release/NovaLauncher");
  process.exit(2);
}
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });

// Eigenes, leeres Zuhause: echte Nutzerdaten bleiben unberührt
const home = mkdtempSync(join(tmpdir(), "nova-e2e-"));
const steam = join(home, ".local", "share", "Steam");
mkdirSync(join(steam, "steamapps", "common", "Portal 2"), { recursive: true });
writeFileSync(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam}"\n\t\t"apps"\n\t\t{\n\t\t\t"620"\t\t"0"\n\t\t}\n\t}\n}\n`);
writeFileSync(join(steam, "steamapps", "appmanifest_620.acf"), `"AppState"\n{\n\t"appid"\t\t"620"\n\t"name"\t\t"Portal 2"\n\t"installdir"\t\t"Portal 2"\n}\n`);
writeFileSync(join(steam, "steamapps", "appmanifest_228980.acf"), `"AppState"\n{\n\t"appid"\t\t"228980"\n\t"name"\t\t"Steamworks Common Redistributables"\n\t"installdir"\t\t"Steamworks Shared"\n}\n`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` – ${detail}` : ""}`);
};

const driver = spawn("tauri-driver", ["--port", "4444"], { env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), XDG_CONFIG_HOME: join(home, ".config") }, stdio: ["ignore", "pipe", "pipe"] });
driver.stderr.on("data", () => undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

const base = "http://127.0.0.1:4444";
async function wd(method, path, body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j).slice(0, 400)}`);
  return j.value;
}

let sid;
try {
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } });
  sid = s.sessionId;
  check("App startet über WebDriver", !!sid);

  const js = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
  const ajs = (script, args = []) => wd("POST", `/session/${sid}/execute/async`, { script, args });
  const invoke = (cmd, args = {}) =>
    ajs(`const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(v => done({ ok: true, v }), e => done({ ok: false, e: String(e) }));`, [cmd, args]);
  const shot = async (name) => {
    const b64 = await wd("GET", `/session/${sid}/screenshot`);
    writeFileSync(join(out, `${name}.png`), Buffer.from(b64, "base64"));
    console.log(`   📸 ${name}.png`);
  };

  await sleep(1200);
  await shot("01-intro");
  const introVisible = await js(`return !!document.querySelector('canvas') && document.body.innerText.includes('NOVA')`);
  check("Startanimation sichtbar", introVisible);
  await sleep(5000);
  await shot("02-start");
  const shell = await js(`return !!document.querySelector('.app-shell') && !!document.querySelector('nav')`);
  check("Hauptfenster mit Navigation geladen", shell);

  const info = await invoke("app_info");
  check("Backend antwortet (app_info)", info.ok, info.ok ? `Version ${info.v.version}, Plattform ${info.v.platform}` : info.e);

  const scan = await invoke("scan_library", { options: { steam: true, epic: false, gog: false, startMenu: false, folders: [] } });
  const names = scan.ok ? scan.v.entries.map((e) => e.name) : [];
  check("Steam-Scan findet Portal 2", names.includes("Portal 2"), scan.ok ? JSON.stringify(names) : scan.e);
  check("Steam-Scan filtert Redistributables", !names.some((n) => /Redistributable/i.test(n)));

  // Testspiel: ein Programm, das 20 Sekunden läuft
  const sleepBin = existsSync("/usr/bin/sleep") ? "/usr/bin/sleep" : "/bin/sleep";
  const game = { id: "e2e-game", name: "E2E Testspiel", kind: "game", source: "manual", launch: { type: "exe", target: sleepBin, args: "25" }, exePath: sleepBin, images: {}, favorite: true, hidden: false, status: "playing", rating: 4, notes: "", tags: ["Test"], collectionIds: [], links: { tools: [] }, addedAt: Date.now(), updatedAt: Date.now() };
  const put = await invoke("db_put", { table: "games", id: game.id, value: game });
  check("Spiel in Datenbank speichern", put.ok, put.ok ? "" : put.e);
  const list = await invoke("db_list", { table: "games" });
  check("Spiel aus Datenbank lesen", list.ok && list.v.some((g) => g.id === game.id));
  await invoke("set_tracked_games", { games: [{ gameId: game.id, name: game.name, exePath: sleepBin }] });

  const launched = await invoke("launch_game", { gameId: game.id, launch: game.launch });
  check("Spiel per Klick-Befehl starten", launched.ok, launched.ok ? "" : launched.e);
  let running = [];
  for (let i = 0; i < 12 && !running.length; i++) {
    await sleep(1000);
    const r = await invoke("running_games");
    running = r.ok ? r.v.filter((x) => x.gameId === game.id) : [];
  }
  check("„Läuft gerade“ wird erkannt", running.length > 0);
  await js(`window.location.reload()`);
  await sleep(6500);
  await shot("03-running");
  await sleep(9000);
  const stop = await invoke("stop_game", { gameId: game.id });
  check("Beenden-Knopf beendet den Prozess", stop.ok && stop.v >= 1, stop.ok ? `${stop.v} Prozess(e)` : stop.e);
  await sleep(4500);
  const stats = await invoke("playtime_stats");
  const st = stats.ok ? stats.v.find((x) => x.gameId === game.id) : null;
  check("Spielzeit gemessen und gespeichert", st && st.totalSeconds >= 10, st ? `${st.totalSeconds} s in ${st.sessions} Sitzung(en)` : stats.ok ? "keine Sitzung" : stats.e);
  const sess = await invoke("sessions_for_game", { gameId: game.id, limit: 5 });
  check("Sitzungsliste vorhanden", sess.ok && sess.v.length >= 1);

  const kv = await invoke("kv_set", { key: "settings", value: { theme: "neon", language: "de", introAnimation: false } });
  check("Einstellungen speichern", kv.ok);
  const exp = await invoke("library_export", { path: join(home, "export.json") });
  check("Bibliothek exportieren", exp.ok && existsSync(join(home, "export.json")), exp.ok ? "" : exp.e);
  const imp = await invoke("library_import", { path: join(home, "export.json"), mode: "merge" });
  check("Bibliothek importieren", imp.ok, imp.ok ? JSON.stringify(imp.v) : imp.e);
  const sys = await invoke("system_stats");
  check("PC-Auslastung lesen", sys.ok && sys.v.ramTotal > 0, sys.ok ? `CPU ${Math.round(sys.v.cpu)} %, RAM ${(sys.v.ramTotal / 1e9).toFixed(1)} GB` : sys.e);
  const backup = await invoke("backup_now");
  check("Backup erstellen", backup.ok, backup.ok ? backup.v.file : backup.e);

  await js(`window.location.reload()`);
  await sleep(4000);
  await shot("04-neon-home");
  const themed = await js(`return document.documentElement.dataset.theme`);
  check("Theme wird nach Neustart übernommen", themed === "neon", themed);
  for (const [i, label] of ["Bibliothek", "Statistik", "Einstellungen"].entries()) {
    await js(`[...document.querySelectorAll('nav button')].find(b => b.textContent.includes(arguments[0]))?.click()`, [label]);
    await sleep(1800);
    await shot(`0${5 + i}-${label.toLowerCase()}`);
    if (label === "Bibliothek") {
      const inLibrary = await js(`return document.body.innerText.includes('E2E Testspiel')`);
      check("Testspiel erscheint in der Bibliothek", inLibrary);
    }
  }
} catch (e) {
  check("Ablauf ohne Ausnahme", false, String(e).slice(0, 500));
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => undefined);
  driver.kill();
}

writeFileSync(join(out, "e2e-report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden.`);
process.exit(failed ? 1 : 0);
