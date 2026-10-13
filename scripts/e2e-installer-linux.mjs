#!/usr/bin/env node
/**
 * Ende-zu-Ende-Test des ECHTEN Installers (Oberfläche + Rust-Backend) unter Linux.
 * Ein lokaler Download-Server liefert die App, bricht die Verbindung einmal bei ~45 % ab
 * (Test für "Fortsetzen") und drosselt das Tempo, damit Fortschritt sichtbar wird.
 *
 * Aufruf: xvfb-run -a node scripts/e2e-installer-linux.mjs <installer-binary> <nutzlast-datei> <ausgabe-ordner>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [, , binArg, payloadArg, outArg = "e2e-setup"] = process.argv;
const bin = resolve(binArg);
const payload = readFileSync(resolve(payloadArg));
const sha = createHash("sha256").update(payload).digest("hex");
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` – ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Download-Server mit Range-Unterstützung, Drosselung und einem Abbruch
let requests = [];
let dropped = false;
const server = createServer((req, res) => {
  requests.push({ url: req.url, range: req.headers.range ?? null });
  if (req.url === "/latest.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "1.0.0", notes: "E2E", app: { url: "Pulsar.exe", sha256: sha, size: payload.length } }));
    return;
  }
  if (req.url !== "/Pulsar.exe") {
    res.writeHead(404).end();
    return;
  }
  let start = 0;
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
  if (m) start = Number(m[1]);
  const headers = { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": payload.length - start, etag: '"e2e"' };
  if (m) res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}` });
  else res.writeHead(200, headers);
  let pos = start;
  const chunk = 96 * 1024;
  const timer = setInterval(() => {
    if (!dropped && pos > payload.length * 0.45) {
      dropped = true;
      clearInterval(timer);
      req.socket.destroy();
      return;
    }
    const end = Math.min(payload.length, pos + chunk);
    res.write(payload.subarray(pos, end));
    pos = end;
    if (pos >= payload.length) {
      clearInterval(timer);
      res.end();
    }
  }, 30);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => server.listen(8799, "127.0.0.1", r));

const home = mkdtempSync(join(tmpdir(), "pulsar-setup-e2e-"));
const installDir = join(home, "Programme", "Pulsar");
const driver = spawn("tauri-driver", ["--port", "4447", "--native-port", "4448"], {
  env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PULSAR_MANIFEST_URL: "http://127.0.0.1:8799/latest.json", LANG: "de_DE.UTF-8" },
  stdio: "ignore",
});
await sleep(1500);
const base = "http://127.0.0.1:4447";
async function wd(method, path, body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}

let sid;
try {
  sid = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: bin } } } })).sessionId;
  check("Installer startet", !!sid);
  const js = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
  const shot = async (name) => {
    writeFileSync(join(out, `${name}.png`), Buffer.from(await wd("GET", `/session/${sid}/screenshot`), "base64"));
    console.log(`   📸 ${name}.png`);
  };
  const click = (text) => js(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(arguments[0])); if(b){b.click(); return true} return false`, [text]);
  const text = () => js(`return document.body.innerText`);

  await sleep(1200);
  await shot("01-intro");
  check("Intro mit Logo", (await text()).includes("PULSAR"));
  await sleep(3200);
  await shot("02-willkommen");
  const welcome = await text();
  check("Willkommen-Seite mit Version aus dem Manifest", welcome.includes("1.0.0") || welcome.includes("Version"), welcome.slice(0, 80).replace(/\n/g, " "));
  check("Weiter zum Speicherort", await click("Los geht"));
  await sleep(1200);
  // Installationsordner setzen (React-kontrolliertes Eingabefeld)
  await js(
    `const i=document.querySelector('input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, arguments[0]); i.dispatchEvent(new Event('input',{bubbles:true}));`,
    [installDir],
  );
  await sleep(1200);
  await shot("03-ordner");
  check("Speicherplatz wird angezeigt", /Frei|Free/.test(await text()));
  check("Weiter zu den Optionen", await click("Weiter"));
  await sleep(1000);
  await shot("04-optionen");
  // "Nach Installation starten" aus, damit der Test nichts startet
  await js(`const c=[...document.querySelectorAll('[role=button]')].find(x=>x.textContent.includes('danach starten')||x.textContent.includes('afterwards')); c && c.click();`);
  check("Installation starten", await click("Installieren"));
  await sleep(1500);
  await shot("05-download");
  let state = "";
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const t = await text();
    if (/Erneut versuchen|Try again/.test(t)) {
      state = "error";
      await shot("06-abbruch");
      check("Verbindungsabbruch wird angezeigt (mit „Erneut versuchen“)", true);
      await click("Erneut versuchen");
    }
    if (/bereit|ready/i.test(t)) {
      state = "done";
      break;
    }
  }
  await sleep(1500);
  await shot("07-fertig");
  check("Installation abgeschlossen", state === "done");
  const ranged = requests.filter((r) => r.url === "/Pulsar.exe" && r.range);
  check("Download nach Abbruch fortgesetzt (Range-Anfrage)", dropped && ranged.length >= 1, `${requests.filter((r) => r.url === "/Pulsar.exe").length} Anfragen, ${ranged.length} mit Range`);
  const installed = join(installDir, "Pulsar.exe");
  const ok = existsSync(installed) && createHash("sha256").update(readFileSync(installed)).digest("hex") === sha;
  check("App-Datei installiert und Prüfsumme stimmt", ok, installed);
  check("Deinstaller und install.json angelegt", existsSync(join(installDir, "Uninstall Pulsar.exe")) && existsSync(join(installDir, "install.json")));
} catch (e) {
  check("Ablauf ohne Ausnahme", false, String(e).slice(0, 400));
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => undefined);
  driver.kill();
  server.close();
}
writeFileSync(join(out, "e2e-setup-report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden.`);
process.exit(failed ? 1 : 0);
