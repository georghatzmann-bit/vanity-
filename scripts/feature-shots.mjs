// Screenshots aller Funktionen im Browser (Demo-Daten) für docs/FUNKTIONEN.md.
// Aufruf: node scripts/feature-shots.mjs [app-url] [installer-url] [ausgabe-ordner]
// Vorher starten: npm run dev (Port 1420) und npm run dev:installer (Port 1421)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("/opt/node22/lib/node_modules/playwright"); }
const [, , appUrl = "http://localhost:1420/", setupUrl = "http://localhost:1421/", out = "docs/screenshots/funktionen"] = process.argv;
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const watch = (page) => {
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
};
const shotter = (page) => async (name, wait = 1300) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 86 });
  console.log("📸", name);
};

// ---------- App ----------
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "de-DE" });
watch(page);
const shot = shotter(page);
const ev = (js) => page.evaluate(js);
const go = (route) => ev(`window.__pulsar.useUI.getState().navigate(${JSON.stringify(route)})`);
const settings = (patch) => ev(`window.__pulsar.useSettings.getState().update(${JSON.stringify(patch)})`);
const scrollMain = (y) => ev(`document.querySelectorAll('main *').forEach(e => { if (e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY.match(/auto|scroll/)) e.scrollTop = ${y}; }); document.querySelectorAll('main > div').forEach(d => d.scrollTop = ${y});`);
const click = (text) => page.getByRole("button", { name: text }).first().click();
// Knöpfe in der Karte „Netzwerk automatisch optimieren“ (eindeutig, z. B. „Schließen“ gibt es auch in der Titelleiste)
const card = (text) => page.locator('section[aria-labelledby="netauto-title"]').getByRole("button", { name: text }).first().click();
const dismissToasts = () => ev(`window.__pulsar.useUI.getState().toasts.forEach(t => window.__pulsar.useUI.getState().dismiss(t.id))`);

await page.goto(appUrl, { waitUntil: "networkidle" });
await shot("01-intro", 1500);
await page.waitForTimeout(4200);
await settings({ theme: "pulsar", language: "de" });
await page.waitForTimeout(1500);
await ev(`window.__pulsar.useUI.getState().toasts.forEach(t => window.__pulsar.useUI.getState().dismiss(t.id))`);
await shot("02-cockpit", 2500);
await scrollMain(560);
await shot("02b-cockpit-kuerzlich-gespielt", 1200);
await scrollMain(0);
await page.mouse.move(1268, 575);
await shot("03-cockpit-boost-hover", 600);
await page.mouse.move(1300, 120);
await ev(`window.__pulsar.useBoost.getState().toggle()`);
await shot("04-cockpit-boost-aktiv", 1800);
await ev(`window.__pulsar.useBoost.getState().toggle()`);
await page.waitForTimeout(600);

await go({ page: "games" });
await shot("05-spiele", 2500);
await page.mouse.move(600, 440);
await shot("06-spiele-hover", 700);
await page.mouse.move(1300, 120);
await page.getByRole("button", { name: /Favoriten/ }).first().click();
await shot("07-spiele-favoriten", 900);
await page.getByRole("button", { name: /Favoriten/ }).first().click();
await page.getByPlaceholder(/durchsuchen/i).fill("counter");
await shot("08-spiele-suche", 900);
await page.getByPlaceholder(/durchsuchen/i).fill("");

const cs2 = await ev(`window.__pulsar.useLibrary.getState().games.find(g => /counter/i.test(g.name))?.id || window.__pulsar.useLibrary.getState().games[0].id`);
await go({ page: "game", id: cs2 });
await shot("09-spiel-uebersicht", 1800);
await scrollMain(520);
await shot("10-spiel-messziel", 900);
await scrollMain(0);
await go({ page: "game", id: cs2, section: "reports" });
await shot("11-spiel-berichte", 1200);
await go({ page: "game", id: cs2, section: "settings" });
await shot("12-spiel-einstellungen", 1200);

await go({ page: "network", section: "regions" });
await shot("13-netzwerk-regionen", 1500);
await click(/Alle messen/);
await shot("14-netzwerk-regionen-gemessen", 4500);
await go({ page: "network", section: "route" });
await click(/Route analysieren/);
await shot("15-netzwerk-route", 5500);
await go({ page: "network", section: "dns" });
await shot("16-netzwerk-dns", 1200);
await click(/DNS-Dienste vergleichen/);
await shot("17-netzwerk-dns-ergebnis", 6000);
await click(/Schnellsten einstellen/);
await shot("17b-netzwerk-dns-eingestellt", 1800);
// Für die Optimieren-Aufnahmen wieder zurück auf den DNS vom Router
await click(/^Zurückstellen$/);
await page.waitForTimeout(1500);
await dismissToasts();
await go({ page: "network", section: "speed" });
await click(/Speedtest starten/);
await shot("18-netzwerk-speedtest-laeuft", 3500);
await shot("19-netzwerk-speedtest-ergebnis", 9000);
await go({ page: "network", section: "connection" });
await shot("20-netzwerk-verbindung", 1500);

await go({ page: "optimize" });
await shot("21-optimieren", 1500);
await card(/Jetzt prüfen/);
await shot("21b-optimieren-netzwerk-auto", 4500);
await card(/Jetzt einstellen/);
await shot("21c-optimieren-netzwerk-fertig", 1800);
await card(/Schließen/);
await page.waitForTimeout(600);
await click(/Alle empfohlenen anwenden/);
await shot("22-optimieren-angewendet", 1500);

await go({ page: "reports" });
await shot("23-berichte", 1800);

await go({ page: "settings" });
await shot("24-einstellungen-aussehen", 1500);
await go({ page: "settings", section: "monitor" });
await shot("25-einstellungen-messung", 1200);
await go({ page: "settings", section: "overlay" });
await shot("26-einstellungen-overlay", 1200);
await go({ page: "settings", section: "about" });
await shot("27-einstellungen-ueber", 1200);

await go({ page: "cockpit" });
await page.waitForTimeout(600);
await ev(`window.__pulsar.useUI.getState().setPalette(true)`);
await page.keyboard.type("speed");
await shot("28-befehlspalette", 800);
await page.keyboard.press("Escape");
await ev(`window.__pulsar.useUI.getState().setScan(true)`);
await shot("29-spiele-suchen", 800);
await page.keyboard.press("Escape");
await ev(`window.__pulsar.useUI.getState().setManual(true)`);
await shot("30-manuell-hinzufuegen", 800);
await page.keyboard.press("Escape");
await ev(`window.__pulsar.useLibrary.getState().launch(window.__pulsar.useLibrary.getState().games.find(g => g.id === "${cs2}"), { boost: true })`);
await shot("31-boost-und-spielen", 900);
await page.waitForTimeout(2500);

for (const theme of ["ember", "toxic", "frost"]) {
  await settings({ theme });
  await shot(`32-theme-${theme}`, 1000);
}
await settings({ theme: "pulsar" });
await page.waitForTimeout(900);

// Overlay (eigenes kleines Fenster)
const ov = await browser.newPage({ viewport: { width: 340, height: 150 }, locale: "de-DE" });
watch(ov);
await ov.goto(appUrl.replace(/\/$/, "") + "/overlay.html", { waitUntil: "networkidle" });
await shotter(ov)("33-overlay", 2500);
await ov.close();
await page.close();

// ---------- Installer ----------
const run = async (query, steps) => {
  const p = await browser.newPage({ viewport: { width: 980, height: 640 }, locale: "de-DE" });
  watch(p);
  p.on("dialog", (d) => d.accept());
  await p.goto(setupUrl + query, { waitUntil: "networkidle" });
  await steps(p, shotter(p));
  await p.close();
};
await run("", async (p, s) => {
  await s("40-setup-intro", 1400);
  await s("41-setup-willkommen", 3000);
  await p.getByRole("button", { name: /Los geht/ }).click();
  await s("42-setup-ordner", 1200);
  await p.getByRole("button", { name: /^Weiter/ }).click();
  await s("43-setup-optionen");
  await p.getByRole("button", { name: /Installieren/ }).click();
  await s("44-setup-download", 2200);
  await s("45-setup-fertig", 5500);
});
await run("?fail=1", async (p, s) => {
  await p.waitForTimeout(3600);
  await p.getByRole("button", { name: /Los geht/ }).click();
  await p.waitForTimeout(700);
  await p.getByRole("button", { name: /^Weiter/ }).click();
  await p.waitForTimeout(700);
  await p.getByRole("button", { name: /Installieren/ }).click();
  await s("46-setup-fehler", 3200);
});
await run("?mode=maintenance", async (p, s) => {
  await s("47-setup-wartung", 3800);
  await p.getByRole("button", { name: /Deinstallieren/ }).first().click();
  await s("48-setup-deinstallieren", 900);
});

await browser.close();
if (errors.length) {
  console.error("\nFehler in der Konsole:\n" + [...new Set(errors)].join("\n"));
  process.exit(1);
}
console.log("\nKeine Fehler in der Konsole.");
