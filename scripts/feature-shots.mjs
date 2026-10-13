// Screenshots aller Funktionen im Browser (Demo-Daten) für docs/FUNKTIONEN.md.
// Aufruf: node scripts/feature-shots.mjs [app-url] [installer-url] [ausgabe-ordner]
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
const nova = (js) => page.evaluate(js);
const go = (route) => nova(`window.__nova.useUI.getState().navigate(${JSON.stringify(route)})`);
const setTheme = (theme, extra = "") => nova(`window.__nova.useSettings.getState().update({ theme: "${theme}"${extra} })`);
const scrollMain = (y) => nova(`document.querySelectorAll('*').forEach(e => { if (e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY.match(/auto|scroll/)) e.scrollTop = ${y}; })`);

await page.goto(appUrl, { waitUntil: "networkidle" });
await shot("01-intro", 1500);
await page.waitForTimeout(4200);
await nova(`window.__nova.useSettings.getState().update({ theme: "nova", language: "de" })`);
await shot("02-startseite", 2500);
await scrollMain(700);
await shot("03-startseite-widgets");
await scrollMain(0);

await go({ page: "library" });
await shot("04-bibliothek", 3500);
await page.mouse.move(470, 470);
await shot("05-bibliothek-3d-hover", 700);
await page.mouse.move(1300, 120);
await nova(`window.__nova.useUI.getState().setFilter({ favoritesOnly: true })`);
await shot("06-bibliothek-filter-favoriten");
await nova(`window.__nova.useUI.getState().resetFilter()`);
await nova(`window.__nova.useSettings.getState().update({ libraryView: "list" })`);
await shot("07-bibliothek-liste");
await nova(`window.__nova.useSettings.getState().update({ libraryView: "grid" })`);

const firstId = await nova(`window.__nova.useLibrary.getState().games.find(g => g.kind === "game").id`);
await go({ page: "game", id: firstId });
await shot("08-spiel-uebersicht", 1800);
await scrollMain(600);
await shot("09-spiel-sitzungen");
await scrollMain(0);
for (const [tab, name] of [["screens", "10-spiel-screenshots"], ["links", "11-spiel-ordner-spielstaende"], ["settings", "12-spiel-einstellungen"]]) {
  await nova(`document.dispatchEvent(new CustomEvent("nova:tab", { detail: "${tab}" }))`);
  if (tab === "screens") {
    await page.waitForTimeout(2500);
    await scrollMain(420);
  }
  await shot(name);
  await scrollMain(0);
}

await go({ page: "collections" });
await shot("13-sammlungen");
await go({ page: "stats" });
await shot("14-statistik", 1800);
await scrollMain(800);
await shot("15-statistik-kalender-uhr");
await scrollMain(1700);
await shot("16-statistik-backlog");
await go({ page: "achievements" });
await shot("17-erfolge");
await go({ page: "wishlist" });
await shot("18-wunschliste");
await go({ page: "cleanup" });
await shot("19-aufraeumen");

await go({ page: "settings" });
await shot("20-einstellungen-aussehen");
for (const [id, name] of [["sound", "21-einstellungen-sound"], ["library", "22-einstellungen-bibliothek"], ["behavior", "23-einstellungen-verhalten"], ["wellbeing", "24-einstellungen-pausen"], ["widgets", "25-einstellungen-widgets"], ["profiles", "26-einstellungen-profile"], ["data", "27-einstellungen-daten"], ["about", "28-einstellungen-tastenkuerzel"]]) {
  await nova(`document.getElementById("settings-${id}")?.scrollIntoView({ block: "start" })`);
  await shot(name, 900);
}

await go({ page: "home" });
await page.waitForTimeout(800);
await nova(`window.__nova.useUI.getState().setPalette(true)`);
await page.keyboard.type("port");
await shot("29-befehlspalette");
await page.keyboard.press("Escape");
await nova(`window.__nova.useUI.getState().setDice(true)`);
await shot("30-wuerfel");
// Der Würfel schwebt (Animation) – deshalb per Skript klicken, sonst wartet Playwright auf Stillstand
await nova(`[...document.querySelectorAll("button")].find((b) => b.textContent.includes("Würfeln"))?.click()`);
await shot("31-wuerfel-ergebnis", 5500);
await page.keyboard.press("Escape");
await nova(`window.__nova.useUI.getState().setScan(true)`);
await shot("32-bibliothek-fuellen");
await page.keyboard.press("Escape");
await nova(`window.__nova.useUI.getState().setManual(true)`);
await shot("33-manuell-hinzufuegen");
await page.keyboard.press("Escape");
await nova(`window.__nova.useUI.getState().setDragging(true)`);
await shot("34-drag-and-drop", 900);
await nova(`window.__nova.useUI.getState().setDragging(false)`);
await nova(`window.__nova.useUI.getState().setBigPicture(true)`);
await shot("35-big-picture", 1600);
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
await shot("36-big-picture-auswahl", 900);
await page.keyboard.press("Escape");

await go({ page: "game", id: firstId });
await page.waitForTimeout(900);
await nova(`window.__nova.useLibrary.getState().launch(window.__nova.useLibrary.getState().games.find(g => g.id === "${firstId}"))`);
await shot("37-start-ritual", 800);
await shot("38-laeuft-gerade", 3200);
await nova(`window.__nova.useUI.getState().pushAchievements(["curator"])`);
await shot("39-erfolg-freigeschaltet", 1200);

await go({ page: "home" });
await setTheme("polar");
await shot("40-theme-ganz-weiss", 1600);
await setTheme("neon");
await go({ page: "library" });
await shot("41-theme-neon", 1600);
await setTheme("midnight");
await go({ page: "stats" });
await shot("42-theme-mitternachtsblau", 1800);
await setTheme("nova", `, accent: "#22c55e"`);
await go({ page: "home" });
await shot("43-eigene-akzentfarbe", 1600);
await nova(`window.__nova.useSettings.getState().update({ theme: "nova", accent: "" })`);
await page.close();

// ---------- Overlay (Mini-Fenster über dem Spiel) ----------
const ov = await browser.newPage({ viewport: { width: 380, height: 560 }, locale: "de-DE" });
watch(ov);
await ov.goto(appUrl + "overlay.html", { waitUntil: "networkidle" });
await shotter(ov)("44-overlay", 1500);
await ov.close();

// ---------- Installer ----------
const run = async (query, steps) => {
  const p = await browser.newPage({ viewport: { width: 980, height: 640 }, locale: "de-DE" });
  watch(p);
  p.on("dialog", (d) => d.accept());
  await p.goto(setupUrl + query, { waitUntil: "networkidle" });
  await steps(p, shotter(p));
  await p.close();
};
const click = (p, text) => p.getByRole("button", { name: text }).first().click();
await run("", async (p, s) => {
  await p.waitForTimeout(4000);
  await click(p, /Los geht/);
  await s("45-setup-ordner", 1200);
  await click(p, /^Weiter/);
  await s("46-setup-optionen");
});
await run("", async (p, s) => {
  await p.waitForTimeout(4000);
  await click(p, /Los geht/);
  await p.waitForTimeout(1000);
  await click(p, /^Weiter/);
  await p.waitForTimeout(1000);
  await click(p, /Installieren/);
  await p.waitForSelector("text=NOVA ist bereit", { timeout: 30000 });
  await s("48-setup-fertig-countdown", 1800);
});
await run("?mode=maintenance", async (p, s) => {
  await s("47-setup-wartung", 4200);
});

await browser.close();
console.log(errors.length ? "\nFEHLER:\n" + [...new Set(errors)].join("\n") : "\nKeine Fehler in der Konsole.");
