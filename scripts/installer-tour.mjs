// Rundgang durch den Installer im Browser (Demo-Backend) mit Screenshots – Spec I.8.
// Wartet auf Zustände (Knöpfe, Überschriften, data-testid="obs-percent") statt auf feste Zeiten.
// Aufruf: node scripts/installer-tour.mjs <url> <ausgabe-ordner>
// Ergebnis: Exit-Code 1 bei Konsolenfehlern, fehlenden Zuständen oder zu langsamem Intro.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("/opt/node22/lib/node_modules/playwright");
}
const [, , base = "http://localhost:1421/", out = "setup-shots"] = process.argv;
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const problems = [];
const fail = (msg) => {
  problems.push(msg);
  console.log("  ✗", msg);
  process.exitCode = 1;
};

// Misst im Seitenkontext: erstes Erscheinen des Intros, body[data-intro-done], erster „Los geht's“-Knopf
const INIT = () => {
  const w = window;
  w.__tour = {};
  const check = () => {
    const now = performance.now();
    if (w.__tour.intro === undefined && document.querySelector('[data-testid="intro"]')) w.__tour.intro = now;
    if (w.__tour.introDone === undefined && document.body?.dataset.introDone) w.__tour.introDone = now;
    if (w.__tour.welcome === undefined) {
      for (const b of document.querySelectorAll("button")) {
        // Die erste Seite liegt vorab (inert, unsichtbar) unter dem Intro – zählt erst, wenn sie bedienbar ist
        if (/Los geht|Let's go/.test(b.textContent ?? "") && !b.closest("[inert]")) {
          w.__tour.welcome = now;
          break;
        }
      }
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-intro-done", "inert"] });
};

let current = "";
async function runWith(ctxOpts, query, steps) {
  current = query || "(ohne)";
  console.log(`\n▶ ${current}${ctxOpts.reducedMotion ? " · reduzierte Bewegung" : ""}`);
  const ctx = await browser.newContext({ viewport: { width: 980, height: 640 }, locale: query.includes("lang=en") ? "en-US" : "de-DE", ...ctxOpts });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  page.on("pageerror", (e) => errors.push(`[${current}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${current}] console: ${m.text()}`);
  });
  page.on("dialog", (d) => d.accept());
  await page.goto(base + query, { waitUntil: "networkidle" });
  try {
    await steps(page);
  } catch (e) {
    fail(`[${current}] ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    await page.screenshot({ path: `${out}/zz-fehler-${query.replace(/[^a-z0-9]+/gi, "_") || "ohne"}.png` }).catch(() => undefined);
  }
  await ctx.close();
}
const run = (query, steps) => runWith({}, query, steps);

const shot = async (p, name, wait = 0) => {
  if (wait) await p.waitForTimeout(wait);
  await p.screenshot({ path: `${out}/${name}.png` });
  console.log("  📸", name);
};
/** Screenshot bei `ms` nach dem ersten Erscheinen des Intros (unabhängig von der Ladezeit der Seite). */
const shotAt = async (p, name, ms) => {
  await p.getByTestId("intro").waitFor({ timeout: 5000 });
  const left = await p.evaluate((m) => m - (performance.now() - window.__tour.intro), ms);
  if (left > 0) await p.waitForTimeout(left);
  await shot(p, name);
};
const click = (p, name) => p.getByRole("button", { name }).first().click();
const waitBtn = (p, name, ms = 8000) => p.getByRole("button", { name }).first().waitFor({ timeout: ms });
const waitHeading = (p, name, ms = 30000) => p.getByRole("heading", { name }).first().waitFor({ timeout: ms });
/** Wartet, bis die Prozentanzeige (data-testid="obs-percent", data-value) mindestens `pct` erreicht. */
const waitPercent = (p, pct, ms = 60000) =>
  p.waitForFunction(
    (v) => {
      const el = document.querySelector('[data-testid="obs-percent"]');
      return el !== null && Number(el.getAttribute("data-value")) >= v;
    },
    pct,
    { timeout: ms, polling: 50 },
  );
const START = /Los geht|Let's go/;
/** Intro überspringen: nach 400 ms Escape, dann auf den Startknopf warten (oder `ready`, falls anderer Modus). */
const skip = async (p, ready = START) => {
  await p.waitForTimeout(400);
  await p.keyboard.press("Escape");
  await waitBtn(p, ready, 4000);
};
/** Willkommen → Speicherort → Optionen → Installieren */
const toInstall = async (p) => {
  await click(p, /Los geht/);
  await waitBtn(p, /^Weiter/);
  await click(p, /^Weiter/);
  await waitBtn(p, /Installieren/);
  await click(p, /Installieren/);
};
const timing = (p) => p.evaluate(() => window.__tour);

// 1) Vollständiges Intro, Installation (?slow), Fertig
await run("?slow", async (p) => {
  // Zeiten ab Intro-Start (D.2): Suche, Echtzeit-Pulse, Zeitraffer, Zeichen auf der Himmelskarte
  await shotAt(p, "01a-intro-search", 700);
  await shotAt(p, "01b-intro-realtime", 1900);
  await shotAt(p, "01c-intro-timelapse", 3300);
  await shotAt(p, "01d-intro-acquired", 4800);
  await waitBtn(p, /Los geht/);
  await p.waitForTimeout(50);
  const tm = await timing(p);
  if (tm?.intro !== undefined) {
    const done = tm.introDone - tm.intro;
    const welcome = tm.welcome - tm.intro;
    console.log(`  ⏱ data-intro-done nach ${done.toFixed(0)} ms, „Los geht's“ nach ${welcome.toFixed(0)} ms (ab Intro-Start)`);
    if (!(done <= 5300 + 100)) fail(`data-intro-done zu spät: ${done.toFixed(0)} ms (≤ 5300)`);
    if (!(welcome <= 5700 + 150)) fail(`Willkommen zu spät: ${welcome.toFixed(0)} ms (≤ 5700)`);
  } else fail("Intro-Zeitmessung fehlt (data-testid=intro nicht gefunden)");
  await shot(p, "02-welcome", 300);
  await click(p, /Los geht/);
  await shot(p, "03-folder", 700);
  await click(p, /^Weiter/);
  await shot(p, "04-options", 700);
  await click(p, /Installieren/);
  await shot(p, "05a-install-b1919", 600);
  await waitPercent(p, 42);
  await shot(p, "05b-install-vela");
  await waitPercent(p, 66);
  await shot(p, "05c-install-crab");
  await waitPercent(p, 88);
  await shot(p, "05d-install-tone");
  await waitHeading(p, /Signal steht/);
  await shot(p, "06a-done", 800);
  await shot(p, "06b-done-countdown", 1200);
});

// 2) Überspringen per Leertaste bei 800 ms → „Los geht's“ in ≤ 1200 ms
await run("", async (p) => {
  await p.getByTestId("intro").waitFor({ timeout: 5000 });
  await p.waitForTimeout(800);
  const t0 = Date.now();
  await p.keyboard.press("Space");
  try {
    await waitBtn(p, /Los geht/, 1200);
    console.log(`  ⏱ Überspringen → „Los geht's“ nach ${Date.now() - t0} ms`);
  } catch {
    fail("Überspringen per Leertaste: „Los geht's“ nicht in 1200 ms");
  }
  await shot(p, "07-intro-skipped", 200);
});

// 3) Fehler und Fortsetzen
await run("?fail=1", async (p) => {
  await skip(p);
  await toInstall(p);
  await waitBtn(p, /Erneut versuchen/, 15000);
  await shot(p, "08-error", 400);
  await click(p, /Erneut versuchen/);
  await p.getByText(/FORTGESETZT BEI/i).first().waitFor({ timeout: 8000 });
  await shot(p, "09-resumed", 300);
});

// 4) Abbruch und Fortsetzen
await run("?slow", async (p) => {
  await skip(p);
  await toInstall(p);
  await p.waitForTimeout(2000);
  await p.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await shot(p, "10a-cancel-dialog", 300);
  await click(p, "Installation abbrechen");
  await shot(p, "10b-cancelled", 1600);
  await click(p, /Erneut versuchen/);
  await shot(p, "10c-resumed", 1500);
});

// 5) Update: Kurz-Intro → Installation → Fertig
await run("?mode=update", async (p) => {
  await shotAt(p, "11a-update-intro", 600);
  await shot(p, "11b-update-install", 2000);
  await waitHeading(p, /Signal steht/);
  await shot(p, "11c-update-done", 500);
});

// 6) Wartung
await run("?mode=maintenance", async (p) => {
  await waitBtn(p, /Aktualisieren oder reparieren/);
  await shot(p, "12-maintenance", 300);
});

// 7) Deinstallieren rückwärts
await run("?mode=uninstall", async (p) => {
  await waitHeading(p, /deinstallieren\?/, 8000);
  await shot(p, "13a-uninstall", 300);
  await click(p, /^Deinstallieren/);
  await shot(p, "13b-uninstall-run", 1800);
  await waitHeading(p, /Signal verloren/);
  await shot(p, "13c-uninstall-done", 1500);
  await shot(p, "13d-uninstall-dissolved", 3000);
});

// 8) Deinstallieren, Rückbau fehlgeschlagen
await run("?mode=uninstall&revertfail", async (p) => {
  await waitHeading(p, /deinstallieren\?/, 8000);
  await click(p, /^Deinstallieren/);
  await p.getByRole("alert").first().waitFor({ timeout: 30000 });
  await shot(p, "14-uninstall-revertfail", 600);
});

// 9) Reduzierte Bewegung
await runWith({ reducedMotion: "reduce" }, "", async (p) => {
  await shotAt(p, "15a-reduced-intro", 500);
  await waitBtn(p, /Los geht/, 3000);
  await shot(p, "15b-reduced-welcome");
  await toInstall(p);
  await shot(p, "15c-reduced-install", 2000);
});

// 10) Englisch
await run("?lang=en", async (p) => {
  await shotAt(p, "16a-en-intro", 2000);
  await skip(p);
  await shot(p, "16b-en-welcome", 300);
  await click(p, /Let's go/);
  await shot(p, "16c-en-folder", 700);
  await click(p, /^Next/);
  await waitBtn(p, /^Install/);
  await click(p, /^Install/);
  await shot(p, "16d-en-install", 2000);
});

// 11) Ton aus bleibt gespeichert
await run("", async (p) => {
  await skip(p);
  await p.getByRole("switch", { name: "Ton" }).click();
  if ((await p.evaluate(() => localStorage.getItem("pulsar-setup-muted"))) !== "1") fail("Ton aus nicht gespeichert");
  await p.screenshot({ path: `${out}/17-muted-titlebar.png`, clip: { x: 0, y: 0, width: 980, height: 40 } });
  console.log("  📸", "17-muted-titlebar");
});

// 12) Speicherort: ungültiger Pfad sperrt „Weiter“ sofort, Skala ohne alte Werte
await run("", async (p) => {
  await skip(p);
  await click(p, /Los geht/);
  await waitBtn(p, /^Weiter/);
  await p.waitForTimeout(500);
  await p.getByLabel("Zielordner").fill("Spiele");
  if (!(await p.getByRole("button", { name: /^Weiter/ }).isDisabled())) fail("Weiter nach Ordnerwechsel nicht sofort gesperrt");
  await shot(p, "18-folder-invalid", 700);
});

// 13) Deinstallation wird sofort abgelehnt (?unfail) → Fehler mit „Erneut versuchen“
await run("?mode=uninstall&unfail", async (p) => {
  await waitHeading(p, /deinstallieren\?/, 8000);
  await click(p, /^Deinstallieren/);
  await p.getByTestId("uninstall-error").waitFor({ timeout: 3000 });
  await shot(p, "19-uninstall-error", 300);
  await click(p, /Erneut versuchen/);
  await waitHeading(p, /Signal verloren/);
});

// 14) Windows-Skalierung 150 %: Haarlinien = 1 Gerätepixel
await runWith({ deviceScaleFactor: 1.5 }, "", async (p) => {
  await skip(p);
  await toInstall(p);
  await shot(p, "20-install-150", 2000);
});

await browser.close();
const uniq = [...new Set(errors)];
if (uniq.length) process.exitCode = 1;
console.log(uniq.length ? "\nFEHLER IN DER KONSOLE:\n" + uniq.join("\n") : "\nKeine Fehler in der Konsole.");
if (problems.length) console.log("\nNICHT ERFÜLLT:\n" + problems.join("\n"));
else console.log("Alle Szenen erreicht.");
