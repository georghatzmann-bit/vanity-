// Rundgang durch den Installer im Browser (Demo-Backend) mit Screenshots.
// Aufruf: node scripts/installer-tour.mjs <url> <ausgabe-ordner>
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("/opt/node22/lib/node_modules/playwright"); }
const [, , base = "http://localhost:1421/", out = "setup-shots"] = process.argv;
mkdirSync(out, { recursive: true });
const browser = await playwright.chromium.launch();
const errors = [];
const run = async (query, steps) => {
  const page = await browser.newPage({ viewport: { width: 980, height: 640 }, locale: "de-DE" });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(base + query, { waitUntil: "networkidle" });
  await steps(page);
  await page.close();
};
const shot = async (page, name, wait = 900) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${out}/${name}.png` }); console.log("📸", name); };
const click = (page, text) => page.getByRole("button", { name: text }).first().click();

await run("", async (p) => {
  await shot(p, "01-intro", 1300);
  await shot(p, "02-welcome", 2600);
  await click(p, /Los geht/); await shot(p, "03-folder", 1200);
  await click(p, /^Weiter/); await shot(p, "04-options");
  await click(p, /Installieren/); await shot(p, "05-install", 1800);
  await shot(p, "06-install-later", 1500);
  await shot(p, "07-done", 4500);
});
await run("?fail=1", async (p) => {
  await p.waitForTimeout(3200);
  await click(p, /Los geht/); await p.waitForTimeout(700);
  await click(p, /^Weiter/); await p.waitForTimeout(700);
  await click(p, /Installieren/); await shot(p, "08-error", 3200);
  await click(p, /Erneut versuchen/); await shot(p, "09-resumed", 1500);
});
await run("?mode=maintenance", async (p) => { await shot(p, "10-maintenance", 3600); });
await run("?mode=uninstall", async (p) => {
  await shot(p, "11-uninstall", 3600);
  await click(p, /^Deinstallieren/); await shot(p, "12-uninstall-run", 1800);
  await shot(p, "13-uninstall-done", 4200);
});
await browser.close();
console.log(errors.length ? "\nFEHLER:\n" + [...new Set(errors)].join("\n") : "\nKeine Fehler in der Konsole.");
